-- pds.replace_cronometer_servings_window: the automated Cronometer export's
-- replace, which can also empty a day that no longer has any food in Cronometer.
--
-- Why: pds.replace_cronometer_servings (sql/cronometer_replace_servings.sql)
-- only replaces the dates that HAVE rows in the export. When Riley removed the
-- last food of a day in Cronometer, that date was simply missing from the next
-- export, so its old servings (and its old daily total) stayed in Onyx for good.
-- The daily total matters as much as the servings: pds.cronometer_nutrition_
-- behavioral_daily falls back to the cronometer_nutrition_daily row of a day
-- with no servings, so emptying the servings alone would still show the old
-- totals.
--
-- Only cronometer_etl.py calls this, and only for an export it requested itself
-- (it knows the exact window) that passed the importer's completeness checks
-- (cronometer_import.check_trusted_export). A manual export (inbox, CLI) still
-- goes through pds.replace_cronometer_servings and can never empty a day. That
-- function is unchanged; both take the same advisory lock, so they take turns.
--
-- Contract (called by cronometer_import.import_servings_window via PostgREST):
--   p_window_start, p_window_end  the export's requested window (both inclusive)
--   p_dates             the calendar dates that have rows in the export
--   p_rows              a JSON array of row objects (keys = pds.cronometer_servings columns)
--   p_empty_dates       window dates the export confirms have no food at all
--   p_max_cleared_days  the most stored days this call may empty
--   returns {"dates", "deleted", "inserted", "empty_dates", "populated_empty_days",
--            "cleared_days", "cleared_servings", "cleared_daily", "refused_days",
--            "max_cleared_days"}
--
-- Safety rules, all enforced here (any violation raises and nothing changes):
--   * the window is 1..400 days and ends no later than two days from now.
--   * p_dates is exactly the set of calendar_date values in p_rows (same rule as
--     the date-set function), every date of p_dates and p_empty_dates lies in
--     the window, and no date is in both.
--   * there must be something to do: rows to put back or dates to empty.
--   * keys must be writable columns (serving_id / synced_at keep their
--     defaults); the number of inserted rows must equal the length of p_rows.
--   * an empty date is only emptied in pds.cronometer_servings and
--     pds.cronometer_nutrition_daily, and every row removed that way is first
--     copied into pds.cronometer_cleared_rows in the same statement, so it can
--     be put back (recipe at the end of this file).
--   * if more than p_max_cleared_days of the empty dates hold stored rows (an
--     export that suddenly lists nothing, a wrong account), NO date is emptied:
--     the dates with rows are still replaced and the answer reports
--     refused_days, which the importer turns into a partial heartbeat.
--   * the lock is taken before the stored days are counted, so a concurrent
--     import cannot change the count between the check and the removal.
--
-- SECURITY INVOKER: runs with the caller's own rights (the service role). EXECUTE
-- is taken away from PUBLIC, anon and authenticated; only service_role may call
-- it. The backup table is service-role only (RLS on, nothing granted to anon or
-- authenticated).
--
-- Rollout: additive. Until this file is applied the importer falls back to
-- pds.replace_cronometer_servings for the dates with rows (nothing is emptied)
-- and writes a partial heartbeat that names this file.

-- 1. Backup of every row an empty-day replace removes ---------------------------
CREATE TABLE IF NOT EXISTS pds.cronometer_cleared_rows (
    cleared_id     BIGSERIAL   PRIMARY KEY,
    cleared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_table   TEXT        NOT NULL
                   CHECK (source_table IN ('cronometer_servings', 'cronometer_nutrition_daily')),
    calendar_date  DATE        NOT NULL,
    window_start   DATE        NOT NULL,
    window_end     DATE        NOT NULL,
    row_data       JSONB       NOT NULL
);

COMMENT ON TABLE pds.cronometer_cleared_rows IS
    'Rows pds.replace_cronometer_servings_window removed because the automated Cronometer export confirmed their day has no food any more. Kept so an emptied day can be put back. service_role only.';

CREATE INDEX IF NOT EXISTS idx_cron_cleared_date ON pds.cronometer_cleared_rows (calendar_date);

ALTER TABLE pds.cronometer_cleared_rows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'pds'
           AND tablename  = 'cronometer_cleared_rows'
           AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.cronometer_cleared_rows
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.cronometer_cleared_rows FROM PUBLIC;
REVOKE ALL ON pds.cronometer_cleared_rows FROM anon, authenticated;
GRANT  ALL ON pds.cronometer_cleared_rows TO service_role;
REVOKE ALL ON SEQUENCE pds.cronometer_cleared_rows_cleared_id_seq FROM anon, authenticated;
GRANT  ALL ON SEQUENCE pds.cronometer_cleared_rows_cleared_id_seq TO service_role;

