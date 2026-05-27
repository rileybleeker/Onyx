-- =============================================================================
-- visibility into rows that pds.unit_to_mg_factor drops
-- =============================================================================
-- The unit conversion function returns NULL for any unit it doesn't recognise
-- (e.g. 'IU' which needs vitamin-specific factors, or 'Calorie(s)' which isn't
-- a mass at all). Those rows silently disappear from per-compound rollup views.
-- This view exposes the drop so a future enrichment effort knows what to add.
--
-- Companion to: sql/supplements_unii_cleanup.sql (unit_to_mg_factor itself).
-- =============================================================================

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
WHERE pds.unit_to_mg_factor(ing->>'unit') IS NULL
  AND ing ? 'unit'
  AND COALESCE(ing->>'unit', '') <> ''
GROUP BY p.product_id, p.brand_name, p.full_name,
         ing->>'ingredient_group', ing->>'unit', ing->>'unii_code'
ORDER BY intake_count DESC NULLS LAST, last_seen DESC NULLS LAST;

COMMENT ON VIEW pds.supplement_intake_unmapped IS
'Surfaces every (product, ingredient, unit) combination where unit_to_mg_factor returned NULL — i.e. rows silently dropped from per-compound rollups. Use this to prioritise which unit codes need vitamin-specific conversion logic. Most-common drop today is IU (Vit D / A / E).';
