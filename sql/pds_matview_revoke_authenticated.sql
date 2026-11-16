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
-- sql/checks/verify_matview_revoke.sql.
--
-- There is deliberately no rollback that grants a browser role again: a grant
-- on a matview shows every row to every signed-in account. Recovery keeps the
-- grants revoked: a caller that still reads a *_mat with the browser session
-- (it now gets 42501) moves to a GET /api/derived/<name> read in
-- lib/derived-reads.ts or a service-role server read, or its panel is turned
-- off until it is moved. If service_role ever lost SELECT (a recreate that
-- skipped the recipe below), GRANT SELECT ON pds.<name>_mat TO service_role
-- restores the facade without opening anything to anon / authenticated.
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
-- successful run changes nothing and passes; the reachability checks (step 3)
-- run over all six on every run, not only over those that still carry a
-- grant. A check that fails means the database is not what was reviewed: stop
-- and review, never add a grant or skip the check to make it pass.
--
-- Boundary of the reachability check (step 3): the graph follows what the
-- catalog records and what function source text names. A function that builds
-- its SQL at run time (EXECUTE, query_to_xml and the like) or is written in
-- another language can read a matview without either. Step 3d therefore fails
-- closed on every SECURITY DEFINER function that browser roles can reach and
-- whose own or callees' SQL the graph cannot read, unless that function and
-- everything it calls is on the reviewed_opaque list with an unchanged hash.
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
    -- Step 3d: SECURITY DEFINER functions with SQL the graph cannot read that were
    -- reviewed by hand, as '<schema>.<name>(<args>)=<md5 of the function and
    -- everything it calls>' (the hash is the closure_md5 of step 3d, so any
    -- change to the body, language, definer flag or a callee fails the check
    -- again). Reviewed 2026-11-16 (SEC01B-R3): Supabase's event-trigger function
    -- that enables row security on tables created in schema public; it reads no
    -- table and never runs for a Data API caller.
    reviewed_opaque constant text[] := ARRAY[
        'public.rls_auto_enable()=979445ae8414446737e577d80ba23b8c'
    ];
    mat_name text;
    rel oid;
    six oid[] := '{}'::oid[];
    targets oid[];
    reach_rels oid[];
    reach_fns oid[];
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
        six := six || rel;
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

    -- 3. Nothing a browser role can reach may read the six in their place, however
    --    indirectly. The graph starts from all six on every run (a re-run, when no
    --    direct grant is left, checks the same graph) and follows, transitively:
    --    views and matviews whose query uses a node (a private definer view over a
    --    matview, then a readable view over that, is two hops); functions whose
    --    SQL-standard body depends on a node or on a matview's row type; functions
    --    whose source text names a node (plpgsql records no dependency). Each
    --    function found is a node too, so a view over it, or a function calling
    --    it, is followed in turn.
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

    -- 3a. No relation in the graph (other than the six) that anon or authenticated
    --     can read, on the table or on a single column: a definer view would keep
    --     showing every row, an invoker view would break for the owner.
    SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY c.oid::regclass::text)
    INTO blocker
    FROM pg_class c
    WHERE c.oid = ANY (reach_rels) AND NOT c.oid = ANY (six)
      AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('authenticated', c.oid, 'SELECT')
           OR has_any_column_privilege('anon', c.oid, 'SELECT')
           OR has_any_column_privilege('authenticated', c.oid, 'SELECT'));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A browser-readable relation reads a matview, directly or through other objects (%); move it first', blocker;
    END IF;

    -- 3b. No row-security policy that uses a relation or a function of the graph.
    SELECT string_agg(DISTINCT format('policy %s on %s', p.polname, p.polrelid::regclass), '; ')
    INTO blocker
    FROM pg_policy p
    JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
    WHERE (d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY (reach_rels))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (reach_fns));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A row-security policy reads a matview, directly or through other objects (%); move it first', blocker;
    END IF;

    -- 3c. No function of the graph that anon or authenticated may call, that is a
    --     trigger or event-trigger function, or that anything other than a view, a
    --     policy or another function uses (a default, a constraint, an index, a
    --     cast, an operator ...: not reviewed, so not allowed). A refresh function
    --     passes only while no browser role may call it.
    SELECT string_agg(DISTINCT p.oid::regprocedure::text, '; ')
    INTO blocker
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
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A function browser roles can reach reads a matview, directly or through other objects (%); move it first', blocker;
    END IF;

    -- 3d. What the graph cannot see. A function that builds its SQL at run time
    --     (EXECUTE, or query_to_xml / table_to_xml / ts_stat / dblink and the
    --     like) or is written in a language other than sql / plpgsql can read a
    --     matview without naming it ('pds.' || 'hrv_' || 'residuals_mat' is in no
    --     catalog entry and in no source text). Only a SECURITY DEFINER function
    --     whose owner can read a relation of the graph turns that into a leak:
    --     anything else runs as its caller, which the revoke refuses. So for each
    --     such definer function the check takes it plus everything it calls
    --     (functions its source names or its SQL body depends on, transitively:
    --     they run as its owner too). If any of them is opaque, it aborts unless
    --     the function is unreachable by browser roles (no anon / authenticated
    --     EXECUTE, no trigger or event trigger, no object that uses it, no
    --     function source that names it) or the whole closure matches an entry of
    --     reviewed_opaque. Fail closed: it may stop on a harmless function; then
    --     review that function and add its entry, never loosen the rule.
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
    INTO blocker
    FROM roots r JOIN fn f ON f.oid = r.root
    WHERE r.opaque
      AND NOT (f.sig || '=' || r.closure_md5) = ANY (reviewed_opaque)
      AND (has_function_privilege('anon', r.root, 'EXECUTE')
           OR has_function_privilege('authenticated', r.root, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = r.root)
           OR EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtfoid = r.root)
           OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = r.root)
           OR EXISTS (SELECT 1 FROM fn o WHERE o.oid <> r.root AND o.src ~ ('\m' || f.proname || '\M')));
    IF blocker IS NOT NULL THEN
        RAISE EXCEPTION 'A SECURITY DEFINER function browser roles can reach runs SQL the graph cannot read (%); review it, then make it unreachable or add it to reviewed_opaque', blocker;
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

    RAISE NOTICE 'pds matviews revoked from browser roles: % (0 = already done); graph checked: % relations, % functions',
        cardinality(targets), cardinality(reach_rels), cardinality(reach_fns);
END
$migration$;
