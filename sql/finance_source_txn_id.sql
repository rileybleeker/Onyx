-- Finance ledger: Rocket Money's own transaction id (2026-11-12). Additive only; applied as the Supabase
-- migration "finance_source_txn_id". The table stays service-role only (RLS on, no grants to anon or authenticated).
--
-- source_txn_id is the numeric part of the id the Rocket Money web app uses for a transaction (the app shows it
-- base64-encoded as "Transaction:<number>"). The CSV export has no id, so the 7,009 rows imported from it start
-- with NULL and are tied to their web id once by tools/rocketmoney_harvest/reconcile-ids.mjs. Rows that the daily
-- harvester creates itself get txn_key = first 32 hex of sha256('rmid|' || source_txn_id).
-- Pending transactions are not stored, so nothing has to be re-keyed when one posts.

alter table pds.finance_transactions add column if not exists source_txn_id text;

-- One ledger row per Rocket Money transaction id; the many NULLs (CSV rows not yet tied to an id) do not collide.
create unique index if not exists finance_transactions_source_txn_id_uidx
  on pds.finance_transactions (source_txn_id)
  where source_txn_id is not null;
