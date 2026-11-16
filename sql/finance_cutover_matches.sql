-- Cutover match provenance for the SimpleFIN feed (PIPE-04, 2026-11-16). Additive only: one new table. Service-role
-- only like the other finance tables (RLS on, no policies, nothing granted to anon or authenticated).
--
-- simplefin_etl.py decides, per SimpleFIN transaction dated near an account's last Rocket Money row, whether the
-- Rocket Money history already holds it (see the cutover rule in its docstring). Every such decision, and every
-- match of a row dated before that window (so the Rocket Money row it took stays taken), is recorded here by key
-- only, so a later reconciliation can find the rows kept for review and the Rocket Money rows they might
-- duplicate. No amount, date, merchant or description is stored here.
--
-- decision:
--   matched           identity evidence matched one Rocket Money row; the SimpleFIN row was not stored
--   stored_duplicate  a row an earlier run stored matches a Rocket Money row; kept (never removed automatically)
--   ambiguous         more than one candidate on either side; kept
--   unconfirmed       a same-amount Rocket Money row is near but no merchant evidence; kept
-- evidence: 'exact' (same date, amount, currency, description) or 'merchant' (shared merchant words, one to one).
-- The ETL reads the table back each run: a Rocket Money row a recorded decision matched stays taken, also when a
-- later SimpleFIN answer no longer has the row that matched it. While the table does not exist the ETL matches each
-- response on its own, saves nothing and the SimpleFIN card reads partial with cutover_provenance_unsaved; any
-- other error reading it fails the run before anything is written (db_read_failed), so the record is never
-- rewritten from decisions made without it.
-- Applied 2026-11-16 (Supabase MCP, before the merge of the change that added it).

create table if not exists pds.finance_cutover_matches (
  sf_txn_key        text primary key,          -- the SimpleFIN row's txn_key (= finance_transactions.txn_key when kept)
  account_key       text not null references pds.finance_accounts(account_key) on delete cascade,
  decision          text not null check (decision in ('matched', 'stored_duplicate', 'ambiguous', 'unconfirmed')),
  evidence          text check (evidence in ('exact', 'merchant')),
  history_txn_keys  text[] not null default '{}',   -- the Rocket Money twin, or up to 10 candidates
  cutover_date      date not null,               -- the account's last Rocket Money date the decision used
  first_decided_at  timestamptz not null default now(),
  decided_at        timestamptz not null default now()
);

create index if not exists finance_cutover_matches_review_idx
  on pds.finance_cutover_matches (decision, account_key)
  where decision <> 'matched';

alter table pds.finance_cutover_matches enable row level security;

revoke all on pds.finance_cutover_matches from anon, authenticated;
