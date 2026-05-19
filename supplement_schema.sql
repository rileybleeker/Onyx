-- ============================================
-- Personal Data Scientist — Supplement Schema
-- ============================================
-- Two tables + two analytical views. Deliberately kept isolated from
-- daily_health_matrix (matches the spotify_plays / spotify_tracks
-- isolation pattern documented in CLAUDE.md). Correlation against
-- HRV/sleep/recovery happens at query time via the daily_supplement_matrix
-- view, not at storage.
--
-- Source of truth for product data: NIH DSLD (Dietary Supplement Label
-- Database) — public, no auth, comprehensive coverage including
-- vitamins, minerals, botanicals, and nootropics. Each label entry
-- ships with FDA UNII codes per ingredient, which is what lets us
-- roll up "total Vitamin C across all products" cleanly regardless
-- of brand.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. supplement_products (dim, one row per unique product/SKU)
-- ---------------------------------------------------------------------------
-- ingredients JSONB shape (one element per ingredient row from DSLD):
--   [
--     {
--       "name": "Vitamin A",
--       "ingredient_group": "Vitamin A",   -- canonical name (cross-brand)
--       "unii_code": "81G40H8B0T",         -- FDA universal ingredient ID
--       "category": "vitamin",             -- vitamin | mineral | botanical | amino_acid | ...
--       "quantity": 3500,
--       "unit": "IU",
--       "percent_dv": 70,                  -- nullable
--       "forms": [{"name": "Beta-Carotene", "unii_code": "01YAE03M7J"}]
--     },
--     ...
--   ]
CREATE TABLE IF NOT EXISTS pds.supplement_products (
    product_id          TEXT PRIMARY KEY,           -- e.g. "dsld_19155"
    dsld_id             INTEGER,                    -- raw DSLD numeric id (lookup convenience)
    brand_name          TEXT,
    full_name           TEXT,
    upc_sku             TEXT,                       -- normalized barcode (digits only)
    serving_size        NUMERIC,
    serving_unit        TEXT,                       -- e.g. "Tablet(s)", "Capsule(s)", "g"
    servings_per_container INTEGER,
    product_type        TEXT,                       -- DSLD productType.langualCodeDescription
    physical_state      TEXT,                       -- e.g. "Tablet or Pill", "Capsule", "Liquid"
    target_groups       JSONB,                      -- e.g. ["Adult (18 - 50 Years)"]
    ingredients         JSONB NOT NULL,             -- see shape above
    off_market          BOOLEAN DEFAULT FALSE,

    raw_json            JSONB,                      -- full DSLD response for replay
    fetched_at          TIMESTAMPTZ DEFAULT NOW(),
    synced_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplement_products_upc
    ON pds.supplement_products (upc_sku) WHERE upc_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplement_products_brand
    ON pds.supplement_products (brand_name);
CREATE INDEX IF NOT EXISTS idx_supplement_products_dsld
    ON pds.supplement_products (dsld_id) WHERE dsld_id IS NOT NULL;
-- GIN on ingredients lets us answer "which products contain magnesium?"
-- without a full scan once the library grows.
CREATE INDEX IF NOT EXISTS idx_supplement_products_ingredients
    ON pds.supplement_products USING GIN (ingredients);

-- ---------------------------------------------------------------------------
-- 2. supplement_intake (fact, one row per intake event)
-- ---------------------------------------------------------------------------
-- intake_date is canonical ET-aligned, matching project-wide TZ convention.
-- intake_time is optional but useful for time-of-day analysis (e.g. did
-- evening melatonin actually correlate with REM gain?).
CREATE TABLE IF NOT EXISTS pds.supplement_intake (
    intake_id           BIGSERIAL PRIMARY KEY,
    intake_date         DATE NOT NULL,
    intake_time         TIMESTAMPTZ,                -- nullable; null = "took it today, time unspecified"
    product_id          TEXT NOT NULL REFERENCES pds.supplement_products(product_id),
    doses               NUMERIC NOT NULL DEFAULT 1, -- # of servings consumed
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplement_intake_date
    ON pds.supplement_intake (intake_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplement_intake_product
    ON pds.supplement_intake (product_id);
CREATE INDEX IF NOT EXISTS idx_supplement_intake_date_product
    ON pds.supplement_intake (intake_date, product_id);

-- ---------------------------------------------------------------------------
-- 3. supplement_intake_by_compound (view — long format)
-- ---------------------------------------------------------------------------
-- Explodes ingredients JSONB × dose multiplier and rolls up by UNII per day.
-- One row per (date, compound). Use this for ad-hoc analysis, time series of
-- a single compound, or stack-aware "did caffeine spike on workout days?"
-- queries.
DROP VIEW IF EXISTS pds.supplement_intake_by_compound CASCADE;
CREATE VIEW pds.supplement_intake_by_compound AS
SELECT
    i.intake_date                       AS calendar_date,
    COALESCE(ing->>'unii_code', ing->>'ingredient_group', ing->>'name')
                                        AS compound_key,
    ing->>'ingredient_group'            AS ingredient_group,
    ing->>'name'                        AS ingredient_name,
    ing->>'unii_code'                   AS unii_code,
    ing->>'category'                    AS category,
    ing->>'unit'                        AS unit,
    SUM((ing->>'quantity')::numeric * i.doses) AS total_amount,
    SUM(i.doses)                        AS total_doses,
    COUNT(DISTINCT i.product_id)        AS source_product_count
FROM pds.supplement_intake i
JOIN pds.supplement_products p ON p.product_id = i.product_id
CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing
WHERE (ing->>'quantity') IS NOT NULL
  AND (ing->>'quantity') ~ '^[0-9.]+$'
GROUP BY
    i.intake_date,
    COALESCE(ing->>'unii_code', ing->>'ingredient_group', ing->>'name'),
    ing->>'ingredient_group',
    ing->>'name',
    ing->>'unii_code',
    ing->>'category',
    ing->>'unit';

-- ---------------------------------------------------------------------------
-- 4. daily_supplement_matrix (view — wide-ish format, JSONB-per-day)
-- ---------------------------------------------------------------------------
-- One row per ET date. compounds_jsonb is a {compound_key: total_amount} map.
-- Mirrors the daily_health_matrix join surface area without locking us into
-- a fixed set of columns (the user's stack will change).
--
-- Typical analysis query (joined at query time, not at storage):
--   SELECT m.calendar_date, m.whoop_recovery_score,
--          (s.compounds_jsonb->>'Vitamin D')::numeric AS vitamin_d
--   FROM pds.daily_health_matrix m
--   LEFT JOIN pds.daily_supplement_matrix s ON s.calendar_date = m.calendar_date;
DROP VIEW IF EXISTS pds.daily_supplement_matrix CASCADE;
CREATE VIEW pds.daily_supplement_matrix AS
SELECT
    calendar_date,
    jsonb_object_agg(
        COALESCE(ingredient_group, ingredient_name),
        jsonb_build_object('amount', total_amount, 'unit', unit, 'category', category)
    ) AS compounds_jsonb,
    COUNT(*) AS distinct_compounds,
    SUM(total_doses) AS total_doses
FROM pds.supplement_intake_by_compound
GROUP BY calendar_date
ORDER BY calendar_date DESC;

-- ---------------------------------------------------------------------------
-- 5. daily_health_matrix integration (MFP pattern)
-- ---------------------------------------------------------------------------
-- Supplements join into daily_health_matrix the same way MFP does — one
-- LEFT JOIN, three new columns at the end. JSONB rather than hardcoded
-- per-compound columns because a stack can carry 50+ distinct compounds
-- and the set changes over time; locking schema would be wrong.
--
-- Applied via the `daily_health_matrix_add_supplements` migration.
-- The full view definition lives in Supabase — to inspect:
--   SELECT pg_get_viewdef('pds.daily_health_matrix', true);
--
-- Query pattern for correlation analysis:
--   SELECT calendar_date,
--          whoop_recovery_score,
--          (supplements_jsonb->'Vitamin D'->>'amount')::numeric AS vitamin_d_iu
--   FROM pds.daily_health_matrix
--   WHERE calendar_date >= CURRENT_DATE - INTERVAL '90 days';

-- ---------------------------------------------------------------------------
-- 6. RLS + grants
-- ---------------------------------------------------------------------------
ALTER TABLE pds.supplement_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.supplement_intake   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.supplement_products FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.supplement_intake   FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.supplement_products            TO anon;
GRANT SELECT ON pds.supplement_intake              TO anon;
GRANT SELECT ON pds.supplement_intake_by_compound  TO anon;
GRANT SELECT ON pds.daily_supplement_matrix        TO anon;
