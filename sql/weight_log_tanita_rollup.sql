-- pds.upsert_tanita_weight_days: the Tanita daily rollup into pds.weight_log,
-- with manual precedence decided by the database write itself.
--
-- Why (audit PIPE-05): tanita_etl.py used to read which days had a manual row
-- and then, in a separate request, upsert the Tanita value for every other
-- day. A manual save from the Log weight form landing between those two
-- requests was overwritten by the scale value. Here the precedence check is
-- part of the one INSERT ... ON CONFLICT statement: Postgres locks the
-- conflicting row and evaluates the WHERE against its newest committed
-- version, so a row whose source is not 'tanita' at that moment is left
-- exactly as it is, and a manual save that commits after this call replaces
-- the Tanita value as it always has (POST /api/weight writes source='manual').
--
-- Contract (called by tanita_etl.rollup_weight_log through PostgREST):
--   p_rows   a JSON array of {log_date, weight_kg, logged_at} objects, one per
--            ET day: the earliest Tanita measurement of that day (the ETL
--            picks it; logged_at = that measurement's instant).
--   returns  {"rows": n, "inserted": n, "updated": n, "unchanged": n,
--             "skipped_manual": n}
--            inserted       = a day with no row got the Tanita value
--            updated        = a Tanita-owned day got a different value / instant
--            unchanged      = a Tanita-owned day already held this value (no write)
--            skipped_manual = the day is owned by another source (manual, or a
--                             future source) and was not touched
--            The precedence is exact; the split between unchanged and
--            skipped_manual is read in a second statement and is for the log
--            only (a row changed by someone else in between can move between
--            the two).
--
-- Rules, all enforced here (any violation raises and nothing changes):
--   * every row has exactly the keys log_date, weight_kg, logged_at, none
--     empty. A caller cannot choose the source (always 'tanita'), the notes or
--     created_at.
--   * one row per log_date.
--   * logged_at falls on log_date in America/New_York (the ET-day rule the
--     rollup has always used).
--   * 0 < weight_kg < 500 (the table's own CHECK, refused here first so the
--     error carries no value).
--   * only rows of the given log_dates are written; nothing is removed, and
--     pds.tanita_measurements is not read or changed.
--   * a Tanita-owned day that already holds the same value and instant is not
--     rewritten, so a re-run changes nothing (updated_at stays put).
--
-- SECURITY INVOKER: runs with the caller's own rights (the service role, which
-- already writes pds.weight_log) and gains nothing. EXECUTE is taken away from
-- PUBLIC, anon and authenticated; only service_role may call it.
--
-- Apply once (Supabase SQL editor or an approved migration) BEFORE deploying
-- the tanita_etl.py that calls it: until then the rollup step stops with an
-- error naming this file (raw measurements are still stored) and the /status
-- Tanita card goes red. Rollback: point the ETL back at the previous code; the
-- function can stay in place unused.

