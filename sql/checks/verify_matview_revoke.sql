-- Run only AFTER sql/pds_matview_revoke_authenticated.sql is merged and applied, using privileged
-- SQL access (SEC-01-B phase 2). Read-only: no records, schemas, users or grants are written, and the
-- session role and claims roll back. Returns pass counts and booleans only, never a row of data.
--
-- Checks, for each of the six pds matviews:
--   - anon, authenticated and PUBLIC hold no privilege on it (table or column);
--   - a Data API caller with role authenticated is refused (SQLSTATE 42501), both with the owner's
--     claims and with a synthetic other account's claims: the owner reads through the server facade
--     GET /api/derived/<name>, never directly;
--   - service_role still reads it, it is populated, and its unique non-partial index (needed by
--     REFRESH ... CONCURRENTLY) is still there;
-- that nothing anon or authenticated can read or call reaches one of the six another way (the same
-- dependency graph as step 3 of the migration: views over views, functions naming them, views and
-- functions over those functions, policies), that no SECURITY DEFINER function a browser role can
-- reach runs SQL that graph cannot read (dynamic SQL, another language) unless it is on the reviewed
-- list (the migration's step 3d), and that no other pds matview is readable by anon or authenticated.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '45s';
DO $check$
DECLARE
    mat_names constant text[] := ARRAY['pds.daily_health_matrix_behavioral_mat','pds.hrv_prediction_gaps_mat','pds.hrv_residuals_mat','pds.recovery_vs_pace_mat','pds.spotify_daily_signature_mat','pds.tz_log_gaps_mat'];
    -- The same list as reviewed_opaque in the migration (keep the two equal):
    -- SECURITY DEFINER functions with SQL the graph cannot read that were
    -- reviewed by hand, as '<schema>.<name>(<args>)=<md5 of the function and
    -- everything it calls>' (closure_md5 of step 3d, so any change to the body,
    -- language, definer flag or a callee fails the check again). Reviewed 2026-11-16 (SEC01B-R3): Supabase's event-trigger function
    -- that enables row security on tables created in schema public; it reads no
    -- table and never runs for a Data API caller.
    reviewed_opaque constant text[] := ARRAY[
        'public.rls_auto_enable()=979445ae8414446737e577d80ba23b8c'
    ];
    owner_id uuid;
    initial_role text := current_user;
    relation_name text;
    subject text;
    readable boolean;
    leaked text;
    six oid[];
    reach_rels oid[];
    reach_fns oid[];
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
        IF NOT (SELECT c.relispopulated FROM pg_class c WHERE c.oid = relation_name::regclass) THEN
            RAISE EXCEPTION 'Not populated (the facade read would fail): %', relation_name;
        END IF;
        grant_checks := grant_checks + 1;
    END LOOP;

    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO leaked
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND c.relkind = 'm'
      AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT')
           OR has_any_column_privilege('anon', c.oid, 'SELECT')
           OR has_any_column_privilege('authenticated', c.oid, 'SELECT'));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Other pds matviews readable by a browser role: %', leaked;
    END IF;

    -- The dependency graph from the six, exactly as in step 3 of the migration.
    six := ARRAY(SELECT n::regclass::oid FROM unnest(mat_names) AS n);
    WITH RECURSIVE reach(cls, obj) AS (
        SELECT 'pg_class'::regclass::oid, r FROM unnest(six) AS r
      UNION
        SELECT nxt.cls, nxt.obj
        FROM reach cur
        CROSS JOIN LATERAL (
            SELECT 'pg_class'::regclass::oid AS cls, w.ev_class AS obj
            FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid
            WHERE d.classid = 'pg_rewrite'::regclass
              AND d.refclassid = cur.cls AND d.refobjid = cur.obj
              AND NOT (cur.cls = 'pg_class'::regclass AND w.ev_class = cur.obj)
          UNION
            SELECT 'pg_proc'::regclass::oid, d.objid
            FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass
              AND ((d.refclassid = cur.cls AND d.refobjid = cur.obj)
                   OR (cur.cls = 'pg_class'::regclass AND d.refclassid = 'pg_type'::regclass
                       AND d.refobjid = (SELECT c.reltype FROM pg_class c WHERE c.oid = cur.obj)))
          UNION
            SELECT 'pg_proc'::regclass::oid, p.oid
            FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace
            WHERE pn.nspname NOT IN ('pg_catalog', 'information_schema')
              AND NOT (cur.cls = 'pg_proc'::regclass AND p.oid = cur.obj)
              AND p.prosrc ~ ('\m' || CASE WHEN cur.cls = 'pg_class'::regclass
                                           THEN (SELECT c.relname FROM pg_class c WHERE c.oid = cur.obj)::text
                                           ELSE (SELECT q.proname FROM pg_proc q WHERE q.oid = cur.obj)::text
                                      END || '\M')
        ) nxt
    )
    SELECT coalesce(array_agg(obj) FILTER (WHERE cls = 'pg_class'::regclass), '{}'::oid[]),
           coalesce(array_agg(obj) FILTER (WHERE cls = 'pg_proc'::regclass), '{}'::oid[])
    INTO reach_rels, reach_fns
    FROM reach;

    SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY c.oid::regclass::text) INTO leaked
    FROM pg_class c
    WHERE c.oid = ANY (reach_rels) AND NOT c.oid = ANY (six)
      AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT')
           OR has_any_column_privilege('anon', c.oid, 'SELECT')
           OR has_any_column_privilege('authenticated', c.oid, 'SELECT'));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Browser-readable relation reaches a matview: %', leaked;
    END IF;
    SELECT string_agg(DISTINCT format('policy %s on %s', p.polname, p.polrelid::regclass), '; ') INTO leaked
    FROM pg_policy p
    JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
    WHERE (d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY (reach_rels))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (reach_fns));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Row-security policy reaches a matview: %', leaked;
    END IF;
    SELECT string_agg(DISTINCT p.oid::regprocedure::text, '; ') INTO leaked
    FROM pg_proc p
    WHERE p.oid = ANY (reach_fns)
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype)
           OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)
           OR EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtfoid = p.oid)
           OR EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
                        AND d.classid NOT IN ('pg_proc'::regclass, 'pg_rewrite'::regclass, 'pg_policy'::regclass)));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Function a browser role can reach reads a matview: %', leaked;
    END IF;

    -- Step 3d of the migration, word for word: no reachable SECURITY DEFINER function
    -- runs SQL the graph cannot read unless it was reviewed.
    WITH RECURSIVE fn AS (
        SELECT p.oid, p.proname, p.prosecdef, p.proowner, l.lanname,
               pn.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.prosrc || coalesce(pg_get_function_sqlbody(p.oid), '') AS src
        FROM pg_proc p
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE pn.nspname NOT IN ('pg_catalog', 'information_schema')
    ), priv AS (
        SELECT f.oid FROM fn f
        WHERE f.prosecdef
          AND EXISTS (SELECT 1 FROM unnest(reach_rels) AS g WHERE has_table_privilege(f.proowner, g, 'SELECT'))
    ), calls(root, fn) AS (
        SELECT oid, oid FROM priv
      UNION
        SELECT c.root, q.oid
        FROM calls c JOIN fn cur ON cur.oid = c.fn JOIN fn q ON q.oid <> cur.oid
        WHERE cur.src ~ ('\m' || q.proname || '\M')
           OR EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = cur.oid
                        AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = q.oid)
    ), roots AS (
        SELECT c.root,
               bool_or(q.lanname NOT IN ('sql', 'plpgsql')
                       OR q.src ~* '\mexecute\M'
                       OR q.src ~* '\m((query|cursor|table|schema|database)_to_xml|ts_stat|ts_rewrite|dblink)') AS opaque,
               md5(string_agg(q.sig || '|' || q.lanname || '|' || q.prosecdef::text || '|' || q.src,
                              E'\n' ORDER BY q.sig)) AS closure_md5
        FROM calls c JOIN fn q ON q.oid = c.fn
        GROUP BY c.root
    )
    SELECT string_agg(f.sig, '; ' ORDER BY f.sig)
    INTO leaked
    FROM roots r JOIN fn f ON f.oid = r.root
    WHERE r.opaque
      AND NOT (f.sig || '=' || r.closure_md5) = ANY (reviewed_opaque)
      AND (has_function_privilege('anon', r.root, 'EXECUTE')
           OR has_function_privilege('authenticated', r.root, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = r.root)
           OR EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtfoid = r.root)
           OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = r.root)
           OR EXISTS (SELECT 1 FROM fn o WHERE o.oid <> r.root AND o.src ~ ('\m' || f.proname || '\M')));
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION 'Unreviewed SECURITY DEFINER function a browser role can reach runs SQL the graph cannot read: %', leaked;
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
        'matviews_populated', grant_checks,
        'authenticated_probes_denied', denied_probes,
        'service_role_reads', service_checks,
        'graph_relations', cardinality(reach_rels),
        'graph_functions', cardinality(reach_fns),
        'graph_closed_to_browser_roles', true,
        'dynamic_sql_definers_reviewed', true,
        'other_pds_matviews_closed', true)::text, true);
END
$check$;
SELECT current_setting('onyx.matview_revoke_verification')::jsonb AS verification;
ROLLBACK;
