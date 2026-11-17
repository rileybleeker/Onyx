-- unit_class-aware mass totals for the two SQL rollup consumers (2026-11-16)
-- ---------------------------------------------------------------------------
-- pds.supplement_intake_by_compound now has one row per
-- (calendar_date, compound_key, ingredient_group, unii_code, unit_class), and
-- total_amount is milligrams ONLY when unit_class = 'mass'; any other
-- unit_class is the raw literal unit (IU, mL, Calorie...) and total_amount is
-- the amount in THAT unit (sql/supplement_iu_conversion.sql).
--
-- Two consumers still summed total_amount by ingredient group without looking
-- at unit_class, so a literal-unit row was added into a mass total:
--   1. pds.melatonin_unified          (sql/melatonin_unified.sql)
--   2. pds.daily_micronutrient_totals (sql/db_perf_2026_11.sql, matview-backed)
--
-- This migration re-creates both views with a `unit_class = 'mass'` condition
-- on every mass-based sum. Columns and their order are unchanged, so every
-- reader keeps working. Mass rows give exactly the same totals as before.
--
-- MUST BE APPLIED BY RILEY (not by an agent, not through the Supabase MCP
-- apply path without review). Before applying:
--   * Check the matview refresh function pds.refresh_supplement_intake_by_compound_mat()
--     (sql/db_perf_2026_11.sql): it must still reference the matview
--     pds.supplement_intake_by_compound_mat, whose rows already carry
--     unit_class, so no matview change is needed here -- but confirm the
--     function's fingerprint/heartbeat still succeeds after this view change
--     (the pg_cron job refresh_supplement_rollup_mat writes the
--     supplement_mat heartbeat; it should stay 'success').
--   * pds.daily_micronutrient_totals keeps reading the matview; the
--     unit_class column is already part of the matview's unique index
--     (uq_supplement_intake_by_compound_mat_key), so nothing else to rebuild.
--
-- After applying, a quick read-only sanity check:
--   SELECT count(*) FROM pds.supplement_intake_by_compound
--   WHERE unit_class <> 'mass'
--     AND (unii_code = 'JL5DK93RCL' OR ingredient_group ILIKE 'melatonin'
--          OR ingredient_group IN ('Vitamin C','Vitamin E','Thiamin','Calcium'));
--   -> rows that existed will now be excluded from the mass totals.
-- ---------------------------------------------------------------------------

-- 1. pds.melatonin_unified: same columns, same order; the dose sum now only
--    counts unit_class = 'mass' rows. A day with only a non-mass melatonin
--    row no longer produces an s row, so it cannot look like a dosed day
--    (melatonin_present falls back to the journal answer, source_flag to
--    'journal'). Melatonin is labelled mg, so a non-mass row is a unit
--    mismatch, not a dose.
CREATE OR REPLACE VIEW pds.melatonin_unified AS
WITH j AS (
    SELECT COALESCE(behaviors_date, cycle_date) AS calendar_date,
           MAX((answer = 'Yes')::int)           AS journal_present
    FROM pds.journal
    WHERE question ILIKE '%melatonin%'
      AND answer IN ('Yes', 'No')
    GROUP BY 1
),
s AS (
    -- Robust to a future ingredient_group spelling change: match the stable UNII
    -- OR the name. Melatonin is labelled mg; only unit_class = 'mass' rows carry
    -- a milligram total_amount, so a literal-unit row (e.g. mL) is left out of
    -- the dose entirely.
    SELECT calendar_date,
           SUM(total_amount) AS dose_mg
    FROM pds.supplement_intake_by_compound
    WHERE (unii_code = 'JL5DK93RCL' OR ingredient_group ILIKE 'melatonin')
      AND unit_class = 'mass'
    GROUP BY 1
)
SELECT
    COALESCE(j.calendar_date, s.calendar_date)                          AS calendar_date,
    CASE WHEN s.dose_mg IS NOT NULL THEN 1 ELSE j.journal_present END   AS melatonin_present,
    s.dose_mg                                                          AS melatonin_dose_mg,
    CASE
        WHEN s.dose_mg IS NOT NULL AND j.journal_present IS NOT NULL THEN 'both'
        WHEN s.dose_mg IS NOT NULL THEN 'supplement'
        ELSE 'journal'
    END                                                                AS source_flag
FROM j
FULL OUTER JOIN s ON j.calendar_date = s.calendar_date;

GRANT SELECT ON pds.melatonin_unified TO anon, authenticated;

