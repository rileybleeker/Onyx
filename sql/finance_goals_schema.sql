-- Savings goals (2026-11-14): tracking only, Onyx never moves money toward a goal. Applied as the Supabase
-- migration finance_goals_schema. Service-role only (RLS on, no policies, no grants).
create table if not exists pds.finance_goals (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 80),
  target_cents bigint not null check (target_cents > 0 and target_cents <= 100000000000),
  target_date  date not null,
  account_key  text,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz
);
alter table pds.finance_goals enable row level security;
revoke all on pds.finance_goals from anon, authenticated;
