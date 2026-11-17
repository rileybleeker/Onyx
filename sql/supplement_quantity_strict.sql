-- =============================================================================
-- Strict quantity filter for pds.supplement_intake_by_compound (2026-11-16)
-- =============================================================================
-- The rollup's filter '(ing->>''quantity'') ~ ''^[0-9.]+$''' checked only the
-- character set, so a label typo like '1.2.3' passed it and the ::numeric cast
-- failed at query time — taking the whole view (and every reader with it:
-- daily_supplement_matrix, daily_micronutrient_totals, melatonin_unified,
-- /supplements) down. The strict filter keeps the old intent — accept '10',
-- '0.5' and '.5' (at least one digit, at most one dot) — and rejects '1.2.3',
-- '1..', '.5.5' and '.':
--     (ing->>'quantity') ~ '^[0-9]*\.?[0-9]+$'
-- isQuantified in frontend/src/lib/supplement-units.ts mirrors the same
-- pattern; frontend/tests/supplement-units.test.cjs checks the two stay
-- identical.
--
-- Additive migration: CREATE OR REPLACE VIEW with the identical output column
-- list and order of sql/supplement_iu_conversion.sql; no dependency changes.
-- =============================================================================

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
      -- strict numeric: at most one dot and at least one digit, so '1.2.3'
      -- can never reach the ::numeric casts above
      AND (ing.value->>'quantity') ~ '^[0-9]*\.?[0-9]+$'
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