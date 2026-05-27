-- =============================================================================
-- Supplements: UNII data validity + cross-brand rollup fixes (2026-05-25)
-- =============================================================================
-- Closes Notion roadmap item "Supplements: UNII data validity + cross-brand
-- rollup fixes" (page 369bf5b44bf281e481a3c98ff7471f01). Four issues audited
-- 2026-05-23; this migration ships fixes for #1-#3 + regression check.
-- Issue #4 (UNII curated backfill) deferred — task explicitly says "should
-- NOT be model-guessed; needs verified codes per compound."
--
-- Fixes shipped:
--   1. View GROUP BY rewrite: drops category from grouping so same-compound
--      across-brand rows roll up. Aggregates name/category as arrays for
--      traceability.
--   2. Spelling drift: "Alpha Lipoic Acid" → "Alpha-Lipoic Acid" canonical.
--   3. Bogus UNII sentinels (unii_code = '0' or '1'): removed.
--   5. Regression check view: pds.supplement_unii_sentinel_check.
--
-- Plus follow-up: unit normalization. Cross-brand same-compound rollup
-- needed mass-unit conversion to mg so "3 Gram(s)" + "1000 mg" sum to
-- 4000 mg instead of staying as two rows.
-- =============================================================================

-- ----- Issue 3: drop bogus UNII sentinels --------------------------------
UPDATE pds.supplement_products
SET ingredients = (
  SELECT jsonb_agg(
    CASE WHEN ing->>'unii_code' IN ('0', '1') THEN ing - 'unii_code' ELSE ing END
  )
  FROM jsonb_array_elements(ingredients) ing
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(ingredients) ing
  WHERE ing->>'unii_code' IN ('0', '1')
);

-- ----- Issue 2: canonicalize "Alpha Lipoic Acid" → "Alpha-Lipoic Acid" --
UPDATE pds.supplement_products
SET ingredients = (
  SELECT jsonb_agg(
    CASE WHEN ing->>'ingredient_group' = 'Alpha Lipoic Acid'
         THEN jsonb_set(ing, '{ingredient_group}', '"Alpha-Lipoic Acid"')
         ELSE ing END
  )
  FROM jsonb_array_elements(ingredients) ing
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(ingredients) ing
  WHERE ing->>'ingredient_group' = 'Alpha Lipoic Acid'
);

-- ----- Unit normalization helper ----------------------------------------
-- added 'mcgdfe' (Dietary Folate Equivalent) and
-- 'mcgrae' (Retinol Activity Equivalent) which previously silently returned
-- NULL. Both equivalence units are treated as mcg for our purposes — exact
-- DFE/RAE conversion would need source-form-specific factors (folic acid vs
-- 5-MTHF; preformed retinol vs beta-carotene), which we don't capture per-row.
-- 'IU' still returns NULL: conversion is vitamin-specific (Vit D 1 IU =
-- 0.025 mcg, Vit A 1 IU = 0.3 mcg, Vit E 1 IU = 0.67 mg) and the function
-- has no UNII context. Use pds.supplement_intake_unmapped to surface drops.
CREATE OR REPLACE FUNCTION pds.unit_to_mg_factor(u TEXT)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE REGEXP_REPLACE(LOWER(COALESCE(u, '')), '[^a-zµ]', '', 'g')
        WHEN 'mg'          THEN 1
        WHEN 'milligram'   THEN 1
        WHEN 'milligrams'  THEN 1
        WHEN 'mcgdfe'      THEN 0.001  -- Folate DFE (approximation: treats as mcg)
        WHEN 'mcgrae'      THEN 0.001  -- Vitamin A RAE (approximation: treats as mcg)
        WHEN 'g'           THEN 1000
        WHEN 'gram'        THEN 1000
        WHEN 'grams'       THEN 1000
        WHEN 'mcg'         THEN 0.001
        WHEN 'µg'          THEN 0.001
        WHEN 'microgram'   THEN 0.001
        WHEN 'micrograms'  THEN 0.001
        WHEN 'kg'          THEN 1000000
        WHEN 'kilogram'    THEN 1000000
        WHEN 'kilograms'   THEN 1000000
        ELSE NULL
    END;
$$;

COMMENT ON FUNCTION pds.unit_to_mg_factor(TEXT) IS
'Returns multiplier to convert a mass unit string to milligrams. NULL for non-mass units (IU, mL, count, etc.) — caller keeps those grouped by their original unit separately. Lowercase-then-strip so "Gram(s)" and "GRAMS" both match correctly.';

-- ----- Issue 1 (rewrite) + unit normalization (view) -------------------
DROP VIEW IF EXISTS pds.supplement_intake_by_compound CASCADE;

CREATE VIEW pds.supplement_intake_by_compound AS
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
            pds.unit_to_mg_factor(ing.value->>'unit') AS amount_mg,
        -- 'mass' if convertible to mg; else use the original unit as the
        -- class label so non-mass units (IU, mL, count) stay separated.
        CASE WHEN pds.unit_to_mg_factor(ing.value->>'unit') IS NOT NULL
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

GRANT SELECT ON pds.supplement_intake_by_compound TO anon, authenticated;

-- ----- daily_supplement_matrix (recreated after CASCADE) ----------------
CREATE OR REPLACE VIEW pds.daily_supplement_matrix AS
SELECT
    calendar_date,
    jsonb_object_agg(
        ingredient_group,
        jsonb_build_object('amount', total_amount, 'unit', unit, 'category', categories[1])
    ) AS compounds_jsonb,
    COUNT(DISTINCT compound_key) AS distinct_compounds,
    SUM(total_doses) AS total_doses
FROM pds.supplement_intake_by_compound
WHERE ingredient_group IS NOT NULL
GROUP BY calendar_date;

GRANT SELECT ON pds.daily_supplement_matrix TO anon, authenticated;

-- ----- Issue 5: regression check ----------------------------------------
DROP VIEW IF EXISTS pds.supplement_unii_sentinel_check;
CREATE VIEW pds.supplement_unii_sentinel_check AS
SELECT
    p.product_id, p.brand_name, p.full_name,
    ing.value->>'name' AS ingredient_name,
    ing.value->>'ingredient_group' AS ingredient_group,
    ing.value->>'unii_code' AS bogus_unii
FROM pds.supplement_products p,
     jsonb_array_elements(p.ingredients) ing(value)
WHERE ing.value->>'unii_code' ~ '^[0-9]$'
ORDER BY p.brand_name, p.full_name;
GRANT SELECT ON pds.supplement_unii_sentinel_check TO anon, authenticated;

COMMENT ON VIEW pds.supplement_unii_sentinel_check IS
'Regression check: if this view returns rows, the DSLD parser has regressed and is emitting placeholder UNIIs (0 or 1) again. Should always be empty.';
