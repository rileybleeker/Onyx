-- Post-apply check for sql/supplement_stack_atomic_save.sql (audit PROD-07). SAFE TO RUN ON PRODUCTION.
--
-- One READ ONLY transaction: it reads the catalog and counts rows, nothing else. It writes nothing, creates nothing,
-- takes no lock beyond the shared one every SELECT takes, and prints no stack name, description or product (counts
-- only). Run it after applying the file and BEFORE merging the app change that calls the function: every flag must
-- be true, and stacks_bad_version must be 0.
--
-- The behaviour checks (rollback on failure, versions, replays, out-of-date pages, the concurrent create) insert
-- synthetic rows and add a temporary trigger, so they run on a Supabase branch or a local copy only:
-- sql/checks/verify_supplement_stack_atomic_save_branch.sql and sql/checks/race_supplement_stack_create_branch.sql.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH fn AS (
    SELECT p.oid, p.prosecdef, p.proacl, p.proconfig
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('pds.save_supplement_stack(bigint,uuid,bigint,uuid,jsonb,jsonb,jsonb)')
), trg AS (
    SELECT t.tgtype::int AS tgtype, t.tgenabled, t.tgfoid
      FROM pg_trigger t
     WHERE t.tgrelid = to_regclass('pds.supplement_stack')
       AND t.tgname = 'supplement_stack_version'
       AND NOT t.tgisinternal
), col AS (
    SELECT c.column_name, c.data_type, c.is_nullable, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'pds' AND c.table_name = 'supplement_stack'
       AND c.column_name IN ('version', 'last_save_id', 'client_key')
)
SELECT jsonb_build_object(
    'function_exists',        EXISTS (SELECT 1 FROM fn),
    'security_invoker',       COALESCE((SELECT NOT prosecdef FROM fn), false),
    'search_path_pinned',     COALESCE((SELECT EXISTS (SELECT 1 FROM unnest(proconfig) AS c WHERE c LIKE 'search_path=%') FROM fn), false),
    -- A NULL proacl means the default grant, which includes PUBLIC: that counts as not revoked.
    'public_cannot_execute',  COALESCE((SELECT proacl IS NOT NULL
                                               AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a
                                                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                          FROM fn), false),
    'anon_cannot_execute',          COALESCE((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') FROM fn), false),
    'authenticated_cannot_execute', COALESCE((SELECT NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM fn), false),
    'service_role_can_execute',     COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE') FROM fn), false),
    -- BEFORE UPDATE FOR EACH ROW (tgtype bits: 1 row, 2 before, 16 update), enabled, calling the bump function.
    'version_trigger',        EXISTS (SELECT 1 FROM trg
                                       WHERE (tgtype & 19) = 19 AND tgenabled <> 'D'
                                         AND tgfoid = to_regprocedure('pds.supplement_stack_bump_version()')),
    'version_column',         EXISTS (SELECT 1 FROM col WHERE column_name = 'version' AND data_type = 'bigint'
                                         AND is_nullable = 'NO' AND column_default = '1'),
    'last_save_id_column',    EXISTS (SELECT 1 FROM col WHERE column_name = 'last_save_id' AND data_type = 'uuid'),
    'client_key_column',      EXISTS (SELECT 1 FROM col WHERE column_name = 'client_key' AND data_type = 'uuid'),
    'client_key_unique_index', EXISTS (SELECT 1 FROM pg_indexes
                                        WHERE schemaname = 'pds' AND tablename = 'supplement_stack'
                                          AND indexname = 'supplement_stack_client_key_uniq'),
    'active_name_unique_index', EXISTS (SELECT 1 FROM pg_indexes
                                         WHERE schemaname = 'pds' AND tablename = 'supplement_stack'
                                           AND indexname = 'idx_supplement_stack_active_name'),
    -- Counts only. (These two read the new columns: an error here means the file was not applied.)
    'stacks_total',           (SELECT count(*) FROM pds.supplement_stack),
    'stacks_active',          (SELECT count(*) FROM pds.supplement_stack WHERE is_active),
    'stacks_bad_version',     (SELECT count(*) FROM pds.supplement_stack WHERE version IS NULL OR version < 1),
    'stacks_with_save_id',    (SELECT count(*) FROM pds.supplement_stack WHERE last_save_id IS NOT NULL)
) AS verification;

ROLLBACK;
