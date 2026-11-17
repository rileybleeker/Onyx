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

Investment accounts (Fidelity, the Wells Fargo brokerage) never enter the spending ledger (trades and dividends are not
spending). Trial result 2026-11-17: SimpleFIN returns Fidelity with balances, positions (symbol, description, shares,
market value, cost basis, purchase price) and activity as plain rows (amount, description, payee, dates; no quantity or
price per trade). Since then each run also writes positions to `pds.finance_holdings` and activity to
`pds.finance_investment_activity` (`sql/finance_holdings.sql`, service-role only), shown in the Investments panel on
`/financials`. A failed or unapplied write of these never fails the run; the log says so by type name only.

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
| `rows near the Rocket Money cutover were kept ... [cutover_review xN]` (amber until reported) | Possible duplicates were kept rather than guessed; see "The cutover from Rocket Money" below. Each such row is reported until a run writes **both** heartbeats carrying it (the record's `review_state`: `pending`, then `reported`; the card shows the worse of the two newest heartbeats, so one landing alone could leave the note hidden behind the other kind's older one), so it may be reported twice, never not at all. A run that loses either heartbeat write, a run stopped after it saved the record, or a failed mark leaves it pending, and the next run reports it again, also when SimpleFIN's answer no longer has the row. A red `db_write_failed` heartbeat carries the pending count too (when saving the record itself failed: the rows pending on record all the same, or all of this run's when the record cannot be read back). |
| `the cutover match record table is missing or out of date ... [cutover_provenance_unsaved]` (red) | Apply `sql/finance_cutover_matches.sql` (the whole file; every statement is idempotent). Nothing was written that run: while the table is missing, a run with cutover decisions to record stops before the ledger, so no row is left out on a match that is not on record; while the table lacks its `review_state` column, every run stops. |
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
  not) and the payee names do not contradict each other (by their names, store numbers or kinds of business, as
  below).
- **merchant**: dates within 3 days (either feed's original or posted date counts) and the same merchant: more than
  half of the shorter side's description and merchant name words in common, the distinctive words of one side (all
  but kinds of business such as `COFFEE` or `DELI`) all present on the other, both rows leading with the same word
  (the one that names the business), at least one shared word that is neither a city nor a kind of business, and
  no payee names, store numbers or kinds of business that contradict each other. A shared city, kind of business
  or first word is not enough (`DEMO COFFEE ATLANTA` and `OTHER COFFEE ATLANTA`, or `DEMO BOTTLE COFFEE` and `DEMO
  DONKEY COFFEE`, are two merchants), while a bank text and its cleaned name agree (`DEMO CAFE 0042 ATLANTA GA` and
  `Demo Cafe`). Two-letter names are merchant words (review of round 8): `ZQ ATLANTA GA` and `XK ATLANTA GA` are
  two merchants, where dropping short words had left both as just `ATLANTA`. The city is read as the words before
  a trailing state code (`ATLANTA` in `DEMO CAFE 0042 ATLANTA GA`; a multi-word city through a short list of
  words such as `NEW`, `SAN`, `CITY` or `BEACH`), never the first word of the text; state codes, two-letter fillers
  (`ON`, `OF`, `TO`, `US`) and processor prefixes (`SQ`, `TST`, `SP`, `IC`, `DD`, `PP`) are never merchant words.
  A merchant named by digits only (`88 ATLANTA GA`) leads with its city and shares nothing else, so it is kept
  for review; a city word the list does not know still leaves the two rows leading with different words. A candidate pair counts only at the smallest date gap of both its rows, so
  the same purchase on consecutive days pairs day by day. A day Rocket Money lacks is kept, since its neighbours
  are the nearer twins.

