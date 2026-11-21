# Rewards (/rewards)

Points, miles and cash back across the cards and travel programs Riley holds. Read-only: nothing here moves points,
books or pays.

## What is where
- `sql/rewards_schema.sql` (applied): `pds.rewards_balances` (one row per program per read, written by the PC reader)
  and `pds.rewards_settings` (Riley's valuations, Discover quarter, Apple Card merchants, credit amounts). Both are
  service-role only (RLS on, no policies, no grants to anon / authenticated).
- `lib/rewards.ts` (pure) and `lib/rewards-server.ts` (service role, server-only). Page `app/rewards`, force-dynamic,
  noindex; the scroll copy reads `GET /api/rewards/page-data` (memory-only cache key). Edits go through
  `PUT /api/rewards/settings` (owner session, same-origin JSON, 2 KB, merged per key); never a CI route.
- `/status` card **Rewards** = heartbeat `rewards|balances` from the PC reader (unknown until the first run; more than
  36 h degraded, more than 96 h or failed red; a partial row carries per-program sign-in problems).
- Today: `GET /api/finance/alerts` appends rewards alerts (a lean read, 1.2 s limit, fail-open): points expiring in
  60 days, and an Amex credit with value left and 7 or fewer days in its period.

## Rules
- A program with no harvested row is "Not connected yet", never 0. A balance older than 7 days is stale.
- Earn estimates (12 months, counted purchases only, same rules as the ledger): Amex Platinum 5x airfare with the
  airline and prepaid Amex Travel hotels, 1x otherwise; Apple Card 3% at Apple and listed merchants, 2% otherwise
  (the 1% non-Apple-Pay case cannot be seen); Discover it 1%, 5% on the stored quarter's keywords up to $1,500; Citi
  cards earn nothing. Cards are found by institution + account name, never by mask or id.
- Hilton / Marriott expiry: 24 months after the last counted purchase at a brand of the family (estimate; a harvested
  `expires_on` wins). No stay seen = "unknown", never a date. Delta miles and Amex MR do not expire while open.
- Amex Platinum credits (amounts are estimates of the current benefits, editable): a credit is used only by a negative
  row on the Platinum account whose description names it, dated inside the calendar period. Uber Cash leaves no row
  and is shown as not tracked from the card. "Not used yet" needs proof the card is read: with no Platinum account or
  no Platinum row, a credit is unknown, and so is one whose matching credit row in the period is in another currency
  (left out of the dollar math). Unknown credits never alert on Today.
- Valuations (cents per point) are Riley's to edit; defaults are estimates.

## PC reader
Built separately in `tools/rewards_harvest` (README there): it writes `pds.rewards_balances` and the `rewards|balances` heartbeat. Until it has signed in to a program once, that program reads "Not connected yet" and only the card-derived parts (earn, credits, hotel-based expiry estimates) have data.
