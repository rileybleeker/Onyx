-- ============================================================
-- Onyx: Uber Eats leftovers eaten on a LATER day (2026-11-14)
-- ============================================================
-- pds.delivery_order_items.eaten_fraction records how much of a dish was eaten
-- on the delivery day. Until now the rest simply vanished: half a pizza saved
-- for lunch the next day never reached that day's calories. This adds:
--
--   pds.delivery_item_leftovers   one row per (dish, later behavioral day):
--                                 the share of the WHOLE cart line eaten that
--                                 day, and threw_out = the rest was thrown away
--                                 after that day (stop asking).
--
-- Rules (Riley, 2026-11-14):
--   * Asked only when the delivery-day portion was set below All
--     (eaten_fraction < 1; NULL means All, so nothing is left).
--   * A leftover can be eaten on behavioral days D+1 .. D+3 (D = delivery day),
--     never on a future day. A leftover never answered in that window counts
--     as THROWN OUT: it adds nothing anywhere.
--   * delivery-day portion + all leftover rows <= the whole dish.
--   * fraction 0 + threw_out false = "not today" (still have it);
--     threw_out true closes the dish (no row may follow it).
--
-- Consumers changed here:
--   * pds.delivery_nutrition_daily adds each leftover on the day it was eaten
--     (same columns, same order, + leftover_lines appended).
--   * pds.delivery_uneaten_meal_orders (new): orders whose every food dish was
--     marked None on the delivery day, matched to their receipt in
--     pds.delivery_orders (same behavioral day, nearest delivery time, at most
--     2 h apart; live check 2026-11-14: median gap 0.6 min, 205 of 210 within
--     90 min).
--   * pds.delivery_daily (HRV pipeline input) no longer counts such a receipt
--     as a meal: meal counts, first/last meal time, late-meal flag and the gap
--     to sleep skip it (same columns, + uneaten_meal_order_count appended).
--     Leftovers carry no clock time, so they never enter the timing features.
--
-- Writes: PUT /api/delivery/items/[itemId]/leftovers (owner session only).
-- Guards live in triggers so every write path obeys them. Errors use custom
-- SQLSTATEs the API maps to 409 messages (OXL01 too much, OXL02 window,
-- OXL03 nothing left, OXL04 after a thrown-out day).
--
-- Additive only: CREATE OR REPLACE, no DROP (the Supabase connector declines
-- migrations containing one). Neither view has database dependents.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.delivery_item_leftovers (
    item_id     BIGINT  NOT NULL REFERENCES pds.delivery_order_items (item_id) ON DELETE CASCADE,
    eaten_date  DATE    NOT NULL,             -- behavioral day the leftover was eaten
    fraction    NUMERIC NOT NULL,             -- share of the WHOLE cart line eaten that day
    threw_out   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_id, eaten_date),
    CONSTRAINT delivery_item_leftovers_fraction_check CHECK (fraction >= 0 AND fraction <= 1)
);

COMMENT ON TABLE pds.delivery_item_leftovers IS
    'Leftovers of an Uber Eats cart line eaten on a later behavioral day (D+1..D+3). fraction = share of the whole line eaten that day; threw_out = the rest was discarded after that day. Unanswered leftovers count as thrown out. Set on /check-in and /nutrition.';

CREATE INDEX IF NOT EXISTS idx_delivery_item_leftovers_date ON pds.delivery_item_leftovers (eaten_date);

-- ── Guard on the leftover rows ──────────────────────────────
CREATE OR REPLACE FUNCTION pds.delivery_item_leftovers_guard()
RETURNS TRIGGER AS $$
DECLARE
    parent   RECORD;
    others   NUMERIC;
