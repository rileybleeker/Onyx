-- ============================================================
-- Onyx — Delivery order ITEMS + estimated nutrition (Uber Eats harvester)
-- ============================================================
-- Receipt emails (pds.delivery_orders) carry no line items. The signed-in
-- Uber Eats web app does: POST https://www.ubereats.com/_p/api/getPastOrdersV1
-- returns, per order, the store, exact completion time and every cart item
-- (title, quantity, price, customizations). tools/ubereats_harvest/harvest.mjs
-- reads that from a signed-in Chrome profile on Riley's PC and posts it to
-- /api/delivery/items/import, which writes these tables.
--
--   pds.delivery_order_items      one row per cart line (FACTS only)
--   pds.delivery_item_nutrition   one row per distinct dish (est_key = hash of
--                                 store | title | customizations) holding the
--                                 ESTIMATE for ONE unit: kcal + macros, made by
--                                 Claude from the dish name. Repeat orders of
--                                 the same dish are estimated once.
--   pds.delivery_items_unestimated  work queue for the estimator
--   pds.delivery_nutrition_daily    per behavioral day: estimated kcal/macros
--                                   from restaurant orders
--
-- These numbers are ESTIMATES from dish names — good for "big / small day"
-- and macro shape, not for gram-level tracking. Micronutrients are not
-- estimated. Ordered is not eaten: leftovers and shared orders overcount
-- (multi_consumer flags group orders). Store / package-store orders are kept
-- as rows but excluded from the daily totals (a bottle is not one day's intake).
--
-- No DROP statements anywhere (the Supabase connector declines migrations that
-- contain one when nobody can confirm).
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.delivery_order_items (
    item_id               BIGSERIAL PRIMARY KEY,
    provider              TEXT NOT NULL DEFAULT 'uber_eats',
    order_uuid            TEXT NOT NULL,           -- Uber order uuid
    item_key              TEXT NOT NULL,           -- shoppingCartItemUuid (stable per cart line)

    store_name            TEXT NOT NULL,
    merchant_kind         TEXT NOT NULL DEFAULT 'restaurant',  -- restaurant | alcohol | store (same keyword rule as delivery_orders)
    completed_at          TIMESTAMPTZ,             -- exact delivery instant from the API
    is_cancelled          BOOLEAN NOT NULL DEFAULT FALSE,
    order_total           NUMERIC(10,2),
    currency              TEXT,
    multi_consumer        BOOLEAN NOT NULL DEFAULT FALSE,      -- group order: items belong to more than one person

    title                 TEXT NOT NULL,
    quantity              NUMERIC NOT NULL DEFAULT 1,
    price                 NUMERIC(10,2),           -- unit price as listed
    customizations        JSONB,                   -- [{title, options:[...]}]
    est_key               TEXT NOT NULL,           -- → pds.delivery_item_nutrition

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,

    CONSTRAINT delivery_order_items_uniq       UNIQUE (provider, order_uuid, item_key),
    CONSTRAINT delivery_order_items_kind_check CHECK (merchant_kind IN ('restaurant', 'alcohol', 'store'))
);

COMMENT ON TABLE pds.delivery_order_items IS
    'One row per Uber Eats cart line, harvested from the signed-in web app (tools/ubereats_harvest). Facts only; the per-dish nutrition estimate lives in pds.delivery_item_nutrition (join on est_key).';

CREATE INDEX IF NOT EXISTS idx_delivery_order_items_behavioral ON pds.delivery_order_items (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_delivery_order_items_est_key    ON pds.delivery_order_items (est_key);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_delivery_order_items()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    NEW.synced_at := NOW();
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.completed_at, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER delivery_order_items_set_onyx_dates
    BEFORE INSERT OR UPDATE ON pds.delivery_order_items
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_delivery_order_items();

CREATE TABLE IF NOT EXISTS pds.delivery_item_nutrition (
    est_key               TEXT PRIMARY KEY,        -- sha256(store | title | customizations)
    store_name            TEXT NOT NULL,
    title                 TEXT NOT NULL,
    customizations_text   TEXT,
    kind                  TEXT NOT NULL,           -- food | drink | alcohol | non_food
    kcal                  NUMERIC,                 -- ONE unit, as sold, with the listed customizations
    protein_g             NUMERIC,
    carbs_g               NUMERIC,
    fat_g                 NUMERIC,
    alcohol_g             NUMERIC,
    confidence            TEXT NOT NULL,           -- high | medium | low
    basis                 TEXT NOT NULL,           -- published (chain's own numbers) | typical (dish-type estimate)
    model                 TEXT NOT NULL,
    estimated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT delivery_item_nutrition_kind_check CHECK (kind IN ('food', 'drink', 'alcohol', 'non_food')),
    CONSTRAINT delivery_item_nutrition_conf_check CHECK (confidence IN ('high', 'medium', 'low'))
);

COMMENT ON TABLE pds.delivery_item_nutrition IS
    'Claude-estimated nutrition for ONE unit of a distinct delivered dish (keyed by est_key). Estimates from the dish name, not measurements; hand-correct a row with an UPDATE and it will not be re-estimated.';

-- Work queue: distinct dishes that have no estimate yet.
CREATE OR REPLACE VIEW pds.delivery_items_unestimated AS
SELECT DISTINCT ON (i.est_key)
       i.est_key, i.store_name, i.merchant_kind, i.title, i.customizations, i.price, i.currency
  FROM pds.delivery_order_items i
  LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = i.est_key
 WHERE n.est_key IS NULL
 ORDER BY i.est_key, i.completed_at DESC NULLS LAST;

-- Per behavioral day: estimated intake from delivered RESTAURANT orders.
CREATE OR REPLACE VIEW pds.delivery_nutrition_daily AS
SELECT i.onyx_behavioral_date                                              AS behavioral_date,
       count(DISTINCT i.order_uuid)                                        AS order_count,
       count(*)                                                            AS item_lines,
       count(*) FILTER (WHERE n.est_key IS NULL)                           AS unestimated_lines,
       count(*) FILTER (WHERE n.confidence = 'low')                        AS low_confidence_lines,
       bool_or(i.multi_consumer)                                           AS has_group_order,
       round(sum(i.quantity * n.kcal)      FILTER (WHERE n.kind IN ('food', 'drink')))    AS est_kcal,
       round(sum(i.quantity * n.protein_g) FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_protein_g,
       round(sum(i.quantity * n.carbs_g)   FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_carbs_g,
       round(sum(i.quantity * n.fat_g)     FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_fat_g,
       round(sum(i.quantity * n.alcohol_g) FILTER (WHERE n.kind = 'alcohol'), 1)          AS est_alcohol_g_with_meal
  FROM pds.delivery_order_items i
  LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = i.est_key
 WHERE i.merchant_kind = 'restaurant'
   AND NOT i.is_cancelled
   AND i.onyx_behavioral_date IS NOT NULL
 GROUP BY i.onyx_behavioral_date;

COMMENT ON VIEW pds.delivery_nutrition_daily IS
    'Per behavioral day: ESTIMATED kcal / macros from delivered restaurant orders (quantity x per-dish estimate). Ordered, not eaten — leftovers and shared orders overcount. Store / package-store orders are excluded.';

ALTER TABLE pds.delivery_order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.delivery_item_nutrition ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read"           ON pds.delivery_order_items    FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.delivery_order_items    FOR ALL    TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_read"           ON pds.delivery_item_nutrition FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.delivery_item_nutrition FOR ALL    TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pds.delivery_order_items, pds.delivery_item_nutrition TO anon, authenticated;
GRANT ALL    ON pds.delivery_order_items, pds.delivery_item_nutrition TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.delivery_order_items_item_id_seq TO service_role;
GRANT SELECT ON pds.delivery_items_unestimated, pds.delivery_nutrition_daily TO anon, authenticated, service_role;
