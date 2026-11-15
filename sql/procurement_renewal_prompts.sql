-- ============================================================================
-- Procurement: renewal prompt ledger (push cards in /agents)
-- ============================================================================
-- /procurement estimates when each subscription detected in the finance ledger
-- renews. The sms-reminders Worker polls POST /api/procurement/renewals/claim
-- and posts a push card in the /agents chat a few days before a renewal
-- ("<merchant> renews in 2 days"; Riley's decision of 2026-11-13).
--
--   pds.procurement_renewal_prompt   one row per (subscription, billing cycle):
--                                    the claim ledger. The primary key is what
--                                    stops two concurrent claim calls, or an
--                                    estimate that moves by a day, from
--                                    prompting the same cycle twice.
--
-- What is stored: sub_id is the 16-hex hash the detector derives from the
-- normalized merchant name; last_charge is the day of the charge that opened
-- the cycle; renewal_date is the estimate that was prompted. No merchant name
-- and no amount is written here.
--
-- Access: service-role only. The Worker never talks to Supabase; it goes
-- through the Onyx route, so neither anon nor the signed-in owner reads this.
--
-- Additive and safe to re-run (IF NOT EXISTS everywhere); rows are only ever
-- inserted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.procurement_renewal_prompt (
    sub_id        TEXT        NOT NULL CHECK (sub_id ~ '^[0-9a-f]{16}$'),
    last_charge   DATE        NOT NULL,
    renewal_date  DATE        NOT NULL,
    prompted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sub_id, last_charge)
);

ALTER TABLE pds.procurement_renewal_prompt ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'procurement_renewal_prompt' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.procurement_renewal_prompt
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.procurement_renewal_prompt FROM anon, authenticated;
GRANT ALL ON pds.procurement_renewal_prompt TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
