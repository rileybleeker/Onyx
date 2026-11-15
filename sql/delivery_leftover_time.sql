-- ============================================================
-- Onyx: WHEN an Uber Eats leftover was eaten (2026-11-14)
-- ============================================================
-- Follows sql/delivery_item_leftovers.sql. A leftover answer can now carry
-- the clock time it was eaten:
--
--   eaten_time  TIME         the wall-clock time Riley entered ("19:30"),
--                            in the time zone of that day. A time before
--                            06:00 is the small hours that CLOSE the day
--                            (awake tail): 01:30 on behavioral day D is
--                            01:30 on calendar day D+1.
--   eaten_at    TIMESTAMPTZ  the instant, computed by the guard trigger from
--                            (eaten_date, eaten_time) and pds.tz_for_instant
--                            at noon ET of that day. Never sent by a client.
--
-- A time needs an amount eaten (fraction > 0) and cannot be in the future
-- (5 min slack): SQLSTATE OXL05.
--
-- pds.delivery_daily (HRV pipeline input) now also lists leftover meals:
--   * leftover_meal_count / untimed_leftover_meal_count (appended): one meal
--     per (day, order, time) with a food dish eaten that day;
--   * first/last meal time, late_meal_delivery and the gap to sleep include
--     TIMED leftover meals (late = eaten 22:00-05:59 local);
--   * order_count, meal_order_count, untimed_meal_order_count and merchants
--     stay receipts only.
-- hrv_analysis.merge_delivery_features adds the two counts to the receipt
-- counts. An untimed leftover meal leaves the day's late flag unknown unless
-- another meal that day is known to be late (same rule as untimed receipts).
--
-- Additive only (CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE pds.delivery_item_leftovers ADD COLUMN IF NOT EXISTS eaten_time TIME;
ALTER TABLE pds.delivery_item_leftovers ADD COLUMN IF NOT EXISTS eaten_at   TIMESTAMPTZ;

COMMENT ON COLUMN pds.delivery_item_leftovers.eaten_time IS
    'Wall-clock time the leftover was eaten, as entered (local time of that day; before 06:00 = the small hours after the behavioral day). NULL = not given.';
COMMENT ON COLUMN pds.delivery_item_leftovers.eaten_at IS
    'Instant the leftover was eaten, computed by the guard trigger from eaten_date + eaten_time and pds.tz_for_instant. NULL when eaten_time is NULL.';

CREATE OR REPLACE FUNCTION pds.delivery_item_leftovers_guard()
RETURNS TRIGGER AS $$
DECLARE
    parent   RECORD;
    others   NUMERIC;
    tz       TEXT;
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

    IF NEW.eaten_time IS NULL THEN
        NEW.eaten_at := NULL;
    ELSE
        IF NEW.fraction <= 0 THEN
            RAISE EXCEPTION 'a time needs an amount eaten' USING ERRCODE = 'OXL05';
        END IF;
        tz := COALESCE(pds.tz_for_instant((NEW.eaten_date + time '12:00') AT TIME ZONE 'America/New_York'),
                       'America/New_York');
        NEW.eaten_at := ((NEW.eaten_date + CASE WHEN NEW.eaten_time < time '06:00' THEN 1 ELSE 0 END)
                         + NEW.eaten_time) AT TIME ZONE tz;
        IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
            RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXL05';
        END IF;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── HRV pipeline input: receipts + leftover meals ───────────
CREATE OR REPLACE VIEW pds.delivery_daily AS
WITH uneaten AS (
    SELECT DISTINCT receipt_order_id AS order_id
      FROM pds.delivery_uneaten_meal_orders
     WHERE receipt_order_id IS NOT NULL
), leftover_meals AS (
    SELECT l.eaten_date,
           i.order_uuid,
           min(i.store_name) AS merchant_name,
           l.eaten_at,
           l.eaten_time
      FROM pds.delivery_item_leftovers l
      JOIN pds.delivery_order_items i ON i.item_id = l.item_id
      LEFT JOIN pds.delivery_item_nutrition n ON n.est_key = i.est_key
     WHERE l.fraction > 0
       AND i.merchant_kind = 'restaurant'
       AND NOT i.is_cancelled
       AND COALESCE(n.kind, 'food') = 'food'
     GROUP BY l.eaten_date, i.order_uuid, l.eaten_at, l.eaten_time
), o AS (
    SELECT d.order_id,
           d.merchant_name,
           d.merchant_kind,
           d.time_source,
           d.onyx_behavioral_date,
           COALESCE(d.delivered_at, d.ordered_at)       AS event_time,
           COALESCE(d.delivered_local, d.ordered_local) AS event_local,
           (d.merchant_kind = 'restaurant' AND u.order_id IS NULL)     AS is_meal,
           (d.merchant_kind = 'restaurant' AND u.order_id IS NOT NULL) AS is_uneaten_meal,
           FALSE                                                       AS is_leftover
      FROM pds.delivery_orders d
      LEFT JOIN uneaten u ON u.order_id = d.order_id
     WHERE d.status = 'delivered'
       AND d.onyx_behavioral_date IS NOT NULL
    UNION ALL
    SELECT NULL::bigint,
           lm.merchant_name,
           'restaurant',
           'leftover',
           lm.eaten_date,
           lm.eaten_at,
           CASE WHEN lm.eaten_time IS NULL THEN NULL
                ELSE (lm.eaten_date + CASE WHEN lm.eaten_time < time '06:00' THEN 1 ELSE 0 END) + lm.eaten_time
           END,
           TRUE,
           FALSE,
           TRUE
      FROM leftover_meals lm
), sleep AS (
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           min(ws.start_time)       AS sleep_start
      FROM pds.whoop_main_cycle_per_behavioral_date wcm
      JOIN pds.whoop_sleep ws ON ws.cycle_id = wcm.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'
     GROUP BY wcm.onyx_behavioral_date
), agg AS (
    SELECT o.onyx_behavioral_date AS behavioral_date,
           count(*) FILTER (WHERE NOT o.is_leftover) AS order_count,
           count(*) FILTER (WHERE o.is_meal AND NOT o.is_leftover) AS meal_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'alcohol') AS alcohol_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'store') AS store_order_count,
           count(*) FILTER (WHERE o.is_meal AND NOT o.is_leftover AND o.event_time IS NULL) AS untimed_meal_order_count,
           min(o.event_time) FILTER (WHERE o.is_meal) AS first_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.is_meal) AS last_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.is_meal AND o.event_time < sl.sleep_start) AS last_meal_before_sleep,
           bool_or(EXTRACT(hour FROM o.event_local) >= 22 OR EXTRACT(hour FROM o.event_local) < 6)
               FILTER (WHERE o.is_meal AND o.event_local IS NOT NULL) AS late_meal_delivery,
           COALESCE(bool_or(o.time_source = 'payment_estimate'), false) AS has_estimated_time,
           string_agg(o.merchant_name, ' | ' ORDER BY o.event_time, o.order_id) FILTER (WHERE NOT o.is_leftover) AS merchants,
           min(sl.sleep_start) AS sleep_start,
           count(*) FILTER (WHERE o.is_uneaten_meal) AS uneaten_meal_order_count,
           count(*) FILTER (WHERE o.is_leftover) AS leftover_meal_count,
           count(*) FILTER (WHERE o.is_leftover AND o.event_time IS NULL) AS untimed_leftover_meal_count
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
       uneaten_meal_order_count,
       leftover_meal_count,
       untimed_leftover_meal_count
  FROM agg a;

COMMENT ON VIEW pds.delivery_daily IS
    'One row per behavioral day with a delivered Uber Eats order (receipt emails) or a leftover meal (pds.delivery_item_leftovers). order/meal counts and merchants are receipts only and skip orders whose every food dish was marked None (uneaten_meal_order_count); leftover_meal_count / untimed_leftover_meal_count count leftover meals (one per order and time). First/last meal time, late_meal_delivery and the gap to sleep include timed leftover meals.';
