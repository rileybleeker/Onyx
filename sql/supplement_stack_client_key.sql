-- Idempotent stack creation from the /supplements stack editor (autosave, 2026-11-15).
--
-- The editor now creates a new stack on its own as soon as it has a name and a product. If the answer to that
-- POST is lost (a network blip) the editor tries again, which used to insert a second copy of the stack. The editor
-- therefore sends one random UUID per new stack (`client_key`); POST /api/supplements/stacks looks the key up first
-- and, when the stack already exists, brings it up to date and answers with it instead of inserting another.
--
-- Additive only: one nullable column and a unique index over the rows that carry a key. Rows created before this
-- (and by any other path) keep client_key NULL and are not affected. The route works before this file is applied
-- (it then creates stacks without a key, as before).

ALTER TABLE pds.supplement_stack ADD COLUMN IF NOT EXISTS client_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS supplement_stack_client_key_uniq
  ON pds.supplement_stack (client_key)
  WHERE client_key IS NOT NULL;

COMMENT ON COLUMN pds.supplement_stack.client_key IS
  'Random UUID the stack editor sends with a create, so a retried create returns the same stack (autosave, 2026-11-15).';
