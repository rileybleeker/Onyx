# Handoff: fix the one-night misalignment in the HRV analysis

Status: source-contract handoff; personal historical measurements are retained privately.

Written 2026-11-10 for a Claude Code session with no memory of the session that found this. Read the "KNOWN ISSUE (confirmed 2026-11-10 ...)" bullet under Conventions in `AGENTS.md` first; this brief adds what that bullet does not say. The roadmap row is Notion task `414bf5b4-4bf2-81ee-a60a-f7775ae71ec7` (Critical); its Notes hold the raw evidence.

## The problem

Row D of `pds.daily_health_matrix_behavioral` holds the HRV of the sleep that CLOSES behavioral day D. The analysis takes the NEXT row's HRV as the outcome. So a day-D behaviour is scored against the sleep that closes day D+1: one night late.

## Source contract and verification

The behavioral matrix row for day D contains HRV from the sleep closing D. A forecast for the next behavioral day must use the intended next-day outcome exactly once. Historical agreement between two derived joins does not establish the correct source-day mapping.

Use explicit synthetic source timestamps around midnight and verify private production mappings separately. Keep original provider timestamps, source IDs and behavioral dates distinct; do not apply a second shift when the matrix already owns attribution. Inspect every downstream target, lag, backfill and chart consumer before changing the shared invariant.

## What to do

1. **Build an alignment table from live data, not from code comments.** For every feature family in the matrix and the pandas merges (`journal_`, `habit_`, `supplement_`, `nutrition_`, `caffeine_`, `meal_`, `act_`, `nj_`, WHOOP cycle/workout/sleep, Garmin daily/sleep/stress/body battery/activities, Eight Sleep, `delivery_`, workout gap), state whether the value on row D describes something before, during or after the sleep whose HRV is on row D. Verify each with real timestamps for a few dates, including one travel day and one post-midnight bedtime.
2. **Show Riley the table and the design in plain words**, and ask the one question that is theirs: should the forecast predict the HRV they wake up to tomorrow, or keep its current target (whatever step 1 shows that to be)? Do not change code before this.
3. **Implement one alignment rule**, defined in one place and used by the descriptive layer, the causal layer and the forecast. If the outcome becomes same-row HRV, remove both D-1 re-keyings in the same change, and lift the `delivery_*` exclusion from forecast features only if those values are available at prediction time.
4. **Tests.** Replace the synthetic alignment test with one that encodes the real matrix dating, and update `tests/test_delivery_features.py`. The `.venv` has no pytest; run test files directly.
5. **Snapshot before retraining.** Save the current `pds.hrv_analysis_results` rows (correlation, journal/habit/supplement/nutrition impact, causal) to a file. The retrain overwrites them, so this is the only "before" copy. Baseline retrain: Actions run 42763606230.
6. **Retrain in GitHub Actions** (`hrv-retrain-on-backfill.yml`; the local machine has no `.env`) and compare before and after: which findings strengthened, vanished or changed sign, and which survive FDR.
7. **Wording and records.** Update `/analytics/hrv` (`HrvAnalysisClient.tsx` has about 38 "next-night" / "tomorrow" phrases), remove the KNOWN ISSUE bullet from `AGENTS.md` and correct the other passages there that describe the old alignment, set the Notion task to Done with notes, then commit and push.
3. **Make alignment a runtime guard.** Before retraining, verify the WHOOP main-cycle sleep-to-behavioral-day mapping. Stop on failure and write a failed `hrv_analysis|retrain` heartbeat beginning `GUARD alignment:`. A behavioral canary is optional and requires adequate private support; use `GUARD canary-<name>:` for a partial canary failure. If no canary qualifies, keep the structural guard. Preserve the `GUARD` prefix consumed by the devops agent.

## Constraints

- The matrix dating is correct. Fix the analysis, not the view or the source tables. If a view change turns out to be unavoidable, stop and say so: the matview must be recreated with it, and the Supabase MCP rejects migrations that contain `DROP`.
- Feature names stored in `pds.hrv_analysis_results` and read by the frontend must not change.
- If the forecast target changes, give new forecasts a new `model_version` suffix and keep old-target rows out of the accuracy metrics and the Prediction-vs-Actual chart, or mark on the page where the definition changed.
- Settle every disputed point against live data, never against `AGENTS.md`, a CONTEXT file or an existing test (Conventions, "Audit and review findings ...").
- Riley is a consultant, not a developer. Report in plain language.

## Done when

A behaviour on day D is scored against the sleep that closes day D in every test family; the forecast targets what Riley chose and the page says so; the retrain is green on `/status`; the runtime guard runs on every retrain; and the new test fails if the alignment regresses.

## Report back

The alignment table, what changed in the code, a before/after list of the findings that moved most, and anything you could not verify, marked as such.
