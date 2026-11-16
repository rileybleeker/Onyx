-- The Cronometer import's writes, each in ONE transaction under one shared lock:
--
--   pds.replace_cronometer_servings_window   the automated export (cronometer_etl.py):
--       replace the servings of the days with food, upsert the daily totals, and
--       empty days that no longer have any food in Cronometer, on a second look.
--   pds.replace_cronometer_servings_and_daily  every import without a window (a
--       manual export from the inbox or the CLI, a run with emptying off, a very
--       long backfill): the servings of the dates with rows plus the daily totals.
--       It never empties a day.
--   pds.cronometer_upsert_daily   the daily upsert both of them use.
--
-- Why: pds.replace_cronometer_servings (sql/cronometer_replace_servings.sql)
-- only replaces the dates that HAVE rows in an export. When Riley removed the
-- last food of a day in Cronometer, that date was simply missing from the next
-- export, so its old servings (and its old daily total) stayed in Onyx for good.
-- The daily total matters as much as the servings: pds.cronometer_nutrition_
-- behavioral_daily falls back to the cronometer_nutrition_daily row of a day
-- with no servings, so emptying the servings alone would still show the old
-- totals. The daily totals are written in the same transaction as the servings
-- by BOTH writers, so no import can leave its daily total next to another
-- import's servings (with the daily upsert as a separate request, a manual
-- import could put back the daily row of a day the automated export had just
-- emptied, with no servings under it).
--
-- Only cronometer_etl.py calls the window function, and only for an export it
-- requested itself (it knows the exact window) that passed the importer's checks
-- (cronometer_import.check_trusted_export: both files well formed with an Energy
-- column, every date in the window, every nutrient cell blank or a finite number,
-- per-day servings sums equal to the daily totals for every nutrient column the
-- two files share). An export that fails the checks still calls it, with only the
-- rows that may be written and nothing to empty. A manual export has no window
-- and can never empty a day. pds.replace_cronometer_servings is
-- unchanged and still the one place that replaces servings: both new functions
-- call it, and all of them take the same advisory lock, so they take turns.
--
-- Contract of pds.replace_cronometer_servings_window (cronometer_import.import_servings_window):
--   p_window_start, p_window_end  the export's requested window
--   p_dates                  the calendar dates that have serving rows in p_rows
--   p_rows                   a JSON array of row objects (keys = pds.cronometer_servings columns)
--   p_empty_dates            days in neither file: their servings AND daily row are emptied
--   p_servings_empty_dates   days the daily summary lists with no food and no servings:
--                            their servings are emptied, their daily row is in p_daily_rows
--                            (every date of both lists lies strictly between the first
--                            and the last date of p_dates)
--   p_food_dates             every day the export shows (or may show) food on, whether
--                            or not its rows are in p_rows / p_daily_rows (a day the
--                            files disagree on, a value that cannot be read, a file that
--                            is not well formed): each loses its empty-day record. Any
--                            date (it only forgets records); never one of the two
--                            empty lists. A call may carry only this.
--   p_daily_rows             a JSON array of daily Total rows (keys = pds.cronometer_nutrition_daily
--                            columns), upserted on calendar_date
--   p_max_cleared_days       the most stored days this call may empty
--   returns {"dates", "deleted", "inserted", "daily_upserted", "empty_dates",
--            "servings_empty_dates", "populated_empty_days", "confirmed_days",
--            "pending_days", "cleared_days", "cleared_servings", "cleared_daily",
--            "refused_days", "max_cleared_days"}
--
-- Contract of pds.replace_cronometer_servings_and_daily (cronometer_import.import_servings_and_daily):
--   p_dates, p_rows   as for pds.replace_cronometer_servings; both may be empty, and
--                     then only the daily rows are written
--   p_daily_rows      a JSON array of daily Total rows, upserted on calendar_date
--   returns {"dates", "deleted", "inserted", "daily_upserted"}
--
-- Safety rules, all enforced here (any violation raises and nothing changes):
--   * the window is 1..400 days and ends no later than two days from now.
--   * p_dates is exactly the set of calendar_date values in p_rows (checked here
--     and again by pds.replace_cronometer_servings); every date of every argument
--     but p_food_dates lies in the window; the replaced, emptied and
--     servings-emptied dates are three separate sets; a day that is emptied has no
--     daily row in p_daily_rows, and every servings-emptied day has one; no date
--     of p_food_dates is emptied or servings-emptied.
--   * coverage comes from dates, not from time: every emptied or servings-emptied
--     date lies strictly between the first and the last date of p_dates, so the
--     export itself has food on a day before it and on a day after it. A day past
--     the export's newest day with food (or before its oldest) may just be missing
--     from a cut-short export, however long ago the first look was; it is never
--     emptied, and neither is anything in an export with fewer than two days with
--     food. This also keeps the first and last day of the window out.
--   * there must be something to do.
--   * keys must be writable columns (serving_id / synced_at keep their defaults),
--     every daily row carries the same keys (a key missing from one row would
--     write NULL over its stored value), no day appears twice in p_daily_rows, and
--     the inserted and upserted row counts must equal the lengths of p_rows and
--     p_daily_rows.
--   * a stored day is emptied only on a SECOND look. The servings.csv and
--     dailysummary.csv of one run are one look: both downloads can miss the same
--     day, and then they agree with each other. The first call that lists a
--     stored day as empty records it in pds.cronometer_empty_day_candidates; a
--     later call at least 6 hours after that first look that still lists it
--     empty empties it. Two runs a few seconds apart are not two looks. Food
--     seen on the day removes the record, so the count starts over: a window
--     call whose rows or p_food_dates show food on it (even when its rows are
--     not written), and EVERY call of the other writer
--     (replace_cronometer_servings_and_daily: a manual import, a run with
--     emptying off), for each date it writes. Otherwise food seen in between
--     would leave the old first look behind, and the next automated export that
--     missed the day would empty it on one look. (A direct call of the date-set
--     function, which no importer makes once this file is applied, does not
--     reset it.)
--   * an empty day is only emptied in pds.cronometer_servings and (for
--     p_empty_dates) pds.cronometer_nutrition_daily, and every row removed that
--     way is first copied into pds.cronometer_cleared_rows in the same statement,
--     so it can be put back (recipe at the end of this file).
--   * if more than p_max_cleared_days of the empty days hold stored rows
--     (confirmed or not: an export that suddenly lists nothing, a wrong account),
--     NO day is emptied: the rest is still written and the answer reports
--     refused_days, which the importer turns into a partial heartbeat. Only days
--     that hold stored rows count (a servings-emptied day counts when it has
--     stored servings), so a retry of the same export counts nothing again.
--   * the lock is taken before the stored days are counted, so a concurrent
--     import cannot change the count between the check and the removal.
--
-- Columns are looked up in pg_catalog.pg_attribute, as in the date-set function.
-- A column that was removed from a table keeps only a placeholder name there,
-- which no key can equal, so the key match alone leaves it out (and this file
-- stays free of the one word the Supabase connector refuses).
--
-- SECURITY INVOKER: everything runs with the caller's own rights (the service
-- role). EXECUTE is taken away from PUBLIC, anon and authenticated; only
-- service_role may call these functions. Both tables are service-role only (RLS
-- on, nothing granted to anon or authenticated).
--
-- Rollout: additive. Until this file is applied the importer falls back to
-- pds.replace_cronometer_servings for the dates with rows plus the usual daily
-- upsert (nothing is emptied); an automated run then writes a partial heartbeat
-- that names this file. Before the first real run, `python cronometer_etl.py
-- --dry-run` prints how many stored days a real run would empty (read only,
-- counts only).

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
    'Rows pds.replace_cronometer_servings_window removed because the automated Cronometer export confirmed (two looks at least 6 h apart) that their day has no food any more. Kept so an emptied day can be put back. service_role only.';

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

