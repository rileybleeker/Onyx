-- ============================================
-- Personal Data Scientist — Supplement Stack Schema
-- ============================================
-- "Stacks" are a bill-of-materials concept for supplements: a reusable,
-- named list of products + per-item dosages. Selecting a stack records
-- intake of every product in it at once (one tap instead of N).
--
-- Design principle: a stack is a TEMPLATE only. Logging it writes ordinary
-- pds.supplement_intake rows (one per item, carrying that item's dose), so
-- every existing rollup — supplement_intake_by_compound, daily_supplement_matrix,
-- and the HRV/causal pipeline — picks the rows up transparently with no change.
-- The only fact-table change is a nullable provenance column linking an intake
-- back to the stack it came from.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. supplement_stack (header — one row per named stack)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.supplement_stack (
    stack_id      BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,  -- soft-delete: archived stacks hidden; intake provenance preserved
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active stack per name (case-insensitive) so the chat tool can resolve
-- "my morning stack" unambiguously; archived dupes are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplement_stack_active_name
    ON pds.supplement_stack (lower(name)) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- 2. supplement_stack_item (lines — one row per product in a stack)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.supplement_stack_item (
    item_id     BIGSERIAL PRIMARY KEY,
    stack_id    BIGINT NOT NULL REFERENCES pds.supplement_stack(stack_id) ON DELETE CASCADE,
    product_id  TEXT NOT NULL REFERENCES pds.supplement_products(product_id),
    doses       NUMERIC NOT NULL DEFAULT 1,   -- # of servings this stack logs for the product
    sort_order  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (stack_id, product_id)             -- a product appears at most once per stack
);

CREATE INDEX IF NOT EXISTS idx_supplement_stack_item_stack
    ON pds.supplement_stack_item (stack_id);

-- ---------------------------------------------------------------------------
-- 3. Provenance: link an intake event back to the stack that produced it
-- ---------------------------------------------------------------------------
-- Nullable — most intakes are logged ad-hoc (no stack). ON DELETE SET NULL so
-- archiving/deleting a stack never orphans or breaks historical intake rows.
ALTER TABLE pds.supplement_intake
    ADD COLUMN IF NOT EXISTS stack_id BIGINT
        REFERENCES pds.supplement_stack(stack_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_supplement_intake_stack
    ON pds.supplement_intake (stack_id) WHERE stack_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RLS + grants (mirror supplement_products / supplement_intake)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.supplement_stack      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.supplement_stack_item ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON pds.supplement_stack;
DROP POLICY IF EXISTS "anon_read" ON pds.supplement_stack_item;
CREATE POLICY "anon_read" ON pds.supplement_stack      FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.supplement_stack_item FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.supplement_stack      TO anon;
GRANT SELECT ON pds.supplement_stack_item TO anon;
