# Financials: SimpleFIN Bridge feed

Since 2026-11-14 the finance ledger behind `/financials` and `/procurement` is fed by
[SimpleFIN Bridge](https://beta-bridge.simplefin.org), a paid, read-only bank-data service ($15 a year).
It replaced the Rocket Money browser harvester, whose web sign-in expired within hours every day.

- Code: `simplefin_etl.py` (rules in its docstring), workflow `.github/workflows/simplefin-etl.yml`
  (every 6 hours at :30), schema `sql/finance_simplefin.sql`, tests `tests/test_simplefin_etl.py`.
- `/status` card **SimpleFIN**: degraded after 14 hours without a heartbeat, red after 30 hours or on a failed run.

## Coverage (checked 2026-11-14 on SimpleFIN's bank search)

| Account | Through SimpleFIN |
|---|---|
| Amex, Wells Fargo, Citi, Discover, Fidelity | Yes, refreshed about daily |
| Apple Card | Yes, but "Updated Monthly" (statement level) |
| Apple Cash | Not offered (Apple exposes it only on the iPhone, via FinanceKit) |

Investment accounts (Fidelity, the Wells Fargo brokerage) are stored as balances only, as before.

## One-time setup (Riley)

1. Create the SimpleFIN Bridge account and connect each bank on SimpleFIN's own site.
2. Choose **New app connection** and save the setup token it shows into `C:\Users\riley\.simplefin_setup_token`.
   Do not paste it into a chat.
3. Run `python simplefin_etl.py --claim --set-github-secret`. This exchanges the token (it works only once) for the
   read-only Access URL, saves it to `~/.simplefin_access_url` and sets the GitHub secret `SIMPLEFIN_ACCESS_URL`.
4. Check the matching locally: `python simplefin_etl.py --dry-run`. Every account line should say
   `linked`, `matched` or `new`; a `skip` line means an account could not be matched safely (set its
   `finance_accounts.simplefin_id` by hand, then run again).
5. `gh workflow run simplefin-etl.yml` for the first import; the schedule takes over from there.

## When the card is not green

| Card says | Do |
|---|---|
| `SimpleFIN refused the Access URL ...` | The Access URL was revoked or disabled. Make a new setup token on SimpleFIN's site, then step 3. |
| `SimpleFIN says payment is required` | Renew the SimpleFIN Bridge subscription. |
| `SimpleFIN: <a message about a bank>` (amber) | That bank needs reconnecting on SimpleFIN's site. |
| `one ... account was not imported` (amber) | A new or renamed account could not be matched; see step 4. |
| `one new ... account is balances-only until its account type is set` | Set `finance_accounts.account_type` (Cash or Credit Card) if its transactions should count. |

## What is never stored or printed

The Access URL is a credential: it is never printed, logged or written to `sync_log`. The Actions log is public,
so a run prints counts only (no names, descriptions, amounts or ids). Pending transactions are not requested.

## The cutover from Rocket Money

Rocket Money rows (up to 2026-11-11) stay as they are. For each account, SimpleFIN rows dated more than 3 days before
the last Rocket Money row are dropped; nearer ones are dropped only when a Rocket Money row with the same amount
within 3 days exists. Rows Rocket Money never stored (it skipped pending ones) are kept.

## Categories

SimpleFIN sends no categories, and `/financials` needs them to keep card payments and transfers out of spending. In
order: a matching payment or transfer on another of Riley's accounts (same amount, opposite sign, within 5 days,
payment or transfer wording) becomes Credit Card Payment or Internal Transfers; else the category Rocket Money used
for the same description or merchant; else payment or transfer wording; else none (Uncategorized). About 70% of
recent rows have a description Rocket Money categorized consistently, so expect more Uncategorized than before.
