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
| `rows near the Rocket Money cutover were kept ... [cutover_review xN]` (amber, once) | Possible duplicates were kept rather than guessed; see "The cutover from Rocket Money" below. Reported by the run that records them: if that run's ledger write then fails, the count is on its red `db_write_failed` heartbeat, and the next run (which writes those rows) does not report them again. |
| `the cutover match record table is missing ... [cutover_provenance_unsaved]` (red) | Apply `sql/finance_cutover_matches.sql`. Nothing was written that run: a run with cutover decisions to record stops before the ledger, so no row is left out on a match that is not on record. |
| `the SimpleFIN ETL could not write to Supabase [db_write_failed]` (red) | The cutover record (written first) or the ledger could not be written; the next run retries (every write is an upsert). |
| `the SimpleFIN ETL could not read its cutover record ... [db_read_failed]` (red) | Nothing was written that run; the next run retries. If it repeats, check that Supabase is up and the table is readable. |
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

Rocket Money rows (up to 2026-11-11) stay as they are. For each account, a SimpleFIN row transacted more than 3 days
before the last Rocket Money row and posted by that date is dropped: it was posted while Rocket Money still read the
account, so its history has it. A row transacted earlier but posted after that date is not dropped on its date:
Rocket Money skipped pending rows, so it is matched on evidence like the others.

A nearer row is dropped only on identity evidence (2026-11-16). The two feeds share no transaction id, so the
evidence is the account, the amount and the currency plus either:

- **exact**: the same date and the same description text (store numbers included, so `DEMO DELI 0042` and `DEMO
  DELI 0099` are two shops), where the description names a merchant (`POS PURCHASE` or `COFFEE SHOP` alone does
  not) and the payee names do not contradict each other.
- **merchant**: dates within 3 days (either feed's original or posted date counts) and the same merchant: more than
  half of the shorter side's description and merchant name words in common, the distinctive words of one side
  (all but kinds of business such as `COFFEE` or `DELI`) all present on the other, including the word that names
  the business, and payee names that do not contradict each other. A shared city, kind of business or first word
  is not enough (`DEMO COFFEE ATLANTA` and `OTHER COFFEE ATLANTA`, or `DEMO BOTTLE COFFEE` and `DEMO DONKEY
  COFFEE`, are two merchants), while a bank text and its cleaned name agree (`DEMO CAFE 0042 ATLANTA GA` and
  `Demo Cafe`). A candidate pair counts only at the smallest date gap of both its rows, so the same purchase on
  consecutive days pairs day by day. A day Rocket Money lacks is kept, since its neighbours are the nearer twins.

Payee names contradict when both name a business and neither one's distinctive words (all but kinds of business
and generic words such as `STORE`, `COFFEE` or `POS`) are all on the other row: `Demo Store` and `Other Store`
share a word and are still two payees. A payee of generic words only says nothing either way.

In both steps a group of candidate pairs is a match only when it is one to one, or when its rows cannot be told
apart on either side (same dates and text) and every SimpleFIN row has a twin of its own: two identical coffees on
both sides both match, and one coffee with two identical Rocket Money twins matches one of them (the only unequal
group that is paired: whichever twin it takes, the same SimpleFIN row is dropped and the other twin stays free).
More SimpleFIN rows than twins (two identical new rows and one Rocket Money row) is never guessed: all of them are
kept as ambiguous, and that Rocket Money row is held, so no other row is matched to it.