CREATE OR REPLACE FUNCTION pds.upsert_tanita_weight_days(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_n_rows        integer;
    v_n_dates       integer;
    v_bad_keys      text[];
    v_written       date[];
    v_inserted      integer := 0;
    v_updated       integer := 0;
    v_unchanged     integer := 0;
BEGIN
    -- 1. Shape of the argument.
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: p_rows must be a JSON array'
            USING ERRCODE = '22023';
    END IF;
    v_n_rows := jsonb_array_length(p_rows);
    IF v_n_rows = 0 THEN
        RETURN jsonb_build_object('rows', 0, 'inserted', 0, 'updated', 0,
                                  'unchanged', 0, 'skipped_manual', 0);
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE jsonb_typeof(e.elem) <> 'object') THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: every element of p_rows must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Only the three accepted keys, all present and non-empty.
    SELECT array_agg(DISTINCT k.key ORDER BY k.key) INTO v_bad_keys
      FROM jsonb_array_elements(p_rows) AS e(elem),
           LATERAL jsonb_object_keys(e.elem) AS k(key)
     WHERE k.key NOT IN ('log_date', 'weight_kg', 'logged_at');
    IF v_bad_keys IS NOT NULL THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: p_rows has keys that are not accepted: %', v_bad_keys
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE NULLIF(e.elem ->> 'log_date', '') IS NULL
                  OR NULLIF(e.elem ->> 'weight_kg', '') IS NULL
                  OR NULLIF(e.elem ->> 'logged_at', '') IS NULL) THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: a row is missing log_date, weight_kg or logged_at'
            USING ERRCODE = '22023';
    END IF;

    -- 3. One row per day (ON CONFLICT cannot touch one row twice anyway; this
    --    says why instead of failing on it).
    SELECT count(DISTINCT (e.elem ->> 'log_date')::date) INTO v_n_dates
      FROM jsonb_array_elements(p_rows) AS e(elem);
    IF v_n_dates <> v_n_rows THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: % row(s) for % day(s); send one row per log_date', v_n_rows, v_n_dates
            USING ERRCODE = '22023';
    END IF;

    -- 4. Values: the ET-day rule and the weight range, with no value in the message.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE ((e.elem ->> 'logged_at')::timestamptz AT TIME ZONE 'America/New_York')::date
                     <> (e.elem ->> 'log_date')::date) THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: a row''s logged_at is not on its log_date in America/New_York'
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE (e.elem ->> 'weight_kg')::numeric <= 0
                  OR (e.elem ->> 'weight_kg')::numeric >= 500) THEN
        RAISE EXCEPTION 'upsert_tanita_weight_days: a row has a weight outside 0..500 kg'
            USING ERRCODE = '22023';
    END IF;

    -- 5. The write. Precedence lives in the ON CONFLICT ... WHERE: only a row
    --    that is still Tanita-owned when Postgres holds its lock is updated, and
    --    only when the value or instant differs. xmax = 0 marks a freshly
    --    inserted row (an updated one carries this transaction's lock).
    WITH incoming AS (
        SELECT (e.elem ->> 'log_date')::date         AS log_date,
               (e.elem ->> 'weight_kg')::numeric     AS weight_kg,
               (e.elem ->> 'logged_at')::timestamptz AS logged_at
          FROM jsonb_array_elements(p_rows) AS e(elem)
    ), written AS (
        INSERT INTO pds.weight_log AS w (log_date, weight_kg, source, logged_at)
        SELECT i.log_date, i.weight_kg, 'tanita', i.logged_at
          FROM incoming AS i
        ON CONFLICT (log_date) DO UPDATE
           SET weight_kg = EXCLUDED.weight_kg,
               logged_at = EXCLUDED.logged_at
         WHERE w.source = 'tanita'
           AND (w.weight_kg, w.logged_at) IS DISTINCT FROM (EXCLUDED.weight_kg, EXCLUDED.logged_at)
        RETURNING w.log_date, (w.xmax = 0) AS was_inserted
    )
    SELECT count(*) FILTER (WHERE was_inserted),
           count(*) FILTER (WHERE NOT was_inserted),
           COALESCE(array_agg(log_date), ARRAY[]::date[])
      INTO v_inserted, v_updated, v_written
      FROM written;

    -- 6. For the log only: of the days not written, which are already Tanita's.
    SELECT count(*) INTO v_unchanged
      FROM jsonb_array_elements(p_rows) AS e(elem)
      JOIN pds.weight_log AS w ON w.log_date = (e.elem ->> 'log_date')::date
     WHERE w.source = 'tanita'
       AND NOT (w.log_date = ANY (v_written));

    RETURN jsonb_build_object(
        'rows',           v_n_rows,
        'inserted',       v_inserted,
        'updated',        v_updated,
        'unchanged',      v_unchanged,
        'skipped_manual', v_n_rows - v_inserted - v_updated - v_unchanged);
END;
$function$;

COMMENT ON FUNCTION pds.upsert_tanita_weight_days(jsonb) IS
    'Tanita daily rollup into pds.weight_log: inserts or updates Tanita-owned days only, decided inside one INSERT ... ON CONFLICT so a manual row is never overwritten, even one saved during the run. Returns counts. Used by tanita_etl.py. service_role only.';

REVOKE ALL ON FUNCTION pds.upsert_tanita_weight_days(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.upsert_tanita_weight_days(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.upsert_tanita_weight_days(jsonb) TO service_role;
