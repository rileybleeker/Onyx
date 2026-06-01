-- cronometer_schema.sql
-- Cronometer nutrition ingestion (MFP → Cronometer migration, cutover 2026-05-31).
--
-- Two physical tables under schema `pds`, mirroring the ADR-0001 triple-date
-- convention used by pds.meal_events / pds.myfitnesspal_nutrition:
--   • pds.cronometer_nutrition_daily  — one row per behavioral day (from dailysummary.csv "Total" rows)
--   • pds.cronometer_servings         — one row per logged food entry (from servings.csv)
--
-- Column set verified against Riley's REAL export (2026-05-31):
--   servings.csv     = 66 columns (extended nutrient targets ON; EPA/DHA/ALA/AA/LA present)
--   dailysummary.csv = 64 columns (per-(date,meal-group) rows + a Group='Total' daily row)
-- NO `Time` column present (per-entry timestamps are Cronometer Gold-only and not enabled),
-- so `cronometer_servings.event_time` is nullable + reserved for a future Gold export.
--
-- Future-proof nullable columns (beta_carotene, biotin, choline, iodine, chromium,
-- molybdenum) are declared but NOT in the current default export — they auto-populate
-- if Cronometer ever emits them. The importer only writes columns whose header exists.
--
-- Apply via Supabase MCP apply_migration (idempotent: IF NOT EXISTS + DROP POLICY IF EXISTS).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Daily totals  (PK = calendar_date)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pds.cronometer_nutrition_daily (
    calendar_date          DATE PRIMARY KEY,

    -- ADR-0001 triple-date + provenance (mirrors pds.myfitnesspal_nutrition cols 14-17).
    -- With no per-entry time, behavioral = et = local = calendar_date (manual-backdate
    -- convention, same as MFP); tz_source records that the date came from the CSV.
    onyx_et_date           DATE,
    onyx_behavioral_date   DATE,
    onyx_local_date        DATE,
    onyx_tz_source         TEXT,

    completed              BOOLEAN,            -- dailysummary.csv "Completed" flag on the Total row

    -- ── Energy / hydration / antinutrients ──
    calories               NUMERIC,            -- Energy (kcal)
    alcohol_g              NUMERIC,            -- Alcohol (g)
    caffeine_mg            NUMERIC,            -- Caffeine (mg)
    oxalate_mg             NUMERIC,            -- Oxalate (mg)
    phytate_mg             NUMERIC,            -- Phytate (mg)
    water_g                NUMERIC,            -- Water (g)   (1 g ≈ 1 ml; matrix maps to nutrition_water_ml)

    -- ── B-vitamins + folate ──
    b1_thiamine_mg         NUMERIC,            -- B1 (Thiamine) (mg)
    b2_riboflavin_mg       NUMERIC,            -- B2 (Riboflavin) (mg)
    b3_niacin_mg           NUMERIC,            -- B3 (Niacin) (mg)
    b5_pantothenic_mg      NUMERIC,            -- B5 (Pantothenic Acid) (mg)
    b6_pyridoxine_mg       NUMERIC,            -- B6 (Pyridoxine) (mg)
    b12_cobalamin_mcg      NUMERIC,            -- B12 (Cobalamin) (µg)
    folate_mcg             NUMERIC,            -- Folate (µg)

    -- ── Fat- & water-soluble vitamins ──
    vit_a_rae_mcg          NUMERIC,            -- Vitamin A (µg)  — RAE, NOT IU
    vit_c_mg               NUMERIC,            -- Vitamin C (mg)
    vit_d_iu               NUMERIC,            -- Vitamin D (IU)  — IU, NOT mcg
    vit_e_mg               NUMERIC,            -- Vitamin E (mg)
    vit_k_mcg              NUMERIC,            -- Vitamin K (µg)

    -- ── Minerals ──
    calcium_mg             NUMERIC,            -- Calcium (mg)
    copper_mg              NUMERIC,            -- Copper (mg)
    iron_mg                NUMERIC,            -- Iron (mg)
    magnesium_mg           NUMERIC,            -- Magnesium (mg)
    manganese_mg           NUMERIC,            -- Manganese (mg)
    phosphorus_mg          NUMERIC,            -- Phosphorus (mg)
    potassium_mg           NUMERIC,            -- Potassium (mg)
    selenium_mcg           NUMERIC,            -- Selenium (µg)
    sodium_mg              NUMERIC,            -- Sodium (mg)
    zinc_mg                NUMERIC,            -- Zinc (mg)

    -- ── Carbohydrates ──
    net_carbs_g            NUMERIC,            -- Net Carbs (g)
    carbs_g                NUMERIC,            -- Carbs (g)
    fiber_g                NUMERIC,            -- Fiber (g)
    insoluble_fiber_g      NUMERIC,            -- Insoluble Fiber (g)
    soluble_fiber_g        NUMERIC,            -- Soluble Fiber (g)
    starch_g               NUMERIC,            -- Starch (g)
    sugars_g               NUMERIC,            -- Sugars (g)
    added_sugars_g         NUMERIC,            -- Added Sugars (g)

    -- ── Fats ──
    fat_g                  NUMERIC,            -- Fat (g)
    cholesterol_mg         NUMERIC,            -- Cholesterol (mg)
    monounsaturated_g      NUMERIC,            -- Monounsaturated (g)
    polyunsaturated_g      NUMERIC,            -- Polyunsaturated (g)
    saturated_g            NUMERIC,            -- Saturated (g)
    trans_fat_g            NUMERIC,            -- Trans-Fats (g)
    omega3_g               NUMERIC,            -- Omega-3 (g)
    ala_g                  NUMERIC,            -- ALA (g)
    dha_g                  NUMERIC,            -- DHA (g)
    epa_g                  NUMERIC,            -- EPA (g)
    omega6_g               NUMERIC,            -- Omega-6 (g)
    aa_g                   NUMERIC,            -- AA (g)  (arachidonic)
    la_g                   NUMERIC,            -- LA (g)  (linoleic)

    -- ── Amino acids (11 proteinogenic that Cronometer exports) + protein ──
    cystine_g              NUMERIC,            -- Cystine (g)
    histidine_g            NUMERIC,            -- Histidine (g)
    isoleucine_g           NUMERIC,            -- Isoleucine (g)
    leucine_g              NUMERIC,            -- Leucine (g)
    lysine_g               NUMERIC,            -- Lysine (g)
    methionine_g           NUMERIC,            -- Methionine (g)
    phenylalanine_g        NUMERIC,            -- Phenylalanine (g)
    protein_g              NUMERIC,            -- Protein (g)
    threonine_g            NUMERIC,            -- Threonine (g)
    tryptophan_g           NUMERIC,            -- Tryptophan (g)
    tyrosine_g             NUMERIC,            -- Tyrosine (g)
    valine_g               NUMERIC,            -- Valine (g)

    -- ── Future-proof: NOT in current export, auto-populate if Cronometer adds them ──
    beta_carotene_mcg      NUMERIC,
    b7_biotin_mcg          NUMERIC,
    choline_mg             NUMERIC,
    iodine_mcg             NUMERIC,
    chromium_mcg           NUMERIC,
    molybdenum_mcg         NUMERIC,

    raw_json               JSONB,              -- per-meal-group breakdown for the day
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pds.cronometer_nutrition_daily IS
    'Cronometer daily nutrition totals (from dailysummary.csv Group=Total rows). One row per behavioral day. Sole new-day nutrition source post 2026-05-31 cutover; MFP (pds.myfitnesspal_nutrition) preserved as historical archive.';

CREATE INDEX IF NOT EXISTS idx_cron_daily_behavioral
    ON pds.cronometer_nutrition_daily (onyx_behavioral_date);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Per-entry servings  (surrogate PK serving_id; idempotency via delete-by-date + insert)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pds.cronometer_servings (
    serving_id             BIGSERIAL PRIMARY KEY,

    event_time             TIMESTAMPTZ,        -- per-entry clock instant (Cronometer Gold "Time"); NULL on free tier
    calendar_date          DATE NOT NULL,      -- Cronometer "Day" (clock day as logged)

    -- ADR-0001 triple-date + provenance. When event_time is present (Gold), the importer
    -- derives onyx_behavioral_date via the −6h rule; otherwise behavioral = calendar_date.
    onyx_et_date           DATE,
    onyx_behavioral_date   DATE,
    onyx_local_date        DATE,
    onyx_tz_source         TEXT,

    food_name              TEXT,               -- Food Name
    amount_raw             TEXT,               -- Amount, verbatim ("1.00 x 3.0 scoops", "1.00 tablet")
    amount                 NUMERIC,            -- best-effort parsed quantity
    unit                   TEXT,               -- best-effort parsed unit
    meal_group             TEXT,               -- Group (Breakfast/Lunch/Dinner/Snacks/Uncategorized)
    food_category          TEXT,               -- Category (Supplements/Beverages/… — heuristic, often blank)

    -- ── Same nutrient column set as the daily table ──
    calories               NUMERIC,
    alcohol_g              NUMERIC,
    caffeine_mg            NUMERIC,
    oxalate_mg             NUMERIC,
    phytate_mg             NUMERIC,
    water_g                NUMERIC,
    b1_thiamine_mg         NUMERIC,
    b2_riboflavin_mg       NUMERIC,
    b3_niacin_mg           NUMERIC,
    b5_pantothenic_mg      NUMERIC,
    b6_pyridoxine_mg       NUMERIC,
    b12_cobalamin_mcg      NUMERIC,
    folate_mcg             NUMERIC,
    vit_a_rae_mcg          NUMERIC,
    vit_c_mg               NUMERIC,
    vit_d_iu               NUMERIC,
    vit_e_mg               NUMERIC,
    vit_k_mcg              NUMERIC,
    calcium_mg             NUMERIC,
    copper_mg              NUMERIC,
    iron_mg                NUMERIC,
    magnesium_mg           NUMERIC,
    manganese_mg           NUMERIC,
    phosphorus_mg          NUMERIC,
    potassium_mg           NUMERIC,
    selenium_mcg           NUMERIC,
    sodium_mg              NUMERIC,
    zinc_mg                NUMERIC,
    net_carbs_g            NUMERIC,
    carbs_g                NUMERIC,
    fiber_g                NUMERIC,
    insoluble_fiber_g      NUMERIC,
    soluble_fiber_g        NUMERIC,
    starch_g               NUMERIC,
    sugars_g               NUMERIC,
    added_sugars_g         NUMERIC,
    fat_g                  NUMERIC,
    cholesterol_mg         NUMERIC,
    monounsaturated_g      NUMERIC,
    polyunsaturated_g      NUMERIC,
    saturated_g            NUMERIC,
    trans_fat_g            NUMERIC,
    omega3_g               NUMERIC,
    ala_g                  NUMERIC,
    dha_g                  NUMERIC,
    epa_g                  NUMERIC,
    omega6_g               NUMERIC,
    aa_g                   NUMERIC,
    la_g                   NUMERIC,
    cystine_g              NUMERIC,
    histidine_g            NUMERIC,
    isoleucine_g           NUMERIC,
    leucine_g              NUMERIC,
    lysine_g               NUMERIC,
    methionine_g           NUMERIC,
    phenylalanine_g        NUMERIC,
    protein_g              NUMERIC,
    threonine_g            NUMERIC,
    tryptophan_g           NUMERIC,
    tyrosine_g             NUMERIC,
    valine_g               NUMERIC,
    beta_carotene_mcg      NUMERIC,
    b7_biotin_mcg          NUMERIC,
    choline_mg             NUMERIC,
    iodine_mcg             NUMERIC,
    chromium_mcg           NUMERIC,
    molybdenum_mcg         NUMERIC,

    raw_json               JSONB,              -- full source row as a dict (header → value)
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pds.cronometer_servings IS
    'Cronometer per-entry food log (from servings.csv). Idempotent re-import via delete-by-calendar_date + insert. event_time is NULL until Cronometer Gold per-entry timestamps are enabled. food_category may say "Supplements" but is an unreliable heuristic — supplements are tracked in pds.supplement_intake, not here.';

CREATE INDEX IF NOT EXISTS idx_cron_serv_calendar    ON pds.cronometer_servings (calendar_date);
CREATE INDEX IF NOT EXISTS idx_cron_serv_behavioral  ON pds.cronometer_servings (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_cron_serv_event_time  ON pds.cronometer_servings (event_time);
CREATE INDEX IF NOT EXISTS idx_cron_serv_meal_group  ON pds.cronometer_servings (meal_group);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS  (mirror pds.myfitnesspal_nutrition: anon read-only, service_role full)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE pds.cronometer_nutrition_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.cronometer_servings        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read"           ON pds.cronometer_nutrition_daily;
DROP POLICY IF EXISTS "service_full_access" ON pds.cronometer_nutrition_daily;
CREATE POLICY "anon_read"           ON pds.cronometer_nutrition_daily FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.cronometer_nutrition_daily FOR ALL    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read"           ON pds.cronometer_servings;
DROP POLICY IF EXISTS "service_full_access" ON pds.cronometer_servings;
CREATE POLICY "anon_read"           ON pds.cronometer_servings FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.cronometer_servings FOR ALL    TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pds.cronometer_nutrition_daily TO anon, authenticated;
GRANT SELECT ON pds.cronometer_servings        TO anon, authenticated;
GRANT ALL    ON pds.cronometer_nutrition_daily TO service_role;
GRANT ALL    ON pds.cronometer_servings        TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.cronometer_servings_serving_id_seq TO service_role;
