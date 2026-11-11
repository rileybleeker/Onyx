# Handoff: fix the one-night misalignment in the HRV analysis

Written 2026-11-10 for a Claude Code session with no memory of the session that found this. Read the "KNOWN ISSUE (confirmed 2026-11-10 ...)" bullet under Conventions in `AGENTS.md` first; this brief adds what that bullet does not say. The roadmap row is Notion task `414bf5b4-4bf2-81ee-a60a-f7775ae71ec7` (Critical); its Notes hold the raw evidence.

## The problem

Row D of `pds.daily_health_matrix_behavioral` holds the HRV of the sleep that CLOSES behavioral day D. The analysis takes the NEXT row's HRV as the outcome. So a day-D behaviour is scored against the sleep that closes day D+1: one night late.

## History (why the old fix and the old test cannot be trusted)

- 2026-04-04, commit `b0828fa`: introduced `shift(-1)` ("use next-night HRV as target"). Correct then, because the matrix dated the WHOOP cycle by wake day, so a row held the HRV Riley woke up with.
- 2026-05-25, commits `165b879` and `a04d35e` (ADR-0001): the pipeline switched to the behavioral matrix, which dates the cycle by bedtime minus 6 hours. `shift(-1)` was left in place.
- 2026-05-26: the re-audit flagged exactly this (gemini F-001, P0). It was marked DISPUTED because it contradicted the docs and `tests/test_phase2_alignment.py`, and it never became a task.
- That test builds a synthetic, pre-aligned frame in the April layout and never reads the real matrix. It passes and catches nothing.

This is not the April bug again, and the fix is not the April fix again. For most behaviour features it is the reverse.

## Verified (do not re-derive)

- All 717 matrix rows with HRV equal the recovery of the WHOOP main cycle dated to that row. Example: row 2026-11-06 = 68.7 ms = the cycle starting 2026-11-07 08:47Z (3:47 AM ET).
- Outcome sites (line numbers approximate):

  | File | What | Line |
  |---|---|---|
  | `hrv_analysis.py` | `df["hrv_next"] = df[TARGET].shift(-1)` (descriptive layer) | ~2361 |
  | `hrv_analysis.py` | `prepare_ml_data`: `hrv_target_t{h} = TARGET.shift(-h)` | ~3106 |
  | `hrv_analysis.py` | SARIMAX exog `shift(1)` | ~3546 |
  | `hrv_analysis.py` | Prophet `hrv_target_t1` | ~3752 |
  | `causal_inference.py` | `OUTCOME_COL`, `_build_outcome_frame` (`shift(-1)`) | ~107, ~974 |

- Two features are already re-keyed to row D-1, so they line up under the current outcome: `merge_delivery_features` (~1322) and `workout_to_sleep_gap` (~2172, `pred_date = calendar_date - 1 day` at ~2215). The latter's docstring still describes wake-day dating, but `cycles.calendar_date` has been `onyx_behavioral_date` since ~722.
- Effects sit on the same row: drinking days (n=6) -35 ms same-row vs -11.5 next-row; late delivered meal, raw, -7.3 vs -1.3. Small samples: a sanity anchor, not proof.
- `pds.hrv_analysis_results` is upserted on `(result_type, result_key)` (~4770): every retrain overwrites every finding in place.
- Live rows in `pds.hrv_predictions` are never regenerated; only `model_version = 'backtest_initial'` rows are rewritten by a retrain.

## Suspected, not verified: check before designing the fix

1. **WHOOP cycle-level columns may belong to the day AFTER the row.** The view takes `whoop_day_strain`, `whoop_kilojoule` and cycle HR from the same main cycle as the recovery (`sql/adr_0001_08_daily_health_matrix_behavioral.sql` ~175, ~247, ~272), and a WHOOP cycle is a sleep followed by the next waking day. If so, strain is correctly aligned today and a blanket switch to same-row HRV would make it reverse-causal.
2. **The forecast.** `prepare_ml_data` keeps same-row `whoop_hrv_rmssd` as a feature on the assumption that it is "this morning's HRV, known at prediction time" (~3112). Under behavioral dating the newest row's HRV may not exist yet when `hrv_predict.py` predicts (it uses `X.iloc[[-1]]` at ~183 and labels the result `et_today() + 1` at ~217). Find out which sleep a stored prediction actually refers to, and whether the model's main input is NaN at serve time but filled in training.
3. **Lags, rolling windows and confounders.** `*_lag1`, `hrv_7d_mean`, the training-load windows (~1846 onward) and the causal confounder set were designed for the old dating. Confounders must stay strictly before the treatment; same-sleep variables must stay out (they are mediators).

## What to do

1. **Build an alignment table from live data, not from code comments.** For every feature family in the matrix and the pandas merges (`journal_`, `habit_`, `supplement_`, `nutrition_`, `caffeine_`, `meal_`, `act_`, `nj_`, WHOOP cycle/workout/sleep, Garmin daily/sleep/stress/body battery/activities, Eight Sleep, `delivery_`, workout gap), state whether the value on row D describes something before, during or after the sleep whose HRV is on row D. Verify each with real timestamps for a few dates, including one travel day and one post-midnight bedtime.
2. **Show Riley the table and the design in plain words**, and ask the one question that is theirs: should the forecast predict the HRV they wake up to tomorrow, or keep its current target (whatever step 1 shows that to be)? Do not change code before this.
3. **Implement one alignment rule**, defined in one place and used by the descriptive layer, the causal layer and the forecast. If the outcome becomes same-row HRV, remove both D-1 re-keyings in the same change, and lift the `delivery_*` exclusion from forecast features only if those values are available at prediction time.
4. **Tests.** Replace the synthetic alignment test with one that encodes the real matrix dating, and update `tests/test_delivery_features.py`. The `.venv` has no pytest; run test files directly.
5. **Snapshot before retraining.** Save the current `pds.hrv_analysis_results` rows (correlation, journal/habit/supplement/nutrition impact, causal) to a file. The retrain overwrites them, so this is the only "before" copy. Baseline retrain: Actions run 42763606230.
6. **Retrain in GitHub Actions** (`hrv-retrain-on-backfill.yml`; the local machine has no `.env`) and compare before and after: which findings strengthened, vanished or changed sign, and which survive FDR.
7. **Wording and records.** Update `/analytics/hrv` (`HrvAnalysisClient.tsx` has about 38 "next-night" / "tomorrow" phrases), remove the KNOWN ISSUE bullet from `AGENTS.md` and correct the other passages there that describe the old alignment, set the Notion task to Done with notes, then commit and push.
8. **Make the alignment a runtime guard, not only a test.** At the start of every retrain, check the assumption the pairing depends on: each matrix row's HRV is the recovery of the WHOOP main cycle whose sleep began at the end of that row's day. If it fails, stop the run and write a `failed` `hrv_analysis|retrain` heartbeat whose `error_message` starts with `GUARD alignment:`. Add a known-answer canary if one has enough data: a behaviour with a known direction should move same-night HRV more than the following night's; on a reversal write a `partial` heartbeat starting `GUARD canary-<name>:`. Alcohol has only 6 drinking days, so check the canary has power before relying on it; if nothing qualifies, ship the structural guard alone and say so. The `GUARD` prefix is a contract: the devops agent matches it (`personal-agents/agents/devops.md`, check 2) and tells Riley instead of re-running.

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
