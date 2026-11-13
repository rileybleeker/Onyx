-- Online orders from shipping / delivery emails (orders_email_etl.py, 2026-11-12).
--
--   pds.online_order_events  one row per email the ETL read (Message-ID key): parsed order updates
--                            plus 'ignored' / 'error' rows, so a re-run skips what it already read.
--   pds.online_orders        one row per order, RECOMPUTED from all events on every run (emails
--                            joined by store + order number or by tracking number).
--   pds.online_order_marks   Riley's one-tap answers on /orders ("Got it" = it arrived, "Hide"),
--                            keyed by any of an order's aliases so a later email that changes the
--                            order key keeps the answer.
--
-- Never stored: email bodies, the shipping address, phone numbers, prices or payment details.
-- SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon / authenticated. The browser
-- never reads these tables; /orders and /api/orders/* read them server-side behind the owner
-- session check.

CREATE TABLE IF NOT EXISTS pds.online_order_events (
    message_id      TEXT PRIMARY KEY,
    account_fp      TEXT NOT NULL,                 -- sha256(address)[:8], never the address
    received_at     TIMESTAMPTZ NOT NULL,
    sender_address  TEXT NOT NULL,
    sender_name     TEXT,
    subject         TEXT,
    parse_status    TEXT NOT NULL CHECK (parse_status IN ('parsed', 'ignored', 'error')),
    note            TEXT,
    kind            TEXT CHECK (kind IN ('merchant', 'carrier', 'marketplace')),
    merchant_key    TEXT,
    merchant_name   TEXT,
    order_number    TEXT,
    tracking        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{number, carrier}]
    status          TEXT CHECK (status IN ('ordered', 'shipped', 'out_for_delivery', 'delivered',
                                           'delayed', 'exception', 'canceled')),
    expected_date   DATE,
    items           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- up to five item names
    item_count      INTEGER,
    parser_version  INTEGER NOT NULL,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS online_order_events_received_idx ON pds.online_order_events (received_at DESC);
CREATE INDEX IF NOT EXISTS online_order_events_merchant_idx ON pds.online_order_events (merchant_key);

CREATE TABLE IF NOT EXISTS pds.online_orders (
    order_key            TEXT PRIMARY KEY,         -- o:<store>:<order no> | t:<tracking no> | m:<store>:<hash>
    aliases              TEXT[] NOT NULL,
    merchant_key         TEXT,
    merchant_name        TEXT NOT NULL,
    order_number         TEXT,
    tracking             JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{number, carrier, delivered}]
    items                JSONB NOT NULL DEFAULT '[]'::jsonb,
    item_count           INTEGER,
    status               TEXT NOT NULL CHECK (status IN ('ordered', 'shipped', 'out_for_delivery', 'delivered', 'canceled')),
    issue                TEXT CHECK (issue IN ('delayed', 'exception')),
    partially_delivered  BOOLEAN NOT NULL DEFAULT false,
    ordered_at           TIMESTAMPTZ,
    shipped_at           TIMESTAMPTZ,
    out_for_delivery_at  TIMESTAMPTZ,
    delivered_at         TIMESTAMPTZ,
    canceled_at          TIMESTAMPTZ,
    expected_date        DATE,
    first_event_at       TIMESTAMPTZ NOT NULL,
    last_event_at        TIMESTAMPTZ NOT NULL,
    event_count          INTEGER NOT NULL,
    confirms_delivery    BOOLEAN NOT NULL,         -- this store / carrier usually emails on delivery
    ships_physically     BOOLEAN NOT NULL,         -- this store has sent a shipping email before
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS online_orders_last_event_idx ON pds.online_orders (last_event_at DESC);
CREATE INDEX IF NOT EXISTS online_orders_aliases_idx ON pds.online_orders USING gin (aliases);

CREATE TABLE IF NOT EXISTS pds.online_order_marks (
    alias_key    TEXT PRIMARY KEY,
    received_at  TIMESTAMPTZ,                      -- Riley said it arrived
    hidden       BOOLEAN NOT NULL DEFAULT false,   -- Riley said it is not an order to track
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pds.online_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.online_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.online_order_marks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.online_order_events FROM anon, authenticated;
REVOKE ALL ON pds.online_orders FROM anon, authenticated;
REVOKE ALL ON pds.online_order_marks FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON pds.online_order_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.online_orders TO service_role;   -- recompute removes orders that no longer exist
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.online_order_marks TO service_role;
