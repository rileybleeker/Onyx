# Rocket Money finance ledger: importers and PC harvester

Loads Rocket Money data into the finance tables (`sql/finance_schema.sql`: `pds.finance_accounts`,
`pds.finance_transactions`, `pds.finance_balance_snapshots`; `sql/finance_source_txn_id.sql` adds Rocket Money's own
transaction id). Rocket Money is the only source that sees all accounts, including the Fidelity balances; it has no API.

## Status

| Piece | State |
|---|---|
| Schema | Applied to the live project. Service-role only: RLS on, no policies, no grants to anon or authenticated. |
| Transaction history | Backfilled once from the export CSV (7,009 rows, 9 accounts, 2019-07-08 to 2026-11-11), then tied to Rocket Money's own transaction ids once (see "Reconciling the history"). |
| Transactions, going forward | **Automatic, no email, no export**: the daily run reads the Transactions list from the signed-in app and upserts it by Rocket Money's transaction id (see "Transactions"). `import-csv.mjs` stays for manual backfills. |
| Harvester (balances + transactions) | Built and unit-tested, **not yet signed in or scheduled**. Follow "Turn it on". The signed-in browser flow cannot be tested offline. |

## Turn it on (balances and transactions, daily)

You do these once. The harvester never asks for, types or stores a Rocket Money credential.

1. `cd tools\rocketmoney_harvest` then `npm install`.
2. Make sure `~\.onyx_supabase_secret` exists (the Supabase `sb_secret_` key, one line; the same file the other tools use).
3. Sign in: `node harvest.mjs --login`. A Chrome window opens on a dedicated profile
   (`%LOCALAPPDATA%\Onyx\rocketmoney-harvest-profile`). Sign in yourself; when the Net Worth page has loaded the
   script says `LOGIN OK` and closes the window. If Rocket Money refuses to sign in inside the automated window,
   use a plain Chrome window on the same profile (the route that worked for the Uber Eats harvester), sign in,
   then **close that window** (the harvester cannot start while it is open):

   ```
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\Onyx\rocketmoney-harvest-profile" https://app.rocketmoney.com/net-worth
   ```
4. Check: `node harvest.mjs --dry-run` (reads the app and the database, writes nothing; the log line
   `transactions (dry run) {...}` shows what would be inserted, updated or attached). Then
   `node harvest.mjs --force` for the first real run. `--days N` widens the transaction window (default 60).
5. Schedule: `pwsh -File register-task.ps1` registers **"Onyx Rocket Money Harvest"**, daily at 07:20.

## When it fails

Every failure writes a `failed` heartbeat with a short reason to `pds.sync_log`: `rocketmoney|balances`,
`rocketmoney|transactions`, or both when the run could not read the app at all. The two steps are independent: a failed
balances import does not stop the transactions step, and the other way round. A run with unreadable or ambiguous rows
writes `partial` (counts in the message).

| Reason | What to do |
|---|---|
| `login required` | Sign in again (step 3). The next run is not held back by the 20-hour rule. |
| `the Net Worth data did not load within 30 s` / `the account list did not load` | Usually a blip; the next run retries. If it persists the app changed (see "How it reads"). |
| `the app's responses contained no accounts` | The response shape changed; `lib/harvest-core.mjs` `classifyResponse` / `buildBalanceEntries` need an update. |
| `could not read the app: ...` | Chrome could not start (profile open in another window, Chrome updating). |
| `balance import failed: ...` | Database write problem. The scratch file is kept (at most 3) in `%LOCALAPPDATA%\Onyx\rocketmoney-harvest-tmp`. |
| `the transactions request ...` / `the transactions query was rejected` / `... unexpected shape` | The Transactions data changed or was refused. `lib/web-transactions.mjs` holds the query (`TRANSACTIONS_QUERY`) and the reader; compare with what the Transactions page asks for. |
| `no readable transactions in the last N days` | The app returned rows the reader could not use (or none). Same place as above. |
| `transaction import failed: ...` | Database problem while writing the transactions. Safe to run again: it is idempotent. |
| `partial`: `N row(s) rejected, M left alone as ambiguous` | Rejected = a row without a usable id, date, amount or account. Ambiguous = rows the harvester could not safely pair with an existing export row (see below); they are not inserted, so no duplicate is created. |