-- 2. Stored days an export showed empty, waiting for the second look -------------
CREATE TABLE IF NOT EXISTS pds.cronometer_empty_day_candidates (
    calendar_date  DATE        PRIMARY KEY,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    times_seen     INTEGER     NOT NULL DEFAULT 1 CHECK (times_seen >= 1)
);

COMMENT ON TABLE pds.cronometer_empty_day_candidates IS
    'Stored Cronometer days the automated export showed with no food, not emptied yet. pds.replace_cronometer_servings_window empties a day once an export at least 6 h after first_seen_at still shows it empty; both import functions forget a day whenever they write it, and the window function also whenever the export shows food on it, written or not. Dates only. service_role only.';

ALTER TABLE pds.cronometer_empty_day_candidates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'pds'
           AND tablename  = 'cronometer_empty_day_candidates'
           AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.cronometer_empty_day_candidates
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.cronometer_empty_day_candidates FROM PUBLIC;
REVOKE ALL ON pds.cronometer_empty_day_candidates FROM anon, authenticated;
GRANT  ALL ON pds.cronometer_empty_day_candidates TO service_role;

-- 3. The daily upsert (used by both writers below) --------------------------------
CREATE OR REPLACE FUNCTION pds.cronometer_upsert_daily(p_daily_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_n      integer;
    v_dates  date[];
    v_keys   text[];
    v_bad    text[];
    v_cols   text;
    v_set    text;
    v_done   integer := 0;
BEGIN
    IF p_daily_rows IS NULL OR jsonb_typeof(p_daily_rows) <> 'array' THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: p_daily_rows must be a JSON array'
            USING ERRCODE = '22023';
    END IF;
    v_n := jsonb_array_length(p_daily_rows);
    IF v_n = 0 THEN
        RETURN 0;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_daily_rows) AS e(elem)
               WHERE jsonb_typeof(e.elem) <> 'object'
                  OR NULLIF(e.elem ->> 'calendar_date', '') IS NULL) THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: every element of p_daily_rows must be a JSON object with a calendar_date'
            USING ERRCODE = '22023';
    END IF;

    -- One row per day, all with the same keys.
    SELECT array_agg((e.elem ->> 'calendar_date')::date) INTO v_dates
      FROM jsonb_array_elements(p_daily_rows) AS e(elem);
    IF (SELECT count(DISTINCT u.d) FROM unnest(v_dates) AS u(d)) <> v_n THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: a date appears twice in p_daily_rows'
            USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(DISTINCT ks.key_set)
          FROM (SELECT (SELECT array_agg(k.key ORDER BY k.key)
                          FROM jsonb_object_keys(e.elem) AS k(key)) AS key_set
                  FROM jsonb_array_elements(p_daily_rows) AS e(elem)) AS ks) > 1 THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: the rows of p_daily_rows do not all carry the same keys'
            USING ERRCODE = '22023';
    END IF;

    -- Keys must be real, writable columns (synced_at keeps its default).
    SELECT array_agg(k.key ORDER BY k.key) INTO v_keys
      FROM jsonb_object_keys(p_daily_rows -> 0) AS k(key);
    SELECT array_agg(u.key ORDER BY u.key) INTO v_bad
      FROM unnest(v_keys) AS u(key)
     WHERE u.key = 'synced_at'
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                        WHERE a.attrelid = 'pds.cronometer_nutrition_daily'::regclass
                          AND a.attnum > 0
                          AND a.attname = u.key);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: p_daily_rows has keys that are not writable columns of pds.cronometer_nutrition_daily: %', v_bad
            USING ERRCODE = '22023';
    END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           string_agg(format('%1$I = EXCLUDED.%1$I', a.attname), ', ' ORDER BY a.attnum)
               FILTER (WHERE a.attname <> 'calendar_date')
      INTO v_cols, v_set
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'pds.cronometer_nutrition_daily'::regclass
       AND a.attnum > 0
       AND a.attname = ANY (v_keys);
    IF v_set IS NULL THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: p_daily_rows carry no column besides calendar_date'
            USING ERRCODE = '22023';
    END IF;

    -- The same upsert on calendar_date the importer used to send as a request
    -- (columns not in the rows keep their stored values).
    EXECUTE format(
        'INSERT INTO pds.cronometer_nutrition_daily (%s) SELECT %s FROM jsonb_populate_recordset(NULL::pds.cronometer_nutrition_daily, $1) ON CONFLICT (calendar_date) DO UPDATE SET %s',
        v_cols, v_cols, v_set)
      USING p_daily_rows;
    GET DIAGNOSTICS v_done = ROW_COUNT;

    IF v_done <> v_n THEN
        RAISE EXCEPTION 'cronometer_upsert_daily: wrote % daily row(s) but % were sent; nothing was changed', v_done, v_n;
    END IF;
    RETURN v_done;
