-- pds.cronometer_nutrition_behavioral_daily — Cronometer daily nutrient totals
-- re-aggregated by BEHAVIORAL day (ADR-0001 −6h rule) instead of diary day.
-- Applied via Supabase migration `cronometer_nutrition_behavioral_daily` (2026-06-09).
--
-- Why: dailysummary.csv totals are keyed by Cronometer's diary day with no time
-- component, so a post-midnight pre-bed meal (logged truthfully to the new clock
-- day — the convention) lands its macros on the wrong behavioral day for HRV
-- analysis. Per-entry servings DO carry Gold timestamps, and cronometer_import.py
-- already derives onyx_behavioral_date per entry (TZ-aware via the pds.user_tz_log
-- ladder). Summing servings by onyx_behavioral_date gives behavioral-day totals
-- for free — verified to match dailysummary totals exactly per diary day on all
-- post-cutover days (2026-06-09; e.g. 12:33 AM pizza + 1:20 AM candy on clock
-- June 3 correctly moved to behavioral June 2: 1733.94 → 2793.94 kcal).
--
-- Consumers (all repointed in the same change):
--   • pds.daily_health_matrix_behavioral — the `cn` join + spine member
--     (migration daily_health_matrix_behavioral_cronometer_behavioral_totals)
--   • pds.daily_micronutrient_totals — dietary side
--     (migration daily_micronutrient_totals_behavioral)
--   • frontend getDailyNutrientsFull ("All tracked nutrients" table)
-- NOT repointed: /status freshness (tracks raw import recency on the base table
-- by design) and the raw tables themselves (source data stays untouched).
--
-- Member 2 (fallback): diary days present in cronometer_nutrition_daily but with
-- ZERO servings coverage (e.g. an export carrying dailysummary.csv without
-- servings.csv for that range) fall through with their diary-day totals — unless
-- that behavioral date already exists in the rollup (dedupe guard; the matrix
-- join requires one row per day).
--
-- Untimed entries (event_time NULL) have onyx_behavioral_date = calendar_date,
-- so they sum into the diary day exactly as before — mixed days degrade gracefully.

CREATE OR REPLACE VIEW pds.cronometer_nutrition_behavioral_daily AS
WITH rollup AS (
    SELECT s.onyx_behavioral_date,
        sum(s.calories)           AS calories,
        sum(s.alcohol_g)          AS alcohol_g,
        sum(s.caffeine_mg)        AS caffeine_mg,
        sum(s.oxalate_mg)         AS oxalate_mg,
        sum(s.phytate_mg)         AS phytate_mg,
        sum(s.water_g)            AS water_g,
        sum(s.b1_thiamine_mg)     AS b1_thiamine_mg,
        sum(s.b2_riboflavin_mg)   AS b2_riboflavin_mg,
        sum(s.b3_niacin_mg)       AS b3_niacin_mg,
        sum(s.b5_pantothenic_mg)  AS b5_pantothenic_mg,
        sum(s.b6_pyridoxine_mg)   AS b6_pyridoxine_mg,
        sum(s.b12_cobalamin_mcg)  AS b12_cobalamin_mcg,
        sum(s.folate_mcg)         AS folate_mcg,
        sum(s.vit_a_rae_mcg)      AS vit_a_rae_mcg,
        sum(s.vit_c_mg)           AS vit_c_mg,
        sum(s.vit_d_iu)           AS vit_d_iu,
        sum(s.vit_e_mg)           AS vit_e_mg,
        sum(s.vit_k_mcg)          AS vit_k_mcg,
        sum(s.calcium_mg)         AS calcium_mg,
        sum(s.copper_mg)          AS copper_mg,
        sum(s.iron_mg)            AS iron_mg,
        sum(s.magnesium_mg)       AS magnesium_mg,
        sum(s.manganese_mg)       AS manganese_mg,
        sum(s.phosphorus_mg)      AS phosphorus_mg,
        sum(s.potassium_mg)       AS potassium_mg,
        sum(s.selenium_mcg)       AS selenium_mcg,
        sum(s.sodium_mg)          AS sodium_mg,
        sum(s.zinc_mg)            AS zinc_mg,
        sum(s.net_carbs_g)        AS net_carbs_g,
        sum(s.carbs_g)            AS carbs_g,
        sum(s.fiber_g)            AS fiber_g,
        sum(s.insoluble_fiber_g)  AS insoluble_fiber_g,
        sum(s.soluble_fiber_g)    AS soluble_fiber_g,
        sum(s.starch_g)           AS starch_g,
        sum(s.sugars_g)           AS sugars_g,
        sum(s.added_sugars_g)     AS added_sugars_g,
        sum(s.fat_g)              AS fat_g,
        sum(s.cholesterol_mg)     AS cholesterol_mg,
        sum(s.monounsaturated_g)  AS monounsaturated_g,
        sum(s.polyunsaturated_g)  AS polyunsaturated_g,
        sum(s.saturated_g)        AS saturated_g,
        sum(s.trans_fat_g)        AS trans_fat_g,
        sum(s.omega3_g)           AS omega3_g,
        sum(s.ala_g)              AS ala_g,
        sum(s.dha_g)              AS dha_g,
        sum(s.epa_g)              AS epa_g,
        sum(s.omega6_g)           AS omega6_g,
        sum(s.aa_g)               AS aa_g,
        sum(s.la_g)               AS la_g,
        sum(s.cystine_g)          AS cystine_g,
        sum(s.histidine_g)        AS histidine_g,
        sum(s.isoleucine_g)       AS isoleucine_g,
        sum(s.leucine_g)          AS leucine_g,
        sum(s.lysine_g)           AS lysine_g,
        sum(s.methionine_g)       AS methionine_g,
        sum(s.phenylalanine_g)    AS phenylalanine_g,
        sum(s.protein_g)          AS protein_g,
        sum(s.threonine_g)        AS threonine_g,
        sum(s.tryptophan_g)       AS tryptophan_g,
        sum(s.tyrosine_g)         AS tyrosine_g,
        sum(s.valine_g)           AS valine_g,
        sum(s.beta_carotene_mcg)  AS beta_carotene_mcg,
        sum(s.b7_biotin_mcg)      AS b7_biotin_mcg,
        sum(s.choline_mg)         AS choline_mg,
        sum(s.iodine_mcg)         AS iodine_mcg,
        sum(s.chromium_mcg)       AS chromium_mcg,
        sum(s.molybdenum_mcg)     AS molybdenum_mcg,
        count(*)                  AS entry_count,
        count(s.event_time)       AS timestamped_entries
    FROM pds.cronometer_servings s
    WHERE s.onyx_behavioral_date IS NOT NULL
    GROUP BY s.onyx_behavioral_date
)
SELECT r.onyx_behavioral_date,
       r.onyx_behavioral_date AS calendar_date,
       NULL::boolean AS completed,
       r.calories, r.alcohol_g, r.caffeine_mg, r.oxalate_mg, r.phytate_mg, r.water_g,
       r.b1_thiamine_mg, r.b2_riboflavin_mg, r.b3_niacin_mg, r.b5_pantothenic_mg,
       r.b6_pyridoxine_mg, r.b12_cobalamin_mcg, r.folate_mcg,
       r.vit_a_rae_mcg, r.vit_c_mg, r.vit_d_iu, r.vit_e_mg, r.vit_k_mcg,
       r.calcium_mg, r.copper_mg, r.iron_mg, r.magnesium_mg, r.manganese_mg,
       r.phosphorus_mg, r.potassium_mg, r.selenium_mcg, r.sodium_mg, r.zinc_mg,
       r.net_carbs_g, r.carbs_g, r.fiber_g, r.insoluble_fiber_g, r.soluble_fiber_g,
       r.starch_g, r.sugars_g, r.added_sugars_g,
       r.fat_g, r.cholesterol_mg, r.monounsaturated_g, r.polyunsaturated_g,
       r.saturated_g, r.trans_fat_g,
       r.omega3_g, r.ala_g, r.dha_g, r.epa_g, r.omega6_g, r.aa_g, r.la_g,
       r.cystine_g, r.histidine_g, r.isoleucine_g, r.leucine_g, r.lysine_g,
       r.methionine_g, r.phenylalanine_g, r.protein_g, r.threonine_g,
       r.tryptophan_g, r.tyrosine_g, r.valine_g,
       r.beta_carotene_mcg, r.b7_biotin_mcg, r.choline_mg, r.iodine_mcg,
       r.chromium_mcg, r.molybdenum_mcg,
       r.entry_count, r.timestamped_entries,
       'servings_rollup'::text AS rollup_source
