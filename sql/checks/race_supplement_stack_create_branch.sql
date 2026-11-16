-- Concurrent-create check for pds.save_supplement_stack (audit PROD-07): a create retried while the first copy is
-- still running must wait for it and adopt that stack. It must never answer "name in use" (OXS04) for its own stack
-- and never leave a second one.
--
-- SUPABASE BRANCH OR LOCAL SUPABASE STACK ONLY. NEVER RUN THIS ON PRODUCTION: step A2 commits a synthetic stack,
-- which step C removes again. Step A0 refuses to start on a database that holds any stack.
--
-- Needs TWO sessions that can each hold a transaction open (two psql windows; the Supabase SQL editor cannot do
-- this), connected as a role that may SET ROLE service_role. Run the blocks in this order:
--   A0, A1 in session A; B1 in session B (it waits); A1b, A2 in session A; read B1's answer; B2 in session B; C.
-- Every id and name below is invented.

-- A0 (session A): guard + a synthetic product, committed so session B sees it.
DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM pds.supplement_stack) OR EXISTS (SELECT 1 FROM pds.supplement_stack_item) THEN
        RAISE EXCEPTION 'refusing to run: this database holds supplement stacks. Use a Supabase branch or a local copy without real data.';
    END IF;
END
$guard$;
INSERT INTO pds.supplement_products (product_id, ingredients) VALUES ('zz-synthetic-race-a', '[]');

-- A1 (session A): the first copy of the create. Leave the transaction open.
BEGIN;
SET LOCAL ROLE service_role;
SELECT r ->> 'created' AS a_created            -- expect true
  FROM (SELECT pds.save_supplement_stack(
            NULL, '00000000-0000-4000-8000-00000000d001', NULL, '00000000-0000-4000-8000-00000000d101', '[]',
            '{"name":"zz synthetic race check"}', '[{"product_id":"zz-synthetic-race-a","doses":1}]') AS r) s;

-- B1 (session B): the same create sent again (same client key, same save id) while A is still open.
-- It waits on the client-key lock until A2 commits.
BEGIN;
SET LOCAL ROLE service_role;
SELECT r ->> 'existing' AS b_existing,          -- expect true
       r ->> 'replayed' AS b_replayed,          -- expect true (same save id: answered from A's row, nothing written)
       r ->> 'version'  AS b_version            -- expect 1
  FROM (SELECT pds.save_supplement_stack(
            NULL, '00000000-0000-4000-8000-00000000d001', NULL, '00000000-0000-4000-8000-00000000d101', '[]',
            '{"name":"zz synthetic race check"}', '[{"product_id":"zz-synthetic-race-a","doses":1}]') AS r) s;
-- Variant: send save id ...d102 with after_save_ids '["00000000-0000-4000-8000-00000000d101"]' instead; then expect
-- b_existing true, b_replayed false, b_version 2 (the editor's newer body adopted onto its own stack).

-- A1b (session A), while B1 waits: B must be waiting on the client-key ADVISORY lock, i.e. before its key lookup.
-- (Without that lock B would look the key up at once, find nothing, and could then meet A's committed row at the
-- name check and answer "name in use"; it would show up here as a wait on a transactionid lock, or not at all.)
SELECT count(*) AS waiting_on_client_key_lock   -- expect 1
  FROM pg_locks WHERE locktype = 'advisory' AND NOT granted;

-- A2 (session A)
COMMIT;

-- B2 (session B), after B1 answered:
COMMIT;
SELECT count(*) AS stacks_with_key              -- expect 1
  FROM pds.supplement_stack WHERE client_key = '00000000-0000-4000-8000-00000000d001';

-- C (either session): remove the synthetic rows.
DELETE FROM pds.supplement_stack_item
 WHERE stack_id IN (SELECT stack_id FROM pds.supplement_stack WHERE client_key = '00000000-0000-4000-8000-00000000d001');
DELETE FROM pds.supplement_stack WHERE client_key = '00000000-0000-4000-8000-00000000d001';
DELETE FROM pds.supplement_products WHERE product_id = 'zz-synthetic-race-a';
