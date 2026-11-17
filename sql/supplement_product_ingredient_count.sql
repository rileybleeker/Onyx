-- Ingredient count as a stored column on supplement_products (speed, 2026-11-17).
--
-- GET /api/supplements/stacks needs only the NUMBER of ingredients per product (the picker shows "N ingredients"),
-- but it used to pull every product's full ingredients JSONB across the wire to count it. This column is computed
-- by Postgres from `ingredients` on every insert and update, so nothing has to be written to it and no backfill is
-- needed. The route reads ingredient_count when it exists and falls back to ingredients when it does not.
--
-- Additive only: one new column. Writers keep sending the same fields (none of them names this column), and
-- the value is 0 for a non-array ingredients value, the same rule the route used.

ALTER TABLE pds.supplement_products
  ADD COLUMN IF NOT EXISTS ingredient_count integer
  GENERATED ALWAYS AS (
    CASE WHEN jsonb_typeof(ingredients) = 'array' THEN jsonb_array_length(ingredients) ELSE 0 END
  ) STORED;
