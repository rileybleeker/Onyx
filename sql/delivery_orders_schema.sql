-- ============================================================
-- Onyx — Delivery orders (Uber Eats receipt-email ETL) Schema
-- ============================================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
--
-- Uber has no API for a customer's own order history, and the claude.ai Uber
-- Eats connector only searches restaurants. The receipt email Uber sends after
-- every order ("[Personal] Your Monday evening order with Uber Eats", from
-- noreply@uber.com) is the only automatic record — delivery_email_etl.py
-- parses it over IMAP (same shape as flights_email_etl.py).
--
-- Two receipt templates (verified on the full Oct 2022 → Nov 2026 mailbox):
--   Nov 2025 →  merchant, total, ORDER time, pickup time + merchant address,
--               DELIVERY time ("Order completed <date> at <time>"), plus
--               canceled / refunded / tip-only variants.   time_source='receipt'
--   → Nov 2025  merchant, total, order DATE only, and the card-charge time.
--               The charge posts 70 min after delivery in ~81% of orders (the
--               tip window) and the next morning in most of the rest, so
--               delivered_local = charge − 70 min is kept ONLY when it agrees
--               with the subject line's weekday + daypart ("Friday evening
--               order")                              time_source='payment_estimate'
--               otherwise the row keeps just its date + daypart
--                                                    time_source='date_only'
-- Neither template lists the ITEMS — they sit behind the "full receipt" link
-- (Uber login). So this table gives meal TIMING and delivery COUNTS, not
-- calories; item capture is a separate, later piece.
--
-- One row per order, natural key (provider, order_key). An order can produce
-- several emails (receipt, re-issued receipt after a tip change, tip-only
-- receipt, canceled receipt, refund notice) that all carry the same merchant
-- + order time (new template) or merchant + first charge time (old template).
-- Latest email wins; a tip-only receipt never overwrites the order total; a
-- FULL refund flips status to 'refunded' (the order failed — not a meal).
--
-- The receipt prints naive LOCAL wall-clock times. The trigger resolves them
-- to instants with the ADR-0001 ladder (WHOOP cycle offset → user_tz_log → ET)
-- and derives the usual date quad from the delivery instant (order instant
-- when there is no delivery time; the printed order date for date_only rows).
-- The delivery ADDRESS is deliberately not stored (home address; this table
-- is anon-readable like the rest of pds).
--
-- Consumers: pds.delivery_daily (per behavioral day), /status "Delivery" card
-- (delivery|email heartbeat). Not in the HRV matrix yet.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.delivery_orders (
    order_id              BIGSERIAL PRIMARY KEY,

    provider              TEXT NOT NULL DEFAULT 'uber_eats',
    order_key             TEXT NOT NULL,           -- "<merchant>|<order time>" (new template) / "<merchant>|pay:<charge time>" (old)
    merchant_name         TEXT NOT NULL,           -- 'STK Steakhouse (Atlanta)' as printed
    merchant_kind         TEXT NOT NULL DEFAULT 'restaurant',  -- restaurant | alcohol | store (name-keyword guess; hand-correctable)
    merchant_address      TEXT,                    -- pickup address (the business, not the customer); new template only
    merchant_tz           TEXT,                    -- IANA zone derived from merchant_address by the ETL (NULL when unknown / old template)
    profile               TEXT,                    -- 'Personal' / 'Business' tag from the subject

    order_date_local      DATE NOT NULL,           -- printed order date (local)
    daypart               TEXT,                    -- morning | afternoon | evening, from the subject line
    ordered_local         TIMESTAMP,               -- naive local wall clock, as printed (new template only)
    delivered_local       TIMESTAMP,               -- naive local wall clock: printed (receipt) or estimated (payment_estimate); NULL when canceled / date_only
    time_source           TEXT NOT NULL DEFAULT 'receipt',     -- receipt | payment_estimate | date_only. 'payment_estimate' = any ESTIMATED time:
                                                   --   old template: card charge − 70 min; new template without a courier timeline:
                                                   --   order + 30 min (its "Order completed" stamp is a 90-minute auto-close, not a drop-off).
                                                   --   raw_json.estimate_basis says which.
    local_utc_offset      TEXT,                    -- trigger: offset used to resolve the two instants, e.g. '-05:00'
    ordered_at            TIMESTAMPTZ,             -- trigger-resolved instant
    delivered_at          TIMESTAMPTZ,             -- trigger-resolved instant

    total                 NUMERIC(10,2),           -- charged total incl. fees + tip (NULL if only a tip-only receipt was seen)
    currency              TEXT,                    -- 'USD' / 'CAD'
    fulfillment           TEXT,                    -- 'delivery' | 'pickup'
    status                TEXT NOT NULL DEFAULT 'delivered',   -- delivered | canceled | refunded (full refund)

    source_message_id     TEXT,                    -- RFC 822 Message-ID of the email that last wrote this row
    source_email_date     TIMESTAMPTZ NOT NULL,    -- Date header of that email (the "latest wins" clock)
    source_account        TEXT,
    raw_json              JSONB,                   -- parsed fields as the parser saw them

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ADR-0001 quad for the DELIVERY instant (order instant when not delivered)
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,

    CONSTRAINT delivery_orders_uniq         UNIQUE (provider, order_key),
    CONSTRAINT delivery_orders_status_check CHECK (status IN ('delivered', 'canceled', 'refunded')),
    CONSTRAINT delivery_orders_time_check   CHECK (time_source IN ('receipt', 'payment_estimate', 'date_only')),
    CONSTRAINT delivery_orders_kind_check   CHECK (merchant_kind IN ('restaurant', 'alcohol', 'store'))
);

