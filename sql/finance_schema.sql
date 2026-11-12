-- Finance ledger (2026-11-12). Source: Rocket Money transaction export + account balances.
-- Additive only. Service-role only: RLS is on and there are deliberately NO policies and NO grants to
-- anon/authenticated (same model as the phone_usage_* tables). The browser never reads these tables;
-- server routes behind the owner-only middleware read them with the service role.
-- Sign convention (verified on the real export): amount_cents follows Rocket Money, so expenses are
-- positive and income/refunds are negative.

create table if not exists pds.finance_accounts (
  account_key  text primary key,            -- sha256(lower(institution)|lower(account_type)|lower(account_name)|mask) first 24 hex chars
  institution  text not null,
  account_name text not null,
  account_type text not null,               -- as Rocket Money labels it: Credit Card, Cash, Investment, ...
  mask         text,                        -- last 4 digits only, never a full account number
  source       text not null default 'rocketmoney',
  first_seen   date,
  last_seen    date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists pds.finance_transactions (
  txn_key        text primary key,          -- sha256(account_key|txn_date|original_date|name|amount_cents|ordinal) first 32 hex chars
  account_key    text not null references pds.finance_accounts(account_key) on delete cascade,
  txn_date       date not null,
  original_date  date,
  name           text not null,
  custom_name    text,
  amount_cents   bigint not null,
  currency       text not null default 'USD',
  category       text,
  description    text,
  note           text,
  ignored_from   text,
  tax_deductible boolean,
  tags           text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index if not exists finance_transactions_date_idx    on pds.finance_transactions (txn_date desc);
create index if not exists finance_transactions_account_idx on pds.finance_transactions (account_key, txn_date desc);

create table if not exists pds.finance_balance_snapshots (
  account_key   text not null references pds.finance_accounts(account_key) on delete cascade,
  captured_at   timestamptz not null,
  balance_cents bigint not null,
  currency      text not null default 'USD',
  kind          text,                       -- 'asset' | 'liability' when the source says so, else null
  source        text not null default 'rocketmoney',
  primary key (account_key, captured_at)
);

alter table pds.finance_accounts          enable row level security;
alter table pds.finance_transactions      enable row level security;
alter table pds.finance_balance_snapshots enable row level security;

revoke all on pds.finance_accounts, pds.finance_transactions, pds.finance_balance_snapshots from anon, authenticated;
