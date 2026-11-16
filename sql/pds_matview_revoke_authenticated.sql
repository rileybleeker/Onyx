-- ============================================================================
-- pds materialized views: service role only (SEC-01-B phase 2, 2026-11-16)
-- ============================================================================
-- Postgres has no row security on a materialized view, so the authenticated
-- SELECT grant on a pds *_mat let ANY signed-in account read every row of it
-- through the Data API (the base tables answer only the owner, through
-- owner_read). Phase 1 (#360, lib/derived-reads.ts) moved every browser read of
-- a matview behind GET /api/derived/<name>, which runs on the server with the
-- service role behind the owner-only middleware. This migration takes the
-- direct grant away, so the Data API refuses a matview to every caller except
-- service_role (and the postgres owner, which refreshes them).
--
-- Apply ONLY after the facade is deployed and the browser is confirmed to read
-- no *_mat directly (docs/owner-view-access.md). Then run
-- sql/checks/verify_matview_revoke.sql. Rollback (reopens the direct read; use
-- only while something that cannot use the facade is broken):
-- sql/pds_matview_revoke_authenticated_rollback.sql.
--
-- What it changes: REVOKE ALL ... FROM PUBLIC, anon, authenticated on each of
-- the six matviews below that still carries such a grant (today:
-- authenticated=r; anon and PUBLIC already have none). Nothing else: no data,
-- no definitions, no indexes, no refresh functions, no service_role privilege,
-- no default privileges. REFRESH ... CONCURRENTLY runs as the owner inside the
-- SECURITY DEFINER refresh functions and keeps working.
--
-- One DO statement, so it is atomic: every check runs before the first REVOKE,
-- and a failed check after it undoes the whole statement. Re-running after a
-- successful run changes nothing and passes. A check that fails means the
-- database is not what was reviewed: stop and review, never add a grant or
-- skip the check to make it pass.
--
-- Recreating one of these matviews later: the pds default privileges
-- (sql/rls_policies.sql) give authenticated SELECT on every new relation, so a
-- recreate recipe must end with
--   REVOKE ALL ON pds.<name>_mat FROM PUBLIC, anon, authenticated;
--   GRANT SELECT ON pds.<name>_mat TO service_role;
-- (sql/perf_matrix_matview.sql, sql/perf_tier2_matviews.sql), and PART 1 of
-- sql/pds_owner_only_read.sql skips matviews.
--
-- Contains no statement that removes an object (the Supabase MCP connector
-- refuses migrations that do).
-- ============================================================================

DO $migration$
DECLARE
    expected constant text[] := ARRAY[
        'daily_health_matrix_behavioral_mat',
        'hrv_prediction_gaps_mat',
        'hrv_residuals_mat',
        'recovery_vs_pace_mat',
        'spotify_daily_signature_mat',
        'tz_log_gaps_mat'
    ];
    browser_roles constant oid[] := ARRAY[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid];  -- 0 = PUBLIC
    mat_name text;
    rel oid;
    targets oid[];
    unexpected text;
    blocker text;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    -- 1. The six exist as pds materialized views, service_role can read each, and
    --    each keeps the unique non-partial index REFRESH ... CONCURRENTLY needs.
    FOREACH mat_name IN ARRAY expected LOOP
        SELECT c.oid INTO rel
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pds' AND c.relname = mat_name AND c.relkind = 'm';
        IF rel IS NULL THEN
            RAISE EXCEPTION 'pds.% is not a materialized view here; review before applying', mat_name;
        END IF;
        IF NOT has_table_privilege('service_role', rel, 'SELECT') THEN
            RAISE EXCEPTION 'service_role cannot read pds.%; the facade would break; review before applying', mat_name;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_index i
                       WHERE i.indrelid = rel AND i.indisunique AND i.indpred IS NULL) THEN
            RAISE EXCEPTION 'pds.% has no unique non-partial index; review before applying', mat_name;
        END IF;
    END LOOP;

    -- 2. Every pds matview a browser role can still use, on the table or on a
    --    column. Only the reviewed six may be on that list.
    SELECT coalesce(array_agg(c.oid ORDER BY c.relname), '{}'::oid[]),
           string_agg(c.relname, ', ' ORDER BY c.relname) FILTER (WHERE NOT c.relname = ANY (expected))
    INTO targets, unexpected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND c.relkind = 'm'
      AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = ANY (browser_roles))
           OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                      WHERE att.attrelid = c.oid AND att.attnum > 0 AND a.grantee = ANY (browser_roles)));
    IF unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'Unreviewed pds matview readable by a browser role: %; review before applying', unexpected;
    END IF;

    -- 3. Nothing a browser role can reach may read these matviews in its place:
    --    a view or matview over one (an invoker view would break for the owner, a
    --    definer view would keep exposing every row), a row-security policy that
    --    queries one, or a function naming one that anon / authenticated may call
    --    or that a trigger runs with the caller's rights.
    SELECT string_agg(DISTINCT format('%s <- %s', m.oid::regclass, dc.oid::regclass), '; ')
    INTO blocker
    FROM pg_class m
    JOIN pg_depend d ON d.refobjid = m.oid AND d.refclassid = 'pg_class'::regclass
                    AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_rewrite w ON w.oid = d.objid
    JOIN pg_class dc ON dc.oid = w.ev_class
    WHERE m.oid = ANY (targets) AND dc.oid <> m.oid
      AND (has_table_privilege('anon', dc.oid, 'SELECT')
           OR has_table_privilege('authenticated', dc.oid, 'SELECT'));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A browser-readable relation reads a matview (%); move it first', blocker;
    END IF;

    SELECT string_agg(DISTINCT format('%s <- policy %s on %s', m.oid::regclass, p.polname, p.polrelid::regclass), '; ')
    INTO blocker
    FROM pg_class m
    JOIN pg_depend d ON d.refobjid = m.oid AND d.refclassid = 'pg_class'::regclass
                    AND d.classid = 'pg_policy'::regclass
    JOIN pg_policy p ON p.oid = d.objid
    WHERE m.oid = ANY (targets);
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A row-security policy reads a matview (%); move it first', blocker;
    END IF;

    SELECT string_agg(DISTINCT format('%s <- %s', m.oid::regclass, p.oid::regprocedure), '; ')
    INTO blocker
    FROM pg_class m
    JOIN pg_proc p ON p.prosrc ~ ('\m' || m.relname || '\M')
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE m.oid = ANY (targets)
      AND pn.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR (NOT p.prosecdef AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A function browser roles can reach reads a matview (%); move it first', blocker;
    END IF;

    -- 4. Revoke. Table-level REVOKE also takes away any column privileges.
    FOREACH rel IN ARRAY targets LOOP
        EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated', rel::regclass);
    END LOOP;

    -- 5. After: no pds matview is usable by anon or authenticated, and the six are
    --    still readable by service_role. Anything else undoes the statement.
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO blocker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND c.relkind = 'm'
      AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('authenticated', c.oid, 'SELECT')
           OR has_any_column_privilege('anon', c.oid, 'SELECT')
           OR has_any_column_privilege('authenticated', c.oid, 'SELECT'));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'Still readable by a browser role after the revocation: %', blocker;
    END IF;
    FOREACH mat_name IN ARRAY expected LOOP
        IF NOT has_table_privilege('service_role', format('pds.%I', mat_name)::regclass, 'SELECT') THEN
            RAISE EXCEPTION 'service_role lost SELECT on pds.%', mat_name;
        END IF;
    END LOOP;

    RAISE NOTICE 'pds matviews revoked from browser roles: % (0 = already done)', cardinality(targets);
END
$migration$;