COMMENT ON TABLE pds.delivery_orders IS
    'One row per food-delivery order parsed from Uber Eats receipt emails (delivery_email_etl.py, IMAP). Natural key (provider, order_key); latest email wins. Carries merchant, times and total — NOT the items (receipt emails do not list them). time_source says whether the delivery time was printed, estimated from the card charge, or absent.';

CREATE INDEX IF NOT EXISTS idx_delivery_orders_behavioral ON pds.delivery_orders (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_order_date ON pds.delivery_orders (order_date_local);

-- -----------------------------------------------------------
-- Trigger — resolve the printed local times to instants, then the quad.
-- 1. merchant_tz known (new-template receipts): the receipt prints the
--    MERCHANT's clock, so that zone is authoritative and is passed to
--    derive_onyx_dates as a source-field offset. This is what keeps the day
--    Riley flies home right — the WHOOP cycle still carries the trip's offset
--    then (an Atlanta order after landing from Madrid was stored 6 h early).
-- 2. otherwise the ADR-0001 ladder. The offset lookup needs an instant, so the
--    local time is first read as ET (never more than a few hours off) to pick
--    the WHOOP-cycle offset or the user_tz_log zone in force, and the local
--    time is then re-read in that zone.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_delivery_orders()
RETURNS TRIGGER AS $$
DECLARE
    approx    TIMESTAMPTZ;
    off_text  TEXT;
    off_iv    INTERVAL;
    tz_name   TEXT;
    ev        TIMESTAMPTZ;
    d         RECORD;
BEGIN
    NEW.synced_at := NOW();

    IF NEW.delivered_local IS NULL AND NEW.ordered_local IS NULL THEN
        -- date_only: no clock time at all. An afternoon/evening order belongs to
        -- its printed date; a "morning" one could be a 1 AM awake-tail order
        -- (previous behavioral day) or breakfast — unknowable, so its behavioral
        -- date stays NULL and pds.delivery_daily leaves it out.
        NEW.ordered_at := NULL; NEW.delivered_at := NULL; NEW.local_utc_offset := NULL;
        NEW.onyx_et_date         := NEW.order_date_local;
        NEW.onyx_local_date      := NEW.order_date_local;
        NEW.onyx_behavioral_date := CASE WHEN NEW.daypart IN ('afternoon', 'evening') THEN NEW.order_date_local END;
        NEW.onyx_tz_source       := 'date_only';
        RETURN NEW;
    END IF;

    IF NEW.merchant_tz IS NOT NULL AND NEW.merchant_tz <> '' THEN
        NEW.ordered_at   := NEW.ordered_local   AT TIME ZONE NEW.merchant_tz;
        NEW.delivered_at := NEW.delivered_local AT TIME ZONE NEW.merchant_tz;
        ev       := COALESCE(NEW.delivered_at, NEW.ordered_at);
        off_iv   := COALESCE(NEW.delivered_local, NEW.ordered_local) - (ev AT TIME ZONE 'UTC');
        off_text := CASE WHEN off_iv < INTERVAL '0' THEN '-' ELSE '+' END
                    || to_char(abs(EXTRACT(epoch FROM off_iv))::int * INTERVAL '1 second', 'HH24:MI');
        NEW.local_utc_offset := off_text;
        SELECT * INTO d FROM pds.derive_onyx_dates(ev, off_text, 'source_field');
        NEW.onyx_et_date         := d.onyx_et_date;
        NEW.onyx_behavioral_date := d.onyx_behavioral_date;
        NEW.onyx_local_date      := d.onyx_local_date;
        NEW.onyx_tz_source       := d.onyx_tz_source;
        RETURN NEW;
    END IF;

    approx   := COALESCE(NEW.delivered_local, NEW.ordered_local) AT TIME ZONE 'America/New_York';
    off_text := pds.cycle_offset_for_instant(approx);
    IF off_text IS NOT NULL AND off_text <> '' THEN
        NEW.ordered_at   := (NEW.ordered_local   - off_text::interval) AT TIME ZONE 'UTC';
        NEW.delivered_at := (NEW.delivered_local - off_text::interval) AT TIME ZONE 'UTC';
    ELSE
        tz_name := pds.tz_for_instant(approx);
        NEW.ordered_at   := NEW.ordered_local   AT TIME ZONE tz_name;
        NEW.delivered_at := NEW.delivered_local AT TIME ZONE tz_name;
        off_iv   := COALESCE(NEW.delivered_local, NEW.ordered_local)
                    - (COALESCE(NEW.delivered_at, NEW.ordered_at) AT TIME ZONE 'UTC');
        off_text := CASE WHEN off_iv < INTERVAL '0' THEN '-' ELSE '+' END
                    || to_char(abs(EXTRACT(epoch FROM off_iv))::int * INTERVAL '1 second', 'HH24:MI');
    END IF;
    NEW.local_utc_offset := off_text;

    ev := COALESCE(NEW.delivered_at, NEW.ordered_at);
    SELECT * INTO d FROM pds.derive_onyx_dates(ev, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER delivery_orders_set_onyx_dates
    BEFORE INSERT OR UPDATE ON pds.delivery_orders
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_delivery_orders();

-- -----------------------------------------------------------
-- pds.delivery_email_log — every Uber Eats receipt email the ETL looked at.
-- Re-runs skip message_ids present here unless --reprocess; status
-- 'unmatched' / 'error' = "Uber changed the template" (parser needs a look).
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.delivery_email_log (
    message_id            TEXT PRIMARY KEY,
    account               TEXT NOT NULL,
    received_at           TIMESTAMPTZ,
    subject               TEXT,
    kind                  TEXT,                    -- receipt | canceled | refund | tip_only
    merchant_name         TEXT,
    status                TEXT NOT NULL,           -- parsed | unmatched | error
    error                 TEXT,
    processed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.delivery_email_log IS
    'Processing ledger for delivery_email_etl.py: one row per Uber Eats receipt email seen. Re-runs skip message_ids present here unless --reprocess; status unmatched/error = parser needs attention.';

-- -----------------------------------------------------------
-- pds.delivery_daily — one row per behavioral day with a delivered order.
-- "Meal" = merchant_kind 'restaurant' (alcohol / convenience-store runs are
-- counted separately and never feed the meal-timing columns).
--   last_meal_delivery_to_sleep_minutes : WHOOP main-sleep onset − last meal
--       delivery of the day (same sleep join as caffeine / screen time).
--       Small = ate right before bed. NULL until that sleep is scored.
--   late_meal_delivery : a meal delivered at/after 22:00 or before 06:00 local
--       (NULL when no meal that day has a clock time).
--   untimed_meal_order_count : meals counted from date_only rows — they add to
--       the counts but cannot feed any time column.
--   has_estimated_time : some time that day is charge − 70 min, not printed.
-- Days without any order have NO row (absence = "nothing delivered", but only
-- inside the ETL's backfilled coverage window).
-- -----------------------------------------------------------
CREATE OR REPLACE VIEW pds.delivery_daily AS
WITH o AS (
    SELECT order_id, merchant_name, merchant_kind, time_source,
           onyx_behavioral_date,
           COALESCE(delivered_at, ordered_at)       AS event_time,   -- NULL for date_only rows
           COALESCE(delivered_local, ordered_local) AS event_local
      FROM pds.delivery_orders
     WHERE status = 'delivered' AND onyx_behavioral_date IS NOT NULL
), sleep AS (
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           min(ws.start_time)       AS sleep_start
      FROM pds.whoop_main_cycle_per_behavioral_date wcm
      JOIN pds.whoop_sleep ws
        ON ws.cycle_id = wcm.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'
     GROUP BY wcm.onyx_behavioral_date
), agg AS (
    SELECT o.onyx_behavioral_date                                          AS behavioral_date,
           count(*)                                                        AS order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'restaurant')          AS meal_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'alcohol')             AS alcohol_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'store')               AS store_order_count,
           count(*) FILTER (WHERE o.merchant_kind = 'restaurant' AND o.event_time IS NULL) AS untimed_meal_order_count,
           min(o.event_time) FILTER (WHERE o.merchant_kind = 'restaurant') AS first_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.merchant_kind = 'restaurant') AS last_meal_delivery_time,
           max(o.event_time) FILTER (WHERE o.merchant_kind = 'restaurant' AND o.event_time < sl.sleep_start) AS last_meal_before_sleep,
           bool_or(EXTRACT(hour FROM o.event_local) >= 22 OR EXTRACT(hour FROM o.event_local) < 6)
               FILTER (WHERE o.merchant_kind = 'restaurant' AND o.event_local IS NOT NULL) AS late_meal_delivery,
           COALESCE(bool_or(o.time_source = 'payment_estimate'), false)    AS has_estimated_time,
           string_agg(o.merchant_name, ' | ' ORDER BY o.event_time NULLS LAST, o.order_id) AS merchants,
           min(sl.sleep_start)                                             AS sleep_start
      FROM o
      LEFT JOIN sleep sl ON sl.behavioral_date = o.onyx_behavioral_date
     GROUP BY o.onyx_behavioral_date
)
SELECT a.behavioral_date,
       a.order_count,
       a.meal_order_count,
       a.alcohol_order_count,
       a.store_order_count,
       a.untimed_meal_order_count,
       a.first_meal_delivery_time,
       a.last_meal_delivery_time,
       a.late_meal_delivery,
       a.sleep_start,
       round(EXTRACT(epoch FROM a.sleep_start - a.last_meal_before_sleep) / 60.0, 1) AS last_meal_delivery_to_sleep_minutes,
       a.has_estimated_time,
       a.merchants
  FROM agg a;

COMMENT ON VIEW pds.delivery_daily IS
    'Per behavioral day: delivered-order counts by merchant kind, first/last meal delivery time, late-meal flag, and minutes from the last meal delivery to WHOOP sleep onset. Source: pds.delivery_orders (Uber Eats receipt emails). No row = no delivered order that day.';

-- -----------------------------------------------------------
-- Row-Level Security — anon read, service-role full access
-- (No DROP ... IF EXISTS guards anywhere in this file: the Supabase connector asks for
-- an interactive confirmation on any destructive statement and declines the whole
-- migration when nobody can answer. Policies are created once; edit them with ALTER POLICY.)
-- -----------------------------------------------------------
ALTER TABLE pds.delivery_orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.delivery_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read"           ON pds.delivery_orders FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.delivery_orders FOR ALL    TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "anon_read"           ON pds.delivery_email_log FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.delivery_email_log FOR ALL    TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pds.delivery_orders, pds.delivery_email_log TO anon, authenticated;
GRANT ALL    ON pds.delivery_orders, pds.delivery_email_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.delivery_orders_order_id_seq TO service_role;
GRANT SELECT ON pds.delivery_daily TO anon, authenticated, service_role;
