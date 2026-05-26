# Date-attribution audit — 2026-05-25

Closes Notion roadmap item _"HRV walkthrough: date-attribution audit for every variable in the analysis matrix"_ (page `369bf5b4-4bf2-812f-93a4-f25578dbf771`). Spun out of the WHOOP-journal `behaviors_date` fix (commit `562545d`) — that bug went undetected for ~6 weeks because the original audit verified a single pre-midnight-bedtime data point and over-generalized. Goal here: prove no analogous bug exists for any other variable in `pds.daily_health_matrix_behavioral`.

## Method

For every date / timestamp column in every `pds` source table:

1. Identify the upstream date column's semantics (clock-date, behavioral-day, log instant, etc.).
2. Verify it has an `onyx_*` sibling per ADR-0001 (`onyx_behavioral_date`, `onyx_et_date`, `onyx_local_date`).
3. Confirm the matrix view joins on the **behavioral** column, not a legacy one.
4. Sanity-check sample data for pre-midnight and post-midnight cases.

ADR-0001 made step (2) systematic — the schema migration added `onyx_*` columns to 13 source tables and a trigger keeps them current. So the audit is now mostly a structural query rather than per-variable spot-checks.

## Findings

### Tables with full ADR-0001 coverage (15)

These have all three `onyx_*` columns and the matrix view joins on `onyx_behavioral_date`:

`whoop_cycles`, `whoop_sleep`, `whoop_workouts`, `whoop_journal`, `garmin_activities`, `garmin_sleep`, `garmin_hrv`, `eight_sleep_trends`, `myfitnesspal_nutrition`, `meal_events`, `supplement_intake`, `habit_journal`, `journal_entries`, `spotify_plays`, plus the `daily_health_matrix_behavioral` view itself.

`whoop_recovery` and `whoop_sleep` are joined by `cycle_id` (which inherits the cycle's behavioral_date), not by their own date columns — also correct.

### Tables joined on raw `calendar_date` (4) — known limitation, not a bug

These are pre-aggregated Garmin daily summaries (steps, stress buckets, HR zones, training-load snapshot) whose date column is Garmin's midnight-boundary clock-day in the user's local TZ at the time the day rolled over. They join the matrix on `calendar_date = onyx_behavioral_date` directly:

- `garmin_daily_summary`
- `garmin_stress`
- `garmin_heart_rate`
- `garmin_training_status`

These aren't bugs because the data is irreversibly pre-aggregated at Garmin's midnight boundary — there is no way to re-attribute the 6 hours of "behaviorally yesterday but clocked today" data without raw-minute series. For a user with consistent post-midnight bedtimes, this means up to ~6h of daytime values land on the clock-day after their behavioral day. The HRV pipeline's downstream `shift(-1)` join is still pointed at the correct row; only the inputs themselves are mildly leaky. Documented; no fix.

### Bug found and fixed

**`pds.meal_timing_daily`** joined `pds.whoop_cycles` via the legacy `(start_time + 12h) AT NY ::date = (calendar_date + 1)::date` rule, predating ADR-0001. In ET that produces the right cycle, but during travel the cycle's `onyx_behavioral_date` is computed from the user's local TZ and diverges from the +12h-ET shortcut. Result: `meal_last_meal_to_bedtime_min` would silently pick an off-by-one cycle on transition days and on stays in foreign timezones — exactly the class of bug the WHOOP-journal fix was meant to catch.

**Fix:** migration `sql/meal_timing_daily_behavioral_join.sql` switches to `LEFT JOIN LATERAL (… WHERE wc.onyx_behavioral_date = agg.calendar_date ORDER BY length DESC LIMIT 1)`, mirroring the `wc` lateral in `daily_health_matrix_behavioral`. Column list unchanged → `CREATE OR REPLACE` keeps the dependent matrix views intact.

Applied to production 2026-05-25 (`apply_migration` name `meal_timing_daily_behavioral_join`). Verified the three most recent rows still compute sensible bedtime gaps (134, 83, 219 minutes).

### Doc drift found

`CLAUDE.md` claims supplements are "merged into `daily_health_matrix`" as `supplements_jsonb` / `supplement_distinct_compounds` / `supplement_total_doses` columns. The actual view has none of those columns — supplements are loaded in Python (`hrv_analysis.py` line ~609 reads `supplement_intake_by_compound` directly) and joined in pandas. The schema-level merge was aspirational. CLAUDE.md corrected in the same commit as this audit.

### Data integrity spot-checks (zero mismatches)

| Table | Check | Mismatched rows |
|---|---|---|
| `supplement_intake` | `intake_date == onyx_behavioral_date` | 0 |
| `meal_events` | `event_date == onyx_behavioral_date` | 0 |
| `weight_log` | `log_date` vs behavioral day of `logged_at` | aligned on the only timestamped row |

## Verification of related fix

This audit ran in parallel with the post-ADR-0001 Phase A bugfix verification (`commit a04d35e`). The HRV pipeline re-ran on 2026-05-25 23:48 UTC and now produces causal estimates for the new travel features:

- `is_transition_day`: AIPW ATE −10.1 ms (95% CI −23.6 to +3.4), n_treated=27. Direction consistent with the "travel days dent HRV" hypothesis; CI crosses zero so not yet statistically significant.
- `is_outbound`, `is_return`, `offset_delta_hours`: correctly dropped for n_treated<10 (not enough travel volume yet to support a per-direction estimate; need more transitions before these can be tested).
- `days_since_transition`: continuous treatment, 274 days.

The Phase A bugfix is therefore confirmed: previously these all had `n_treated=0` because the travel-feature merge keyed off the wrong cycle column.

## Follow-up

None at present. If Garmin's raw minute-level series (`raw_hr_values`, `raw_stress_values` JSONB) is ever brought into the pipeline, the Garmin-daily-summary midnight-boundary limitation can be eliminated by re-aggregating those into behavioral-day buckets directly. Filed under the existing "research roadmap" CLAUDE.md note rather than as a new task.
