-- ============================================================================
-- Procurement: hand-typed subscription tracker (/procurement)
-- ============================================================================
-- One row per subscription Riley types into /procurement. The page works
-- without this table (in memory, with a "not saved yet - setup pending" note);
-- applying this file makes the tracker persist across visits.
--
-- Access: service-role only, same as the other newer pds tables. The
-- /api/procurement/subscriptions routes sit behind the middleware login (owner
-- account) and read/write with the service-role key; the browser never touches
-- the table, and anon / authenticated get nothing.
--
-- Orders stay permanently disabled: this table stores what was typed. Nothing
-- reads it to buy, pay for, cancel or change a subscription.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Contains no statement that removes
-- an object, so the Supabase MCP connector will not refuse it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.procurement_subscriptions (
    subscription_id BIGSERIAL PRIMARY KEY,
    name            TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    vendor          TEXT                 CHECK (vendor IS NULL OR char_length(vendor) <= 80),
    amount_cents    INTEGER     NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 999999999),
    currency        TEXT        NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    cadence         TEXT        NOT NULL CHECK (cadence IN ('monthly', 'quarterly', 'annual')),
    next_renewal    DATE        NOT NULL,
    notes           TEXT                 CHECK (notes IS NULL OR char_length(notes) <= 500),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,   -- soft delete: archived rows are hidden, never removed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The page lists active rows soonest-renewal first.
CREATE INDEX IF NOT EXISTS idx_procurement_subscriptions_active_renewal
    ON pds.procurement_subscriptions (next_renewal, subscription_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- RLS + grants: service role only (mirrors sql/phone_usage_schema.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.procurement_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'procurement_subscriptions' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.procurement_subscriptions
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.procurement_subscriptions FROM anon, authenticated;
GRANT ALL ON pds.procurement_subscriptions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.procurement_subscriptions_subscription_id_seq TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