-- 2. pds.daily_micronutrient_totals: same columns, same order, still reading
--    the matview. Every supplement FILTER sum below assumes total_amount is
--    milligrams (plain sums are _mg columns; *1000 is mg->mcg, *40000 is
--    mg->IU for vitamin D, /1000.0 is mg->g for the omega fractions), so each
--    one now also requires unit_class = 'mass'. The conversion factors are
--    unchanged for the rows that remain.
CREATE OR REPLACE VIEW pds.daily_micronutrient_totals AS
 WITH supp AS (
         SELECT supplement_intake_by_compound.calendar_date AS d,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin A'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS vit_a_rae_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin C'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS vit_c_mg,
            sum(supplement_intake_by_compound.total_amount * 40000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin D'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS vit_d_iu,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin E'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS vit_e_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin K'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS vit_k_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Thiamin'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b1_thiamine_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Riboflavin'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b2_riboflavin_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Niacin'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b3_niacin_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = ANY (ARRAY['Pantothenic Acid (Vitamin B5)'::text, 'Vitamin B5 (Pantothenic Acid)'::text]) AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b5_pantothenic_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin B6'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b6_pyridoxine_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group ~~* 'Vitamin B12%'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS b12_cobalamin_mcg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Folate'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS folate_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Calcium'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS calcium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Iron'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS iron_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Magnesium'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS magnesium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Phosphorus'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS phosphorus_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Potassium'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS potassium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Zinc'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS zinc_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Copper'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS copper_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Manganese'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS manganese_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Selenium'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS selenium_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Sodium'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS sodium_mg,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Omega-3'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS omega3_g,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'EPA (Eicosapentaenoic Acid)'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS epa_g,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'DHA (Docosahexaenoic Acid)'::text AND supplement_intake_by_compound.unit_class = 'mass'::text) AS dha_g
           FROM pds.supplement_intake_by_compound_mat supplement_intake_by_compound
          GROUP BY supplement_intake_by_compound.calendar_date
        )
 SELECT COALESCE(cn.onyx_behavioral_date, supp.d) AS onyx_behavioral_date,
    cn.vit_a_rae_mcg AS vit_a_dietary_mcg,
    supp.vit_a_rae_mcg AS vit_a_supplement_mcg,
    COALESCE(cn.vit_a_rae_mcg, 0::numeric) + COALESCE(supp.vit_a_rae_mcg, 0::numeric) AS vit_a_total_mcg,
    cn.vit_c_mg AS vit_c_dietary_mg,
    supp.vit_c_mg AS vit_c_supplement_mg,
    COALESCE(cn.vit_c_mg, 0::numeric) + COALESCE(supp.vit_c_mg, 0::numeric) AS vit_c_total_mg,
    cn.vit_d_iu AS vit_d_dietary_iu,
    supp.vit_d_iu AS vit_d_supplement_iu,
    COALESCE(cn.vit_d_iu, 0::numeric) + COALESCE(supp.vit_d_iu, 0::numeric) AS vit_d_total_iu,
    cn.vit_e_mg AS vit_e_dietary_mg,
    supp.vit_e_mg AS vit_e_supplement_mg,
    COALESCE(cn.vit_e_mg, 0::numeric) + COALESCE(supp.vit_e_mg, 0::numeric) AS vit_e_total_mg,
    cn.vit_k_mcg AS vit_k_dietary_mcg,
    supp.vit_k_mcg AS vit_k_supplement_mcg,
    COALESCE(cn.vit_k_mcg, 0::numeric) + COALESCE(supp.vit_k_mcg, 0::numeric) AS vit_k_total_mcg,
    cn.b1_thiamine_mg AS b1_dietary_mg,
    supp.b1_thiamine_mg AS b1_supplement_mg,
    COALESCE(cn.b1_thiamine_mg, 0::numeric) + COALESCE(supp.b1_thiamine_mg, 0::numeric) AS b1_total_mg,
    cn.b2_riboflavin_mg AS b2_dietary_mg,
    supp.b2_riboflavin_mg AS b2_supplement_mg,
    COALESCE(cn.b2_riboflavin_mg, 0::numeric) + COALESCE(supp.b2_riboflavin_mg, 0::numeric) AS b2_total_mg,
    cn.b3_niacin_mg AS b3_dietary_mg,
    supp.b3_niacin_mg AS b3_supplement_mg,
    COALESCE(cn.b3_niacin_mg, 0::numeric) + COALESCE(supp.b3_niacin_mg, 0::numeric) AS b3_total_mg,
    cn.b5_pantothenic_mg AS b5_dietary_mg,
    supp.b5_pantothenic_mg AS b5_supplement_mg,
    COALESCE(cn.b5_pantothenic_mg, 0::numeric) + COALESCE(supp.b5_pantothenic_mg, 0::numeric) AS b5_total_mg,
    cn.b6_pyridoxine_mg AS b6_dietary_mg,
    supp.b6_pyridoxine_mg AS b6_supplement_mg,
    COALESCE(cn.b6_pyridoxine_mg, 0::numeric) + COALESCE(supp.b6_pyridoxine_mg, 0::numeric) AS b6_total_mg,
    cn.b12_cobalamin_mcg AS b12_dietary_mcg,
    supp.b12_cobalamin_mcg AS b12_supplement_mcg,
    COALESCE(cn.b12_cobalamin_mcg, 0::numeric) + COALESCE(supp.b12_cobalamin_mcg, 0::numeric) AS b12_total_mcg,
    cn.folate_mcg AS folate_dietary_mcg,
    supp.folate_mcg AS folate_supplement_mcg,
    COALESCE(cn.folate_mcg, 0::numeric) + COALESCE(supp.folate_mcg, 0::numeric) AS folate_total_mcg,
    cn.calcium_mg AS calcium_dietary_mg,
    supp.calcium_mg AS calcium_supplement_mg,
    COALESCE(cn.calcium_mg, 0::numeric) + COALESCE(supp.calcium_mg, 0::numeric) AS calcium_total_mg,
    cn.iron_mg AS iron_dietary_mg,
    supp.iron_mg AS iron_supplement_mg,
    COALESCE(cn.iron_mg, 0::numeric) + COALESCE(supp.iron_mg, 0::numeric) AS iron_total_mg,
    cn.magnesium_mg AS magnesium_dietary_mg,
    supp.magnesium_mg AS magnesium_supplement_mg,
    COALESCE(cn.magnesium_mg, 0::numeric) + COALESCE(supp.magnesium_mg, 0::numeric) AS magnesium_total_mg,
    cn.phosphorus_mg AS phosphorus_dietary_mg,
    supp.phosphorus_mg AS phosphorus_supplement_mg,
    COALESCE(cn.phosphorus_mg, 0::numeric) + COALESCE(supp.phosphorus_mg, 0::numeric) AS phosphorus_total_mg,
    cn.potassium_mg AS potassium_dietary_mg,
    supp.potassium_mg AS potassium_supplement_mg,
    COALESCE(cn.potassium_mg, 0::numeric) + COALESCE(supp.potassium_mg, 0::numeric) AS potassium_total_mg,
    cn.zinc_mg AS zinc_dietary_mg,
    supp.zinc_mg AS zinc_supplement_mg,
    COALESCE(cn.zinc_mg, 0::numeric) + COALESCE(supp.zinc_mg, 0::numeric) AS zinc_total_mg,
    cn.copper_mg AS copper_dietary_mg,
    supp.copper_mg AS copper_supplement_mg,
    COALESCE(cn.copper_mg, 0::numeric) + COALESCE(supp.copper_mg, 0::numeric) AS copper_total_mg,
    cn.manganese_mg AS manganese_dietary_mg,
    supp.manganese_mg AS manganese_supplement_mg,
    COALESCE(cn.manganese_mg, 0::numeric) + COALESCE(supp.manganese_mg, 0::numeric) AS manganese_total_mg,
    cn.selenium_mcg AS selenium_dietary_mcg,
    supp.selenium_mcg AS selenium_supplement_mcg,
    COALESCE(cn.selenium_mcg, 0::numeric) + COALESCE(supp.selenium_mcg, 0::numeric) AS selenium_total_mcg,
    cn.sodium_mg AS sodium_dietary_mg,
    supp.sodium_mg AS sodium_supplement_mg,
    COALESCE(cn.sodium_mg, 0::numeric) + COALESCE(supp.sodium_mg, 0::numeric) AS sodium_total_mg,
    cn.omega3_g AS omega3_dietary_g,
    supp.omega3_g AS omega3_supplement_g,
    COALESCE(cn.omega3_g, 0::numeric) + COALESCE(supp.omega3_g, 0::numeric) AS omega3_total_g,
    cn.epa_g AS epa_dietary_g,
    supp.epa_g AS epa_supplement_g,
    COALESCE(cn.epa_g, 0::numeric) + COALESCE(supp.epa_g, 0::numeric) AS epa_total_g,
    cn.dha_g AS dha_dietary_g,
    supp.dha_g AS dha_supplement_g,
    COALESCE(cn.dha_g, 0::numeric) + COALESCE(supp.dha_g, 0::numeric) AS dha_total_g
   FROM pds.cronometer_nutrition_behavioral_daily cn
     FULL JOIN supp ON supp.d = cn.onyx_behavioral_date
  ORDER BY (COALESCE(cn.onyx_behavioral_date, supp.d)) DESC;

-- Grants are kept by CREATE OR REPLACE VIEW; no further statements here.
