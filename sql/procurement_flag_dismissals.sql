-- ============================================================================
-- Procurement: dismissed waste flags (/procurement)
-- ============================================================================
-- /procurement raises rule-based flags on the subscriptions it detects in the
-- finance ledger (price went up, possible duplicate, no recent use on the
-- iPhone). Riley can dismiss a flag; this table remembers that, one row per
-- (subscription, flag).
--
-- What is stored: two opaque hashes and a boolean. sub_id is the 16-hex id the
-- detector derives from the normalized merchant name; flag_key is
-- "<kind>:<16 hex>". No merchant name, no amount and no date from the ledger
-- is written here.
--
-- Access: service-role only, same as the finance and procurement tables. The
-- PATCH /api/procurement/flags route sits behind the owner login and writes
-- with the service-role key; anon / authenticated get nothing.
--
-- Additive and safe to re-run (IF NOT EXISTS everywhere). Taking a dismissal
-- back sets dismissed = false; rows are never removed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.procurement_flag_dismissals (
    sub_id      TEXT        NOT NULL CHECK (sub_id ~ '^[0-9a-f]{16}$'),
    flag_key    TEXT        NOT NULL CHECK (flag_key ~ '^(price_increase|duplicate|no_recent_use):[0-9a-f]{16}$'),
    dismissed   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sub_id, flag_key)
);

ALTER TABLE pds.procurement_flag_dismissals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'procurement_flag_dismissals' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.procurement_flag_dismissals
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.procurement_flag_dismissals FROM anon, authenticated;
GRANT ALL ON pds.procurement_flag_dismissals TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