## How it reads (read-only by construction)

- It opens `app.rocketmoney.com/net-worth`, then `/settings/accounts`, in the signed-in profile, a normal
  headful Chrome window parked off-screen (no stealth plugin, no fingerprint changes, no headless trick).
- It **listens** to the GraphQL responses the app itself loads (`NetWorthQuery`: asset or debt buckets;
  `SettingsAccountsPage`: name, last four digits, type, balance in cents).
- For transactions it then runs the Transactions list's own read query from inside the same page, with the page's
  own session (`pageFetchTransactions`): the app's operation name and fields, 200 rows per request, last 60 days.
  That is the only GraphQL the harvester sends, it is a **query**, and a test pins that it is never a mutation.
- It never types and never clicks. As a guard, any GraphQL request whose body is a **mutation** is aborted
  in the browser (`isMutationRequest`), so nothing in the account can change even if the page fires one.
- It never reads email.
- Liabilities are stored as positive amounts owed with `kind = 'liability'`; net worth = assets minus liabilities.
- A balance entry is matched to an existing account by the export's key, with or without the `NAME ...1234`
  suffix the export uses for some institutions, else by institution plus last four digits when that is unique;
  otherwise a new account row is created (the Fidelity accounts, which have no transactions).
- It refuses to run twice within 20 hours unless `--force`, takes a lock file so two runs cannot overlap, and
  logs counts only to `harvest.log` (gitignored, with `state.json` and the scratch folder).
- The scratch `balances.json` goes in a fresh folder under `%LOCALAPPDATA%\Onyx\rocketmoney-harvest-tmp` and is
  sent to the Recycle Bin (.NET API) after a successful import.

## Transactions

Rocket Money's **Export** button only emails a link (the file name is the server's request time), and this harvester
never reads email, so the export cannot be automated. The Transactions page's own data, though, carries a stable id for
every transaction and matches the export on account, date and amount for every row. Its `name` differs from the export's
`Name` for roughly a third of the rows, so web rows are **never keyed on the name**; they are keyed on the id.

Per run (`lib/web-transactions.mjs`), for the last 60 days of non-pending transactions, by Rocket Money transaction id:

| Case | What happens | Summary count |
|---|---|---|
| (a) the id is already in the ledger | the web fields are refreshed: date, amount, name, category, note, ignored-from, tax-deductible, `last_seen_at` | `updated` (or `unchanged`) |
| (b) the id is new, and exactly as many export rows without an id share its (account, date, amount) | the id is attached to that row (and the same fields refreshed). With identical rows the pairing follows the rule below; a pairing the data cannot prove is left alone | `attached` (or `ambiguous`) |
| (c) otherwise | a new row is inserted, `txn_key` = first 32 hex of sha256(`rmid` + `\|` + id) | `inserted` |

- **Pending rows are skipped** (a pending transaction can change id, date or amount when it posts), so nothing has to be
  re-keyed later. An export row that was pending when exported stays untied until its posted twin shows the same
  account, date and amount; if the posting changed the date or amount it stays as a stale row (about a dozen such rows today).
- **Idempotent**: ids are unique (`finance_transactions_source_txn_id_uidx`) and keys derive from the id, so re-running
  adds nothing. **Nothing is ever deleted**, including rows that are not in the window.
- **What the web does not carry** is never touched: custom name, tags, description (the bank text) and original date stay
  as the export set them; rows created from the web leave them empty.
- `name` follows the web (its short name). A row first written from the export may therefore get the web's name on its
  first run; that is a one-time normalization, not churn.
- The export's blank `Ignored From` is replaced by the web's value (`everything` on 1,915 historical rows, all of them
  Internal Transfers, Credit Card Payment or Savings Transfer, which `/financials` already leaves out of spending).
- The summary and the heartbeat hold **counts only**: no ids, names, amounts or dates.