FROM rollup r
UNION ALL
SELECT d.onyx_behavioral_date,
       d.onyx_behavioral_date AS calendar_date,
       d.completed,
       d.calories, d.alcohol_g, d.caffeine_mg, d.oxalate_mg, d.phytate_mg, d.water_g,
       d.b1_thiamine_mg, d.b2_riboflavin_mg, d.b3_niacin_mg, d.b5_pantothenic_mg,
       d.b6_pyridoxine_mg, d.b12_cobalamin_mcg, d.folate_mcg,
       d.vit_a_rae_mcg, d.vit_c_mg, d.vit_d_iu, d.vit_e_mg, d.vit_k_mcg,
       d.calcium_mg, d.copper_mg, d.iron_mg, d.magnesium_mg, d.manganese_mg,
       d.phosphorus_mg, d.potassium_mg, d.selenium_mcg, d.sodium_mg, d.zinc_mg,
       d.net_carbs_g, d.carbs_g, d.fiber_g, d.insoluble_fiber_g, d.soluble_fiber_g,
       d.starch_g, d.sugars_g, d.added_sugars_g,
       d.fat_g, d.cholesterol_mg, d.monounsaturated_g, d.polyunsaturated_g,
       d.saturated_g, d.trans_fat_g,
       d.omega3_g, d.ala_g, d.dha_g, d.epa_g, d.omega6_g, d.aa_g, d.la_g,
       d.cystine_g, d.histidine_g, d.isoleucine_g, d.leucine_g, d.lysine_g,
       d.methionine_g, d.phenylalanine_g, d.protein_g, d.threonine_g,
       d.tryptophan_g, d.tyrosine_g, d.valine_g,
       d.beta_carotene_mcg, d.b7_biotin_mcg, d.choline_mg, d.iodine_mcg,
       d.chromium_mcg, d.molybdenum_mcg,
       NULL::bigint AS entry_count, NULL::bigint AS timestamped_entries,
       'dailysummary_fallback'::text AS rollup_source
FROM pds.cronometer_nutrition_daily d
WHERE NOT EXISTS (SELECT 1 FROM pds.cronometer_servings s
                   WHERE s.calendar_date = d.calendar_date)
  AND NOT EXISTS (SELECT 1 FROM rollup r
                   WHERE r.onyx_behavioral_date = d.onyx_behavioral_date);

GRANT SELECT ON pds.cronometer_nutrition_behavioral_daily TO anon, authenticated;

-- ── Matrix wiring (migration daily_health_matrix_behavioral_cronometer_behavioral_totals) ──
-- pds.daily_health_matrix_behavioral's `cn` relation was repointed from
-- pds.cronometer_nutrition_daily to THIS view (global identifier rename across the
-- spine UNION member + the LEFT JOIN, via server-side string surgery on
-- pg_get_viewdef). Column names/types unchanged, so CREATE OR REPLACE was legal.
