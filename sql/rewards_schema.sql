-- Rewards (REWARDS-01): points / miles / cash balances per loyalty program, and Riley's editable values.
-- SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon / authenticated (like the finance tables).
-- pds.rewards_balances is written by the PC harvester (tools/rewards_harvest); numbers only, no names or numbers
-- of accounts. pds.rewards_settings holds valuations (cents per point), the Discover quarter categories and
-- credit-list overrides; written only by PUT /api/rewards/settings.

create table if not exists pds.rewards_balances (
  program text not null check (program in ('amex_mr','delta_skymiles','hilton_honors','marriott_bonvoy','uber_cash','uber_one')),
  captured_at timestamptz not null,
  balance numeric not null,
  unit text not null check (unit in ('points','miles','usd')),
  status_tier text,
  status_progress jsonb,
  expires_on date,
  source text not null default 'harvest',
  primary key (program, captured_at)
);
create index if not exists rewards_balances_program_recent on pds.rewards_balances (program, captured_at desc);

create table if not exists pds.rewards_settings (
  key text primary key check (key ~ '^[a-z0-9_.:-]{1,60}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table pds.rewards_balances enable row level security;
alter table pds.rewards_settings enable row level security;
revoke all on pds.rewards_balances from public, anon, authenticated;
revoke all on pds.rewards_settings from public, anon, authenticated;
grant select, insert, update, delete on pds.rewards_balances to service_role;
grant select, insert, update, delete on pds.rewards_settings to service_role;
