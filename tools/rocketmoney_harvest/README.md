# Rocket Money finance ledger: importers and PC harvester

> **RETIRED 2026-11-14.** New transactions and balances come from SimpleFIN Bridge (`simplefin_etl.py`,
> `docs/financials-simplefin.md`): the Rocket Money web sign-in expired within hours every day. The Task Scheduler
> entry "Onyx Rocket Money Harvest" is disabled (not deleted). This folder stays as the record of how the history was
> built and for a manual backfill (`import-csv.mjs`). Do not turn the harvester back on as a feed.

Loads Rocket Money data into the finance tables (`sql/finance_schema.sql`: `pds.finance_accounts`,
`pds.finance_transactions`, `pds.finance_balance_snapshots`; `sql/finance_source_txn_id.sql` adds Rocket Money's own
transaction id). Rocket Money is the only source that sees all accounts, including the Fidelity balances; it has no API.

## Status

| Piece | State |
|---|---|
| Schema | Applied to the live project. Service-role only: RLS on, no policies, no grants to anon or authenticated. |
| Transaction history | Backfilled once from the export CSV (7,009 rows, 9 accounts, 2019-07-08 to 2026-11-11), then tied to Rocket Money's own transaction ids once (see "Reconciling the history"). |
| Transactions, going forward | **Automatic, no email, no export**: the daily run reads the Transactions list from the signed-in app and upserts it by Rocket Money's transaction id (see "Transactions"). `import-csv.mjs` stays for manual backfills. |
| Harvester (balances + transactions) | Built and unit-tested. It was signed in once (2026-11-11) and **lost the sign-in within 8 hours**; see "Staying signed in" for why and what changed. It needs one more sign-in (step 3). |

## Turn it on (balances and transactions)

You do these once. The harvester never asks for, types or stores a Rocket Money credential.

1. `cd tools\rocketmoney_harvest` then `npm install`.
2. Make sure `~\.onyx_supabase_secret` exists (the Supabase `sb_secret_` key, one line; the same file the other tools use).
3. Schedule: `pwsh -File register-task.ps1` registers **"Onyx Rocket Money Harvest"**, every 2 hours. Do this
   before signing in: the sign-in only lasts if the app is visited again within a few hours. **Before switching an
   existing daily task to every 2 hours, Riley re-confirms the Rocket Money terms acceptance for the higher visit
   count** (accepted on 2026-11-12 for a once-a-day harvester; this is up to 12 visits a day, see
   `docs/financials-rocket-money.md`, "Terms note").
4. Sign in: `node harvest.mjs --login`. A **normal Chrome window** opens on the harvester's own profile
   (`%LOCALAPPDATA%\Onyx\rocketmoney-harvest-profile`). Sign in yourself, wait until your accounts show, then
   **close the window**. The harvester then runs once straight away and prints `LOGIN OK` (signed in and imported)
   or says what it saw. Nothing is typed for you.
5. Optional: `node harvest.mjs --dry-run` reads the app and the database and writes nothing (the log line
   `transactions (dry run) {...}` shows what would be inserted, updated or attached). `node harvest.mjs --force`
   imports now instead of waiting for the 20-hour mark. `--days N` widens the transaction window (default 60).

If you ever sign in with your own Chrome command instead of `--login`, start it on the same profile; the next
scheduled run notices that the profile was used and imports:

```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\Onyx\rocketmoney-harvest-profile" https://app.rocketmoney.com/net-worth
```

## Staying signed in

**What was found (2026-11-13, from the harvester profile; names and times only, no values).**

- Rocket Money's web sign-in is one short-lived cookie held by its API. It is not a "dies when the browser closes"
  cookie (the harvester restarted Chrome twice within a minute of the 2026-11-11 sign-in and was still signed in),
  and it was gone 8 hours later. An independent open-source Rocket Money client describes the same cookie as
  **rolling, about 3 h 48 min**: every answer from the API re-issues it. A visit once a day can never keep it.
- No token in local storage or IndexedDB, and no sign-in cookie with a far expiry date. The Uber Eats and Kindle
  profiles each hold such a cookie (6 to 12 months), which is why those harvesters stay signed in for weeks with the
  same launch and close code.
- When the app's cookie has lapsed, the app asks the sign-in service (`auth.rocketaccount.com`) to renew it silently.
  On 2026-11-12 and 11-13 that request was answered `login_required`.