-- 2. The function ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.replace_cronometer_servings_window(
    p_window_start     date,
    p_window_end       date,
    p_dates            date[],
    p_rows             jsonb,
    p_empty_dates      date[],
    p_max_cleared_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_n_rows           integer;
    v_row_dates        date[];
    v_arg_dates        date[];
    v_empty            date[];
    v_keys             text[];
    v_bad_keys         text[];
    v_cols             text;
    v_populated        integer := 0;
    v_refused          integer := 0;
    v_cleared_days     integer := 0;
    v_cleared_servings integer := 0;
    v_cleared_daily    integer := 0;
    v_deleted          integer := 0;
    v_inserted         integer := 0;
BEGIN
    -- 1. The window.
    IF p_window_start IS NULL OR p_window_end IS NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: the window needs a start and an end'
            USING ERRCODE = '22023';
    END IF;
    IF p_window_end < p_window_start THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: the window ends before it starts'
            USING ERRCODE = '22023';
    END IF;
    IF (p_window_end - p_window_start) + 1 > 400 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: the window is % days; at most 400', (p_window_end - p_window_start) + 1
            USING ERRCODE = '22023';
    END IF;
    IF p_window_end > current_date + 2 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: the window ends more than two days from now'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Shape of the other arguments.
    IF p_dates IS NULL OR p_empty_dates IS NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_dates and p_empty_dates must be arrays (they may be empty)'
            USING ERRCODE = '22023';
    END IF;
    IF array_position(p_dates, NULL) IS NOT NULL OR array_position(p_empty_dates, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date array contains NULL'
            USING ERRCODE = '22023';
    END IF;
    IF p_max_cleared_days IS NULL OR p_max_cleared_days < 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_max_cleared_days must be 0 or more'
            USING ERRCODE = '22023';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_rows must be a JSON array'
            USING ERRCODE = '22023';
    END IF;
    v_n_rows := jsonb_array_length(p_rows);
    IF v_n_rows = 0 AND cardinality(p_empty_dates) = 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: no rows and no empty dates; nothing to do'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE jsonb_typeof(e.elem) <> 'object') THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: every element of p_rows must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE NULLIF(e.elem ->> 'calendar_date', '') IS NULL) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a row has no calendar_date'
            USING ERRCODE = '22023';
    END IF;

    -- 3. Dates: the rows' dates are exactly p_dates; everything is in the window;
    --    a date is either replaced or emptied, never both.
    SELECT array_agg(DISTINCT (e.elem ->> 'calendar_date')::date ORDER BY (e.elem ->> 'calendar_date')::date)
      INTO v_row_dates
      FROM jsonb_array_elements(p_rows) AS e(elem);
    SELECT array_agg(DISTINCT d ORDER BY d) INTO v_arg_dates FROM unnest(p_dates) AS u(d);
    SELECT array_agg(DISTINCT d ORDER BY d) INTO v_empty FROM unnest(p_empty_dates) AS u(d);
    IF v_row_dates IS DISTINCT FROM v_arg_dates THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_dates (% date(s)) is not the set of calendar_date values in p_rows (% date(s))',
            coalesce(cardinality(v_arg_dates), 0), coalesce(cardinality(v_row_dates), 0)
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(coalesce(v_arg_dates, '{}'::date[]) || coalesce(v_empty, '{}'::date[])) AS u(d)
               WHERE u.d < p_window_start OR u.d > p_window_end) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date lies outside the window'
            USING ERRCODE = '22023';
    END IF;
    IF coalesce(v_empty && v_arg_dates, false) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date is both in p_dates and in p_empty_dates'
            USING ERRCODE = '22023';
    END IF;

    -- 4. Keys must be real, writable columns (same rule as the date-set function;
    --    read from information_schema, which lists only live columns).
    IF v_n_rows > 0 THEN
        SELECT array_agg(DISTINCT k.key ORDER BY k.key) INTO v_keys
          FROM jsonb_array_elements(p_rows) AS e(elem),
               LATERAL jsonb_object_keys(e.elem) AS k(key);
        SELECT array_agg(key ORDER BY key) INTO v_bad_keys
          FROM unnest(v_keys) AS u(key)
         WHERE u.key IN ('serving_id', 'synced_at')
            OR NOT EXISTS (SELECT 1 FROM information_schema.columns c
                            WHERE c.table_schema = 'pds'
                              AND c.table_name = 'cronometer_servings'
                              AND c.column_name = u.key);
        IF v_bad_keys IS NOT NULL THEN
            RAISE EXCEPTION 'replace_cronometer_servings_window: p_rows has keys that are not writable columns of pds.cronometer_servings: %', v_bad_keys
                USING ERRCODE = '22023';
        END IF;
        SELECT string_agg(quote_ident(c.column_name::text), ', ' ORDER BY c.ordinal_position) INTO v_cols
          FROM information_schema.columns c
         WHERE c.table_schema = 'pds'
           AND c.table_name = 'cronometer_servings'
           AND c.column_name = ANY (v_keys);
    END IF;

    -- 5. One import at a time: the SAME key as pds.replace_cronometer_servings,
    --    so the two functions take turns too (released when this transaction ends).
    PERFORM pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'));

    -- 6. Empty days: count the ones that still hold rows, then empty all or none.
    IF v_empty IS NOT NULL THEN
        SELECT count(*) INTO v_populated
          FROM unnest(v_empty) AS u(d)
         WHERE EXISTS (SELECT 1 FROM pds.cronometer_servings s WHERE s.calendar_date = u.d)
            OR EXISTS (SELECT 1 FROM pds.cronometer_nutrition_daily n WHERE n.calendar_date = u.d);

        IF v_populated > p_max_cleared_days THEN
            v_refused := v_populated;
        ELSIF v_populated > 0 THEN
            WITH gone AS (
                DELETE FROM pds.cronometer_servings s
                 WHERE s.calendar_date = ANY (v_empty)
                RETURNING s.*
            )
            INSERT INTO pds.cronometer_cleared_rows (source_table, calendar_date, window_start, window_end, row_data)
            SELECT 'cronometer_servings', g.calendar_date, p_window_start, p_window_end, to_jsonb(g)
              FROM gone g;
            GET DIAGNOSTICS v_cleared_servings = ROW_COUNT;

            WITH gone AS (
                DELETE FROM pds.cronometer_nutrition_daily n
                 WHERE n.calendar_date = ANY (v_empty)
                RETURNING n.*
            )
            INSERT INTO pds.cronometer_cleared_rows (source_table, calendar_date, window_start, window_end, row_data)
            SELECT 'cronometer_nutrition_daily', g.calendar_date, p_window_start, p_window_end, to_jsonb(g)
              FROM gone g;
            GET DIAGNOSTICS v_cleared_daily = ROW_COUNT;

            v_cleared_days := v_populated;
        END IF;
    END IF;

    -- 7. Replace the dates that have rows (same as the date-set function).
    IF v_n_rows > 0 THEN
        DELETE FROM pds.cronometer_servings WHERE calendar_date = ANY (v_arg_dates);
        GET DIAGNOSTICS v_deleted = ROW_COUNT;

        EXECUTE format(
            'INSERT INTO pds.cronometer_servings (%s) SELECT %s FROM jsonb_populate_recordset(NULL::pds.cronometer_servings, $1)',
            v_cols, v_cols)
          USING p_rows;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;

        IF v_inserted <> v_n_rows THEN
            RAISE EXCEPTION 'replace_cronometer_servings_window: inserted % row(s) but % were sent; nothing was changed', v_inserted, v_n_rows;
        END IF;
    END IF;

    RETURN jsonb_build_object('dates',                coalesce(cardinality(v_arg_dates), 0),
                              'deleted',              v_deleted,
                              'inserted',             v_inserted,
                              'empty_dates',          coalesce(cardinality(v_empty), 0),
                              'populated_empty_days', v_populated,
                              'cleared_days',         v_cleared_days,
                              'cleared_servings',     v_cleared_servings,
                              'cleared_daily',        v_cleared_daily,
                              'refused_days',         v_refused,
                              'max_cleared_days',     p_max_cleared_days);
END;
$function$;

COMMENT ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], integer) IS
    'Atomically replaces pds.cronometer_servings for the dates with rows AND empties (servings + daily total, backed up in pds.cronometer_cleared_rows) window dates the automated export confirms have no food, up to p_max_cleared_days stored days. Used by cronometer_etl.py only. service_role only.';

REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], integer) TO service_role;

-- 3. Putting an emptied day back (rollback; run by hand in the SQL editor) -------
-- Check the day in Cronometer first: while it is still empty there, the next
-- automated run empties it again (stop that by reverting the importer change).
--
--   INSERT INTO pds.cronometer_servings
--   SELECT (jsonb_populate_record(NULL::pds.cronometer_servings, c.row_data)).*
--     FROM pds.cronometer_cleared_rows c
--    WHERE c.source_table = 'cronometer_servings' AND c.calendar_date = '<YYYY-MM-DD>'
--   ON CONFLICT (serving_id) DO NOTHING;
--
--   INSERT INTO pds.cronometer_nutrition_daily
--   SELECT (jsonb_populate_record(NULL::pds.cronometer_nutrition_daily, c.row_data)).*
--     FROM pds.cronometer_cleared_rows c
--    WHERE c.source_table = 'cronometer_nutrition_daily' AND c.calendar_date = '<YYYY-MM-DD>'
--   ON CONFLICT (calendar_date) DO NOTHING;
--
-- If a day was emptied more than once, add `AND c.cleared_at = (SELECT max(...))`
-- for the copy you want; the backup rows are never removed by any code.