BEGIN
    -- Lock the dish so two writes for it are checked one after the other.
    SELECT onyx_behavioral_date, eaten_fraction
      INTO parent
      FROM pds.delivery_order_items
     WHERE item_id = NEW.item_id
       FOR UPDATE;

    IF parent.eaten_fraction IS NULL OR parent.eaten_fraction >= 1 THEN
        RAISE EXCEPTION 'nothing left: the delivery-day portion is All' USING ERRCODE = 'OXL03';
    END IF;
    IF parent.onyx_behavioral_date IS NULL
       OR NEW.eaten_date <= parent.onyx_behavioral_date
       OR NEW.eaten_date >  parent.onyx_behavioral_date + 3
       OR NEW.eaten_date >  pds.behavioral_today_now() THEN
        RAISE EXCEPTION 'leftover day outside D+1..D+3 or in the future' USING ERRCODE = 'OXL02';
    END IF;

    SELECT COALESCE(sum(fraction), 0)
      INTO others
      FROM pds.delivery_item_leftovers
     WHERE item_id = NEW.item_id
       AND eaten_date <> NEW.eaten_date;
    IF parent.eaten_fraction + others + NEW.fraction > 1.000001 THEN
        RAISE EXCEPTION 'portions add up to more than the whole dish' USING ERRCODE = 'OXL01';
    END IF;

    IF EXISTS (SELECT 1 FROM pds.delivery_item_leftovers
                WHERE item_id = NEW.item_id AND threw_out AND eaten_date < NEW.eaten_date)
       OR (NEW.threw_out AND EXISTS (SELECT 1 FROM pds.delivery_item_leftovers
                WHERE item_id = NEW.item_id AND eaten_date > NEW.eaten_date)) THEN
        RAISE EXCEPTION 'a leftover cannot follow the day it was thrown out' USING ERRCODE = 'OXL04';
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER delivery_item_leftovers_guard
    BEFORE INSERT OR UPDATE ON pds.delivery_item_leftovers
    FOR EACH ROW EXECUTE FUNCTION pds.delivery_item_leftovers_guard();

-- ── Guard on the delivery-day portion once leftovers exist ──
-- Fires only when eaten_fraction itself changes (the harvester never sends it).
CREATE OR REPLACE FUNCTION pds.delivery_order_items_leftover_guard()
RETURNS TRIGGER AS $$
DECLARE
    later NUMERIC;
BEGIN
    SELECT sum(fraction) INTO later FROM pds.delivery_item_leftovers WHERE item_id = NEW.item_id;
    IF later IS NOT NULL AND (NEW.eaten_fraction IS NULL OR NEW.eaten_fraction + later > 1.000001) THEN
        RAISE EXCEPTION 'leftovers of this dish are saved on a later day' USING ERRCODE = 'OXL01';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER delivery_order_items_leftover_guard
    BEFORE UPDATE OF eaten_fraction ON pds.delivery_order_items
    FOR EACH ROW
    WHEN (NEW.eaten_fraction IS DISTINCT FROM OLD.eaten_fraction)
    EXECUTE FUNCTION pds.delivery_order_items_leftover_guard();

-- ── Access: owner reads in the browser, service role writes ─
ALTER TABLE pds.delivery_item_leftovers ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON pds.delivery_item_leftovers FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
CREATE POLICY service_full_access ON pds.delivery_item_leftovers FOR ALL TO service_role
    USING (true) WITH CHECK (true);
GRANT SELECT ON pds.delivery_item_leftovers TO authenticated;
GRANT ALL    ON pds.delivery_item_leftovers TO service_role;

