# Eight Sleep date contract

Status: settled 2026-11-16 (audit item HIST-ETL-01). Covers `pds.eight_sleep_trends`,
`eight_sleep_etl.py`, the table's `onyx_*` trigger and the Eight Sleep re-key in
`hrv_alignment.py`. Every example below is synthetic.

## The contract

Four dates are involved. They are kept apart on purpose.

| Date | What it is | Where it comes from |
|---|---|---|
| **Provider day** | The trends API `day` of a night: the **wake-up date**, i.e. the local date of the night's end (`presenceEnd` / `sleepEnd`) in the zone the request names (`?tz=`). | Eight Sleep. Stored unchanged as `calendar_date` (and `session_date`). |
| **Bed zone** | The zone of the Pod. The Pod is stationary, so this is a fixed setting: `EIGHTSLEEP_TIMEZONE` (default `America/New_York`). | Configuration. Each session in the payload also carries a `timezone` field; whether that is the Pod's own setting or an echo of `?tz=` is **unknown** (every request so far used the same zone, so the data cannot tell). |
| **Session instants** | `ts` (start of presence), `sleepStart`, `sleepEnd`, `presenceEnd`: UTC instants per session in `raw_json.sessions[]`. | Eight Sleep. **Never used to date a row.** |
| **Closing-night date** | The behavioral day (ADR-0001, onset - 6 h) whose closing sleep this is: `calendar_date - 1` for a night-time onset. | Derived **downstream only**: `hrv_alignment.py` moves `eight_sleep_*` one day earlier (`PREVIOUS_NIGHT_PREFIXES`, `wake_date_to_closing_day`); the check-in and the sweet spot read the row dated D+1 for the sleep that closes day D. |

On this table the trigger `pds.set_onyx_dates_calendar_passthrough` copies `calendar_date`
into `onyx_et_date`, `onyx_behavioral_date` and `onyx_local_date` (label `source_field`).
So **`onyx_behavioral_date` here is the wake-up date, not the behavioral day of the sleep.**
The matrix joins on it and `hrv_alignment.py` corrects by one day; re-dating the rows in SQL
would double-shift every consumer, and the alignment guard would fail the retrain.

Rules the ETL follows (since 2026-11-16):

1. Onyx never dates an Eight Sleep row itself. `calendar_date` is the provider day.
2. Values from `/intervals` (bed and room temperature, fallback biometrics) attach to a trend
   day by **session id**, never by the interval's own timestamp. The id is the day's
   `mainSessionId`, else its only `sessionIds` entry when the day has exactly one session. A day
   with several sessions and no `mainSessionId` has no known main session (the list order is not
   documented, so the first may be a nap): nothing is attached, its stored temperatures stay, and
   the self-heal and the comparison below count it as having no session. Unknown stays unknown.
3. No row is written without a trend day. An interval whose night is still processing, or
   whose trends chunk failed, writes nothing; the next run (7-day window) or the temp
   self-heal (per-ID lookup) picks it up.
4. The wearer's zone is never consulted: no `user_tz_log`, no `pds.tz_for_instant`, no WHOOP
   offset. A night in the bed is dated in the bed's zone.
