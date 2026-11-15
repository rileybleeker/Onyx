-- Stored finance results (2026-11-14). Additive only. Applied as the Supabase migration finance_result_cache.
--
-- The Today money alerts (/api/finance/alerts), the Today renewals summary (/api/procurement/renewals/summary)
-- and the /financials/forecast and /financials/budgets renders are computed from the ledger and the plan
-- tables (about 2,500 transactions, a 500-path forecast). Those inputs change only when the SimpleFIN ETL runs
-- (every 6 h) or Riley edits categories, budgets, plan items, drivers, goals or cancel marks, so the app stores
-- each computed result here and answers from it (lib/finance-result-cache.ts, lib/finance-result-cache-server.ts).
--
-- Invalidation: every write statement on an input table bumps the row key = 'inputs' (statement-level
-- trigger, inside the writer's own transaction, so the new version becomes visible together with the new
-- data). A stored result carries the input version it was computed from and is fresh only while that equals
-- the current version, on the same ET day, from the same app build and within an hour.
--
-- A new table that the forecast, budgets or renewals loaders read must be added to the trigger list below
-- (frontend/tests/finance-result-cache.test.cjs fails when a pds.finance_* table used by the app is missing).
--
-- Service-role only, like the rest of finance: RLS on, no policies, no grants to anon / authenticated. The
-- bodies hold computed figures and labels from the ledger: never read by the browser or by a model.

create table if not exists pds.finance_result_cache (
  key          text primary key check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  version      bigint not null default 0,
  et_date      date,
  build        text check (build is null or char_length(build) <= 80),
  computed_at  timestamptz not null default now(),
  failed_at    timestamptz,
  body         jsonb
);
alter table pds.finance_result_cache enable row level security;
revoke all on pds.finance_result_cache from anon, authenticated;

-- The input version. Stored results compare their own version with this row's.
insert into pds.finance_result_cache (key, version) values ('inputs', 1) on conflict (key) do nothing;

create or replace function pds.finance_inputs_changed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into pds.finance_result_cache as c (key, version, computed_at) values ('inputs', 1, now())
  on conflict (key) do update set version = c.version + 1, computed_at = now();
  return null;
end;
$$;
revoke execute on function pds.finance_inputs_changed() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_accounts',
    'finance_balance_snapshots',
    'finance_transactions',
    'finance_category_rules',
    'finance_txn_categories',
    'finance_budgets',
    'finance_cancel_marks',
    'finance_plan_items',
    'finance_plan_drivers',
    'finance_goals',
    'finance_forecast_snapshots'
  ] loop
    execute format(
      'create or replace trigger %I after insert or update or delete on pds.%I for each statement execute function pds.finance_inputs_changed()',
      t || '_inputs_changed', t
    );
  end loop;
end;
$$;
