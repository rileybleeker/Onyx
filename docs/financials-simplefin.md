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

Every message ends with its code in brackets (`[sf_reauth]`, `[account_unmatched x2]`). The full list is
`NOTE_CODES` in `simplefin_etl.py`.

| Card says | Do |
|---|---|
| `SimpleFIN refused the Access URL ... [sf_access_refused]` | The Access URL was revoked or disabled. Make a new setup token on SimpleFIN's site, then step 3. |
| `SimpleFIN says payment is required [sf_payment_required]` | Renew the SimpleFIN Bridge subscription. |
| `SimpleFIN: a bank connection needs signing in again [sf_reauth]` (amber) | Reconnect that bank on SimpleFIN's site (it marks which one). `--dry-run` locally flags the account too. |
| Other `[sf_...]` codes (amber) | SimpleFIN reported a connection, account or general problem; check its site. Most clear on the next run. |
| `an account was not imported [account_unmatched]` (amber) | A new or renamed account could not be matched; see step 4. |
| `a new account is balances-only ... [account_type_unset]` | Set `finance_accounts.account_type` (Cash or Credit Card) if its transactions should count. |
| `rows near the Rocket Money cutover were kept ... [cutover_review xN]` (amber, once) | Possible duplicates were kept rather than guessed; see "The cutover from Rocket Money" below. |
| `the cutover match record was not saved ... [cutover_provenance_unsaved]` | Apply `sql/finance_cutover_matches.sql`; the ledger itself was written. Rows kept for review are reported (`cutover_review`) by the first run that saves the record. |
| `SimpleFIN reported a problem; its details are not shown here` | An older heartbeat (or an unexpected one) without a code. Wait for the next run, or run `--dry-run` locally. |

## What is never stored or printed

The Access URL is a credential: it is never printed, logged or written to `sync_log`. The Actions log is public,
so a run prints counts only (no names, descriptions, amounts or ids). Pending transactions are not requested.

Heartbeat text is an allowlist (2026-11-16): a code from `NOTE_CODES`, its fixed wording and a count. SimpleFIN's
own error messages (which can name the bank, the person or an account number), institution and account names and
ids never reach `sync_log` or the log; SimpleFIN's `errlist` codes (`con.auth`, `act.failed`, ...) are mapped to our
codes and anything unknown is `sf_unclassified`. `/status` and `/financials` re-render SimpleFIN heartbeats from the
codes alone (`lib/finance-status.ts`, `SIMPLEFIN_NOTES`, which must match `NOTE_CODES`: a test checks), so an older
row or a rolled-back ETL still cannot show free text there.

## The cutover from Rocket Money

Rocket Money rows (up to 2026-11-11) stay as they are. For each account, SimpleFIN rows whose dates (transaction and
posting) are all more than 3 days before the last Rocket Money row are dropped. A row transacted earlier but posted
later is not dropped on its date: Rocket Money skipped pending rows, so it is matched on evidence like the others.

A nearer row is dropped only on identity evidence (2026-11-16). The two feeds share no transaction id, so the
evidence is the account, the amount and the currency plus either:

- **exact**: the same date and the same description (letters only, ignoring store numbers), where the description
  names a merchant (`POS PURCHASE` or `COFFEE SHOP` alone does not) and the payee names do not contradict each
  other. Such rows cannot be told apart, so they are paired one for one (two identical coffees on both sides: both
  match).
- **merchant**: dates within 3 days (either feed's original or posted date counts), more than half of the shorter
  side's description and merchant name words in common, including the word that names the business (its first
  word, unless that is a kind of business such as `COFFEE` or `DELI`), and payee names that do not contradict each
  other, where that one SimpleFIN row and that one Rocket Money row have no other such candidate. A shared city or
  kind of business alone is not enough (`DEMO COFFEE ATLANTA` and `OTHER COFFEE ATLANTA` are two merchants).

Every SimpleFIN row of the response takes part, also the rows before the window, so a Rocket Money row whose twin is
before the window is taken by that twin and a later purchase of the same amount is not matched to it. A Rocket Money
row a recorded decision matched stays taken on later runs, also when SimpleFIN's answer no longer has that row (a
narrower or incomplete answer), and a settled match is not reopened by a new row of the same merchant.

An equal amount alone never drops a row. A row with competing candidates (**ambiguous**) or with a same-amount
Rocket Money row nearby but no merchant evidence (**unconfirmed**) is kept, and so is a row an earlier run already
stored that turns out to match (**stored_duplicate**). The SimpleFIN card turns amber once, with
`[cutover_review xN]`, by the run that records such rows; they may be duplicates to fix by hand.

Every decision is recorded in `pds.finance_cutover_matches` (`sql/finance_cutover_matches.sql`, service-role only):
the SimpleFIN row's key, the decision, its evidence and the Rocket Money key(s), no amounts or text. **That file is
not applied yet: Riley applies it before or with the merge of the change that added it.** Until then every run
works without the record (each response matched on its own) and the card reads amber with
`[cutover_provenance_unsaved]`. To review: `python simplefin_etl.py --dry-run` prints the decisions per account (counts only), and

```sql
select decision, account_key, sf_txn_key, history_txn_keys from pds.finance_cutover_matches
where decision <> 'matched' order by account_key;
```

lists the kept rows next to the Rocket Money rows they might duplicate (join `finance_transactions` on `txn_key`).
Nothing is ever removed automatically: a duplicate is resolved by hand, e.g. by setting its `ignored_from`.

## Categories

SimpleFIN sends no categories, and `/financials` needs them to keep card payments and transfers out of spending. In
order: a matching payment or transfer on another of Riley's accounts (same amount, opposite sign, within 5 days,
payment or transfer wording) becomes Credit Card Payment or Internal Transfers; else the category Rocket Money used
for the same description or merchant; else payment or transfer wording; else none (Uncategorized). About 70% of
recent rows have a description Rocket Money categorized consistently, so expect more Uncategorized than before.