- The sign-in service's cookies (`auth0` and `auth0_compat` on `auth.rocketaccount.com`) **are in the profile, and
  they are persistent**: stored on disk, kept across browser restarts, HttpOnly, expiring **72 hours** after they were
  issued (Auth0's default idle limit is 3 days). So Chrome did not throw them away, and the refused renewal 8 hours
  after the 2026-11-11 sign-in (the PC was awake throughout) was most likely refused by the sign-in service itself.
  Caveat: the cookie seen was issued on the signed-out sign-in page; the one issued at sign-in could not be inspected.
- The browser was closed cleanly every time and cookies written seconds before a close were on disk afterwards:
  nothing was lost by the way the harvester shuts Chrome down.

**What the harvester does about it.**

1. **Visits every 2 hours** (the scheduled task). A run imports once 20 hours have passed since the last import; the
   runs in between are keep-alive visits: they open the Net Worth page so the app re-issues its cookie, then close.
   They write nothing to the ledger tables, only a `rocketmoney|keepalive` heartbeat (see "When it fails"). Two hours
   is well inside both lifetimes: the app cookie (about 3 h 48 min) and the sign-in service's cookie (72 h); a test
   pins that (`test/session.test.mjs`).
2. **Never re-opens old tabs.** Chrome is started without `--restore-last-session`, and if the profile's "On startup"
   setting was set to "Continue where you left off", the saved tabs go to the Recycle Bin before Chrome starts and
   the setting is switched back to "Open the New Tab page". A re-opened tab would load the app before the read-only
   guard exists. Nothing the sign-in needs depends on it: its cookies are persistent (above).
3. **Follows the silent renewal** instead of calling the first redirect "signed out": a visit is signed in when the
   Net Worth data arrives, and signed out only when the page comes to rest on a sign-in screen.
4. **Says what it saw.** Each signed-in visit logs the kind and remaining minutes of the session cookies (never a
   value) and whether the session had to be renewed. A lost sign-in is reported by whichever run finds it, at once,
   as a failed heartbeat: where the page stopped, what the silent renewal answered, how long ago it was last signed
   in and how long that sign-in lasted.
5. **Stops knocking while signed out.** After a `login required`, the sign-in page is opened again only after 20
   hours, with `--force`, or as soon as the profile has been used (you signed in).

**What to expect, not yet proven.** A keep-alive cannot run while the PC is asleep. Because the sign-in service's
cookie is persistent and still refused the silent renewal once while the PC was awake, a sleep longer than the app
cookie's lifetime is **expected to end the sign-in**, unless the first `signed in:` line after a long sleep says the
session "had lapsed and was renewed without a sign-in". Also not known until you sign in once: the app cookie's real
lifetime and how long a sign-in lasts in total. The Chrome side (the guard before any page loads, the redirect
handling, the keep-alive, the plain sign-in window) was run against a stand-in site on localhost with the installed
Chrome.

**What to look at after signing in** (`harvest.log`, in this folder):

| Line | Meaning |
|---|---|
| `session cookies: app <name>: N min left; sign-in service <name>: ...` | `N` is the app cookie's real lifetime (about 228 if the 3 h 48 min figure is right). The sign-in service's cookie should read about 4320 min (72 h); `browser-session only` there would contradict what was found on 2026-11-13 and is logged as a `NOTE:`. |
| `NOTE: the sign-in service's cookie has N h left; ...` | Less than a day left on the sign-in service's own cookie: once it is gone, a lapsed app session needs a new sign-in. |
| `WARNING: the app session has N min left, less than the 2-hour schedule needs` | The lifetime is shorter than assumed: lower `-Hours` in `register-task.ps1`. |
| `signed in: the app session was still alive (visit K since ...)` | The keep-alive is holding it. |
| `signed in: the app session had lapsed and was renewed without a sign-in` | The silent renewal works. If this appears after the PC was asleep for hours, the sign-in survives sleep gaps. |
| `FAILED: login required ...; silent renewal: login_required; last signed in X h ago; sign-in lasted Y h` | The sign-in service refused. `X` near the length of a sleep means sleep gaps end the sign-in (see below); a steady `Y` across failures is the sign-in's total lifetime. |

**If a sleep gap ends the sign-in** (the expected case, see above) there are three ways out, none built: keep the
session on a machine that never sleeps; use another source for balances and transactions (a bank-data aggregator such
as SimpleFIN, or Rocket Money's emailed export, which needs mailbox access); or let the task wake the laptop
(`pwsh -File register-task.ps1 -Wake`, see the warning in that file: where wake timers are allowed on battery, a
closed laptop wakes in its bag).

## When it fails

Every failure writes a `failed` heartbeat with a short reason to `pds.sync_log`: `rocketmoney|balances`,
`rocketmoney|transactions`, or both when the run could not read the app at all. The two steps are independent: a failed
balances import does not stop the transactions step, and the other way round. A run with unreadable or ambiguous rows
writes `partial` (counts in the message). Every keep-alive visit writes `rocketmoney|keepalive`: `success`, or for a
visit that fails for a reason other than a lost sign-in `partial` on the first miss in a row and `failed` from the
second (the app cookie outlives one missed visit, not two). The `/status` card counts that heartbeat only when it is
newer than both import heartbeats, so a failing keep-alive shows before the sign-in lapses; it never makes the card
look fresher.

| Reason | What to do |
|---|---|
| `login required: ...; at <where>; silent renewal: <answer>; last signed in X h ago; sign-in lasted Y h` | Sign in again (step 4). The text says what was seen; "Staying signed in" explains how to read it. The first signed-in run imports straight away. |
| `keep-alive visit failed (N in a row): ...` | The keep-alive could not open the app (the reason follows, same words as below). Two in a row and the sign-in has probably lapsed; the next visit says which. |
| `the transactions read was refused although the app was signed in (...)` | The landing of the same visit was signed in, so this is not treated as a lost sign-in (the keep-alive visits go on); the next visit's landing decides. If it repeats while the landing stays signed in, the Transactions request changed (see below). |
| `the Net Worth data did not load within 45 s` / `the account list did not load` | Usually a blip; the next run retries. If it persists the app changed (see "How it reads"). |
| `the sign-in round trip stopped at <where>` | The page left the app and came to rest somewhere that is neither the app nor a sign-in screen (a block or error page). `harvest.log` has the hops. |
| `the app's responses contained no accounts` | The response shape changed; `lib/harvest-core.mjs` `classifyResponse` / `buildBalanceEntries` need an update. |
| `could not read the app: ...` | Chrome could not start (profile open in another window, Chrome updating), or the profile is set to re-open its last tabs and they could not be moved to the Recycle Bin (then Chrome is not started at all). |
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
- It never types and never clicks in Rocket Money. As a guard, any GraphQL request whose body is a **mutation**
  is aborted in every tab of the browser (`attachReadOnlyGuard`, `isMutationRequest`), so nothing in the account can
  change even if the page fires one. The guard is the first thing attached after Chrome starts, and no page of the
  app can load before it: Chrome is never asked to re-open old tabs, and a profile set to do so has its saved tabs
  moved to the Recycle Bin before Chrome starts (`lib/browser.mjs`; a test pins the order, and a stand-in run with
  the installed Chrome found 0 mutations reaching the stand-in API both after the profile was closed on the app
  with that setting on and after a run that was killed while on the app).
- The one thing it may change outside Rocket Money is Chrome's "On startup" setting, in its own profile only and
  only if someone set it to "Continue where you left off": it is switched back to "Open the New Tab page" through
  Chrome's settings page.
- It never reads email.
- Liabilities are stored as positive amounts owed with `kind = 'liability'`; net worth = assets minus liabilities.
- A balance entry is matched to an existing account by the export's key, with or without the `NAME ...1234`
  suffix the export uses for some institutions, else by institution plus last four digits when that is unique;
  otherwise a new account row is created (the Fidelity accounts, which have no transactions).
- It imports at most once every 20 hours unless `--force` (the runs in between are keep-alive visits), takes a
  lock file so two runs cannot overlap, and logs counts and statuses only to `harvest.log` (gitignored, with
  `state.json` and the scratch folder).
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
rows, the in-page reader against a mocked `fetch`, the heartbeats and exit codes, the CSV surplus rule, and the
sign-in handling (`test/session.test.mjs`: which address is a sign-in screen and which is only a redirect hop, the
visit verdict over time, the failure text, the keep-alive and signed-out schedule, the launch arguments, the guard
attached before any page loads, saved tabs cleared before launch). The signed-in
browser flow (Playwright driving the real app) cannot be tested offline; run `node harvest.mjs --dry-run` yourself.
