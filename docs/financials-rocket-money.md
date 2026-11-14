# Financials: Rocket Money first

> **Superseded 2026-11-14:** the ledger is now fed by SimpleFIN Bridge, see `docs/financials-simplefin.md`. The Rocket
> Money harvester is retired; the rows it and the CSV export stored before the cutover stay as history.

## Current state (2026-11-12)

`/financials` shows a persisted ledger. Accounts, balances and transactions from Rocket Money are stored in `pds.finance_accounts`, `pds.finance_transactions` and `pds.finance_balance_snapshots` and are filled by a Rocket Money importer and a daily harvester (separate from the frontend). The page is rendered on the server for every request (`force-dynamic`: no ISR, no CDN caching, `noindex`), only for the signed-in owner. It shows net worth and the latest balance per account (with its capture time and a stale badge after 48 hours), a month picker with money in / money out / net cashflow, a category outflow ranking, a 12-month spending trend, and a searchable, server-paged transaction list with a per-account filter.

Rules the page follows:

- **Service role only.** The three tables have RLS on, no policies and no grants to `anon`/`authenticated`. The browser never queries them. The only reader is `frontend/src/lib/finance-ledger-server.ts` (`server-only`, service-role key, explicit column lists, no `select *`), called from the server page behind the owner-only middleware. No chat or LLM tool reads finance data, and nothing logs rows (failures log an error code only).
- **Sign convention.** `amount_cents` follows Rocket Money: expenses are positive, income and refunds are negative. Money in includes refunds (they are money coming back, not income).
- **Not spending.** The categories `Internal Transfers`, `Credit Card Payment` and `Savings Transfer` (one constant, `NON_SPENDING_CATEGORIES` in `lib/finance-ledger.ts`) and any row with a non-empty `ignored_from` are excluded from money in/out, the ranking and the trend. Non-USD rows are never added to USD totals.
- **Net worth.** Assets minus liabilities from the newest balance per account. A liability always reduces net worth (by its absolute value, whichever sign the source used). A balance whose `kind` is null is listed as unclassified and left out of the totals rather than guessed from the account type; non-USD balances are listed and left out; accounts with no snapshot yet are listed as such.
- **Honest states.** "No ledger data yet - the harvester has not run." (empty ledger), "Couldn't load the ledger." (a failed query) and the data view are three different states. Investment accounts appear from balances only.
- **Transaction identity.** Transactions are keyed on Rocket Money's own transaction id (`source_txn_id`), read automatically from the signed-in app by the harvester (no email, no export button). Names are not part of the identity: the app's names differ from the export's for about a third of the rows. The export CSV remains the manual backfill and cannot duplicate web rows (count-based insert). Details and the tie-breaking rule for identical rows: `tools/rocketmoney_harvest/README.md`.
- **Health.** The importers write `sync_log` heartbeats (`rocketmoney` / `transactions` and `balances`) on every import run, and the harvester's keep-alive visits write `rocketmoney` / `keepalive`; `/status` has a "Rocket Money" card (more than 36 hours degraded, more than 72 hours or a failed run red, a failed run shows its own error text such as a login-required message). The card reads heartbeats only, never amounts. The harvester's task runs every 2 hours to keep Rocket Money's short web sign-in alive (it imports once 20 hours have passed since the last import; the other runs only open the app); a lost sign-in turns the card red at once with what was seen, and a keep-alive visit that fails for another reason makes it degraded (red from the second in a row) when it is newer than the imports (`tools/rocketmoney_harvest/README.md`, "Staying signed in").

