-- ============================================================================
-- HRV source fingerprints: how the retrain detector sees edits and deletions (audit PIPE-09)
-- ============================================================================
-- hrv_feature_sources.py lists every input of the HRV pipeline. For each one with a fingerprint,
-- this function returns the number of rows dated before p_before and an md5 over the content of
-- those rows (each row hashed on its own, the hashes sorted, so neither row order nor storage
-- layout matters). hrv_analysis.py records the fingerprints before it loads its data (stored as
-- pds.hrv_analysis_results lineage / source_fingerprints after its results); the hourly
-- hrv_backfill_check.py computes them again with the same p_before and retrains when one differs.
-- That is how an edit to a table whose timestamp is set only on insert, or a deleted row, reaches
-- the retrain, without adding a trigger to any high-churn table.
--
-- A relation with no date of its own (Garmin laps, supplement products) is fingerprinted through
-- a link instead of p_date_col: only its rows whose p_link_col value appears in p_parent_key of a
-- p_parent_relation row dated (p_parent_date_col) before p_before, e.g. the laps of historical
-- activities, or the products of historical intakes. p_date_col must then be NULL.
--
-- Not hashed: the columns named in p_exclude (the caller always passes synced_at), every column
-- whose name starts with raw_ (source payloads; the typed columns derived from them are hashed),
-- and vector columns (embeddings). The function reads only; it returns a count and a hash, never
-- a row.
--
-- Access: SECURITY INVOKER, executable by service_role only (which can already read every pds
-- relation; the function adds no access). p_relation must name an existing relation in pds and
-- p_date_col one of its columns (the link arguments likewise); every name is quoted as an
-- identifier, never spliced in as text.
--
-- Additive and safe to re-run. Until it is applied, hrv_backfill_check.py falls back to its row
-- scans and the trigger signal (the behaviour before PIPE-09) and writes a partial
-- hrv_analysis|backfill_check heartbeat that says so; the retrain records no fingerprints.
-- ============================================================================

CREATE OR REPLACE FUNCTION pds.hrv_source_fingerprint(
    p_relation          text,
    p_date_col          text,
    p_before            date,
    p_exclude           text[] DEFAULT '{}'::text[],
    p_link_col          text DEFAULT NULL,
    p_parent_relation   text DEFAULT NULL,
    p_parent_key        text DEFAULT NULL,
    p_parent_date_col   text DEFAULT NULL
)
RETURNS TABLE (row_count bigint, fingerprint text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_rel    regclass := to_regclass(format('pds.%I', p_relation));
    v_parent regclass;
    v_cols   text;
    v_where  text := '';
BEGIN
    IF v_rel IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42P01', MESSAGE = 'hrv_source_fingerprint: unknown relation';
    END IF;

    SELECT string_agg(format('t.%I', a.attname), ', ' ORDER BY a.attnum)
      INTO v_cols
      FROM pg_attribute a
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE a.attrelid = v_rel
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname NOT LIKE 'raw\_%'
       AND ty.typname <> 'vector'
       AND NOT (a.attname = ANY (coalesce(p_exclude, '{}'::text[])));

    IF v_cols IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'hrv_source_fingerprint: no columns to hash';
    END IF;

    IF p_date_col IS NOT NULL AND p_parent_relation IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'hrv_source_fingerprint: give a date column or a link, not both';
    END IF;

    IF p_date_col IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = v_rel AND a.attname = p_date_col AND a.attnum > 0 AND NOT a.attisdropped
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'hrv_source_fingerprint: unknown date column';
        END IF;
        v_where := format(' WHERE t.%I < $1', p_date_col);
    ELSIF p_parent_relation IS NOT NULL THEN
        v_parent := to_regclass(format('pds.%I', p_parent_relation));
        IF v_parent IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '42P01', MESSAGE = 'hrv_source_fingerprint: unknown parent relation';
        END IF;
        IF p_link_col IS NULL OR p_parent_key IS NULL OR p_parent_date_col IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'hrv_source_fingerprint: incomplete link';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attname = p_link_col
                          AND a.attnum > 0 AND NOT a.attisdropped)
           OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = v_parent
                  AND a.attname IN (p_parent_key, p_parent_date_col) AND a.attnum > 0 AND NOT a.attisdropped)
              < CASE WHEN p_parent_key = p_parent_date_col THEN 1 ELSE 2 END THEN
            RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'hrv_source_fingerprint: unknown link column';
        END IF;
        v_where := format(' WHERE t.%I IN (SELECT p.%I FROM %s p WHERE p.%I < $1)',
                          p_link_col, p_parent_key, v_parent, p_parent_date_col);
    END IF;

    RETURN QUERY EXECUTE format(
        'SELECT count(*)::bigint, md5(coalesce(string_agg(s.h,  ORDER BY s.h), )) '
        'FROM (SELECT md5(ROW(%s)::text) AS h FROM %s t%s) s',
        v_cols, v_rel, v_where)
    USING p_before;
END;
$function$;

COMMENT ON FUNCTION pds.hrv_source_fingerprint(text, text, date, text[], text, text, text, text) IS
'Row count + content md5 of a pds relation''s rows dated before p_before (audit PIPE-09). Used by hrv_backfill_check.py / hrv_analysis.py to see edits and deletions in HRV inputs. Read-only; service_role only.';

REVOKE ALL ON FUNCTION pds.hrv_source_fingerprint(text, text, date, text[], text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.hrv_source_fingerprint(text, text, date, text[], text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.hrv_source_fingerprint(text, text, date, text[], text, text, text, text) TO service_role;
