-- pds.daily_micronutrient_totals — unified dietary (Cronometer) + supplemental (Onyx UNII
-- rollup) micronutrient intake per behavioral day, with per-nutrient unit reconciliation.
-- Applied via Supabase migration `daily_micronutrient_totals` (2026-05-31).
--
-- Supplement amounts come from pds.supplement_intake_by_compound, which normalizes every
-- compound to MASS (mg). Cronometer uses mixed units, so supplement mg is converted to the
-- Cronometer column unit per nutrient (validated against real magnitudes on cutover day):
--   mg  -> mg  : x1     (minerals, B/C/E vitamins)
--   mg  -> µg  : x1000  (selenium, B12, folate, vit K, vit A[RAE])
--   mg  -> g   : /1000  (omega-3, EPA, DHA)
--   mg  -> IU  : x40000 (vit D; 1 mg = 1000 µg = 40000 IU)  [validated 0.062 mg -> 2480 IU]
--
-- CAVEATS (query/UI convenience, NOT a HRV-pipeline input — the pipeline reads the dietary
-- Cronometer columns and the per-compound supplement treatments separately):
--   • Vitamin A x1000 treats the supplement mass as µg RAE (exact for retinyl forms;
--     β-carotene would over-count RAE — acceptable approximation).
--   • Vitamin E mg↔mg ignores IU/alpha-tocopherol-equivalent nuance.
--   • Iron has no supplement source in the current stack (supplement column resolves to 0).
CREATE OR REPLACE VIEW pds.daily_micronutrient_totals AS
 WITH supp AS (
    SELECT calendar_date AS d,
        SUM(total_amount * 1000)   FILTER (WHERE ingredient_group = 'Vitamin A')                                            AS vit_a_rae_mcg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Vitamin C')                                            AS vit_c_mg,
        SUM(total_amount * 40000)  FILTER (WHERE ingredient_group = 'Vitamin D')                                            AS vit_d_iu,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Vitamin E')                                            AS vit_e_mg,
        SUM(total_amount * 1000)   FILTER (WHERE ingredient_group = 'Vitamin K')                                            AS vit_k_mcg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Thiamin')                                              AS b1_thiamine_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Riboflavin')                                           AS b2_riboflavin_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Niacin')                                               AS b3_niacin_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group IN ('Pantothenic Acid (Vitamin B5)','Vitamin B5 (Pantothenic Acid)')) AS b5_pantothenic_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Vitamin B6')                                           AS b6_pyridoxine_mg,
        SUM(total_amount * 1000)   FILTER (WHERE ingredient_group ILIKE 'Vitamin B12%')                                     AS b12_cobalamin_mcg,
        SUM(total_amount * 1000)   FILTER (WHERE ingredient_group = 'Folate')                                               AS folate_mcg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Calcium')                                              AS calcium_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Iron')                                                 AS iron_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Magnesium')                                            AS magnesium_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Phosphorus')                                           AS phosphorus_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Potassium')                                            AS potassium_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Zinc')                                                 AS zinc_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Copper')                                               AS copper_mg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Manganese')                                            AS manganese_mg,
        SUM(total_amount * 1000)   FILTER (WHERE ingredient_group = 'Selenium')                                            AS selenium_mcg,
        SUM(total_amount)          FILTER (WHERE ingredient_group = 'Sodium')                                               AS sodium_mg,
        SUM(total_amount / 1000.0) FILTER (WHERE ingredient_group = 'Omega-3')                                              AS omega3_g,
        SUM(total_amount / 1000.0) FILTER (WHERE ingredient_group = 'EPA (Eicosapentaenoic Acid)')                         AS epa_g,
        SUM(total_amount / 1000.0) FILTER (WHERE ingredient_group = 'DHA (Docosahexaenoic Acid)')                          AS dha_g
    FROM pds.supplement_intake_by_compound
    GROUP BY calendar_date
 )
 SELECT COALESCE(cn.onyx_behavioral_date, supp.d) AS onyx_behavioral_date,
    cn.vit_a_rae_mcg AS vit_a_dietary_mcg,   supp.vit_a_rae_mcg AS vit_a_supplement_mcg,   COALESCE(cn.vit_a_rae_mcg,0) + COALESCE(supp.vit_a_rae_mcg,0) AS vit_a_total_mcg,
    cn.vit_c_mg AS vit_c_dietary_mg,         supp.vit_c_mg AS vit_c_supplement_mg,         COALESCE(cn.vit_c_mg,0) + COALESCE(supp.vit_c_mg,0) AS vit_c_total_mg,
    cn.vit_d_iu AS vit_d_dietary_iu,         supp.vit_d_iu AS vit_d_supplement_iu,         COALESCE(cn.vit_d_iu,0) + COALESCE(supp.vit_d_iu,0) AS vit_d_total_iu,
    cn.vit_e_mg AS vit_e_dietary_mg,         supp.vit_e_mg AS vit_e_supplement_mg,         COALESCE(cn.vit_e_mg,0) + COALESCE(supp.vit_e_mg,0) AS vit_e_total_mg,
    cn.vit_k_mcg AS vit_k_dietary_mcg,       supp.vit_k_mcg AS vit_k_supplement_mcg,       COALESCE(cn.vit_k_mcg,0) + COALESCE(supp.vit_k_mcg,0) AS vit_k_total_mcg,
    cn.b1_thiamine_mg AS b1_dietary_mg,      supp.b1_thiamine_mg AS b1_supplement_mg,      COALESCE(cn.b1_thiamine_mg,0) + COALESCE(supp.b1_thiamine_mg,0) AS b1_total_mg,
    cn.b2_riboflavin_mg AS b2_dietary_mg,    supp.b2_riboflavin_mg AS b2_supplement_mg,    COALESCE(cn.b2_riboflavin_mg,0) + COALESCE(supp.b2_riboflavin_mg,0) AS b2_total_mg,
    cn.b3_niacin_mg AS b3_dietary_mg,        supp.b3_niacin_mg AS b3_supplement_mg,        COALESCE(cn.b3_niacin_mg,0) + COALESCE(supp.b3_niacin_mg,0) AS b3_total_mg,
    cn.b5_pantothenic_mg AS b5_dietary_mg,   supp.b5_pantothenic_mg AS b5_supplement_mg,   COALESCE(cn.b5_pantothenic_mg,0) + COALESCE(supp.b5_pantothenic_mg,0) AS b5_total_mg,
    cn.b6_pyridoxine_mg AS b6_dietary_mg,    supp.b6_pyridoxine_mg AS b6_supplement_mg,    COALESCE(cn.b6_pyridoxine_mg,0) + COALESCE(supp.b6_pyridoxine_mg,0) AS b6_total_mg,
    cn.b12_cobalamin_mcg AS b12_dietary_mcg, supp.b12_cobalamin_mcg AS b12_supplement_mcg, COALESCE(cn.b12_cobalamin_mcg,0) + COALESCE(supp.b12_cobalamin_mcg,0) AS b12_total_mcg,
    cn.folate_mcg AS folate_dietary_mcg,     supp.folate_mcg AS folate_supplement_mcg,     COALESCE(cn.folate_mcg,0) + COALESCE(supp.folate_mcg,0) AS folate_total_mcg,
    cn.calcium_mg AS calcium_dietary_mg,     supp.calcium_mg AS calcium_supplement_mg,     COALESCE(cn.calcium_mg,0) + COALESCE(supp.calcium_mg,0) AS calcium_total_mg,
    cn.iron_mg AS iron_dietary_mg,           supp.iron_mg AS iron_supplement_mg,           COALESCE(cn.iron_mg,0) + COALESCE(supp.iron_mg,0) AS iron_total_mg,
    cn.magnesium_mg AS magnesium_dietary_mg, supp.magnesium_mg AS magnesium_supplement_mg, COALESCE(cn.magnesium_mg,0) + COALESCE(supp.magnesium_mg,0) AS magnesium_total_mg,
    cn.phosphorus_mg AS phosphorus_dietary_mg, supp.phosphorus_mg AS phosphorus_supplement_mg, COALESCE(cn.phosphorus_mg,0) + COALESCE(supp.phosphorus_mg,0) AS phosphorus_total_mg,
    cn.potassium_mg AS potassium_dietary_mg, supp.potassium_mg AS potassium_supplement_mg, COALESCE(cn.potassium_mg,0) + COALESCE(supp.potassium_mg,0) AS potassium_total_mg,
    cn.zinc_mg AS zinc_dietary_mg,           supp.zinc_mg AS zinc_supplement_mg,           COALESCE(cn.zinc_mg,0) + COALESCE(supp.zinc_mg,0) AS zinc_total_mg,
    cn.copper_mg AS copper_dietary_mg,       supp.copper_mg AS copper_supplement_mg,       COALESCE(cn.copper_mg,0) + COALESCE(supp.copper_mg,0) AS copper_total_mg,
    cn.manganese_mg AS manganese_dietary_mg, supp.manganese_mg AS manganese_supplement_mg, COALESCE(cn.manganese_mg,0) + COALESCE(supp.manganese_mg,0) AS manganese_total_mg,
    cn.selenium_mcg AS selenium_dietary_mcg, supp.selenium_mcg AS selenium_supplement_mcg, COALESCE(cn.selenium_mcg,0) + COALESCE(supp.selenium_mcg,0) AS selenium_total_mcg,
    cn.sodium_mg AS sodium_dietary_mg,       supp.sodium_mg AS sodium_supplement_mg,       COALESCE(cn.sodium_mg,0) + COALESCE(supp.sodium_mg,0) AS sodium_total_mg,
    cn.omega3_g AS omega3_dietary_g,         supp.omega3_g AS omega3_supplement_g,         COALESCE(cn.omega3_g,0) + COALESCE(supp.omega3_g,0) AS omega3_total_g,
    cn.epa_g AS epa_dietary_g,               supp.epa_g AS epa_supplement_g,               COALESCE(cn.epa_g,0) + COALESCE(supp.epa_g,0) AS epa_total_g,
    cn.dha_g AS dha_dietary_g,               supp.dha_g AS dha_supplement_g,               COALESCE(cn.dha_g,0) + COALESCE(supp.dha_g,0) AS dha_total_g
 FROM pds.cronometer_nutrition_daily cn
 FULL JOIN supp ON supp.d = cn.onyx_behavioral_date
 ORDER BY 1 DESC;

GRANT SELECT ON pds.daily_micronutrient_totals TO anon, authenticated;
