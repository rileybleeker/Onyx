# Financials: Rocket Money first

## Implemented foundation

`/financials` is an authenticated, browser-memory CSV workspace. It has no finance API, database writes, credentials, automatic sync, model calls, or persistent storage. Selecting a file only stages a preview. Explicit mapping, date/sign review, USD confirmation and a second import action replace the current snapshot. Invalid rows block import. Clear session or a full page reload clears the imported snapshot; browser navigation may retain the page in memory. Keep the original export.

The dashboard shows money in/out, net cashflow, category outflows, transfer exclusions, month filtering and transaction search. Refunds count as money in, not salary. Credit-card payments and transfers must be excluded where applicable. It cannot establish balances, net worth, complete-month coverage, budgets, or verified subscriptions from a transaction export alone. All tests use synthetic fixtures.

## Official provider findings (2026-11-11)

- Rocket Money documents CSV transaction export on mobile and web; the emailed download must be opened on desktop: https://help.rocketmoney.com/en/articles/10296106-exporting-transactions
- Official premium feature list includes data export: https://help.rocketmoney.com/en/articles/2677184-premium-membership-features
- No supported public Rocket Money developer API was verified in official documentation searches. This is not proof that a private partner API cannot exist. No account access or support outreach was attempted.
- Do not build a scraper or reverse-engineered connector. Rocket Money's access/interference terms require express consent for automated extraction: https://www.rocketmoney.com/terms
- A future live-bank alternative is Plaid Transactions, not a Rocket Money account connection: https://plaid.com/docs/transactions/

## Future live connector boundary

Keep provider-neutral normalized posted transactions with integer minor units, explicit ISO currency, provider/item/account/transaction IDs, booked dates, pending status, provenance, and sync timestamps. Separate connections from accounts and import batches. Deduplicate by provider stable ID; CSV without stable IDs needs batch replacement or explicit overlap reconciliation, never merchant/amount-only deletion of legitimate identical purchases.

A supported connector requires approved setup and provider costs/terms, a user-initiated consent flow, server-only encrypted credentials, least-privilege read-only transaction access, owner-only authenticated endpoints/RLS, CSRF protection, webhook verification, and disconnect/revocation plus retention controls. No tokens in browser bundles, logs or analytics. Plaid sync must process added/modified/removed rows, reconcile pending-to-posted transitions, atomically commit complete pagination with its cursor, and restart on pagination mutation. Expose stale/reconnect/error states instead of showing a green connection for fixtures. Do not enable a production connector by environment flag alone without the required security review.

## Procurement boundary

Procurement should separately track purchase ideas, comparisons, user-approved orders, and subscription records. Planned purchases are not posted spending. Link a confirmed order/subscription to finance transactions only when an actual matching record exists; preserve confidence and source. Do not infer active subscription status or cancellation rights just from recurring merchant names. Checkout, renewals, cancellation, and changes to subscriptions require the applicable approval, scope and provider integration. This finance module does none of those actions.

## Checks

From `frontend`: `node scripts/test-financials.mjs`, `npx tsc --noEmit`, and `npx next build --experimental-build-mode compile`. No production credentials or real financial exports are needed. Full production-data smoke tests are not a substitute for these offline tests and are not run by this change.

