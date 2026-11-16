-- ============================================================================
-- ROLLBACK for sql/pds_matview_revoke_authenticated.sql (SEC-01-B phase 2)
-- ============================================================================
-- Gives authenticated back exactly what it had before the revoke: SELECT on
-- the six pds matviews below. Never anon, never PUBLIC (neither had a grant),
-- never more than SELECT, and nothing on any other relation.
--
-- This REOPENS the direct Data API read: a matview has no row security, so any
-- signed-in account could read every row again. The browser does not need it
-- (it reads through GET /api/derived/<name>, service role, owner session), so
-- prefer fixing the caller: add a facade read in lib/derived-reads.ts, or read
-- on the server with the service role, or turn the affected panel off for a
-- moment. Use this file only while something that cannot use the facade is
-- broken, then apply the revoke again once it is moved.
--
-- Safe to re-run. Contains no statement that removes an object.
-- ============================================================================

DO $rollback$
DECLARE
    expected constant text[] := ARRAY[
        'daily_health_matrix_behavioral_mat',
        'hrv_prediction_gaps_mat',
        'hrv_residuals_mat',
        'recovery_vs_pace_mat',
        'spotify_daily_signature_mat',
        'tz_log_gaps_mat'
    ];
    mat_name text;
    rel oid;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    FOREACH mat_name IN ARRAY expected LOOP
        SELECT c.oid INTO rel
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pds' AND c.relname = mat_name AND c.relkind = 'm';
        IF rel IS NULL THEN
            RAISE EXCEPTION 'pds.% is not a materialized view here; review before applying', mat_name;
        END IF;
    END LOOP;
    FOREACH mat_name IN ARRAY expected LOOP
        EXECUTE format('GRANT SELECT ON TABLE pds.%I TO authenticated', mat_name);
    END LOOP;
END
$rollback$;
