-- ============================================================
-- Onyx — Delivery items: record how much of an order was EATEN
-- (2026-11-11, devops agent; Riley ate 1/4 of the 2026-11-10 pizza)
-- ============================================================
-- pds.delivery_nutrition_daily counted every delivered dish as fully eaten
-- (quantity x per-unit estimate), so leftovers overcounted with no way to
-- correct a day. This adds ONE nullable column on the cart line:
--
--   eaten_fraction  NULL = eaten in full (default, every existing row)
--                   0.25 = a quarter of the line was eaten, etc.
--
-- It lives on the order line, NOT on pds.delivery_item_nutrition: the dish
-- estimate is shared by every order of the same dish, and a portion belongs
-- to one meal. The Uber Eats importer (/api/delivery/items/import) upserts
-- only the columns it sends, so a hand-set eaten_fraction survives re-harvests.
-- Setting it changes the existing row in place: no second entry, nothing to
-- double-count.
--
-- Column-level only + CREATE OR REPLACE of the view with the SAME columns in
-- the SAME order. No DROP. delivery_nutrition_daily has no DB dependents
-- (read only by frontend getNutrition), so no matview rebuild is needed.
-- ============================================================

ALTER TABLE pds.delivery_order_items
    ADD COLUMN IF NOT EXISTS eaten_fraction NUMERIC;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_order_items_eaten_fraction_check') THEN
        ALTER TABLE pds.delivery_order_items
            ADD CONSTRAINT delivery_order_items_eaten_fraction_check
            CHECK (eaten_fraction IS NULL OR (eaten_fraction >= 0 AND eaten_fraction <= 1));
    END IF;
END $$;

COMMENT ON COLUMN pds.delivery_order_items.eaten_fraction IS
    'Share of this cart line that was actually eaten (0-1). NULL = all of it. Set by hand for leftovers / shared food; the importer never writes it. Multiplies the per-dish estimate in delivery_nutrition_daily.';

CREATE OR REPLACE VIEW pds.delivery_nutrition_daily AS
SELECT i.onyx_behavioral_date                                              AS behavioral_date,
       count(DISTINCT i.order_uuid)                                        AS order_count,
       count(*)                                                            AS item_lines,
       count(*) FILTER (WHERE n.est_key IS NULL)                           AS unestimated_lines,
       count(*) FILTER (WHERE n.confidence = 'low')                        AS low_confidence_lines,
       bool_or(i.multi_consumer)                                           AS has_group_order,
       round(sum(i.quantity * coalesce(i.eaten_fraction, 1) * n.kcal)      FILTER (WHERE n.kind IN ('food', 'drink')))    AS est_kcal,
       round(sum(i.quantity * coalesce(i.eaten_fraction, 1) * n.protein_g) FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_protein_g,
       round(sum(i.quantity * coalesce(i.eaten_fraction, 1) * n.carbs_g)   FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_carbs_g,
       round(sum(i.quantity * coalesce(i.eaten_fraction, 1) * n.fat_g)     FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_fat_g,
       round(sum(i.quantity * coalesce(i.eaten_fraction, 1) * n.alcohol_g) FILTER (WHERE n.kind = 'alcohol'), 1)          AS est_alcohol_g_with_meal
  FROM pds.delivery_order_items i
  LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = i.est_key
 WHERE i.merchant_kind = 'restaurant'
   AND NOT i.is_cancelled
   AND i.onyx_behavioral_date IS NOT NULL
 GROUP BY i.onyx_behavioral_date;

COMMENT ON VIEW pds.delivery_nutrition_daily IS
    'Per behavioral day: ESTIMATED kcal / macros from delivered restaurant orders (quantity x eaten_fraction x per-dish estimate; eaten_fraction NULL = all). Shared orders still overcount unless eaten_fraction is set. Store / package-store orders are excluded.';

-- ------------------------------------------------------------
-- One-off data fix (run separately, after the migration):
-- Riley ate 1/4 of the San Gennaro pizza delivered the evening of 2026-11-10.
-- Expect exactly 1 row updated.
--
-- UPDATE pds.delivery_order_items
--    SET eaten_fraction = 0.25
--  WHERE provider = 'uber_eats'
--    AND onyx_behavioral_date = '2026-11-10'
--    AND store_name ILIKE 'Antico%'
--    AND title ILIKE '%San Gennaro%';
-- ------------------------------------------------------------