The earlier browser-memory CSV workspace (PR #28) is kept as a secondary tool under a "Preview a CSV" disclosure on the same page. It still has no finance API, database writes, credentials, model calls or storage: selecting a file only stages a preview, an explicit mapping, date/sign review, USD confirmation and a second import action replace the current in-memory snapshot, invalid rows block import, and Clear session or a reload clears it. It does not read from or write to the saved ledger. Keep the original export.

Tests use synthetic fixtures only (the repository is public): no real transactions, names, balances or account details belong in tests, screenshots, PR text or logs.

## Official provider findings (2026-11-11)

- Rocket Money documents CSV transaction export on mobile and web; the emailed download must be opened on desktop: https://help.rocketmoney.com/en/articles/10296106-exporting-transactions
- Official premium feature list includes data export: https://help.rocketmoney.com/en/articles/2677184-premium-membership-features
- No supported public Rocket Money developer API was verified in official documentation searches. This is not proof that a private partner API cannot exist. No support outreach was attempted.
- A future live-bank alternative is Plaid Transactions, not a Rocket Money account connection: https://plaid.com/docs/transactions/

## Terms note (accepted risk)

Rocket Money's terms require express consent for automated extraction, and its access/interference terms apply to scraping and reverse-engineered connectors: https://www.rocketmoney.com/terms. Riley accepted this terms risk on 2026-11-12 for the automated harvester that fills the ledger (a personal tool reading Riley's own accounts). It is not a supported connector: it can break or be blocked whenever Rocket Money changes its site or terms, and a login-required failure surfaces on `/status` rather than being hidden. The terms note stays here so the decision is visible, not forgotten.

**Visit count changed (2026-11-14).** That acceptance was given for a harvester that opened Rocket Money once a day. To hold the short web sign-in, the harvester now visits **every 2 hours, up to 12 times a day** (one import a day; the other visits only open the Net Worth page and read nothing else). This is a new, higher level of automated access. Riley re-confirms the terms acceptance for that frequency before the scheduled task is switched to every 2 hours; until then the existing task keeps its old schedule and the sign-in is expected to lapse between daily runs.

## Future live connector boundary

Keep provider-neutral normalized posted transactions with integer minor units, explicit ISO currency, provider/item/account/transaction IDs, booked dates, pending status, provenance, and sync timestamps. Separate connections from accounts and import batches. Deduplicate by provider stable ID; CSV without stable IDs needs batch replacement or explicit overlap reconciliation, never merchant/amount-only deletion of legitimate identical purchases.

A supported connector requires approved setup and provider costs/terms, a user-initiated consent flow, server-only encrypted credentials, least-privilege read-only transaction access, owner-only authenticated endpoints/RLS, CSRF protection, webhook verification, and disconnect/revocation plus retention controls. No tokens in browser bundles, logs or analytics. Plaid sync must process added/modified/removed rows, reconcile pending-to-posted transitions, atomically commit complete pagination with its cursor, and restart on pagination mutation. Expose stale/reconnect/error states instead of showing a green connection for fixtures. Do not enable a production connector by environment flag alone without the required security review.

## Procurement boundary

Procurement should separately track purchase ideas, comparisons, user-approved orders, and subscription records. Planned purchases are not posted spending. Link a confirmed order/subscription to finance transactions only when an actual matching record exists; preserve confidence and source. Do not infer active subscription status or cancellation rights just from recurring merchant names. Checkout, renewals, cancellation, and changes to subscriptions require the applicable approval, scope and provider integration. This finance module does none of those actions.

## Checks

From `frontend`: `node --test tests/finance-ledger.test.cjs tests/finance-ledger-view.test.cjs tests/finance-ledger-server.test.cjs` (pure ledger functions, heartbeat/status card, rendering, and the server fetcher against an in-memory stand-in), `node scripts/test-financials.mjs` (CSV preview), `npx tsc --noEmit`, `npm run lint`, and `npx next build --experimental-build-mode compile`. No production credentials or real financial data are needed. The smoke test (`e2e/smoke.spec.ts`) loads `/financials` as an authenticated page-loads check and treats the honest empty state as a skip, not a failure; production-data smoke tests are not a substitute for the offline tests.

For isolated interactive checks of the CSV preview, run `node frontend/scripts/test-financials-ui.mjs` from the repository root (Chromium must already be installed for Playwright). It copies only the preview component and styles to a temporary app with its own minimal page, omits production environment variables, blocks external browser requests, exercises mobile/desktop flows and >100-row navigation, and retains synthetic screenshots in its printed temporary directory. It does not exercise production authentication or database access, and it does not render the ledger view.
