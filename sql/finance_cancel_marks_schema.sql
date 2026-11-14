-- Cancel tracker (2026-11-14): Riley marks a detected subscription as cancelled (on the merchant's own site);
-- the Budgets page then checks the ledger for whether the charges stopped. Onyx never cancels anything.
-- Applied as the Supabase migration finance_cancel_marks_schema. Service-role only.
create table if not exists pds.finance_cancel_marks (
  sub_id     text primary key check (sub_id ~ '^[0-9a-f]{16}$'),
  marked_on  date not null,
  created_at timestamptz not null default now()
);
alter table pds.finance_cancel_marks enable row level security;
revoke all on pds.finance_cancel_marks from anon, authenticated;
