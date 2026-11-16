-- Behaviour check for sql/supplement_stack_atomic_save.sql (audit PROD-07).
--
-- SUPABASE BRANCH OR LOCAL POSTGRES ONLY. NEVER RUN THIS ON PRODUCTION. It inserts synthetic products and stacks and
-- adds a temporary trigger (DDL) to pds.supplement_stack_item, which locks that table until the end of the
-- transaction. Everything happens in ONE transaction that ends in ROLLBACK, but that is still a synthetic stack and DDL
-- on the table, which production must not see. The guard at the top refuses to run on a database that holds any
-- stack. On production run the read-only sql/checks/verify_supplement_stack_atomic_save.sql instead.
--
-- Run after the file is applied to the branch, with privileged SQL access. The answer is one JSON object of booleans.
-- The two-session concurrent-create check is sql/checks/race_supplement_stack_create_branch.sql.
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $check$
DECLARE
    initial_role text := current_user;
    k1   constant uuid := '00000000-0000-4000-8000-00000000c001';
    s1   constant uuid := '00000000-0000-4000-8000-00000000c101';
    s2   constant uuid := '00000000-0000-4000-8000-00000000c102';
    s3   constant uuid := '00000000-0000-4000-8000-00000000c103';
    s4   constant uuid := '00000000-0000-4000-8000-00000000c104';
    s5   constant uuid := '00000000-0000-4000-8000-00000000c105';
    s6   constant uuid := '00000000-0000-4000-8000-00000000c106';
    s7   constant uuid := '00000000-0000-4000-8000-00000000c107';
    nm   constant text := 'zz synthetic stack check';
    two  constant jsonb := '[{"product_id":"zz-synthetic-check-a","doses":1},{"product_id":"zz-synthetic-check-b","doses":2}]';
    r    jsonb;
    sid  bigint;
    v    bigint;
    items text;
