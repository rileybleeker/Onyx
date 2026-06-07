# Context — Onyx Timezone & Behavioral-Day Audit

This is a focused audit of how Onyx handles timezones and behavioral-day attribution across every TIMESTAMPTZ event in the system. **The full design is in `ADR_0001.md`. Read that first; everything below is audit-specific framing.**

## What you're auditing

The implementation, not the design. ADR-0001 was a deliberate architecture decision. This audit asks:

- Does the implementation actually match the design?
- Are there code paths that violate the rules (clock-date used where behavioral-date should be, or vice versa)?
- Do the trigger functions correctly handle edge cases (DST transitions, transcontinental flights, midnight-adjacent events)?
- Is the GPS-based auto-population (`gps_tz_backfill.py`) and WHOOP-cycle auto-population (`whoop_tz_backfill.py`) sound?
- Are there silent failure modes where TZ resolution falls back to ET without warning?

## n=1 framing

- Single user (Riley). Travels 1–2x/month. Lives in ET.
- ~3% of behavioral days are "transition days" — TZ shift between bedtime and wakeup.
- `pds.user_tz_log` is hand-maintained for major TZ transitions; the two `_tz_backfill` scripts auto-populate it from GPS/WHOOP signals.
- 836 days of data spanning ~7 years (2019-04-14 → 2026-05-25), but most is concentrated in 2024+.

## The three date columns

Every TIMESTAMPTZ event has:
- `onyx_et_date` — clock day in `America/New_York` (canonical comparison key)
- `onyx_behavioral_date` — `(local_instant − 6h)::date` — bedtime-to-bedtime "day of life"
- `onyx_local_date` — clock day in the TZ the user was physically in (time-of-day features)

Plus `onyx_tz_source` — provenance: `source_field` | `cycle_anchor` | `user_tz_log` | `gps_inferred` | `default_et_fallback`.

## Files in this bundle

- `ADR_0001.md` — the canonical design doc (read first)
- `sql/adr_0001_01_user_tz_log.sql` — `pds.user_tz_log` table + `pds.tz_for_instant()` function
- `sql/adr_0001_02_whoop_onyx_dates.sql` — WHOOP cycle/sleep/workout/journal triggers
- `sql/adr_0001_03_garmin_onyx_dates.sql` — Garmin activities/sleep/HRV triggers
- `sql/adr_0001_04_other_onyx_dates.sql` — Eight Sleep / MFP / journal / meal / supplement triggers
- `sql/adr_0001_05_transition_day_flag.sql` — `onyx_is_transition_day` derivation
- `sql/adr_0001_06_tz_log_gaps_view.sql` — canary view detecting unlogged trips
- `sql/adr_0001_07_snapshot_daily_health_matrix.sql` — pre-ADR snapshot for A/B comparison
- `sql/adr_0001_08_daily_health_matrix_behavioral.sql` — canonical behavioral matrix view
- `sql/adr_0001_09_trips_view.sql` — derived trips view from user_tz_log
- `gps_tz_backfill.py` — auto-populates `user_tz_log` from Garmin GPS coordinates
- `whoop_tz_backfill.py` — auto-populates `user_tz_log` from WHOOP cycle offsets

## Where to focus

1. **Trigger function correctness.** Each `set_onyx_dates_*` trigger function calls `pds.derive_onyx_dates(ts, provenance_field)`. Do they all pass the right provenance? Do edge cases (NULL timestamp, future timestamp, very old timestamp) fall through cleanly?
2. **`pds.tz_for_instant(ts)` semantics.** Does it correctly find the active TZ from `user_tz_log` at any given instant? What happens between two log entries? Before the earliest entry? After the latest?
3. **Behavioral-day boundary.** The `−6h` rule attributes events between midnight and 6 AM back to the previous day. Is this consistently applied? What about a 6:30 AM walk to the bathroom — that's a new day; is it attributed correctly?
4. **WHOOP cycle attribution on transition days.** The `+12h ET wake-day` rule for WHOOP cycles may interact awkwardly with the new ADR-0001 behavioral_date logic. The schema audit already flagged the cycle-pick ambiguity (`compute_journal_behaviors_date`).
5. **GPS-based auto-population.** `gps_tz_backfill.py` reads `pds.garmin_activities.start_latitude/longitude` and calls a TZ lookup library. Same-offset cases (e.g. Toronto/Louisville both EDT with NY) should skip — does it?
6. **WHOOP-cycle auto-population.** `whoop_tz_backfill.py` uses `timezone_offset` from WHOOP cycles to infer IANA TZ — but offset → IANA isn't bijective. How does it disambiguate?
7. **Resolution priority.** Manual > GPS-auto > WHOOP-auto. Is this respected?
8. **Provenance tracking.** `onyx_tz_source` — is it always populated? Is `default_et_fallback` flagged loudly enough?
9. **The two `daily_health_matrix*` views' date attribution semantics.** Legacy view uses `+12h ET` cycle rule; behavioral view uses `onyx_behavioral_date`. Are they computing different things? When should each be used?

## Out of scope

- Schema-level design decisions (covered by schema bundle)
- ETL ingestion correctness (covered by ETL bundle)
- Statistical methodology that consumes these dates (covered by stats bundle)
