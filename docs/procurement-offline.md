# Procurement: offline foundation

Route: `/procurement`. This is a planning preview, not a functioning purchasing integration.

## What works
- Navigation through the shared desktop/mobile/palette catalog (key hint `O`).
- Honest disconnected state, opt-in synthetic examples, generic buying checklist.
- **Subscription tracker (typed by hand).** Name, USD price, monthly/quarterly/annual billing, next renewal date. Shows approximate monthly and yearly cost, renewals sorted by date (a past date is rolled forward by whole billing cycles, month-end safe, leap-day safe), and plain-words "worth a look" prompts: renewing within 14 days, the same name tracked twice, one item over half the spend. "Load synthetic demo subscriptions" fills it with four obviously fake rows.
- **Renewal reminders.** "Download renewal reminders (.ics)" builds an all-day calendar file (reminder 1, 3, 7 or 14 days before each renewal, never in the past) in the browser. Riley imports it into his own calendar; Onyx sends nothing and calls no calendar API. The file is deterministic, escapes names and folds long lines per RFC 5545.
- **Order preparation.** In-memory USD order drafts with exact-cent validation, one-time/monthly commitment, removal and clear. Totals (one-time and recurring), a warning when a recurring draft matches a tracked subscription, and a "Prepared list" grouped by merchant that Riley can copy. The list says in its first lines that nothing was ordered and that he buys it himself.
- **Saved tracker (2026-11-11).** The subscription tracker persists to `pds.procurement_subscriptions` (name, vendor, amount in cents, currency, cadence, next renewal, notes, `is_active` soft delete, timestamps) through owner-session API routes `/api/procurement/subscriptions` (GET list, POST create, DELETE archive all) and `/api/procurement/subscriptions/[id]` (PATCH update, DELETE archive one). The table is service-role only (`sql/procurement_schema.sql`, mirrors `phone_usage_schema.sql`); the browser never reads it directly and the routes are not on any middleware carve-out. The form has no vendor/notes inputs yet; the API accepts them. Synthetic demo rows and order drafts are never saved.
- **Graceful fallback.** If the table is missing (SQL not applied yet) or the API is unreachable, the page keeps working in memory and shows a visible note ("Not saved yet - setup pending ..." or "Saved subscriptions could not be loaded right now ..."). Reads degrade to an empty list with `persisted:false`; writes answer 503 `setupPending:true` and the page keeps the row in memory. A real database error is never reported as "setup pending".
- No localStorage, merchant calls, account discovery, credential entry, or external product recommendations. Order drafts still disappear on reload. Provider management and ordering remain disabled. `executionReadiness()` takes no arguments and always fails closed. There is no purchase, checkout, order-submission or cancel route or function; "archive" only hides a row in Onyx.
- `/status` has a small manual "Procurement" card: grey (unknown) with "saving not set up" until the SQL is applied, green once the table answers, red only on a real database error. Data age is not a signal for a hand-typed list.

## One-time setup (Riley)
Open the Supabase SQL editor for the Onyx project and run `sql/procurement_schema.sql` (idempotent, no DROP). Reload `/procurement`: the note under "Track subscriptions" changes to "Saved to your Onyx account".

## Future execution boundary (not implemented)
An authenticated server must own every quote and authorization, never trust a client approval boolean. The immutable quote needs merchant identity, item/quantity, delivered total including all fees, currency, recurrence/renewal price, fulfillment destination/method, cancellation/refund restrictions, and opaque payment-method reference. Never store card numbers or secrets here.

Authorization must bind the owner, quote revision and exact terms, have a short expiry, and be revoked on any material change. Before execution, revalidate current quote, limits and provider connection. Enforce a server-side idempotency key and atomic execution lock. Record pending, confirmed, failed and unknown outcomes separately. After a timeout, reconcile the provider transaction before any retry. Maintain an audit trail without secrets. Require provider-specific cancellation confirmation and verify the effective date rather than presenting a local state change as cancellation. A draft is not authorization.

No live adapter or authorization endpoint exists in this patch; a UI flag cannot enable spending. Recommendation adapters must return evidence, price timestamps and availability, and distinguish stale, unavailable and empty data. Keep recommendations independent of checkout and label sponsored content if introduced.

Financials has a separate unmerged branch; this module neither reads its data nor claims a connection. Integrate later through an explicit reviewed contract, not a duplicate CSV parser or account scraper.

## Verification
Run from repository root:
- `node frontend/scripts/test-procurement.mjs` (pure logic: money, dates, renewal rolling, prompts, prepared list, .ics)
- `node frontend/scripts/test-procurement-store.mjs` (save validation, missing-table fallback, fake-database store, no purchase action, SQL guards)
- `node frontend/node_modules/typescript/bin/tsc --project frontend/tsconfig.json --noEmit --incremental false`
- `node frontend/scripts/test-procurement-ui.mjs`

The browser test (tracker, .ics download, prepared list, copy, overflow) copies only this module and styles into an isolated temporary Next fixture, supplies no secrets, binds localhost and blocks nonlocal browser requests. It does not weaken application authentication. The real Onyx shell/auth and production smoke suite are deliberately not exercised during the outage. `frontend/e2e/smoke.spec.ts` has a read-only `/procurement` check for the post-deploy production smoke run. These scripts are not run by the required CI checks (`offline-checks`, `frontend-types` run tsc and a compile build only), so run them locally before changing this module.
