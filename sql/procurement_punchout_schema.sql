-- ============================================================================
-- Procurement PunchOut (cXML buyer side): sessions, returned carts, cart lines
-- ============================================================================
-- Flow: /procurement/shop -> POST /api/procurement/punchout/start creates a
-- session row (only a SHA-256 hash of the URL secret is stored), sends a cXML
-- PunchOutSetupRequest to the supplier and redirects to its StartPage. The
-- supplier posts the PunchOutOrderMessage back to
-- /api/procurement/punchout/public/return/<session id>.<secret>; the route
-- checks the secret and the BuyerCookie, then calls
-- pds.procurement_punchout_record_return(), which stores the cart once
-- (duplicate posts of the same payload are idempotent, a different payload is
-- a replay and is refused, an expired session is refused).
--
-- A returned cart is a price snapshot, never an order. Nothing here sends a
-- purchase order to a supplier.
--
-- Access: service-role only (RLS on, no policies for anon/authenticated, no
-- grants), like pds.procurement_subscriptions. The browser never reads these
-- tables; the /procurement/shop server page and the API routes do, behind the
-- owner login (the return route is authenticated by the session secret).
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE everywhere).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.procurement_punchout_sessions (
    session_id          TEXT        PRIMARY KEY CHECK (session_id ~ '^[0-9a-f]{32}$'),
    secret_hash         TEXT        NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    buyer_cookie        TEXT        NOT NULL CHECK (char_length(buyer_cookie) BETWEEN 16 AND 128),
    supplier_key        TEXT        NOT NULL CHECK (supplier_key ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
    source              TEXT        NOT NULL CHECK (source IN ('cxml', 'synthetic')),
    owner_id            UUID        NOT NULL,
    operation           TEXT        NOT NULL DEFAULT 'create' CHECK (operation IN ('create', 'edit', 'inspect')),
    status              TEXT        NOT NULL DEFAULT 'started'
                                    CHECK (status IN ('started', 'returned', 'cancelled', 'failed', 'expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_at         TIMESTAMPTZ,
    return_payload_hash TEXT        CHECK (return_payload_hash IS NULL OR return_payload_hash ~ '^[0-9a-f]{64}$'),
    cart_id             BIGINT,
    error_code          TEXT        CHECK (error_code IS NULL OR char_length(error_code) <= 64)
);

CREATE INDEX IF NOT EXISTS idx_procurement_punchout_sessions_owner_created
    ON pds.procurement_punchout_sessions (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pds.procurement_punchout_carts (
    cart_id             BIGSERIAL   PRIMARY KEY,
    session_id          TEXT        NOT NULL UNIQUE REFERENCES pds.procurement_punchout_sessions (session_id),
    owner_id            UUID        NOT NULL,
    supplier_key        TEXT        NOT NULL,
    source              TEXT        NOT NULL CHECK (source IN ('cxml', 'synthetic')),
    payload_id          TEXT        CHECK (payload_id IS NULL OR char_length(payload_id) <= 256),
    operation_allowed   TEXT        CHECK (operation_allowed IS NULL OR operation_allowed IN ('create', 'inspect', 'edit')),
    supplier_total      NUMERIC(16, 4),
    total_currency      TEXT        CHECK (total_currency IS NULL OR total_currency ~ '^[A-Z]{3}$'),
    shipping            NUMERIC(16, 4),
    shipping_currency   TEXT        CHECK (shipping_currency IS NULL OR shipping_currency ~ '^[A-Z]{3}$'),
    tax                 NUMERIC(16, 4),
    tax_currency        TEXT        CHECK (tax_currency IS NULL OR tax_currency ~ '^[A-Z]{3}$'),
    line_count          INTEGER     NOT NULL CHECK (line_count BETWEEN 1 AND 500),
    status              TEXT        NOT NULL DEFAULT 'returned' CHECK (status IN ('returned', 'reviewed', 'discarded')),
    returned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_punchout_carts_owner_returned
    ON pds.procurement_punchout_carts (owner_id, returned_at DESC);

CREATE TABLE IF NOT EXISTS pds.procurement_punchout_cart_lines (
    cart_id                 BIGINT        NOT NULL REFERENCES pds.procurement_punchout_carts (cart_id),
    line_no                 INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 500),
    supplier_part_id        TEXT          NOT NULL CHECK (char_length(supplier_part_id) BETWEEN 1 AND 256),
    supplier_part_aux_id    TEXT          CHECK (supplier_part_aux_id IS NULL OR char_length(supplier_part_aux_id) <= 1024),
    description             TEXT          NOT NULL CHECK (char_length(description) <= 2000),
    quantity                NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    uom                     TEXT          NOT NULL CHECK (uom ~ '^[A-Z0-9]{1,3}$'),
    unit_price              NUMERIC(16, 4) NOT NULL CHECK (unit_price >= 0),
    currency                TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    classification_domain   TEXT          CHECK (classification_domain IS NULL OR char_length(classification_domain) <= 64),
    classification          TEXT          CHECK (classification IS NULL OR char_length(classification) <= 64),
    manufacturer_part_id    TEXT          CHECK (manufacturer_part_id IS NULL OR char_length(manufacturer_part_id) <= 256),
    manufacturer_name       TEXT          CHECK (manufacturer_name IS NULL OR char_length(manufacturer_name) <= 256),
    provenance              JSONB         NOT NULL,
    PRIMARY KEY (cart_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Atomic return: lock the session, decide duplicate / replay / expired, store
-- the cart and its lines, mark the session consumed. One transaction, so a
-- failure leaves the session open for a retry and never a half-stored cart.
-- Returns {"outcome": "created"|"duplicate"|"cancelled"|"duplicate_cancel"
--          |"replay"|"expired"|"not_open"|"unknown", "cart_id": n|null}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.procurement_punchout_record_return(
    p_session_id   TEXT,
    p_payload_hash TEXT,
    p_cart         JSONB,
    p_lines        JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $$
DECLARE
    s       pds.procurement_punchout_sessions%ROWTYPE;
    new_id  BIGINT;
    n_lines INTEGER := COALESCE(jsonb_array_length(p_lines), 0);
BEGIN
    SELECT * INTO s FROM pds.procurement_punchout_sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome', 'unknown', 'cart_id', NULL);
    END IF;

    IF s.status = 'returned' THEN
        IF s.return_payload_hash = p_payload_hash THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'cart_id', s.cart_id);
        END IF;
        RETURN jsonb_build_object('outcome', 'replay', 'cart_id', NULL);
    END IF;
    IF s.status = 'cancelled' THEN
        IF s.return_payload_hash = p_payload_hash THEN
            RETURN jsonb_build_object('outcome', 'duplicate_cancel', 'cart_id', NULL);
        END IF;
        RETURN jsonb_build_object('outcome', 'replay', 'cart_id', NULL);
    END IF;
    IF s.status <> 'started' THEN
        RETURN jsonb_build_object('outcome', 'not_open', 'cart_id', NULL);
    END IF;
    IF s.expires_at < NOW() THEN
        UPDATE pds.procurement_punchout_sessions
           SET status = 'expired', error_code = 'expired_on_return'
         WHERE session_id = p_session_id;
        RETURN jsonb_build_object('outcome', 'expired', 'cart_id', NULL);
    END IF;

    IF n_lines = 0 THEN
        UPDATE pds.procurement_punchout_sessions
           SET status = 'cancelled', consumed_at = NOW(), return_payload_hash = p_payload_hash
         WHERE session_id = p_session_id;
        RETURN jsonb_build_object('outcome', 'cancelled', 'cart_id', NULL);
    END IF;

    INSERT INTO pds.procurement_punchout_carts (
        session_id, owner_id, supplier_key, source, payload_id, operation_allowed,
        supplier_total, total_currency, shipping, shipping_currency, tax, tax_currency, line_count
    ) VALUES (
        s.session_id, s.owner_id, s.supplier_key, s.source,
        p_cart->>'payload_id', p_cart->>'operation_allowed',
        (p_cart->>'supplier_total')::NUMERIC, p_cart->>'total_currency',
        (p_cart->>'shipping')::NUMERIC, p_cart->>'shipping_currency',
        (p_cart->>'tax')::NUMERIC, p_cart->>'tax_currency',
        n_lines
    ) RETURNING cart_id INTO new_id;

    INSERT INTO pds.procurement_punchout_cart_lines (
        cart_id, line_no, supplier_part_id, supplier_part_aux_id, description, quantity, uom,
        unit_price, currency, classification_domain, classification, manufacturer_part_id,
        manufacturer_name, provenance
    )
    SELECT new_id,
           (l->>'line_no')::INTEGER,
           l->>'supplier_part_id',
           l->>'supplier_part_aux_id',
           COALESCE(l->>'description', ''),
           (l->>'quantity')::NUMERIC,
           l->>'uom',
           (l->>'unit_price')::NUMERIC,
           l->>'currency',
           l->>'classification_domain',
           l->>'classification',
           l->>'manufacturer_part_id',
           l->>'manufacturer_name',
           COALESCE(l->'provenance', '{}'::JSONB)
      FROM jsonb_array_elements(p_lines) AS l;

    UPDATE pds.procurement_punchout_sessions
       SET status = 'returned', consumed_at = NOW(), return_payload_hash = p_payload_hash, cart_id = new_id
     WHERE session_id = p_session_id;

    RETURN jsonb_build_object('outcome', 'created', 'cart_id', new_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS + grants: service role only
-- ---------------------------------------------------------------------------
ALTER TABLE pds.procurement_punchout_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.procurement_punchout_carts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.procurement_punchout_cart_lines ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['procurement_punchout_sessions', 'procurement_punchout_carts', 'procurement_punchout_cart_lines'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE schemaname = 'pds' AND tablename = t AND policyname = 'service_full_access'
        ) THEN
            EXECUTE format('CREATE POLICY service_full_access ON pds.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON pds.procurement_punchout_sessions, pds.procurement_punchout_carts, pds.procurement_punchout_cart_lines
    FROM anon, authenticated;
GRANT ALL ON pds.procurement_punchout_sessions, pds.procurement_punchout_carts, pds.procurement_punchout_cart_lines
    TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.procurement_punchout_carts_cart_id_seq TO service_role;

REVOKE ALL ON FUNCTION pds.procurement_punchout_record_return(TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.procurement_punchout_record_return(TEXT, TEXT, JSONB, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
