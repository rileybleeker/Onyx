-- Budgets, category fixes and forecast snapshots (2026-11-14). Additive only. Service-role only like the rest of
-- finance: RLS on, no policies, no grants to anon / authenticated. Read and written by the server behind the
-- owner-only middleware (/financials/budgets, /api/finance/*). Nothing here moves money.

-- "Always file this merchant under this category": keyed by the normalized merchant label
-- (lib/procurement-recurring.ts merchantKey), applied when the ledger is read; the stored rows are not changed.
create table if not exists pds.finance_category_rules (
  merchant_key text primary key check (char_length(merchant_key) between 1 and 200),
  category     text not null check (char_length(category) between 1 and 60),
  updated_at   timestamptz not null default now()
);

-- "Just this transaction": wins over a merchant rule.
create table if not exists pds.finance_txn_categories (
  txn_key    text primary key check (char_length(txn_key) between 1 and 64),
  category   text not null check (char_length(category) between 1 and 60),
  updated_at timestamptz not null default now()
);

-- Monthly budget per category; category '__total__' is the overall monthly budget.
create table if not exists pds.finance_budgets (
  category      text primary key check (char_length(category) between 1 and 60),
  monthly_cents bigint not null check (monthly_cents > 0 and monthly_cents <= 100000000000),
  updated_at    timestamptz not null default now()
);

-- Weekly forecast snapshots (one row per as-of date and future week), compared with what happened.
create table if not exists pds.finance_forecast_snapshots (
  as_of        date not null,
  week_end     date not null,
  likely_cents bigint not null,
  low_cents    bigint not null,
  high_cents   bigint not null,
  created_at   timestamptz not null default now(),
  primary key (as_of, week_end)
);

alter table pds.finance_category_rules enable row level security;
alter table pds.finance_txn_categories enable row level security;
alter table pds.finance_budgets enable row level security;
alter table pds.finance_forecast_snapshots enable row level security;
revoke all on pds.finance_category_rules, pds.finance_txn_categories, pds.finance_budgets, pds.finance_forecast_snapshots from anon, authenticated;