5. A session that reports a zone whose UTC offset differs from `EIGHTSLEEP_TIMEZONE` (at that
   session's end) turns the `eight_sleep|trends` heartbeat `partial` with a message starting
   `GUARD eight_sleep_bed_tz:` (counts only, no zone name). A session without a readable zone
   or time is counted as unknown, never as a match or a move. A failed trends chunk also
   turns the heartbeat `partial`.
6. Pairing by id assumes `/intervals` items carry the same id as the trend day's
   `mainSessionId` (the per-ID lookup the self-heal makes with that id is the proven part).
   Two checks report it if that stops holding, so the sync cannot stop writing temperatures
   without a word:
   - every `/intervals` item without a usable `id` (missing, renamed, or not an object) turns
     the heartbeat `partial` ("N /intervals item(s) carry no session id");
   - if a run fetched sessions that started inside its window (or the evening before), counted
     over every item whether it had an id or not, has trend days with a known main session, and
     pairs none of them, the heartbeat turns `partial` ("no interval paired with a trend day by
     session id").

   A session's start only places it inside or outside the window; it never dates a row.

## Evidence

Checked read-only against the live schema, trigger definitions and the provider payload shape on 2026-11-16. The observations from Riley's own rows are kept privately, outside this repository; only schema and source facts are listed here.

- **Live trigger.** `eight_sleep_trends_set_onyx_dates` runs `pds.set_onyx_dates_calendar_passthrough()` on `INSERT` and `UPDATE OF calendar_date`. The table has **no `start_time` column**. The ETL comment that said "the DB trigger on `eight_sleep_trends.start_time` corrects travel days downstream" was false, and so was ADR-0001's "Phase 1 ships using cycle-anchor for Eight Sleep".
- **Provider day = wake-up date.** The payload's `day` is the local date of the night's `sleepEnd` / `presenceEnd`, not the date the session starts: a bedtime before local midnight starts on the previous date. Matching the UTC date of the start can look right for late bedtimes; it is not the rule.
- **Session zone.** A day payload has no top-level zone (the ADR-0001 Phase 4 check looked there), but every entry of `sessions[]` carries `timezone`.
- **`bed_side = 'away'`.** The side label the Pod reports at sync time (away mode), not a night away.
- **Several sessions on one day.** A day can hold a main sleep plus a nap or a short second session.
- The synthetic cases below cover the stationary, relocated, travel and DST situations the contract has to handle.

## Cases (synthetic)

Times are Eastern unless marked Z (UTC).

**A. Stationary bed, onset after midnight.** In bed 01:00 on 2026-01-20 (06:00Z), up 08:30
(13:30Z). Provider day 2026-01-20, row `calendar_date = 2026-01-20`. The onset - 6 h is
2026-01-19 19:00, so it is the sleep that closes behavioral day 2026-01-19, where
`hrv_alignment.py` puts it.

**B. Onset before midnight.** In bed 22:30 on 2026-02-08 (03:30Z on 02-09), up 06:30 on 02-09.
Provider day 2026-02-09. The local start date (02-08) is the previous row: until 2026-11-16
the ETL keyed the night's interval by it, so this night's temperatures could land on the
2026-02-08 row (and the 02-09 row got none from that run). Pairing by session id fixes it.

**C. DST.** Fall back: in bed 23:30 EDT on 2026-10-31 (03:30Z on 11-01), up 08:00 EST (13:00Z).
Provider day 2026-11-01. Spring forward: in bed 01:30 EST on 2026-03-08 (06:30Z), up 08:30
EDT (12:30Z). Provider day 2026-03-08. The 23- and 25-hour local days do not matter: the row
is the local date of the end.

**D. UTC date vs local date.** A start at 04:30Z on 2026-01-15 is 23:30 on 01-14 locally. The
UTC start date (01-15) matches the provider day here, the local start date (01-14) does not.
For a bedtime before 19:00 EST / 20:00 EDT both start dates are the previous day; after local
midnight both match. Neither is the rule; the provider day is.

**E. Traveler away, bed at home.** Away for the night that would wake on 2026-09-11. The bed
records nothing, the provider has no day, no row is written; the matrix row has no Eight
Sleep values for that night (unknown, not zero). The return night (in bed 23:00 on 09-11,
up 07:00 on 09-12) is dated 2026-09-12 in the bed's zone. Before 2026-11-16 its interval,
keyed by its start date, could create a temperature-only row on 2026-09-11, the away night.

**F. Wearer's zone differs from the bed's while in the bed.** `user_tz_log` still names the
trip's zone after landing; Riley sleeps at home. The bed's zone dates the night; nothing in
the ETL reads the log.

**G. Relocated bed.** A move within Eastern time (for example to New York) changes nothing.
If the Pod moves to another UTC offset, say Pacific, days sliced in Eastern can be wrong near
local midnight: an evening nap ending 22:30 PDT on 2026-10-05 ends 01:30 EDT on 10-06. Set
`EIGHTSLEEP_TIMEZONE` to the new zone from the move on. The scheduled run sets it in
`.github/workflows/eight-sleep-etl.yml` (a protected path, so Riley changes it; it is neither a
secret nor a repository variable), a local run reads it from `.env` or the shell. Until then, if the session `timezone`
field reflects the Pod, each run is `partial` with the GUARD line (and for up to a week after
the change, while nights from before the move are still in the 7-day window). Changing the
variable is not free: the next routine runs ask the provider to re-slice the whole 7-day
window, including the nights just before the move, in the new zone, so those rows can be
rewritten or a night can land on a neighbouring date. How the provider re-slices them is not
known. Treat a relocation as its own scoped plan (change the variable on the move date, then
check the week around it read-only); rows older than the window are not touched.

**H. Daytime onset (known limit).** In bed 08:00, up 15:00 on 2026-03-20. Provider day
2026-03-20, and the onset - 6 h is 2026-03-20 too, so this sleep closes behavioral day
2026-03-20, yet the uniform one-day move in `hrv_alignment.py` pairs it with row 2026-03-19.
The condition is an onset at or after 06:00 local on the same date the sleep ends (onset - 6 h
= the wake-up date). A sleep that starts in the afternoon or evening and ends after midnight is
not affected: its onset - 6 h falls on the day before its wake-up date, where the move puts it.
Rare; left as a documented limit. Fixing it means re-keying Eight Sleep by the main session's
onset in `hrv_alignment.py`, which needs an `ALIGNMENT_VERSION` bump and a retrain.

**I. Nap on the same day.** Main session 01:00-08:00, nap 15:00-16:30 on 2026-04-14. The
provider puts both in day 2026-04-14 and sums the stages for the day totals; the
`*_main_session_seconds` columns and now the temperatures come from the main session only.
Before 2026-11-16 the temperatures came from whichever of the two sessions with the same start
date the `/intervals` list returned last.

## What changed on 2026-11-16

- `eight_sleep_etl.py`: the false comment is replaced by this contract; `parse_interval` returns
  the session id instead of a date; `sync_user` pairs intervals with trend days by session id
  (`_session_id_from_raw`: main id, else a sole session, else none), writes no interval-only
  rows, counts failed trends chunks, flags `/intervals` items without an id and a run where no
  interval pairs (rule 6) and checks the bed zone (`bed_tz_check`); `trends_problems` builds the
  heartbeat message, GUARD first. The temp self-heal no longer logs a row's date, its
  temperatures or a session id (the Actions log is public); its counters are unchanged.
- `eight_sleep_temp_backfill.py --compare [--max-lookups N]`: the read-only comparison in the
  plan below.
- Comments in `sql/adr_0001_04_other_onyx_dates.sql`, `eight_sleep_schema.sql`, `hrv_alignment.py`
  and the ADR-0001 addendum. **No SQL to apply, no schema change, no date shifted, no backfill.**
- Tests: `tests/test_eight_sleep_date_contract.py` (synthetic payloads and fakes) and
  `tests/test_eight_sleep_selfheal.py` (updated for the new `sync_user` result and id pairing,
  plus the GUARD heartbeat through `main()`).

## The historical claims

1. **"The static `EIGHTSLEEP_TIMEZONE` mis-dates travel nights"** (re-audit 2026-06-07 etl gpt-5/F-002 and deepseek/F-006; 2026-05-26 deepseek F-007): **refuted for the mechanism.** The claim assumed the wearer's zone should date the row. The bed does not travel: a night away leaves no session, and a home night next to a trip is dated in the bed's zone, which is correct. The remaining risk is a relocated Pod, which the GUARD reports.
2. **The ETL comment** that a trigger on `start_time` corrects travel days: false, replaced.
3. **ADR-0001 on Eight Sleep** ("cycle-anchor in Phase 1", "no timezone field"): the passthrough shipped instead, and sessions do carry a zone (see the ADR addendum).
4. **Interval temperatures keyed by the session's start date** (local start date since 2026-05-25, commit `165b879`; UTC start date before that): **mechanism established, stored-value harm not verified.** The counts-only check `eight_sleep_temp_backfill.py` measures it without printing values.

## Affected-history plan (not run)

1. Read-only comparison, from a PC with `.env`:
   `python eight_sleep_temp_backfill.py --compare`. It pages through every row of the table,
   looks up each stored row's main session (one call per distinct session, at most 1000 unless
   `--max-lookups N` raises it) and prints counts only: `scanned`, `truncated`, `rows`, `same`,
   `differ`, `partial` (no stored temperature differs but one could not be checked),
   `unmapped_side` (a side not on the device now, such as `away`), `no_session`, `not_found`,
   `no_temp`, `failed`, `over_cap`, `lookups`, `not_verifiable` (the sum of the four "cannot be
   checked" counts), `complete` (the scan finished) and `clean`. It writes nothing. Every run
   starts again from the newest row, so an identical re-run repeats the same capped lookups:
   when `over_cap` is not 0, re-run with `--max-lookups` at least `lookups + over_cap` (the
   command prints that number). Provider and HTTP logging is turned down while it runs, but treat the whole
   transcript as private: it is about Riley's rows, and a crash traceback can still carry a
   provider id. **Timing:** the first runs after this change is deployed rewrite the temperatures
   of the nights in the 7-day window with correctly paired values and keep no copy of the old
   ones. If a pre-fix count for the most recent week is wanted, run the comparison before the
   deploy; after it, that week reads as `same` whatever it held before.
2. Closing rule. Claim 4 closes as "no harm" only when `clean = True`: `complete = True` (the
   whole table was read and `truncated`, `failed`, `over_cap` and `partial` are all 0),
   `differ = 0` **and** `not_verifiable = 0`. `complete = True` with `differ = 0` but
   `not_verifiable > 0` means only "no difference among the rows that could be checked": report
   it that way, with the `not_verifiable` count as unresolved, and the claim stays open for those
   rows (Riley decides whether that is enough). `complete = False` means re-run with a larger
   `--max-lookups` when `over_cap` is the reason, re-run later when `failed` is, or report the
   result as incomplete. `differ > 0`: Riley decides. A correction is a separate, reviewed,
   reversible one-off: save each affected row's current `(calendar_date, bed_side,
   median_bed_temp, median_room_temp)` to a private file first, then write the main session's
   medians to those rows only. `calendar_date` never changes. The matview refresh and the next
   retrain (the backfill check sees `synced_at`) pick it up.
3. Rows that cannot be compared (side not on the device, no known main session, session gone,
   no readings) stay as stored and are reported as counts.

## Not covered

These open items are also recorded in the Notes of the HIST-ETL-01 roadmap row.

- The daytime-onset pairing (case H).
- Whether the session `timezone` field is the Pod's own setting. Settling it needs one request
  with a different `?tz=`, an extra provider call this change does not make. Until then the
  GUARD may never fire even after a move (if the field only echoes the request).
- Whether stored temperatures were actually harmed by the old start-date pairing (claim 4):
  pending the comparison above.
- That `/intervals` items use the same id as the trend `mainSessionId` is assumed, not observed
  on a collection payload; rule 6 reports it if it ever fails.
- Temperature units: `tempBedC` / `tempRoomC` are Celsius by name; not re-checked here.
- Other ETL log lines still name provider ids (the authenticate line, fetch error messages that
  quote a request URL). Only the temp self-heal's per-row lines were made counts-only here.
- The other items on the same roadmap row (not Eight Sleep) are untouched.