END;
$function$;

COMMENT ON FUNCTION pds.cronometer_upsert_daily(jsonb) IS
    'Validated upsert of Cronometer daily Total rows on calendar_date (same keys in every row, writable columns only, one row per day). Called inside pds.replace_cronometer_servings_window and pds.replace_cronometer_servings_and_daily. service_role only.';

REVOKE ALL ON FUNCTION pds.cronometer_upsert_daily(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.cronometer_upsert_daily(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.cronometer_upsert_daily(jsonb) TO service_role;

-- 4. Every import that may not empty a day ----------------------------------------
CREATE OR REPLACE FUNCTION pds.replace_cronometer_servings_and_daily(
    p_dates       date[],
    p_rows        jsonb,
    p_daily_rows  jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_replace      jsonb := jsonb_build_object('dates', 0, 'deleted', 0, 'inserted', 0);
    v_daily        integer := 0;
    v_daily_dates  date[];
BEGIN
    IF p_dates IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
       OR p_daily_rows IS NULL OR jsonb_typeof(p_daily_rows) <> 'array' THEN
        RAISE EXCEPTION 'replace_cronometer_servings_and_daily: p_dates must be an array (it may be empty) and p_rows, p_daily_rows JSON arrays'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_rows) = 0 AND cardinality(p_dates) > 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_and_daily: % date(s) but no rows; this function never empties a day', cardinality(p_dates)
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_rows) = 0 AND jsonb_array_length(p_daily_rows) = 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_and_daily: no rows; nothing to do'
            USING ERRCODE = '22023';
    END IF;

    -- One import at a time: the SAME key as the other two writers (released when
    -- this transaction ends; taking it again inside the date-set function is fine).
    PERFORM pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'));

    -- Every day this import writes is no longer waiting to be emptied: its count
    -- starts over, under the same lock and in the same transaction as the write.
    -- (The dates are validated below, by the date-set function and the daily
    -- upsert; a bad one raises there and this is rolled back with the rest.)
    SELECT coalesce(array_agg((NULLIF(e.elem ->> 'calendar_date', ''))::date), '{}'::date[])
      INTO v_daily_dates
      FROM jsonb_array_elements(p_daily_rows) AS e(elem)
     WHERE jsonb_typeof(e.elem) = 'object';
    DELETE FROM pds.cronometer_empty_day_candidates c
     WHERE c.calendar_date = ANY (p_dates || v_daily_dates);

    IF jsonb_array_length(p_rows) > 0 THEN
        v_replace := pds.replace_cronometer_servings(p_dates, p_rows);
    END IF;
    v_daily := pds.cronometer_upsert_daily(p_daily_rows);

    RETURN v_replace || jsonb_build_object('daily_upserted', v_daily);
END;
$function$;

COMMENT ON FUNCTION pds.replace_cronometer_servings_and_daily(date[], jsonb, jsonb) IS
    'Atomically replaces pds.cronometer_servings for the dates with rows (via pds.replace_cronometer_servings) and upserts the daily totals, under the shared import lock, and forgets the empty-day record of every date it writes. Never empties a day. Used by cronometer_import.py for imports without a window (manual exports, emptying off) and as the window function''s rollout fallback. service_role only.';

REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_and_daily(date[], jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_and_daily(date[], jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.replace_cronometer_servings_and_daily(date[], jsonb, jsonb) TO service_role;

-- 5. The automated export ---------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.replace_cronometer_servings_window(
    p_window_start           date,
    p_window_end             date,
    p_dates                  date[],
    p_rows                   jsonb,
    p_empty_dates            date[],
    p_servings_empty_dates   date[],
    p_food_dates             date[],
    p_daily_rows             jsonb,
    p_max_cleared_days       integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_n_rows           integer;
    v_n_daily          integer;
    v_row_dates        date[];
    v_arg_dates        date[];
    v_empty            date[];
    v_sempty           date[];
    v_food             date[];
    v_daily_dates      date[];
    v_first            date;
    v_last             date;
    v_stored           date[];
    v_confirmed        date[];
    v_kept             date[];
    v_replace          jsonb;
    v_populated        integer := 0;
    v_refused          integer := 0;
    v_pending          integer := 0;
    v_cleared_days     integer := 0;
    v_cleared_servings integer := 0;
    v_cleared_daily    integer := 0;
    v_deleted          integer := 0;
    v_inserted         integer := 0;
    v_daily            integer := 0;
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
    IF p_dates IS NULL OR p_empty_dates IS NULL OR p_servings_empty_dates IS NULL
       OR p_food_dates IS NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_dates, p_empty_dates, p_servings_empty_dates and p_food_dates must be arrays (they may be empty)'
            USING ERRCODE = '22023';
    END IF;
    IF array_position(p_dates, NULL) IS NOT NULL OR array_position(p_empty_dates, NULL) IS NOT NULL
       OR array_position(p_servings_empty_dates, NULL) IS NOT NULL
       OR array_position(p_food_dates, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date array contains NULL'
            USING ERRCODE = '22023';
    END IF;
    IF p_max_cleared_days IS NULL OR p_max_cleared_days < 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_max_cleared_days must be 0 or more'
            USING ERRCODE = '22023';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
       OR p_daily_rows IS NULL OR jsonb_typeof(p_daily_rows) <> 'array' THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_rows and p_daily_rows must be JSON arrays'
            USING ERRCODE = '22023';
    END IF;
    v_n_rows := jsonb_array_length(p_rows);
    v_n_daily := jsonb_array_length(p_daily_rows);
    IF v_n_rows = 0 AND v_n_daily = 0 AND cardinality(p_empty_dates) = 0
       AND cardinality(p_servings_empty_dates) = 0 AND cardinality(p_food_dates) = 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: no rows, no empty dates and no food dates; nothing to do'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows || p_daily_rows) AS e(elem)
               WHERE jsonb_typeof(e.elem) <> 'object') THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: every element of p_rows and p_daily_rows must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows || p_daily_rows) AS e(elem)
               WHERE NULLIF(e.elem ->> 'calendar_date', '') IS NULL) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a row has no calendar_date'
            USING ERRCODE = '22023';
    END IF;

    -- 3. Dates: the rows' dates are exactly p_dates; everything is in the window;
    --    a day is replaced, emptied or servings-emptied, never two of these.
    SELECT array_agg(DISTINCT (e.elem ->> 'calendar_date')::date ORDER BY (e.elem ->> 'calendar_date')::date)
      INTO v_row_dates
      FROM jsonb_array_elements(p_rows) AS e(elem);
    SELECT array_agg(DISTINCT u.d ORDER BY u.d) INTO v_arg_dates FROM unnest(p_dates) AS u(d);
    IF v_row_dates IS DISTINCT FROM v_arg_dates THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: p_dates (% date(s)) is not the set of calendar_date values in p_rows (% date(s))',
            coalesce(cardinality(v_arg_dates), 0), coalesce(cardinality(v_row_dates), 0)
            USING ERRCODE = '22023';
    END IF;
    v_arg_dates := coalesce(v_arg_dates, '{}'::date[]);
    SELECT coalesce(array_agg(DISTINCT u.d ORDER BY u.d), '{}'::date[]) INTO v_empty FROM unnest(p_empty_dates) AS u(d);
    SELECT coalesce(array_agg(DISTINCT u.d ORDER BY u.d), '{}'::date[]) INTO v_sempty FROM unnest(p_servings_empty_dates) AS u(d);
    SELECT coalesce(array_agg(DISTINCT u.d ORDER BY u.d), '{}'::date[]) INTO v_food FROM unnest(p_food_dates) AS u(d);
    SELECT coalesce(array_agg((e.elem ->> 'calendar_date')::date), '{}'::date[]) INTO v_daily_dates
      FROM jsonb_array_elements(p_daily_rows) AS e(elem);
    IF EXISTS (SELECT 1 FROM unnest(v_arg_dates || v_empty || v_sempty || v_daily_dates) AS u(d)
               WHERE u.d < p_window_start OR u.d > p_window_end) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date lies outside the window'
            USING ERRCODE = '22023';
    END IF;
    IF (v_empty && v_arg_dates) OR (v_sempty && v_arg_dates) OR (v_empty && v_sempty) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date is in more than one of p_dates, p_empty_dates and p_servings_empty_dates'
            USING ERRCODE = '22023';
    END IF;
    IF v_empty && v_daily_dates THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date in p_empty_dates has a row in p_daily_rows'
            USING ERRCODE = '22023';
    END IF;
    IF v_food && (v_empty || v_sempty) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date in p_food_dates is also listed as having no food'
            USING ERRCODE = '22023';
    END IF;
    IF NOT (v_sempty <@ v_daily_dates) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: a date in p_servings_empty_dates has no row in p_daily_rows'
            USING ERRCODE = '22023';
    END IF;
    -- Coverage: an empty date must have food on both sides of it in this export
    -- (v_first / v_last are NULL when p_dates is empty, and then no date passes).
    SELECT min(u.d), max(u.d) INTO v_first, v_last FROM unnest(v_arg_dates) AS u(d);
    IF EXISTS (SELECT 1 FROM unnest(v_empty || v_sempty) AS u(d)
                WHERE v_first IS NULL OR u.d <= v_first OR u.d >= v_last) THEN
        RAISE EXCEPTION 'replace_cronometer_servings_window: an empty date does not lie strictly between the first and last date of p_dates'
            USING ERRCODE = '22023';
    END IF;

    -- 4. One import at a time: the SAME key as the other two writers, so all of
    --    them take turns (released when this transaction ends).
    PERFORM pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'));

    -- 5. A day this export shows food on is no longer waiting to be emptied: its
    --    count starts over (servings rows, a daily row that is not listed as
    --    having no food, or a date in p_food_dates, written or not). The other
    --    writer does the same for every date it writes.
    DELETE FROM pds.cronometer_empty_day_candidates c
     WHERE c.calendar_date = ANY (v_arg_dates || v_daily_dates || v_food)
       AND NOT (c.calendar_date = ANY (v_sempty));

    -- 6. Empty days that still hold rows, and those of them an earlier export, at
    --    least 6 hours ago, already showed empty.
    SELECT coalesce(array_agg(x.d ORDER BY x.d), '{}'::date[]) INTO v_stored
      FROM (SELECT u.d FROM unnest(v_empty) AS u(d)
             WHERE EXISTS (SELECT 1 FROM pds.cronometer_servings s WHERE s.calendar_date = u.d)
                OR EXISTS (SELECT 1 FROM pds.cronometer_nutrition_daily n WHERE n.calendar_date = u.d)
            UNION ALL
            SELECT u.d FROM unnest(v_sempty) AS u(d)
             WHERE EXISTS (SELECT 1 FROM pds.cronometer_servings s WHERE s.calendar_date = u.d)) AS x;
    v_populated := cardinality(v_stored);
    SELECT coalesce(array_agg(c.calendar_date ORDER BY c.calendar_date), '{}'::date[]) INTO v_confirmed
      FROM pds.cronometer_empty_day_candidates c
     WHERE c.calendar_date = ANY (v_stored)
       AND c.first_seen_at <= now() - interval '6 hours';

    -- 7. The limit, then empty the confirmed days (all of them or none).
    IF v_populated > p_max_cleared_days THEN
        v_refused := v_populated;
        v_kept := v_stored;
    ELSE
        IF cardinality(v_confirmed) > 0 THEN
            WITH gone AS (
                DELETE FROM pds.cronometer_servings s
                 WHERE s.calendar_date = ANY (v_confirmed)
                RETURNING s.*
            )
            INSERT INTO pds.cronometer_cleared_rows (source_table, calendar_date, window_start, window_end, row_data)
            SELECT 'cronometer_servings', g.calendar_date, p_window_start, p_window_end, to_jsonb(g)
              FROM gone g;
            GET DIAGNOSTICS v_cleared_servings = ROW_COUNT;

            WITH gone AS (
                DELETE FROM pds.cronometer_nutrition_daily n
                 WHERE n.calendar_date = ANY (v_confirmed)
                   AND n.calendar_date = ANY (v_empty)
                RETURNING n.*
            )
            INSERT INTO pds.cronometer_cleared_rows (source_table, calendar_date, window_start, window_end, row_data)
            SELECT 'cronometer_nutrition_daily', g.calendar_date, p_window_start, p_window_end, to_jsonb(g)
              FROM gone g;
            GET DIAGNOSTICS v_cleared_daily = ROW_COUNT;

            v_cleared_days := cardinality(v_confirmed);
        END IF;
        v_kept := ARRAY(SELECT k.d FROM unnest(v_stored) AS k(d)
                         WHERE NOT (k.d = ANY (v_confirmed)) ORDER BY k.d);
        v_pending := cardinality(v_kept);
    END IF;

    -- 8. Keep the record of the stored empty days not emptied now (first look, or
    --    another look); forget the empty days that hold nothing (any more).
    DELETE FROM pds.cronometer_empty_day_candidates c
     WHERE c.calendar_date = ANY (v_empty || v_sempty)
       AND NOT (c.calendar_date = ANY (v_kept));
    INSERT INTO pds.cronometer_empty_day_candidates AS c (calendar_date)
    SELECT k.d FROM unnest(v_kept) AS k(d)
    ON CONFLICT (calendar_date) DO UPDATE
       SET last_seen_at = now(), times_seen = c.times_seen + 1;

    -- 9. Replace the dates that have rows, through the date-set function itself.
    IF v_n_rows > 0 THEN
        v_replace := pds.replace_cronometer_servings(v_arg_dates, p_rows);
        v_deleted := (v_replace ->> 'deleted')::integer;
        v_inserted := (v_replace ->> 'inserted')::integer;
    END IF;

    -- 10. The daily totals, in the same transaction.
    v_daily := pds.cronometer_upsert_daily(p_daily_rows);

    RETURN jsonb_build_object('dates',                cardinality(v_arg_dates),
                              'deleted',              v_deleted,
                              'inserted',             v_inserted,
                              'daily_upserted',       v_daily,
                              'empty_dates',          cardinality(v_empty),
                              'servings_empty_dates', cardinality(v_sempty),
                              'populated_empty_days', v_populated,
                              'confirmed_days',       cardinality(v_confirmed),
                              'pending_days',         v_pending,
                              'cleared_days',         v_cleared_days,
                              'cleared_servings',     v_cleared_servings,
                              'cleared_daily',        v_cleared_daily,
                              'refused_days',         v_refused,
                              'max_cleared_days',     p_max_cleared_days);
END;
$function$;

COMMENT ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], date[], jsonb, integer) IS
    'Atomically replaces pds.cronometer_servings for the dates with rows, upserts the daily totals AND empties (backed up in pds.cronometer_cleared_rows) days between two dates with food that the automated export showed with no food on two looks at least 6 h apart, up to p_max_cleared_days stored days; every day the export shows food on (p_food_dates, written or not) loses its empty-day record. Used by cronometer_etl.py only. service_role only.';

REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], date[], jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], date[], jsonb, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], date[], jsonb, integer) TO service_role;

-- 6. Putting an emptied day back (rollback; run by hand in the SQL editor) -------
-- Check the day in Cronometer first: while it is still empty there, the next
-- automated runs empty it again (stop that with cronometer_etl.py
-- --no-empty-days, the CRONOMETER_EMPTY_DAYS=off env var, or by reverting the
-- importer change).
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