### Pairing identical rows (rule measured on the full history)

Within one (account, date, amount) group the web lists transactions newest id first, and the export lists them oldest
first; so the n-th row of the file takes the n-th smallest id. On the 2026-11-12 history this held in every one of the 528
multi-row groups, and all 1,086 rows in them agreed on category (884 under the opposite direction). The one-off
reconciliation below uses the file order; the daily run has no file, so for identical export rows without an id it only
accepts a pairing the rows prove (different categories fixing the order, or rows identical in every column, where any
pairing is the same pairing).

## Reconciling the history (one-off, already done once)

`reconcile-ids.mjs` ties the 7,009 export rows to their web ids once so the daily run never has to guess:

```
node reconcile-ids.mjs --web <web-history.json> --csv <export.csv>            # dry run (default): counts only
node reconcile-ids.mjs --web <web-history.json> --csv <export.csv> --apply    # writes, only if >= 98% match
```

`--apply` changes **only** the `source_txn_id` column and refuses to write below a 98% match rate. Ambiguous or
unmatched rows stay NULL and are counted. The web file is a scratch file (ids, dates, accounts, amounts) that must stay
outside the repository and OneDrive and go to the Recycle Bin afterwards. Result on 2026-11-12: 6,997 of 7,009 rows tied
(99.83%); 12 left NULL (rows with no posted counterpart in the app, mostly transactions still pending there, plus one group whose counts differ by one).

## Importers

All three print one JSON line of counts (never merchants, notes, amounts or balances), exit 0 on success and 1 on
failure, and write a `pds.sync_log` heartbeat on every non-dry run (`source rocketmoney`; `data_type`
`transactions` or `balances`; `partial` when some rows were rejected). `--dry-run` reads the database and writes nothing.

| Command | Input |
|---|---|
| `node import-csv.mjs <file.csv> [--dry-run]` | The Rocket Money export CSV. Columns are read by header name. Safe to run after web ingestion, see "Re-importing a CSV" below. |
| `node reconcile-ids.mjs --web <file.json> --csv <export.csv> [--apply]` | One-off, see "Reconciling the history". Dry run unless `--apply`. |
| `node import-rows.mjs <rows.json> [--dry-run]` | A JSON array of objects keyed by the export's column names (must be the complete set). |
| `node import-balances.mjs <balances.json> [--dry-run]` | `[{institution, account_name, account_type, mask, balance_cents, currency, kind, captured_at}]` |

### Re-importing a CSV after web ingestion

Rows written from the web have a different key than the same transaction in a CSV, so a naive re-import would insert
every one of them twice. `import-csv.mjs` therefore inserts **count-based**: per (account, date, amount) group, a CSV row
whose key the ledger does not have is inserted only when the CSV holds more rows for that group than the ledger already
does (the surplus, newest in file order first). The others are counted as `matched_existing` and left alone. Rows whose
key exists (the normal case: the export rows already in the ledger) are updated as before. `--dry-run` shows the counts.

Keys: `account_key` = first 24 hex of sha256(lower(institution)|lower(type)|lower(name)|mask);
`txn_key` = first 32 hex of sha256(account_key|date|original date|name|amount_cents|ordinal), where `ordinal` is the
1-based position among identical rows in file order (the export has no transaction id and about 14% of its rows
are identical to another). Category, note, tags and the like are not in the key and are updated on conflict. Amounts
are stored as exported: expenses positive, income and refunds negative. Only the last four digits of an account
number are ever kept.

## Tests

`node --test test/*.test.mjs` (synthetic data only; no network, browser or credentials). CI runs them in the
"Rocket Money Harvester Tests" workflow. Covered: the pairing rule and its ambiguity cases, the reconciliation (dry run
writes nothing, `--apply` touches only `source_txn_id`, the 98% floor), the three upsert cases, idempotency, pending
rows, the in-page reader against a mocked `fetch`, the heartbeats and exit codes, and the CSV surplus rule. The signed-in
browser flow (Playwright driving the real app) cannot be tested offline; run `node harvest.mjs --dry-run` yourself.
