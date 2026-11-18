-- ============================================================================
-- Finance: per-account asset/liability kind override (/financials)
-- ============================================================================
-- Balances whose pds.finance_balance_snapshots.kind is null show as
-- "Unclassified" on /financials and are left out of net worth (kind is never
-- guessed from the account type). This table stores Riley's one-tap override:
-- one row per account, kind 'asset' or 'liability'. The override wins only
-- where the snapshot's own kind is null - a source-labelled balance is never
-- overridden.
--
-- What is stored: the finance account key and the kind. No balance amount, no
-- institution and no account name is copied here.
--
-- Access: service-role only, same as the other finance tables. The PUT
-- /api/finance/account-kind route sits behind the owner login and writes with
-- the service-role key; anon / authenticated get nothing.
--
-- Additive and safe to re-run (IF NOT EXISTS). "Clear" deletes the row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.finance_account_kind_overrides (
    account_id  TEXT        NOT NULL REFERENCES pds.finance_accounts(account_key) ON DELETE CASCADE,
    kind        TEXT        NOT NULL CHECK (kind IN ('asset', 'liability')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id)
);

ALTER TABLE pds.finance_account_kind_overrides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'finance_account_kind_overrides' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.finance_account_kind_overrides
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.finance_account_kind_overrides FROM anon, authenticated;
GRANT ALL ON pds.finance_account_kind_overrides TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
