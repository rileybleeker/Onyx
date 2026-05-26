# Context — Onyx Stats Pipeline

This is the briefing for an independent reviewer of `hrv_analysis.py` + `causal_inference.py` + `hrv_predict.py`. Read this first. Everything below is extracted from `CLAUDE.md` (the project's internal documentation) and trimmed to what's directly relevant to evaluating the statistics.

## What Onyx is, and what success looks like

**Onyx** is a personal health-data aggregation and analytics platform for **one user** (Riley). It ingests biometric data from WHOOP, Garmin, Eight Sleep, MyFitnessPal, and several other sources into a unified Postgres database (Supabase), and visualizes everything through a Next.js dashboard.

The statistics pipeline you are reviewing has a single, concrete goal: **identify which day-to-day behaviors causally affect next-night HRV.** "Which controllable inputs would change HRV if intervened on?" — not just "what is associated with HRV." That distinction is why the pipeline goes beyond Spearman / Welch into AIPW + PSM + E-value sensitivity.

**Scale context that matters for your review:**

- **n=1, longitudinal.** Cross-individual generalization is irrelevant. The deployment is the user.
- **Effective sample size: ~568 days of HRV data**, ~270 days of behavioral journal data, much less for new features (habits, supplements, meal timing). See `DATA_PROFILE.md`.
- **Not productionized, not multi-tenant.** No latency budgets, no concurrent users, no PII compliance scope. The pipeline runs once daily in GitHub Actions.
- **Failure mode that matters:** a false-positive intervention that Riley acts on for weeks. A test that passes when it shouldn't is worse than a test that's too conservative. Don't tune for sensitivity.

## HRV: three columns, three meanings — do not conflate

This is the single biggest semantic trap in the pipeline.

| Column | Source | Algorithm | Unit | What it is |
|---|---|---|---|---|
| `whoop_hrv_rmssd` | WHOOP API | **RMSSD** of inter-beat intervals during WHOOP-detected sleep | milliseconds | True RMSSD. Canonical target. |
| `garmin_hrv_last_night` | Garmin API | Garmin's proprietary time-weighted average of 5-minute HRV samples during sleep | milliseconds | **NOT RMSSD.** Different algorithm, same unit. |
| `eight_sleep_hrv` | Eight Sleep API | Undocumented by Eight Sleep | milliseconds | Treat as opaque. |

The pipeline targets `whoop_hrv_rmssd` by default. Never average or substitute these. The `garmin_*` and `eight_sleep_*` HRV columns appear in the feature matrix as inputs (lag features, baseline references), not as targets.

## Behavioral-day attribution (ADR-0001)

Every fact in the pipeline is keyed on `onyx_behavioral_date`, NOT clock-date. The behavioral day is defined as `(local_instant − 6 hours)::date`, which assigns post-midnight events (1 AM alcohol, 12:05 AM supplement, pre-bed meal) back to the day that's *ending* rather than the new clock-day.

The HRV pipeline shifts target by `-1` (predicts HRV(N+1) from behaviors(N)). For this to be correct, an event at 12:30 AM must be on row N, not row N+1. Otherwise the pipeline silently mis-trains by attributing pre-bed behavior to the wrong night's HRV.

This is implemented at the SQL view level (`pds.daily_health_matrix_behavioral`) and the pipeline reads pre-attributed columns. **Reviewers should sanity-check that all date-shift logic in `hrv_analysis.py` is consistent with behavioral-day semantics.** Specifically: the `shift(-1)` for the target, the `_lag1` and `_lag7` constructions, the rolling-window means, and the train/test split boundaries.

## Variable coverage and multiple-comparison correction (May 21 audit)

A previous self-audit (May 21, 2026 — `VARIABLE_COVERAGE_AUDIT.md` in this bundle) enumerated every variable from every source against every test. Fixes already applied:

1. **BH-FDR added to `journal_impact` and `habit_impact`** (was missing; supplement and nutrition families already had it). With ~59 journal questions at α=0.05, ~3 false positives would have been expected without correction.
2. **Phase-2 Spearman excludes trivial-autocorrelation HRV transforms** (`whoop_hrv_rmssd`, `whoop_recovery_score`, `hrv_lag*`, `hrv_*d_mean/std`, `hrv_z_28d`, `delta_hrv`, `hrv_vs_baseline`). These were swamping the top-50 drivers chart with persistence rather than behavioral signal.
3. **Granger now uses BH-FDR survivors as input** (was raw top-10 by |r|, inheriting MC bias).
4. **Notion Journal mood/confidence/word_count promoted** as `nj_mood_ord`, `nj_confidence_ord`, `nj_word_count`, `nj_topic_count`, `nj_entry_count`. Note the `nj_` prefix is **deliberately not** `journal_` to avoid being misread as a WHOOP journal boolean by the Welch's t-test machinery.
5. **Ordinal text columns now encoded** (`garmin_hrv_status_ord`, `garmin_training_readiness_level_ord`) rather than silently dropped.
6. **Phase-2 alignment regression test** at `tests/test_phase2_alignment.py` synthesizes alcohol → HRV-depression and locks in the behaviors-of-day-X semantics.

**Reviewers should treat these as completed but verify they're applied consistently.** It's plausible some test paths still bypass corrections (e.g. ad-hoc analyses, the cohorts table generation, the SARIMAX exog selection).

## The causal layer (`causal_inference.py`)

Runs after the descriptive stats. For every controllable treatment, estimates the ATE on next-night HRV three ways:

1. **Naive** — Welch's `mean(Y|T=1) − mean(Y|T=0)`. Unadjusted baseline.
2. **PSM** — 1:3 nearest-neighbor matching on logit propensity, ATT estimated as mean within-pair Y difference, paired-bootstrap CI (B=500), common-support trim [0.05, 0.95].
3. **AIPW (doubly robust)** — logistic propensity + two Ridge outcome models, AIPW influence function, **5-fold cross-fitting** so models aren't evaluated on training data. ATE = mean of influence values; SE = `sd(ψ)/√n`.

**Confounders** are pre-treatment lag-1 only: `hrv_lag1`, `hrv_7d_mean`, `whoop_day_strain_lag1`, `whoop_sleep_duration_milli_lag1`, `rolling_7d_training_load`, `sleep_debt_7d`, `day_of_week`, `is_weekend`. Supplement-family treatments additionally include `journal_have_any_alcoholic_drinks_lag1` and `journal_consumed_caffeine_lag1` (supplement-conscious days cluster with lifestyle).

**Same-night sleep / recovery / HRV-derived variables are deliberately excluded as confounders** — they are mediators on the very causal path being estimated. The reported quantity is therefore the **total effect** (which includes the sleep-quality channel), which is the actionable answer for "if I take magnesium tonight, what happens to my HRV tomorrow?"

**Sensitivity:** VanderWeele & Ding (2017) E-value. Continuous outcome → Cohen's d → RR via Chinn (2000): `RR ≈ exp(0.91·d)`, then `E = RR + √(RR·(RR−1))`.

**Cell-size gates:** treatments with < 10 days in either arm are dropped entirely (logged as `causal/dropped_low_n`). 10–19 in either arm are reported but flagged `low_n=true`.

**Treatments enumerated:**
- **Binary** (auto-enumerated by prefix): `journal_*`, `habit_*`, `supplement_*_amount` (binarized to taken/not-taken).
- **Binary** (explicit): `had_evening_workout`, `is_run_day`, `is_rest_day`, `negative_split`.
- **Continuous** (median-split to put on the same scale): nutrition (`mfp_*`, `net_calories`, `protein_pct`, etc.), daytime strain (`whoop_day_strain`, `whoop_kilojoule`, `steps`, intensity minutes, sedentary/active seconds), training load (rolling, acute, chronic, ATL/CTL), stress (`avg_stress_level`, `high_stress_duration_min`, `garmin_stress_overall`, etc.), body battery, workout timing (minutes-from-workout-to-bedtime, strain÷hours-to-bed), workout aggregates (Garmin + WHOOP, counts/duration/distance/calories/load/HR/zone time), HR zones, recovery state (`days_since_alcohol`, etc.), `meal_last_meal_to_bedtime_min`.
- **Deliberately excluded as treatments** (mediators / outcomes / too slow-moving): every same-night sleep variable, every HRV-derived variable, sleep timing recorded from the sleep itself (bedtime_hour, wake_hour, sleep_midpoint_hour), weight_kg / BMI.

**Storage:** five rows per run in `hrv_analysis_results` under `result_type='causal'`: `binary_treatments`, `continuous_treatments`, `dag` (declared confounder sets + mediator exclusions + identifying assumptions), `meta` (estimator versions, bootstrap reps, fold counts, trim bounds), `dropped_low_n`.

## Multi-horizon XGBoost + baselines (h=1..7)

Walk-forward backtest. Previously only SARIMAX wrote multi-horizon rows to `hrv_model_metrics`; XGBoost / baseline_naive / baseline_7d_avg / baseline_dow were h=1 only.

Now: `prepare_ml_data(df, horizon=h)` pairs the same feature matrix with `TARGET.shift(-h)` for any h ∈ [1..7]. XGBoost retrains per (fold × horizon). Baselines: naive and 7d-avg are constant across h; DOW shifts with the target weekday. Each h has its own residual std for prediction intervals.

`h>1` reuses h=1's tuned hyperparameters (max_depth=4, lr=0.05, n=200) without per-horizon Optuna.

**Downstream analyses that conflate horizons** (Diebold-Mariano paired test, error-mode-by-journal-flag, residual histograms / vs-predicted / DOW plots, rolling-30d-MAE chart) are explicitly filtered to `horizon_days == 1` — they're interpretable only for the headline next-day model.

## Backtest leakage concerns the reviewer should check

1. **Feature engineering that uses future information.** Look at rolling means, EWM, baselines computed on the full series rather than on training data only.
2. **Target leakage via lag features.** `hrv_lag1` is fine; `hrv_z_28d` requires care (the 28-day mean must not include the target row).
3. **Cross-fitting in AIPW.** Verify the 5-fold split is *time-respecting* for time-series data, not random. (Open question for the reviewer — random folds are common in AIPW practice but defensible only if treatment and outcome are conditionally independent given covariates within-fold. With autocorrelation in HRV, this is not obvious.)
4. **The `input_data_hash` retrain guard** — verify it actually catches data changes that matter (currently SHAs the loaded matrix; if a downstream feature changes the matrix, the hash should change; if not, retrains may be skipped when they shouldn't be).
5. **PI coverage.** The prediction intervals use the residual std from the *training* set, not the test set. Empirical coverage is logged in `hrv_model_metrics.ci_coverage` and may be miscalibrated.

## Known limitations the reviewer should NOT spend time on

These are documented as out-of-scope, not bugs:

- `pds.garmin_workouts` (planned workout templates) — not joined into the matrix. Plans ≠ executions; executions are already covered by `garmin_activities` and laps.
- Raw minute-level jsonb (`raw_hrv_readings`, `raw_hr_values`, `raw_stress_values`) — research roadmap item for custom RMSSD / intraday HRV. Not in scope today.
- Spotify daily-signature is opt-in via `ONYX_INCLUDE_SPOTIFY=1` — off by default because of the Garmin offline-playback coverage gap (workout-heavy listening is invisible to the recently-played API).
- Multi-horizon SARIMAX prediction-interval calibration. Known to be loose for h>3.
- Per-horizon Optuna tuning. Deliberate cost/benefit decision.

## Operational facts that affect interpretation

- **The pipeline runs once daily.** No streaming, no real-time. There's no concurrency hazard to worry about.
- **All outputs are stored in Postgres.** The frontend reads from those tables — the pipeline itself never serves anything live.
- **`hrv_predict.py` is a separate, lightweight script** that just predicts tomorrow + backfills actuals. It reuses the saved `xgboost_hrv_model.pkl`. Reviewers can focus 90% of attention on `hrv_analysis.py` and `causal_inference.py`; `hrv_predict.py` is mostly orchestration.
- **CI runs the full retrain only when `hrv_backfill_check.py` detects a backfill signal**, plus a daily unconditional 12:00 UTC safety-net retrain. The detector reads both a Postgres trigger emitting to `sync_log` AND a row-scan; either path triggers retrain.

## Where the existing self-audit ended

`VARIABLE_COVERAGE_AUDIT.md` (in this bundle) is the prior pass. It catalogs every variable × test combination and flags coverage gaps. The reviewer's job is the *next* level: not "is the right test applied to the right variable" but "is each test the right test, given the assumptions and the data?"

Specific questions worth direct attention:

1. Is **walk-forward backtest** time-respecting in every place that needs to be? (AIPW cross-fitting in particular.)
2. Is **BH-FDR** applied at the *right* family granularity? (Per-source family? Across all tests? The current implementation does per-source families which may be undercorrecting.)
3. **Power for the supplement / habit families** — sample sizes don't currently support detecting any plausible effect. Is the pipeline appropriately *silent* on these or does it report noisy estimates?
4. **The mediator-exclusion DAG** — is the set complete? Are there confounders being conditioned on that secretly close mediating paths?
5. **Prediction interval calibration** — does empirical coverage match nominal 80%?
6. **Multicollinearity** — ~250 features at N=568, many derived from the same WHOOP cycle. Is regularization sufficient? VIF computation present?
7. **Stationarity assumptions** — SARIMAX/Prophet assume specific decomposition properties. Are they tested?
