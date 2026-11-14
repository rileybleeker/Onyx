-- pds.replace_cronometer_servings: replace the Cronometer servings of a set of
-- dates in ONE transaction.
--
-- Why: cronometer_import.py used to clear the re-imported dates and then insert
-- the fresh rows as separate requests (audit deepseek/F-005). A reader in
-- between saw those days with no servings, and a failed insert left up to 30
-- days empty until the next good run. A function call is one transaction:
-- readers see the old rows or the new rows, and any error rolls everything back.
--
-- Contract (called by cronometer_import.import_servings through PostgREST):
--   p_dates  the calendar dates being re-imported
--   p_rows   a JSON array of row objects, keys = pds.cronometer_servings columns
--   returns  {"dates": n, "deleted": n, "inserted": n}
--
-- Safety rules, all enforced here (any violation raises and nothing changes):
--   * p_dates must be exactly the set of calendar_date values in p_rows, so a
--     date is only ever cleared together with the rows that replace it. An
--     empty p_rows is refused: this function cannot be used to wipe days.
--   * only rows WHERE calendar_date = ANY (p_dates) are removed, the same scope
--     as the importer's old delete-by-date.
--   * a key that is not a column, or serving_id / synced_at (both keep their
--     defaults), is refused. Columns absent from p_rows keep their defaults,
--     as with a PostgREST insert.
--   * the number of inserted rows must equal the length of p_rows.
--   * two imports at once take turns (transaction-level advisory lock), so
--     neither can miss the other's rows and leave duplicates.
--
-- SECURITY INVOKER: it runs with the caller's own rights (the service role,
-- which already has full access to the table) and gains nothing. EXECUTE is
-- taken away from PUBLIC, anon and authenticated; only service_role may call it.
--
-- Apply once (Supabase SQL editor or an approved migration). The importer fails
-- with a message naming this file while the function does not exist.

CREATE OR REPLACE FUNCTION pds.replace_cronometer_servings(p_dates date[], p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    v_n_rows    integer;
    v_row_dates date[];
    v_arg_dates date[];
    v_keys      text[];
    v_bad_keys  text[];
    v_cols      text;
    v_deleted   integer;
    v_inserted  integer;
BEGIN
    -- 1. Shape of the arguments.
    IF p_dates IS NULL OR cardinality(p_dates) = 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_dates is empty'
            USING ERRCODE = '22023';
    END IF;
    IF array_position(p_dates, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_dates contains NULL'
            USING ERRCODE = '22023';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_rows must be a JSON array'
            USING ERRCODE = '22023';
    END IF;
    v_n_rows := jsonb_array_length(p_rows);
    IF v_n_rows = 0 THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_rows is empty; refusing to clear % date(s) with nothing to put back', cardinality(p_dates)
            USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE jsonb_typeof(e.elem) <> 'object') THEN
        RAISE EXCEPTION 'replace_cronometer_servings: every element of p_rows must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    -- 2. The dates to clear must be exactly the dates the new rows cover.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS e(elem)
               WHERE NULLIF(e.elem ->> 'calendar_date', '') IS NULL) THEN
        RAISE EXCEPTION 'replace_cronometer_servings: a row has no calendar_date'
            USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(DISTINCT (e.elem ->> 'calendar_date')::date ORDER BY (e.elem ->> 'calendar_date')::date)
      INTO v_row_dates
      FROM jsonb_array_elements(p_rows) AS e(elem);
    SELECT array_agg(DISTINCT d ORDER BY d) INTO v_arg_dates FROM unnest(p_dates) AS u(d);
    IF v_row_dates IS DISTINCT FROM v_arg_dates THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_dates (% date(s)) is not the set of calendar_date values in p_rows (% date(s))',
            cardinality(v_arg_dates), cardinality(v_row_dates)
            USING ERRCODE = '22023';
    END IF;

    -- 3. Keys must be real, writable columns.
    SELECT array_agg(DISTINCT k.key ORDER BY k.key) INTO v_keys
      FROM jsonb_array_elements(p_rows) AS e(elem),
           LATERAL jsonb_object_keys(e.elem) AS k(key);
    SELECT array_agg(key ORDER BY key) INTO v_bad_keys
      FROM unnest(v_keys) AS u(key)
     WHERE u.key IN ('serving_id', 'synced_at')
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                        WHERE a.attrelid = 'pds.cronometer_servings'::regclass
                          AND a.attnum > 0 AND NOT a.attisdropped
                          AND a.attname = u.key);
    IF v_bad_keys IS NOT NULL THEN
        RAISE EXCEPTION 'replace_cronometer_servings: p_rows has keys that are not writable columns of pds.cronometer_servings: %', v_bad_keys
            USING ERRCODE = '22023';
    END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'pds.cronometer_servings'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = ANY (v_keys);

    -- 4. One import at a time (released when this transaction ends).
    PERFORM pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'));

    -- 5. Replace. Both statements are in the caller's single transaction.
    DELETE FROM pds.cronometer_servings WHERE calendar_date = ANY (p_dates);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    EXECUTE format(
        'INSERT INTO pds.cronometer_servings (%s) SELECT %s FROM jsonb_populate_recordset(NULL::pds.cronometer_servings, $1)',
        v_cols, v_cols)
      USING p_rows;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted <> v_n_rows THEN
        RAISE EXCEPTION 'replace_cronometer_servings: inserted % row(s) but % were sent; nothing was changed', v_inserted, v_n_rows;
    END IF;

    RETURN jsonb_build_object('dates', cardinality(v_arg_dates),
                              'deleted', v_deleted,
                              'inserted', v_inserted);
END;
$function$;

COMMENT ON FUNCTION pds.replace_cronometer_servings(date[], jsonb) IS
    'Atomically replaces pds.cronometer_servings rows for the given calendar dates with p_rows (one transaction). Used by cronometer_import.py. service_role only.';

REVOKE ALL ON FUNCTION pds.replace_cronometer_servings(date[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.replace_cronometer_servings(date[], jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.replace_cronometer_servings(date[], jsonb) TO service_role;
