-- Cutover match provenance for the SimpleFIN feed (PIPE-04, 2026-11-16). Additive only: one new table. Service-role
-- only like the other finance tables (RLS on, no policies, nothing granted to anon or authenticated).
--
-- simplefin_etl.py decides, per SimpleFIN transaction dated near an account's last Rocket Money row, whether the
-- Rocket Money history already holds it (see the cutover rule in its docstring). Every such decision, and every
-- decision on a row dated before that window (so the Rocket Money row it took stays taken, or its candidates stay
-- held), is recorded here by key only, so a later reconciliation can find the rows kept for review and the Rocket
-- Money rows they might duplicate. No amount, date, merchant or description is stored here.
--
-- decision:
--   matched           identity evidence matched one Rocket Money row; the SimpleFIN row was not stored
--   stored_duplicate  a row an earlier run stored matches a Rocket Money row; kept (never removed automatically)
--   ambiguous         competing candidates (a tie, rows that can be told apart, a group of unequal size); kept
--                     (a row before the window is dropped all the same, and recorded so its candidates stay held)
--   unconfirmed       a same-amount Rocket Money row is near but no merchant evidence, or a recorded match or
--                     ambiguity the row no longer carries (its amount or text changed); kept, holds nothing
-- evidence: 'exact' (same date, amount, currency, description) or 'merchant' (shared merchant words, one to one);
-- neither when payee names or store numbers contradict. history_txn_keys holds every candidate (never cut), since
-- the candidates of an ambiguous row are what later runs hold.
-- The ETL reads the table back each run: a Rocket Money row a recorded decision matched stays taken, also when a
-- later SimpleFIN answer no longer has the row that matched it, and the candidates of an ambiguous row are held while
-- that row is missing from the answer. A recorded match or ambiguity that a row still in the answer no longer
-- carries is replaced (by its new decision, or 'unconfirmed'). The ETL writes its decisions here BEFORE the ledger,
-- and a run that cannot (a failed write, or this table missing while there are decisions to record:
-- cutover_provenance_unsaved) writes nothing, so a row is never left out on a match that is not recorded. Any
-- other error reading it fails the run before anything is written (db_read_failed), so the record is never
-- rewritten from decisions made without it. Every Rocket Money row a recorded match or ambiguity names is read
-- back by key, whatever its date, so the record is replayed whatever the run's date window.
-- review_state tracks the REPORTING of a row kept for review apart from its decision (see the statement at the end).
-- (These comments were revised after the table was applied; the statements down to the review_state section are
-- unchanged.)
-- Applied 2026-11-16 (Supabase MCP, before the merge of the change that added it), except the review_state
-- statement at the end.

create table if not exists pds.finance_cutover_matches (
  sf_txn_key        text primary key,          -- the SimpleFIN row's txn_key (= finance_transactions.txn_key when kept)
  account_key       text not null references pds.finance_accounts(account_key) on delete cascade,
  decision          text not null check (decision in ('matched', 'stored_duplicate', 'ambiguous', 'unconfirmed')),
  evidence          text check (evidence in ('exact', 'merchant')),
  history_txn_keys  text[] not null default '{}',   -- the Rocket Money twin, or every candidate
  cutover_date      date not null,               -- the account's last Rocket Money date the decision used
  first_decided_at  timestamptz not null default now(),
  decided_at        timestamptz not null default now()
);

create index if not exists finance_cutover_matches_review_idx
  on pds.finance_cutover_matches (decision, account_key)
  where decision <> 'matched';

alter table pds.finance_cutover_matches enable row level security;

revoke all on pds.finance_cutover_matches from anon, authenticated;

-- review_state (added 2026-11-16 after the review of round 6; NOT APPLIED YET: apply it before the merge). Every
-- statement in this file is idempotent, so applying the whole file again is safe.
--   pending   a row kept for review (ambiguous / unconfirmed / stored_duplicate, in the ledger) that no WRITTEN
--             heartbeat has carried yet
--   reported  a written heartbeat carried it as cutover_review
--   null      nothing to report (a match, or a decision on a row before the window, recorded for its hold only)
-- Each run reports every pending row, its own and earlier runs', and marks them reported only once one of its
-- heartbeats was written (sync_log_helper.write_sync), so a lost heartbeat, a failed run or a run stopped after
-- the record was saved never hides a row kept for review; at worst one is reported twice. A decision that changes
-- is pending again. A row recorded before this column existed keeps review_state null and is not reported again
-- (none is expected: only this version of the ETL writes the table). Until this statement is applied, every run of
-- this version fails before writing anything (cutover_provenance_unsaved).
alter table pds.finance_cutover_matches
  add column if not exists review_state text check (review_state in ('pending', 'reported'));
