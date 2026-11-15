-- Cash flow forecast inputs (2026-11-14, docs/cash-flow-forecast.md Phase 2). Additive only.
-- Service-role only, like the rest of finance: RLS on, no policies, no grants to anon / authenticated. The
-- /financials/forecast page reads these on the server; the browser writes through /api/finance/forecast/*
-- (owner session only). Nothing here moves money.

-- Planned items Riley enters: a bonus, a move, a trip, a tax payment. amount_cents is BALANCE-POSITIVE
-- (money in +, money out -), unlike the ledger. Removal is soft (removed_at).
create table if not exists pds.finance_plan_items (
  id            uuid primary key default gen_random_uuid(),
  label         text not null check (char_length(label) between 1 and 120),
  item_date     date not null,
  amount_cents  bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  certainty     text not null default 'likely' check (certainty in ('confirmed', 'likely', 'possible')),
  repeat_unit   text check (repeat_unit in ('month', 'week', 'day')),
  repeat_every  integer check (repeat_every between 1 and 52),
  repeat_count  integer check (repeat_count between 1 and 120),
  note          text check (note is null or char_length(note) <= 300),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  removed_at    timestamptz
);
create index if not exists finance_plan_items_date_idx on pds.finance_plan_items (item_date) where removed_at is null;

-- Drivers: one JSON value per key. Keys: 'settings' ({bufferCents, inflationPct}),
-- 'card:<account_key>' ({aprPct, promoEnds, promoAprPct, standardAprPct, promoNote}),
-- 'growth:<account_key>' ({returnPct, monthlyContributionCents, contributionStarts}).
create table if not exists pds.finance_plan_drivers (
  key         text primary key check (char_length(key) between 1 and 80),
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table pds.finance_plan_items enable row level security;
alter table pds.finance_plan_drivers enable row level security;
revoke all on pds.finance_plan_items, pds.finance_plan_drivers from anon, authenticated;

-- 2026-11-15 (migration finance_plan_items_account): the investment account on the other side of a planned
-- transfer, so net worth counts money moved into (or out of) it instead of only seeing cash leave.
alter table pds.finance_plan_items add column if not exists account_key text check (account_key is null or account_key ~ '^[A-Za-z0-9_-]{1,64}$');