BEGIN
    -- Guard: a database with real stacks is not a branch made for this check.
    IF EXISTS (SELECT 1 FROM pds.supplement_stack) OR EXISTS (SELECT 1 FROM pds.supplement_stack_item) THEN
        RAISE EXCEPTION 'refusing to run: this database holds supplement stacks. Run this only on a Supabase branch or a local copy without real data (production: verify_supplement_stack_atomic_save.sql).';
    END IF;

    -- 0. Shape: invoker function, service role only, version column + trigger in place.
    IF (SELECT prosecdef FROM pg_proc WHERE oid = 'pds.save_supplement_stack(bigint,uuid,bigint,uuid,jsonb,jsonb,jsonb)'::regprocedure) THEN
        RAISE EXCEPTION 'save_supplement_stack is SECURITY DEFINER';
    END IF;
    IF has_function_privilege('anon', 'pds.save_supplement_stack(bigint,uuid,bigint,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'pds.save_supplement_stack(bigint,uuid,bigint,uuid,jsonb,jsonb,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon or authenticated may call save_supplement_stack';
    END IF;
    IF NOT has_function_privilege('service_role', 'pds.save_supplement_stack(bigint,uuid,bigint,uuid,jsonb,jsonb,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role cannot call save_supplement_stack';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'supplement_stack_version' AND tgrelid = 'pds.supplement_stack'::regclass) THEN
        RAISE EXCEPTION 'version trigger missing';
    END IF;

    INSERT INTO pds.supplement_products (product_id, ingredients) VALUES
        ('zz-synthetic-check-a', '[]'), ('zz-synthetic-check-b', '[]'), ('zz-synthetic-check-c', '[]');

    EXECUTE 'SET LOCAL ROLE service_role';

    -- 1. Create with a client key: header + items in one call.
    r := pds.save_supplement_stack(NULL, k1, NULL, s1, '[]', jsonb_build_object('name', nm, 'description', NULL, 'remind_time', NULL), two);
    sid := (r ->> 'stack_id')::bigint;
    IF NOT (r ->> 'created')::boolean OR (r ->> 'version')::bigint <> 1 OR (r ->> 'item_count')::int <> 2 THEN
        RAISE EXCEPTION 'create: %', r - 'name';
    END IF;

    -- 2. The same create resent (lost answer): same stack, nothing written.
    r := pds.save_supplement_stack(NULL, k1, NULL, s1, '[]', jsonb_build_object('name', nm), two);
    IF (r ->> 'stack_id')::bigint <> sid OR NOT (r ->> 'replayed')::boolean OR (r ->> 'version')::bigint <> 1 THEN
        RAISE EXCEPTION 'create replay';
    END IF;
    IF (SELECT count(*) FROM pds.supplement_stack WHERE client_key = k1) <> 1 THEN RAISE EXCEPTION 'second stack for one key'; END IF;

    -- 3. Update at the current version replaces the complete list.
    r := pds.save_supplement_stack(sid, NULL, 1, s2, '[]', '{}', '[{"product_id":"zz-synthetic-check-c","doses":3}]');
    IF (r ->> 'version')::bigint <> 2 OR (r ->> 'item_count')::int <> 1 THEN RAISE EXCEPTION 'update'; END IF;

    -- 4. A stale editor (version 1, not its own write) is refused and changes nothing.
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 1, s3, '[]', '{}', two);
        RAISE EXCEPTION 'stale save was accepted';
    EXCEPTION WHEN SQLSTATE 'OXS01' THEN NULL;
    END;
    SELECT version INTO v FROM pds.supplement_stack WHERE stack_id = sid;
    SELECT string_agg(product_id || ':' || doses, ',' ORDER BY sort_order) INTO items FROM pds.supplement_stack_item WHERE stack_id = sid;
    IF v <> 2 OR items <> 'zz-synthetic-check-c:3' THEN RAISE EXCEPTION 'stale save changed the stack'; END IF;

    -- 5. Same editor after a lost answer (its last save s2 is in after_save_ids): accepted.
    r := pds.save_supplement_stack(sid, NULL, 1, s4, jsonb_build_array(s2), '{}', two);
    IF (r ->> 'version')::bigint <> 3 OR (r ->> 'item_count')::int <> 2 THEN RAISE EXCEPTION 'own-chain save'; END IF;

    -- 5b. A page that is out of date: an update without a version and a retried create without a save id are
    --     refused with OXS05; an exact resend of the last save (same save id) is still a replay.
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, NULL, '00000000-0000-4000-8000-00000000c111', '[]', '{}', '[]');
        RAISE EXCEPTION 'update without a version accepted';
    EXCEPTION WHEN SQLSTATE 'OXS05' THEN NULL;
    END;
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, NULL, NULL, '[]', '{}', '[]');
        RAISE EXCEPTION 'update without a version or save id accepted';
    EXCEPTION WHEN SQLSTATE 'OXS05' THEN NULL;
    END;
    BEGIN
        PERFORM pds.save_supplement_stack(NULL, k1, NULL, NULL, '[]', jsonb_build_object('name', nm), '[]');
        RAISE EXCEPTION 'adoption without a save id accepted';
    EXCEPTION WHEN SQLSTATE 'OXS05' THEN NULL;
    END;
    r := pds.save_supplement_stack(sid, NULL, NULL, s4, '[]', '{}', two);
    IF NOT (r ->> 'replayed')::boolean OR (r ->> 'version')::bigint <> 3 THEN RAISE EXCEPTION 'replay without a version'; END IF;
    SELECT version INTO v FROM pds.supplement_stack WHERE stack_id = sid;
    IF v <> 3 OR (SELECT count(*) FROM pds.supplement_stack_item WHERE stack_id = sid) <> 2 THEN
        RAISE EXCEPTION 'an out-of-date page changed the stack';
    END IF;

    -- 6. Malformed items and an unknown product: refused, nothing changes.
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 3, s5, '[]', '{}', '"not a list"');
        RAISE EXCEPTION 'malformed items accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 3, s5, '[]', '{}', '[{"product_id":"zz-synthetic-check-a","doses":1},{"product_id":"zz-synthetic-check-a","doses":1}]');
        RAISE EXCEPTION 'duplicate product accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 3, s5, '[]', jsonb_build_object('name', 'zz renamed'), '[{"product_id":"zz-synthetic-check-missing","doses":1}]');
        RAISE EXCEPTION 'unknown product accepted';
    EXCEPTION WHEN SQLSTATE 'OXS02' THEN NULL;
    END;
    SELECT version INTO v FROM pds.supplement_stack WHERE stack_id = sid;
    IF v <> 3 OR (SELECT name FROM pds.supplement_stack WHERE stack_id = sid) <> nm
       OR (SELECT count(*) FROM pds.supplement_stack_item WHERE stack_id = sid) <> 2 THEN
        RAISE EXCEPTION 'a refused save changed the stack';
    END IF;

    -- 7. A header-only save (items NULL) leaves the items.
    r := pds.save_supplement_stack(sid, NULL, 3, s5, '[]', '{"remind_time":"08:30"}', NULL);
    IF (r ->> 'item_count')::int <> 2 OR (r ->> 'remind_time') <> '08:30' THEN RAISE EXCEPTION 'header-only save'; END IF;

    -- 8. An explicitly empty list clears the stack on purpose.
    r := pds.save_supplement_stack(sid, NULL, 4, s6, '[]', '{}', '[]');
    IF (r ->> 'item_count')::int <> 0 THEN RAISE EXCEPTION 'empty list did not clear'; END IF;
    r := pds.save_supplement_stack(sid, NULL, 5, s7, '[]', '{}', two);

    -- 9. A failure after the old items were cleared rolls the whole save back (header included).
    EXECUTE format('SET LOCAL ROLE %I', initial_role);
    CREATE FUNCTION pds.zz_check_fail_stack_item() RETURNS trigger LANGUAGE plpgsql AS
        $f$ BEGIN IF NEW.product_id = 'zz-synthetic-check-c' THEN RAISE EXCEPTION 'synthetic failure' USING ERRCODE = 'P0099'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER zz_check_fail_stack_item BEFORE INSERT ON pds.supplement_stack_item FOR EACH ROW EXECUTE FUNCTION pds.zz_check_fail_stack_item();
    EXECUTE 'SET LOCAL ROLE service_role';
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 6, '00000000-0000-4000-8000-00000000c108', '[]',
            jsonb_build_object('name', 'zz should not stick'), '[{"product_id":"zz-synthetic-check-c","doses":1}]');
        RAISE EXCEPTION 'failing save was accepted';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
    END;
    SELECT version INTO v FROM pds.supplement_stack WHERE stack_id = sid;
    SELECT string_agg(product_id || ':' || doses, ',' ORDER BY sort_order) INTO items FROM pds.supplement_stack_item WHERE stack_id = sid;
    IF v <> 6 OR items <> 'zz-synthetic-check-a:1,zz-synthetic-check-b:2'
       OR (SELECT name FROM pds.supplement_stack WHERE stack_id = sid) <> nm THEN
        RAISE EXCEPTION 'failed save left a partial stack';
    END IF;

    -- 10. Another stack with the same active name is refused.
    BEGIN
        PERFORM pds.save_supplement_stack(NULL, '00000000-0000-4000-8000-00000000c002', NULL, '00000000-0000-4000-8000-00000000c109', '[]',
            jsonb_build_object('name', upper(nm)), '[]');
        RAISE EXCEPTION 'duplicate active name accepted';
    EXCEPTION WHEN SQLSTATE 'OXS04' THEN NULL;
    END;

    -- 11. An update from any other path (the archive route) raises the version and forgets the save id.
    UPDATE pds.supplement_stack SET is_active = false, updated_at = now() WHERE stack_id = sid;
    IF (SELECT version FROM pds.supplement_stack WHERE stack_id = sid) <> 7
       OR (SELECT last_save_id FROM pds.supplement_stack WHERE stack_id = sid) IS NOT NULL THEN
        RAISE EXCEPTION 'archive did not bump the version';
    END IF;
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, 6, '00000000-0000-4000-8000-00000000c110', jsonb_build_array(s7), '{}', '[]');
        RAISE EXCEPTION 'save after archive accepted as own';
    EXCEPTION WHEN SQLSTATE 'OXS01' THEN NULL;
    END;

    -- 12. authenticated cannot call it.
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
        PERFORM pds.save_supplement_stack(sid, NULL, NULL, NULL, '[]', '{}', NULL);
        RAISE EXCEPTION 'authenticated could call save_supplement_stack';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE format('SET LOCAL ROLE %I', initial_role);

    IF (SELECT count(*) FROM pds.supplement_stack) <> 1 THEN RAISE EXCEPTION 'a check left a second stack'; END IF;

    PERFORM set_config('onyx.stack_save_verification', jsonb_build_object(
        'invoker_service_role_only', true, 'create_and_replay', true, 'version_check', true, 'own_chain_after_lost_answer', true,
        'out_of_date_page_refused', true, 'malformed_and_unknown_refused', true, 'header_only_keeps_items', true, 'empty_list_clears', true,
        'failure_rolls_back_header_and_items', true, 'active_name_unique', true, 'other_updates_bump_version', true,
        'one_stack_only', true)::text, true);
END
$check$;
SELECT current_setting('onyx.stack_save_verification')::jsonb AS verification;
ROLLBACK;
