-- Investment holdings and account activity from SimpleFIN Bridge (2026-11-17). Additive only.
-- Service-role only (RLS on, no policies, no grants), like every pds.finance_* table: the page reads them on the
-- server behind the owner-only middleware.
--
-- finance_holdings: the latest position list per investment account. simplefin_etl.py upserts every position of the
-- run (key account_key + holding_id) and stamps seen_at, so a position that left the account keeps its old seen_at
-- and the reader shows only rows from the account's newest seen_at.
create table if not exists pds.finance_holdings (
  account_key        text        not null,
  holding_id         text        not null,
  symbol             text,
  description        text,
  shares             numeric,
  market_value_cents bigint,
  cost_basis_cents   bigint,
  purchase_price     numeric,
  currency           text        not null default 'USD',
  created_at_source  timestamptz,
  seen_at            timestamptz not null default now(),
  source             text        not null default 'simplefin',
  primary key (account_key, holding_id)
);
alter table pds.finance_holdings enable row level security;
create index if not exists finance_holdings_account_seen_idx on pds.finance_holdings (account_key, seen_at desc);

-- finance_investment_activity: deposits, withdrawals, dividends and trades on investment accounts. NOT spending, so
-- it never enters pds.finance_transactions. amount_cents keeps SimpleFIN's sign (money into the account positive).
create table if not exists pds.finance_investment_activity (
  txn_key      text primary key,
  account_key  text        not null,
  txn_date     date        not null,
  amount_cents bigint      not null,
  currency     text        not null default 'USD',
  name         text,
  description  text,
  seen_at      timestamptz not null default now(),
  source       text        not null default 'simplefin'
);
alter table pds.finance_investment_activity enable row level security;
create index if not exists finance_investment_activity_account_date_idx
  on pds.finance_investment_activity (account_key, txn_date desc);

revoke all on pds.finance_holdings from anon, authenticated;
revoke all on pds.finance_investment_activity from anon, authenticated;
