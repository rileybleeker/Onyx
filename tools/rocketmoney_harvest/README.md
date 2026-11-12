# Rocket Money finance ledger: importers and PC harvester

Loads Rocket Money data into the finance tables (`sql/finance_schema.sql`: `pds.finance_accounts`,
`pds.finance_transactions`, `pds.finance_balance_snapshots`). Rocket Money is the only source that sees
all accounts, including the Fidelity balances; it has no API.

## Status

| Piece | State |
|---|---|
| Schema | Applied to the live project. Service-role only: RLS on, no policies, no grants to anon or authenticated. |
| Transaction history | Backfilled once from the export CSV (7,009 rows, 9 accounts, 2019-07-08 to 2026-11-11). Re-running is a no-op. |
| Transactions, going forward | **Not automated** (see "Transactions" below). Re-import a fresh export CSV by hand with `import-csv.mjs`. |
| Balances harvester | Built and unit-tested, **not yet signed in or scheduled**. Follow "Turn it on". |

## Turn it on (balances, daily)

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
4. Check: `node harvest.mjs --dry-run` (reads the app and the database, writes nothing). Then
   `node harvest.mjs --force` for the first real run.
5. Schedule: `pwsh -File register-task.ps1` registers **"Onyx Rocket Money Harvest"**, daily at 07:20.

## When it fails

Every failure writes a `rocketmoney|balances` heartbeat with status `failed` and a short reason to `pds.sync_log`.

| Reason | What to do |
|---|---|
| `login required` | Sign in again (step 3). The next run is not held back by the 20-hour rule. |
| `the Net Worth data did not load within 30 s` / `the account list did not load` | Usually a blip; the next run retries. If it persists the app changed (see "How it reads"). |
| `the app's responses contained no accounts` | The response shape changed; `lib/harvest-core.mjs` `classifyResponse` / `buildBalanceEntries` need an update. |
| `could not read the app: ...` | Chrome could not start (profile open in another window, Chrome updating). |
| `balance import failed: ...` | Database write problem. The scratch file is kept (at most 3) in `%LOCALAPPDATA%\Onyx\rocketmoney-harvest-tmp`. |

## How it reads (read-only by construction)

- It opens `app.rocketmoney.com/net-worth`, then `/settings/accounts`, in the signed-in profile, a normal
  headful Chrome window parked off-screen (no stealth plugin, no fingerprint changes, no headless trick).
- It **listens** to the GraphQL responses the app itself loads (`NetWorthQuery`: asset or debt buckets;
  `SettingsAccountsPage`: name, last four digits, type, balance in cents). It sends no GraphQL of its own.
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

## Transactions: why they are not scheduled

The web app's **Export all transactions** button submits a mutation whose response contains only the viewer's
id and email. The file name (`<request timestamp to the millisecond>-transactions.csv`) is chosen by the server
and shows up only in the email link, and this harvester must never read email. Guessing a millisecond
timestamp would mean thousands of download-link requests a run, so it is not attempted.

The fallback, reading transactions from the Transactions page's own data (`TransactionsPageTransactionTable`),
was measured on 2026-11-12 and does not reproduce the export closely enough to share its keys:

- amounts are integer cents with the export's sign, and every recent row lined up with the database on
  (account, date, amount);
- but the export's `Name` column is sometimes the short name, sometimes the long name and sometimes neither
  (about 30% of recent rows matched neither), so keys built from the web data would not match the ones from
  the export and each row would be imported twice.

Options when you want transactions to refresh on their own: (a) decide a different identity for web-fed rows
(for example the app's own transaction id plus a reconciliation step), which needs a schema change; (b) accept a
manual refresh: click Export in the app, open the link from your own email, run
`node import-csv.mjs <file> --dry-run` and then without `--dry-run`. Re-importing is safe: unchanged rows are
skipped, re-categorized ones are updated, and nothing is ever deleted.

## Importers

All three print one JSON line of counts (never merchants, notes, amounts or balances), exit 0 on success and 1 on
failure, and write a `pds.sync_log` heartbeat on every non-dry run (`source rocketmoney`; `data_type`
`transactions` or `balances`; `partial` when some rows were rejected). `--dry-run` reads the database and writes nothing.

| Command | Input |
|---|---|
| `node import-csv.mjs <file.csv> [--dry-run]` | The Rocket Money export CSV. Columns are read by header name. |
| `node import-rows.mjs <rows.json> [--dry-run]` | A JSON array of objects keyed by the export's column names (must be the complete set). |
| `node import-balances.mjs <balances.json> [--dry-run]` | `[{institution, account_name, account_type, mask, balance_cents, currency, kind, captured_at}]` |

Keys: `account_key` = first 24 hex of sha256(lower(institution)|lower(type)|lower(name)|mask);
`txn_key` = first 32 hex of sha256(account_key|date|original date|name|amount_cents|ordinal), where `ordinal` is the
1-based position among identical rows in file order (the export has no transaction id and about 14% of its rows
are identical to another). Category, note, tags and the like are not in the key and are updated on conflict. Amounts
are stored as exported: expenses positive, income and refunds negative. Only the last four digits of an account
number are ever kept.

## Tests

`node --test test/*.test.mjs` (synthetic data only; no network, browser or credentials). CI runs them in the
"Rocket Money Harvester Tests" workflow. The signed-in browser flow cannot be tested offline.