Every SimpleFIN row of the response takes part, also the rows before the window, so a Rocket Money row whose twin is
before the window is taken by that twin and a later purchase of the same amount is not matched to it. That match is
recorded too. A Rocket Money row a recorded decision matched stays taken on later runs, also when SimpleFIN's answer
no longer has that row (a narrower or incomplete answer), and a settled match is not reopened by a new row of the
same merchant. In the same way the candidates of a row recorded as **ambiguous** stay held while that row is missing
from a later answer (also a row before the window, which is dropped all the same but recorded for this): two
identical purchases competing for one Rocket Money row, then an answer with only a new purchase of that amount two
days later, keep the new purchase for review instead of matching it to the held row. A held row is never freed by
the run itself; that is a decision by hand. A recorded match or ambiguity that a row still in the answer no longer
carries (SimpleFIN corrected its amount or text) is replaced, before the ledger is written, by the new decision or
by **unconfirmed** with the Rocket Money keys the old record named: the row is kept and listed for review, and the
Rocket Money row is free again for its real twin, also when a later answer lacks the corrected row.

An equal amount alone never drops a row. A row with competing candidates (**ambiguous**: a tie on dates, rows that
can be told apart competing for one twin, or more SimpleFIN rows than twins) or with a same-amount Rocket Money row
nearby but no merchant evidence (**unconfirmed**) is kept, and so is a row an earlier run already stored that turns
out to match (**stored_duplicate**). The SimpleFIN card turns amber once, with `[cutover_review xN]`, by the run that
records such rows; they may be duplicates to fix by hand, so check them (for example in the weekly review) until
each is settled:

```sql
select m.decision, m.account_key, m.sf_txn_key, m.history_txn_keys
from pds.finance_cutover_matches m
join pds.finance_transactions t on t.txn_key = m.sf_txn_key
where m.decision <> 'matched' and coalesce(t.ignored_from, '') = ''
order by m.account_key;
```

lists the kept rows still counted next to the Rocket Money rows they might duplicate (join `finance_transactions`
on `txn_key` again for the details). The record also holds decisions on rows dropped before the window (kept there
only so their Rocket Money rows stay taken or held); the join leaves them out, and they are never reported as
`cutover_review`. A kept row that is a real purchase needs no change; a duplicate is resolved by hand, e.g. by
setting its `ignored_from`. Nothing is ever removed automatically. `python simplefin_etl.py --dry-run` prints the
decisions per account (`... before the window` for the dropped ones) and the rows recorded for review so far that
are in the ledger (counts only).

The matches and the kept rows are recorded in `pds.finance_cutover_matches` (`sql/finance_cutover_matches.sql`,
service-role only): the SimpleFIN row's key, the decision, its evidence and the Rocket Money key(s), no amounts or
text. The record is written **before** the ledger, and a run that cannot write it writes nothing (`[db_write_failed]`,
red; the next run retries): a row is left out of the ledger, and its Rocket Money twin taken, only by a match on
record. Otherwise a failed record followed by a SimpleFIN answer without that row could let another purchase take the
same Rocket Money row. While the table does not exist, a run with decisions to record stops the same way
(`[cutover_provenance_unsaved]`, red); `--dry-run` says so. Any other error reading the record fails the run
before anything is written (`[db_read_failed]`, red), so a run never matches without the record and then saves
over it. The workflow's concurrency group keeps two runs from deciding at once.

**Before merging the change that added this (2026-11-16), Riley:**

1. applies `sql/finance_cutover_matches.sql` (before the merge, not with it; done 2026-11-16);
2. runs `python simplefin_etl.py --dry-run` locally from that branch (it writes nothing) and checks the counts-only
   `cutover decisions`, `new for review` and per-account `kept for review` lines. The first scheduled run after the
   merge decides the cutover window again: rows the earlier equal-amount rule dropped without recording them are
   still in SimpleFIN's 45-day answer until about late December, and every one of them without identity evidence
   is written (and reported as `cutover_review`). Merge once those counts are acceptable.

## Categories

SimpleFIN sends no categories, and `/financials` needs them to keep card payments and transfers out of spending. In
order: a matching payment or transfer on another of Riley's accounts (same amount, opposite sign, within 5 days,
payment or transfer wording) becomes Credit Card Payment or Internal Transfers; else the category Rocket Money used
for the same description or merchant; else payment or transfer wording; else none (Uncategorized). About 70% of
recent rows have a description Rocket Money categorized consistently, so expect more Uncategorized than before.
