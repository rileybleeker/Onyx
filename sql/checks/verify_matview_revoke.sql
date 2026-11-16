-- Run only AFTER sql/pds_matview_revoke_authenticated.sql is merged and applied, using privileged
-- SQL access (SEC-01-B phase 2). Read-only: no records, schemas, users or grants are written, and the
-- session role and claims roll back. Returns pass counts and booleans only, never a row of data.
--
-- Checks, for each of the six pds matviews:
--   - anon, authenticated and PUBLIC hold no privilege on it (table or column);
--   - a Data API caller with role authenticated is refused (SQLSTATE 42501), both with the owner's
--     claims and with a synthetic other account's claims: the owner reads through the server facade
--     GET /api/derived/<name>, never directly;
--   - service_role still reads it, and its unique non-partial index (needed by REFRESH ... CONCURRENTLY)
--     is still there;
-- and that no other pds matview is readable by anon or authenticated.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '45s';
DO $check$
DECLARE
    mat_names constant text[] := ARRAY['pds.daily_health_matrix_behavioral_mat','pds.hrv_prediction_gaps_mat','pds.hrv_residuals_mat','pds.recovery_vs_pace_mat','pds.spotify_daily_signature_mat','pds.tz_log_gaps_mat'];
    owner_id uuid;
    initial_role text := current_user;
    relation_name text;
    subject text;
    readable boolean;
    leaked text;
    grant_checks integer := 0;
    denied_probes integer := 0;
    service_checks integer := 0;
BEGIN
    SELECT substring(qual from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid
    INTO owner_id FROM pg_policies
    WHERE schemaname='pds' AND tablename='habit_journal' AND policyname='owner_read';
    IF owner_id IS NULL OR owner_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
        RAISE EXCEPTION 'Owner policy must identify a distinct configured owner';
    END IF;

    FOREACH relation_name IN ARRAY mat_names LOOP
        IF (SELECT relkind FROM pg_class WHERE oid = relation_name::regclass) <> 'm' THEN
            RAISE EXCEPTION 'Not a materialized view: %', relation_name;
        END IF;
        IF has_table_privilege('anon', relation_name::regclass, 'SELECT')
           OR has_table_privilege('authenticated', relation_name::regclass, 'SELECT')
           OR has_any_column_privilege('anon', relation_name::regclass, 'SELECT')
           OR has_any_column_privilege('authenticated', relation_name::regclass, 'SELECT')
           OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                      WHERE c.oid = relation_name::regclass AND a.grantee = 0::oid) THEN
            RAISE EXCEPTION 'Browser role still holds a privilege on %', relation_name;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = relation_name::regclass
                       AND i.indisunique AND i.indpred IS NULL) THEN
            RAISE EXCEPTION 'Unique non-partial index missing on %', relation_name;
        END IF;
        grant_checks := grant_checks + 1;
    END LOOP;

    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO leaked
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND c.relkind = 'm'
      AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT'));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Other pds matviews readable by a browser role: %', leaked;
    END IF;

    -- The owner and a synthetic other account, each as a Data API caller (role authenticated).
    EXECUTE 'SET LOCAL ROLE authenticated';
    FOREACH subject IN ARRAY ARRAY[owner_id::text, '00000000-0000-0000-0000-000000000001'] LOOP
        PERFORM set_config('request.jwt.claim.sub', subject, true);
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',subject,'role','authenticated')::text, true);
        FOREACH relation_name IN ARRAY mat_names LOOP
            readable := true;
            BEGIN
                EXECUTE format('SELECT 1 FROM %s LIMIT 0', relation_name::regclass);
            EXCEPTION WHEN insufficient_privilege THEN
                readable := false;
            END;
            IF readable THEN
                RAISE EXCEPTION 'Role authenticated can still read %', relation_name;
            END IF;
            denied_probes := denied_probes + 1;
        END LOOP;
    END LOOP;

    EXECUTE 'SET LOCAL ROLE service_role';
    FOREACH relation_name IN ARRAY mat_names LOOP
        EXECUTE format('SELECT * FROM %s LIMIT 0', relation_name::regclass);
        service_checks := service_checks + 1;
    END LOOP;
    EXECUTE format('SET LOCAL ROLE %I', initial_role);
    PERFORM set_config('onyx.matview_revoke_verification', jsonb_build_object(
        'matviews_without_browser_grants', grant_checks,
        'authenticated_probes_denied', denied_probes,
        'service_role_reads', service_checks,
        'other_pds_matviews_closed', true)::text, true);
END
$check$;
SELECT current_setting('onyx.matview_revoke_verification')::jsonb AS verification;
ROLLBACK;