-- ── Calories: each portion on the day it was eaten ──────────
CREATE OR REPLACE VIEW pds.delivery_nutrition_daily AS
WITH portions AS (
    SELECT i.onyx_behavioral_date                       AS behavioral_date,
           i.order_uuid,
           i.est_key,
           i.multi_consumer,
           i.quantity * COALESCE(i.eaten_fraction, 1)   AS units,
           FALSE                                        AS is_leftover
      FROM pds.delivery_order_items i
     WHERE i.merchant_kind = 'restaurant'
       AND NOT i.is_cancelled
       AND i.onyx_behavioral_date IS NOT NULL
    UNION ALL
    SELECT l.eaten_date,
           NULL::text,
           i.est_key,
           i.multi_consumer,
           i.quantity * l.fraction,
           TRUE
      FROM pds.delivery_item_leftovers l
      JOIN pds.delivery_order_items i ON i.item_id = l.item_id
     WHERE i.merchant_kind = 'restaurant'
       AND NOT i.is_cancelled
       AND l.fraction > 0
)
SELECT p.behavioral_date,
       count(DISTINCT p.order_uuid)                                   AS order_count,
       count(*) FILTER (WHERE NOT p.is_leftover)                      AS item_lines,
       count(*) FILTER (WHERE n.est_key IS NULL)                      AS unestimated_lines,
       count(*) FILTER (WHERE n.confidence = 'low')                   AS low_confidence_lines,
       bool_or(p.multi_consumer)                                      AS has_group_order,
       round(sum(p.units * n.kcal)      FILTER (WHERE n.kind IN ('food', 'drink')))    AS est_kcal,
       round(sum(p.units * n.protein_g) FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_protein_g,
       round(sum(p.units * n.carbs_g)   FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_carbs_g,
       round(sum(p.units * n.fat_g)     FILTER (WHERE n.kind IN ('food', 'drink')), 1) AS est_fat_g,
       round(sum(p.units * n.alcohol_g) FILTER (WHERE n.kind = 'alcohol'), 1)          AS est_alcohol_g_with_meal,
       count(*) FILTER (WHERE p.is_leftover)                          AS leftover_lines
  FROM portions p
  LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = p.est_key
 GROUP BY p.behavioral_date;

COMMENT ON VIEW pds.delivery_nutrition_daily IS
    'Per behavioral day: ESTIMATED kcal / macros from delivered restaurant orders. Delivery-day portion (quantity x eaten_fraction, NULL = all) on the delivery day, plus leftovers (pds.delivery_item_leftovers) on the day they were eaten. Unanswered leftovers count as thrown out. Store / package-store orders are excluded.';

-- ── Orders nobody ate on the delivery day ───────────────────
CREATE OR REPLACE VIEW pds.delivery_uneaten_meal_orders AS
WITH item_orders AS (
    SELECT i.order_uuid,
           min(i.store_name)             AS store_name,
           min(i.completed_at)           AS completed_at,
           min(i.onyx_behavioral_date)   AS behavioral_date,
           count(*) FILTER (WHERE COALESCE(n.kind, 'food') = 'food')                          AS food_lines,
           count(*) FILTER (WHERE COALESCE(n.kind, 'food') = 'food' AND i.eaten_fraction = 0) AS uneaten_food_lines
      FROM pds.delivery_order_items i
      LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = i.est_key
     WHERE i.merchant_kind = 'restaurant'
       AND NOT i.is_cancelled
       AND i.completed_at IS NOT NULL
     GROUP BY i.order_uuid
)
SELECT io.order_uuid,
       io.store_name,
       io.completed_at,
       io.behavioral_date,
       r.order_id AS receipt_order_id
  FROM item_orders io
  LEFT JOIN LATERAL (
        SELECT o.order_id
          FROM pds.delivery_orders o
         WHERE o.status = 'delivered'
           AND o.merchant_kind = 'restaurant'
           AND o.onyx_behavioral_date = io.behavioral_date
           AND o.delivered_at IS NOT NULL
           AND abs(extract(epoch FROM o.delivered_at - io.completed_at)) <= 7200
         ORDER BY abs(extract(epoch FROM o.delivered_at - io.completed_at)), o.order_id
         LIMIT 1
       ) r ON TRUE
 WHERE io.food_lines > 0
   AND io.uneaten_food_lines = io.food_lines;

COMMENT ON VIEW pds.delivery_uneaten_meal_orders IS
    'Uber Eats orders whose every food dish was marked None on the delivery day (eaten_fraction = 0; a dish with no estimate counts as food), with the matching receipt in pds.delivery_orders (same behavioral day, nearest delivery time within 2 h; NULL when none). pds.delivery_daily does not count those receipts as meals.';

-- ── HRV pipeline input: an uneaten order is not a meal ──────
CREATE OR REPLACE VIEW pds.delivery_daily AS
WITH uneaten AS (
    SELECT DISTINCT receipt_order_id AS order_id
      FROM pds.delivery_uneaten_meal_orders
     WHERE receipt_order_id IS NOT NULL
), o AS (
    SELECT d.order_id,
           d.merchant_name,
           d.merchant_kind,
           d.time_source,
           d.onyx_behavioral_date,
           COALESCE(d.delivered_at, d.ordered_at)       AS event_time,
           COALESCE(d.delivered_local, d.ordered_local) AS event_local,
           (d.merchant_kind = 'restaurant' AND u.order_id IS NULL)     AS is_meal,
           (d.merchant_kind = 'restaurant' AND u.order_id IS NOT NULL) AS is_uneaten_meal
      FROM pds.delivery_orders d
      LEFT JOIN uneaten u ON u.order_id = d.order_id
     WHERE d.status = 'delivered'
       AND d.onyx_behavioral_date IS NOT NULL
), sleep AS (
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           min(ws.start_time)       AS sleep_start
      FROM pds.whoop_main_cycle_per_behavioral_date wcm
      JOIN pds.whoop_sleep ws ON ws.cycle_id = wcm.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'
     GROUP BY wcm.onyx_behavioral_date
), agg AS (
    SELECT o.onyx_behavioral_date AS behavioral_date,
           count(*) AS order_count,
           count(*) FILTER (WHERE o.is_meal) AS meal_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'alcohol') AS alcohol_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'store') AS store_order_count,
           count(*) FILTER (WHERE o.is_meal AND o.event_time IS NULL) AS untimed_meal_order_count,
           min(o.event_time) FILTER (WHERE o.is_meal) AS first_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.is_meal) AS last_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.is_meal AND o.event_time < sl.sleep_start) AS last_meal_before_sleep,
           bool_or(EXTRACT(hour FROM o.event_local) >= 22 OR EXTRACT(hour FROM o.event_local) < 6)
               FILTER (WHERE o.is_meal AND o.event_local IS NOT NULL) AS late_meal_delivery,
           COALESCE(bool_or(o.time_source = 'payment_estimate'), false) AS has_estimated_time,
           string_agg(o.merchant_name, ' | ' ORDER BY o.event_time, o.order_id) AS merchants,
           min(sl.sleep_start) AS sleep_start,
           count(*) FILTER (WHERE o.is_uneaten_meal) AS uneaten_meal_order_count
      FROM o
      LEFT JOIN sleep sl ON sl.behavioral_date = o.onyx_behavioral_date
     GROUP BY o.onyx_behavioral_date
)
SELECT behavioral_date,
       order_count,
       meal_order_count,
       alcohol_order_count,
       store_order_count,
       untimed_meal_order_count,
       first_meal_delivery_time,
       last_meal_delivery_time,
       late_meal_delivery,
       sleep_start,
       round(EXTRACT(epoch FROM sleep_start - last_meal_before_sleep) / 60.0, 1) AS last_meal_delivery_to_sleep_minutes,
       has_estimated_time,
       merchants,
       uneaten_meal_order_count
  FROM agg a;

COMMENT ON VIEW pds.delivery_daily IS
    'One row per behavioral day with a delivered Uber Eats order (receipt emails). Meal counts and timing skip restaurant orders whose every food dish was marked None on the delivery day (pds.delivery_uneaten_meal_orders); uneaten_meal_order_count counts those.';

-- The two replaced views keep their existing grants (authenticated + service_role).
GRANT SELECT ON pds.delivery_uneaten_meal_orders TO service_role;
