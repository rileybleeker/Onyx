-- Finance ledger fed by SimpleFIN Bridge (2026-11-14). Additive only; applied as the Supabase migration
-- "finance_simplefin". The tables stay service-role only (RLS on, no policies, no grants to anon or authenticated).
--
-- SimpleFIN Bridge (https://beta-bridge.simplefin.org) replaced the Rocket Money browser harvester as the source of
-- new transactions and balances: simplefin_etl.py reads its /accounts endpoint from GitHub Actions every 6 hours.
-- The Rocket Money history (rows up to the cutover) stays as it is; see the cutover rule in simplefin_etl.py.

-- The SimpleFIN account id an existing ledger account is tied to (set by the ETL when it matches an account by
-- institution + last four digits / name; a new SimpleFIN account gets its own row).
alter table pds.finance_accounts add column if not exists simplefin_id text;
create unique index if not exists finance_accounts_simplefin_id_uidx
  on pds.finance_accounts (simplefin_id)
  where simplefin_id is not null;

-- Which feed wrote a transaction: 'rocketmoney' (export, history, web harvester) or 'simplefin'.
alter table pds.finance_transactions add column if not exists source text not null default 'rocketmoney';
create index if not exists finance_transactions_source_account_idx
  on pds.finance_transactions (source, account_key, txn_date);