Payee names contradict when both name a business and neither one's distinctive words (all but kinds of business
and generic words such as `STORE`, `COFFEE` or `POS`) are all on the other row: `Demo Store` and `Other Store`
share a word and are still two payees. A payee of generic words only says nothing either way. Store numbers
contradict when both rows carry one (a run of three digits or more, such as `0042` or `#042`, leading zeros
ignored; dates such as `11/14` do not count) and neither row's numbers are all on the other: `DEMO DELI 0042` and
`DEMO DELI 0099` share every word once the digits are dropped and are still two shops, so neither step matches
them. A number on one side only (`DEMO CAFE 0042 ATLANTA GA` and `Demo Cafe`), or an extra number on one side,
agrees. Kinds of business (words such as `CAFE`, `HOTEL`, `DELI`, `STORE`) are no evidence for a match, but they
contradict when both rows name one and neither row's kinds are all on the other: `DEMO CAFE ATLANTA` and `DEMO
HOTEL ATLANTA` agree on every other word and are still two businesses, while `DEMO COFFEE BAR` and `Demo Coffee`
agree.

In both steps a group of candidate pairs is a match only when it is one to one, or when it has as many SimpleFIN
rows as Rocket Money rows and its rows cannot be told apart on either side (same dates and text): two identical
coffees on both sides both match. A group of unequal size is never guessed, in either direction (key order is not
identity evidence): two identical new rows and one Rocket Money row, and also one coffee with two identical Rocket
Money twins (which twin it is, or whether either is, is not known). All of its SimpleFIN rows are kept as
ambiguous and recorded with every candidate (never cut to a few: those are the Rocket Money rows held on later
runs), and its Rocket Money rows are held, so no other row is matched to them. The nearest date is judged over every
contender, held rows and ambiguous rows included: a row whose nearest Rocket Money candidate is held, or a Rocket
Money row whose nearest SimpleFIN row is ambiguous, is never paired with a farther row instead. That row is kept as
ambiguous with all its candidates.

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
can be told apart competing for one twin, or a group of unequal size) or with a same-amount Rocket Money row
nearby but no merchant evidence (**unconfirmed**) is kept, and so is a row an earlier run already stored that turns
out to match (**stored_duplicate**). The SimpleFIN card turns amber with `[cutover_review xN]` until a written
heartbeat has carried each such row (it is then marked `reported` and not counted again while its decision stays
the same; a changed decision is reported again); they may be duplicates to fix by hand, so check them (for example
in the weekly review) until each is settled:

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
text. The record is written **before** the ledger, as the run's whole set in one statement (all of it is on record,
or none of it: never one of two competing rows without the other), and a run that cannot write it writes nothing
(`[db_write_failed]`, red; the next run retries): a row is left out of the ledger, and its Rocket Money twin taken, only by a match on
record. Otherwise a failed record followed by a SimpleFIN answer without that row could let another purchase take the
same Rocket Money row. While the table does not exist, a run with decisions to record stops the same way
(`[cutover_provenance_unsaved]`, red); `--dry-run` says so. Any other error reading the record fails the run
before anything is written (`[db_read_failed]`, red), so a run never matches without the record and then saves
over it. The workflow's concurrency group keeps two runs from deciding at once.

The record is replayed whatever the run's date window. The ledger is read from before the earliest date in
SimpleFIN's answer (a row posted late can be transacted weeks before the window, with its Rocket Money twin dated
alike), and every Rocket Money row a recorded match or ambiguity names is also read by key, whatever its date, so a
claimant still in the answer stays matched and is not written again. A recorded twin that is no longer in the ledger
turns its row into **unconfirmed** (kept and reported for review). A failed read of those rows stops the run before
anything is written (`[db_read_failed]`).

**Before merging the change that added this (2026-11-16), Riley:**

1. applies `sql/finance_cutover_matches.sql` (before the merge, not with it; the table was applied 2026-11-16, the
   `review_state` statement at the end of the file is not applied yet);
2. runs `python simplefin_etl.py --dry-run` locally from that branch (it writes nothing) and checks the counts-only
   `cutover decisions` (with `to report`) and per-account `kept for review` lines. The first scheduled run after the
   merge decides the cutover window again: rows the earlier equal-amount rule dropped without recording them are
   still in SimpleFIN's 45-day answer until about late December, and every one of them without identity evidence
   is written (and reported as `cutover_review`). Merge once those counts are acceptable.

## Categories

SimpleFIN sends no categories, and `/financials` needs them to keep card payments and transfers out of spending. In
order: a matching payment or transfer on another of Riley's accounts (same amount, opposite sign, within 5 days,
payment or transfer wording) becomes Credit Card Payment or Internal Transfers; else the category Rocket Money used
for the same description or merchant; else payment or transfer wording; else none (Uncategorized). About 70% of
recent rows have a description Rocket Money categorized consistently, so expect more Uncategorized than before.
