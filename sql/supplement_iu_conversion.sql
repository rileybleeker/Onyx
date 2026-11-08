-- =============================================================================
-- Audit P1: compound-aware IU -> mg conversion for supplement rollups (2026-11-07)
-- =============================================================================
-- pds.unit_to_mg_factor(unit) has no compound context, so 'IU' returned NULL and
-- IU-labelled ingredients landed in supplement_intake_by_compound under a
-- separate unit_class='IU' row instead of merging with the same vitamin logged
-- in mcg/mg. Worse, pds.daily_micronutrient_totals sums total_amount by
-- ingredient_group WITHOUT filtering unit_class, so an IU row would have been
-- multiplied as if it were mg (e.g. 5000 IU Vit D x 40000 = 200M IU).
--
-- Fix: pds.unit_to_mg_factor_for(unit, unii, ingredient_group) wraps the mass
-- factor and adds the vitamin-specific IU factors (NIH ODS):
--   Vitamin D (D2/D3)            1 IU = 0.025 mcg            = 0.000025 mg
--   Vitamin A, retinol/esters    1 IU = 0.3 mcg RAE          = 0.0003 mg
--   Vitamin A, supplemental beta-carotene (UNII 01YAE03M7J)
--                                1 IU = 0.15 mcg RAE         = 0.00015 mg
--   Vitamin E, natural d-alpha   1 IU = 0.67 mg (default)
--   Vitamin E, synthetic dl-alpha (UNII 7QWA1RIO01, dl-alpha-tocopheryl acetate
--                                WR1WPI7EW8)  1 IU = 0.45 mg
-- Any other non-mass unit (Calorie(s), mL, count) still returns NULL and stays
-- grouped under its own unit_class — those are not masses and must not merge.
-- Remaining non-mass units are listed by pds.supplement_intake_unmapped.
--
-- supplement_intake_by_compound is CREATE OR REPLACE'd with an identical
-- output column list, so dependents (daily_supplement_matrix,
-- daily_micronutrient_totals, melatonin_unified) need no change.
-- =============================================================================

CREATE OR REPLACE FUNCTION pds.unit_to_mg_factor_for(u TEXT, unii TEXT, grp TEXT)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        pds.unit_to_mg_factor(u),
        CASE
            WHEN REGEXP_REPLACE(LOWER(COALESCE(u, '')), '[^a-z]', '', 'g') <> 'iu' THEN NULL
            WHEN grp ILIKE 'Vitamin D%'                        THEN 0.000025
            WHEN grp ILIKE 'Vitamin A%' AND unii = '01YAE03M7J' THEN 0.00015
            WHEN grp ILIKE 'Vitamin A%'                        THEN 0.0003
            WHEN grp ILIKE 'Vitamin E%' AND unii IN ('7QWA1RIO01', 'WR1WPI7EW8') THEN 0.45
            WHEN grp ILIKE 'Vitamin E%'                        THEN 0.67
            ELSE NULL
        END
    );
$$;

COMMENT ON FUNCTION pds.unit_to_mg_factor_for(TEXT, TEXT, TEXT) IS
'Compound-aware unit -> mg factor: pds.unit_to_mg_factor for mass units, plus vitamin-specific IU factors (Vit D 0.025 mcg, Vit A 0.3 mcg RAE / 0.15 for supplemental beta-carotene, Vit E 0.67 mg natural / 0.45 mg synthetic). NULL for non-mass units.';

CREATE OR REPLACE VIEW pds.supplement_intake_by_compound AS
WITH expanded AS (
    SELECT
        i.intake_date,
        i.product_id,
        i.doses,
        COALESCE(ing.value->>'unii_code', ing.value->>'ingredient_group', ing.value->>'name') AS compound_key,
        ing.value->>'ingredient_group' AS ingredient_group,
        ing.value->>'name'             AS ingredient_name,
        ing.value->>'unii_code'        AS unii_code,
        ing.value->>'category'         AS category,
        ing.value->>'unit'             AS unit,
        ((ing.value->>'quantity')::numeric) * i.doses AS amount_raw,
        ((ing.value->>'quantity')::numeric) * i.doses *
            pds.unit_to_mg_factor_for(ing.value->>'unit', ing.value->>'unii_code', ing.value->>'ingredient_group') AS amount_mg,
        CASE WHEN pds.unit_to_mg_factor_for(ing.value->>'unit', ing.value->>'unii_code', ing.value->>'ingredient_group') IS NOT NULL
             THEN 'mass'
             ELSE COALESCE(ing.value->>'unit', 'unitless')
        END AS unit_class
    FROM pds.supplement_intake i
    JOIN pds.supplement_products p ON p.product_id = i.product_id
    CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing(value)
    WHERE (ing.value->>'quantity') IS NOT NULL
      AND (ing.value->>'quantity') ~ '^[0-9.]+$'
)
SELECT
    intake_date AS calendar_date,
    compound_key,
    ingredient_group,
    unii_code,
    unit_class,
    CASE WHEN unit_class = 'mass' THEN SUM(amount_mg) ELSE SUM(amount_raw) END AS total_amount,
    CASE WHEN unit_class = 'mass' THEN 'mg' ELSE unit_class END AS unit,
    array_agg(DISTINCT unit)             AS source_units,
    array_agg(DISTINCT ingredient_name)  AS ingredient_names,
    array_agg(DISTINCT category)         AS categories,
    SUM(doses)                           AS total_doses,
    COUNT(DISTINCT product_id)           AS source_product_count
FROM expanded
GROUP BY intake_date, compound_key, ingredient_group, unii_code, unit_class;

-- Visibility for whatever still can't convert (was never applied live before).
CREATE OR REPLACE VIEW pds.supplement_intake_unmapped AS
SELECT
    p.product_id,
    p.brand_name,
    p.full_name AS product_name,
    ing->>'ingredient_group' AS ingredient_group,
    ing->>'unit'             AS unit_raw,
    ing->>'unii_code'        AS unii_code,
    COUNT(si.intake_id)      AS intake_count,
    MIN(si.intake_date)      AS first_seen,
    MAX(si.intake_date)      AS last_seen
FROM pds.supplement_products p
CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing
LEFT JOIN pds.supplement_intake si ON si.product_id = p.product_id
WHERE pds.unit_to_mg_factor_for(ing->>'unit', ing->>'unii_code', ing->>'ingredient_group') IS NULL
  AND COALESCE(ing->>'unit', '') <> ''
GROUP BY p.product_id, p.brand_name, p.full_name,
         ing->>'ingredient_group', ing->>'unit', ing->>'unii_code'
ORDER BY intake_count DESC NULLS LAST, last_seen DESC NULLS LAST;

ALTER VIEW pds.supplement_intake_unmapped SET (security_invoker = on);
GRANT SELECT ON pds.supplement_intake_unmapped TO anon, authenticated, service_role;

COMMENT ON VIEW pds.supplement_intake_unmapped IS
'Every (product, ingredient, unit) whose unit has no mg conversion even with compound context (pds.unit_to_mg_factor_for). Those rows are NOT dropped: supplement_intake_by_compound keeps them under unit_class = their raw unit. Expected residents: Calorie(s).';
