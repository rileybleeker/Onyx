# Re-Audit 2026-06-07 — Consolidated Findings Digest (commit 2f70ba1)

Total findings: 111
By severity: P0=3, P1=30, P2=52, P3=26

## Counts per bundle x reviewer

| bundle | gpt-5 | gemini-2.5-pro | deepseek-v4-pro | total |
|---|---|---|---|---|
| units | 6 | 2 | 6 | 14 |
| stats | 9 | 4 | 4 | 17 |
| schema | 12 | 7 | 8 | 27 |
| tz | 10 | 5 | 10 | 25 |
| etl | 10 | 8 | 10 | 28 |

## Domain scores (per reviewer)

### units
- **gpt-5**: correctness=4, robustness=3, scalability=4, idiomaticness=5
- **gemini-2.5-pro**: correctness=4, robustness=3, scalability=4, idiomaticness=4
- **deepseek-v4-pro**: correctness=4, robustness=3, scalability=4, idiomaticness=4

### stats
- **gpt-5**: correctness=4, robustness=4, scalability=4, idiomaticness=5
- **gemini-2.5-pro**: correctness=3, robustness=4, scalability=5, idiomaticness=4
- **deepseek-v4-pro**: correctness=4, robustness=5, scalability=5, idiomaticness=5

### schema
- **gpt-5**: correctness=3, robustness=4, scalability=4, idiomaticness=4
- **gemini-2.5-pro**: correctness=3, robustness=3, scalability=4, idiomaticness=4
- **deepseek-v4-pro**: correctness=4, robustness=4, scalability=4, idiomaticness=4

### tz
- **gpt-5**: correctness=4, robustness=4, scalability=4, idiomaticness=4
- **gemini-2.5-pro**: correctness=3, robustness=4, scalability=5, idiomaticness=4
- **deepseek-v4-pro**: correctness=4, robustness=4, scalability=5, idiomaticness=4

### etl
- **gpt-5**: correctness=4, robustness=4, scalability=4, idiomaticness=4
- **gemini-2.5-pro**: correctness=3, robustness=3, scalability=4, idiomaticness=4
- **deepseek-v4-pro**: correctness=4, robustness=3, scalability=4, idiomaticness=4

## Findings (grouped by bundle, sorted by severity)

---
## BUNDLE: units

### [units/gpt-5/F-001] P1 (S) — Greek mu (μg) is misparsed as g, causing 1,000,000× overstatement of microgram doses
- file_ref: `SQL_UNITS.md:unit_to_mg_factor`  | dimensions: Correctness,Robustness
- desc: The SQL cleaner keeps only [a–zµ] before matching. It includes the micro sign (µ, U+00B5) but not the Greek letter mu (μ, U+03BC). Labels using μg are common; 'μg' becomes 'g' after sanitization and maps to 1000 mg instead of 0.001 mg.
- evidence: REGEXP_REPLACE(..., '[^a-zµ]', '', 'g'); WHEN 'mcg'...'µg'...ELSE NULL. No explicit handling of 'μ' (Greek mu).
- rec: Add 'μ' to the retained charset and explicit 'μg' branch: REGEXP_REPLACE(..., '[^a-zµμ]', '', 'g'); treat 'μg' like 'mcg'/'µg'. Add unit-level regression tests for 'µg' and 'μg'.

### [units/gpt-5/F-002] P1 (M) — Supplement unit coverage is narrow and silently drops common real-world units (IU, mL, oz, capsules, mg/mL)
- file_ref: `SQL_UNITS.md:unit_to_mg_factor`  | dimensions: Correctness,Robustness,Scalability
- desc: unit_to_mg_factor returns NULL for many packaging units, removing those ingredients from pds.supplement_intake_by_compound and downstream totals. Vitamins A/D/E often labeled in IU; liquids in mL/fl-oz; forms like drops/capsules; concentrations like mg/mL normalize to 'mgml' and fall through.
- evidence: Function only maps mg, g, mcg/µg, kg. Docs note IU, oz, mL, fl-oz, drops, scoops, capsules become NULL; mg/mL collapses to mgml.
- rec: Expand mapping and/or stage a two-step normalization: (1) parse numeric + unit, (2) convert via per-compound IU↔mass crosswalk where defined (A, D, E), (3) support volume units with density when available, (4) preserve unknowns with a flag rather than NULL-drop, and (5) add a QA view listing unrecognized units so coverage gaps are visible.

### [units/gemini-2.5-pro/F-001] P1 (S) — `unit_to_mg_factor` silently drops rows for unrecognized and compound units
- file_ref: `SQL_UNITS.md:unit_to_mg_factor`  | dimensions: Correctness,Robustness
- desc: The SQL function `pds.unit_to_mg_factor` returns `NULL` for unrecognized units like `IU`, `oz`, `mL`, `drops`, `scoops`, and `capsules`. Because it uses `REGEXP_REPLACE` to strip non-alphabetic characters, compound units like `mg/mL` are collapsed to `mgml` and also fall through to `NULL`. This causes the `supplement_intake_by_compound` rollup view to silently drop these rows, leading to underreported supplement intake.
- evidence: The `CASE` statement only handles variations of mg, g, mcg, and kg. The regex `[^a-zµ]` removes the slash in `mg/mL`.
- rec: Add support for common units like `IU` (with compound-specific conversion factors if necessary, or pass them through un-converted if they can't be normalized to mg). Fix the regex to handle or preserve slashes for compound units like `mg/mL`, or add `mgml` to the `CASE` statement. Log or store a fallback for unrecognized units instead of silently returning `NULL`.

### [units/deepseek-v4-pro/F-001] P1 (S) — Supplement unit silent drop – unknown units (IU, oz, mL, etc.)
- file_ref: `SQL_UNITS.md:unit_to_mg_factor`  | dimensions: Correctness,Robustness
- desc: The `pds.unit_to_mg_factor` function returns NULL for units not explicitly in its CASE statement, including IU (Vitamin D/E), oz, mL, drops, scoops, capsules. The consuming view `supplement_intake_by_compound` relies on this factor and silently excludes rows with NULL factor, causing underestimated nutrient totals.
- evidence: Function body contains CASE covering only mg, g, mcg/µg, kg; all other units fall through to ELSE NULL. No logging occurs. IU is a common label unit for fat-soluble vitamins; the user may log such products.
- rec: Extend the function to handle these units (e.g., IU to mg conversion factors per compound, oz/m to volume with density assumption, or flagging for manual check). Add logging/notification when an unrecognized unit is encountered.

### [units/deepseek-v4-pro/F-002] P1 (S) — Compound unit parsing failure (e.g., 'mg/mL')
- file_ref: `SQL_UNITS.md:unit_to_mg_factor`  | dimensions: Correctness,Robustness
- desc: The regex `[^a-zµ]` strips all non-alphabetic characters (except 'µ') from the unit string. A product labeled 'mg/mL' becomes 'mgml', which does not match any branch and returns NULL, causing the row to be dropped.
- evidence: REGEXP_REPLACE(LOWER(COALESCE(u, '')), '[^a-zµ]', '', 'g') collapses 'mg/mL' to 'mgml'; no entry in the CASE map for 'mgml'. Same fate for 'g/100ml', etc.
- rec: Parse compound units by splitting on '/' or other delimiters and returning a valid factor (e.g., 'mg/mL' means 1 mg per 1 mL, so factor is 1 if the view handles volume separately). Alternatively, add explicit mappings for common per-volume units.

### [units/gpt-5/F-003] P2 (S) — Ambiguous helper name: formatKcal expects kJ input, inviting accidental double-conversion
- file_ref: `format.ts:formatKcal`  | dimensions: Idiomaticness,Robustness
- desc: formatKcal(kj) converts kJ→kcal and formats the result. The name suggests it formats an already-kcal value, increasing the risk that dietary kcal values are mistakenly divided by 4.184.
- evidence: export function formatKcal(kj: number | null | undefined): string { return `${Math.round(kjToKcal(kj))} kcal`; }
- rec: Rename to formatKjAsKcal or energyKjToKcalStr. Consider branded types (type Kilojoule = number & {__unit:'kJ'}) to catch misuse at compile time.

### [units/gpt-5/F-004] P2 (M) — Opaque select('*') increases semantic-conflation risk as schemas evolve
- file_ref: `queries.ts:getHealthMatrix`  | dimensions: Scalability,Idiomaticness,Robustness
- desc: Several queries use select('*'), pulling many similarly named fields (e.g., multiple HRV variants, calories from different sources). While current consumers appear disciplined, this pattern makes future conflation more likely as new columns are added.
- evidence: getHealthMatrix, getDailySummaries (pre-rename), getSleepData, etc. use select('*').
- rec: Prefer explicit column lists and typed interfaces per query, exposing only canonical fields needed by each consumer. Continue defensive renaming (as done for Garmin kcal) where overlap exists.

### [units/gpt-5/F-005] P2 (M) — Lack of branded unit types for seconds vs milliseconds and kJ vs kcal
- file_ref: `format.ts + queries.ts (module-wide)`  | dimensions: Robustness,Idiomaticness
- desc: The code relies on naming conventions ('_seconds', '_milli') and comments. This is good practice but still allows unit mistakes at call sites that TypeScript can’t catch.
- evidence: Comments in queries.ts header and separate formatDuration/formatDurationMs helpers; no branded types to enforce units.
- rec: Introduce branded types (e.g., type Seconds = number & {__unit:'s'}; Milliseconds; Kilojoule; Kilocalorie) and annotate key APIs. This will surface unit mismatches at compile time.

### [units/deepseek-v4-pro/F-003] P2 (S) — Hard-coded 18-hour window constant in workout-sleep gap calculation
- file_ref: `queries.ts (getWorkoutSleepGap, around eighteenHrMs)`  | dimensions: Idiomaticness
- desc: The maximum gap between a workout and a sleep onset is defined as `18 * 60 * 60 * 1000` directly in code with a descriptive variable name but no named constant.
- evidence: `const eighteenHrMs = 18 * 60 * 60 * 1000;`
- rec: Define a named constant (e.g., `WORKOUT_SLEEP_GAP_MAX_MS`) at the top of the file to make the intent explicit and allow easy adjustment.

### [units/deepseek-v4-pro/F-004] P2 (M) — Distance conversion left solely to display layer
- file_ref: `queries.ts (getActivities) & format.ts (formatDistance)`  | dimensions: Scalability
- desc: Query functions such as `getActivities` return distance in meters without converting to miles; any consuming chart must call `formatDistance` or use `METERS_PER_MILE`. While centralization minimizes risk, a new chart could omit the conversion and display meters as miles.
- evidence: The comment in format.ts states 'format.ts is the canonical formatter' and queries.ts exports raw metrics; no `distance_miles` field is added at the query layer.
- rec: Consider adding a precomputed `distance_miles` column in the query layer (or a transform wrapper) so that all consumers receive a miles value by default, reducing drift risk.

### [units/deepseek-v4-pro/F-005] P2 (S) — Lack of NaN guard after Number() conversion in getWhoopCaloriesBurnt
- file_ref: `queries.ts (getWhoopCaloriesBurnt)`  | dimensions: Robustness
- desc: The function calls `Number(c.kilojoule)` and then `kjToKcal(kj)`. If `kilojoule` is a non-numeric string (e.g., 'NaN', 'N/A'), `Number()` returns NaN, which propagates through `kjToKcal` and into `Math.round`, producing NaN. There is no `isNaN` check after the Number conversion.
- evidence: `const kj = Number(c.kilojoule); const kcalExact = kjToKcal(kj);` with no `isNaN(kj)` guard. The earlier check `c.kilojoule == null` only catches null/undefined.
- rec: Add `if (isNaN(kj)) continue;` after the Number conversion to skip malformed rows.

### [units/gpt-5/F-006] P3 (S) — Distance formatter switches to meters for short distances, diverging from mile-oriented UI
- file_ref: `format.ts:formatDistance`  | dimensions: Idiomaticness
- desc: For distances <0.5 mi, the formatter shows rounded meters, which may feel inconsistent in a mile/lb/kcal UI. Not a unit error, but a presentation inconsistency.
- evidence: if (miles >= 0.5) return `${miles.toFixed(1)} mi`; else `${Math.round(meters)} m`.
- rec: Consider always showing miles (e.g., two decimals below 1 mi) to keep display units consistent, or make threshold configurable.

### [units/gemini-2.5-pro/F-002] P3 (S) — `formatDuration` truncates instead of rounding to the nearest minute
- file_ref: `format.ts:46`  | dimensions: Correctness,Idiomaticness
- desc: The `formatDuration` function uses `Math.floor` for both hours and minutes. This means that a duration of 3599 seconds (59 minutes and 59 seconds) will be formatted as `59m` instead of `1h 0m`. Similarly, 59 seconds will be formatted as `0m`. This truncation can lead to slightly unintuitive display values compared to standard rounding.
- evidence: `const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60);`
- rec: Use `Math.round(seconds / 60)` to get the total minutes, then calculate hours and minutes from that rounded total to ensure durations are rounded to the nearest minute.

### [units/deepseek-v4-pro/F-006] P3 (S) — Silent duplicate-cycle overwrite in getWhoopCaloriesBurnt
- file_ref: `queries.ts (getWhoopCaloriesBurnt)`  | dimensions: Robustness
- desc: When two WHOOP cycles map to the same calendar date (rare but possible), the last-write-wins logic of `byDate.set` silently overwrites the earlier entry. No warning or decision log is emitted.
- evidence: `byDate.set(calendar_date, { ... })` without checking whether a value already exists for the key.
- rec: Log a warning when overwriting, and consider selecting the cycle with the more complete dataset (e.g., non-zero kJ) or averaging if both are valid.

---
## BUNDLE: stats

### [stats/gpt-5/F-001] P0 (M) — SARIMAX exog backfill leaks future info into training and holdout
- file_ref: `hrv_analysis.py:2425-2450`  | dimensions: Correctness
- desc: Exogenous regressors are built with ffill().bfill() over the full series before the train/test split, then shifted. Backward-filling uses future values to impute earlier rows, leaking information into both model fitting and the walk-forward evaluation.
- evidence: original_exog = (hrv_valid[exog_feats].copy().ffill().bfill().asfreq('D')); exog = original_exog.shift(1).ffill().bfill()
- rec: Drop bfill; construct exog with ffill only and perform filling on the training slice per split. For holdout/backtest, impute using last-known historical exog (as already done for forecast steps), not future rows.

### [stats/gpt-5/F-002] P1 (S) — Backtest PIs use σ estimated from full-series OOF, not fold-local
- file_ref: `hrv_analysis.py:2125-2160`  | dimensions: Correctness,Robustness
- desc: In run_evaluation, pred_std_by_horizon is estimated via TimeSeriesSplit OOF over the full series and then reused in every fold, giving PI widths that benefit from information not available at the time each expanding-window model was fit.
- evidence: for _h in HORIZONS: _, _, X_h_full, y_h_full = prepare_ml_data(df, horizon=_h); TimeSeriesSplit on X_h_full → pred_std_by_horizon[_h]; reused in all folds.
- rec: Within each expanding-window fold, estimate σ via OOF residuals on the training slice only, and use that fold-local σ for that fold’s PIs and coverage.

### [stats/gpt-5/F-003] P1 (M) — Causal BH-FDR uses IF-Wald p-values that assume i.i.d.
- file_ref: `causal_inference.py:644-690`  | dimensions: Correctness
- desc: The FDR screen is based on AIPW |ate/se_if| normal p-values even though HRV exhibits autocorrelation; while block-bootstrap CIs are computed, their information is not used in the p-values, making BH-FDR anti-conservative when temporal dependence inflates variance.
- evidence: p_raw = 2*(1 - norm.cdf(|ate/se_if|)); block-bootstrap CI is computed earlier but not used in p-value calculation or FDR gating.
- rec: Derive p-values from a block-bootstrap test (e.g., percentile or studentized) and use those in BH-FDR; at minimum, suppress passes_fdr when bb_width_ratio >> 1 or fold_failures are high.

### [stats/gpt-5/F-004] P1 (S) — Day-of-week encoded as ordinal in causal confounders
- file_ref: `causal_inference.py:36-62`  | dimensions: Correctness
- desc: Using an integer 0–6 for day_of_week assumes a linear effect across weekdays in both the propensity and outcome models, which is misspecified for cyclic/categorical structure and can bias adjustment.
- evidence: COMMON_CONFOUNDERS includes 'day_of_week', 'is_weekend'; no one-hot or cyclic sin/cos expansion before LogisticRegression/Ridge.
- rec: One-hot encode weekdays or use sin/cos cyclic terms for day-of-week in the causal layer before fitting PS and outcome models.

### [stats/gemini-2.5-pro/F-001] P1 (S) — Granger causality applied to non-contiguous time series
- file_ref: `hrv_analysis.py:1946`  | dimensions: Correctness
- desc: The `grangercausalitytests` function is applied to a DataFrame where rows with NaNs have been dropped. This creates a non-contiguous time series where AR lags align incorrect calendar days, invalidating the F-test.
- evidence: `sub = hrv_valid[[STAT_TARGET, feat]].dropna()` removes missing days. The resulting `sub` is passed to `grangercausalitytests(sub[[STAT_TARGET, feat]], maxlag=3)`. If day 3 is missing, lag 1 for day 4 will incorrectly be day 2.
- rec: Reindex the series to a daily frequency (`asfreq('D')`) and impute missing values before running the test, or skip Granger causality if contiguous missingness is too high.

### [stats/gemini-2.5-pro/F-002] P1 (M) — PSM bootstrap ignores matching uncertainty
- file_ref: `causal_inference.py:321-325`  | dimensions: Correctness
- desc: The bootstrap for Propensity Score Matching only resamples the final `matched_diffs` array. It does not re-estimate the propensity score or re-perform the nearest-neighbor matching on each bootstrap sample, leading to artificially narrow confidence intervals.
- evidence: `sample = RNG.choice(matched_diffs, size=n, replace=True)` is inside the bootstrap loop, but `_fit_propensity` and the nearest-neighbor matching logic are outside.
- rec: Move the propensity model fitting and the nearest-neighbor matching steps inside the `for _ in range(n_boot):` loop to properly capture the variance of the entire matching process.

### [stats/gemini-2.5-pro/F-003] P1 (S) — Mediator adjustment bias for rolling treatments
- file_ref: `causal_inference.py:485-491`  | dimensions: Correctness
- desc: `COMMON_CONFOUNDERS` includes `hrv_lag1` (HRV on night N-1). For treatments that aggregate past days (e.g., `rolling_7d_training_load`), `hrv_lag1` acts as a mediator for the earlier days in the window, inducing bias when conditioned on.
- evidence: `rolling_7d_training_load` is a continuous treatment. `_confounders_for` assigns `COMMON_CONFOUNDERS` to it, which includes `hrv_lag1`. Training load on day N-2 affects HRV on night N-1, making `hrv_lag1` a mediator.
- rec: Dynamically exclude `hrv_lag1` and other intermediate variables from the confounder set when the treatment is a multi-day rolling aggregate.

### [stats/deepseek-v4-pro/F-001] P1 (M) — AIPW FDR p‑values rely on IF‑based SE that may be too narrow
- file_ref: `causal_inference.py:600-615`  | dimensions: Correctness
- desc: BH‑FDR p‑values are computed as 2*(1‑Φ(|ATE|/SE_if)), but the IF‑based SE assumes i.i.d. influence values.  HRV autocorrelation can shrink this SE, producing artificially low p‑values.  The block‑bootstrap CI, reported in the same function, often shows wider CIs, indicating the IF SE is underestimated.
- evidence: z = abs(float(ate) / float(se)); p_raws.append(2.0 * (1.0 - norm.cdf(z))).  The accompanying block‑bootstrap CI (ci_low_bb / ci_high_bb) is not used for inference.
- rec: Use the block‑bootstrap distribution to compute p‑values (e.g., percentiles of the bootstrap ATE distribution) or employ a Newey‑West type correction on the influence function before computing the SE used for FDR.

### [stats/gpt-5/F-005] P2 (S) — PSM bootstrap ignores temporal dependence
- file_ref: `causal_inference.py:184-243`  | dimensions: Robustness
- desc: The ATT CI is computed via i.i.d. resampling of matched_diffs; for a daily time series this underestimates uncertainty when residuals are autocorrelated.
- evidence: for _ in range(n_boot): sample = RNG.choice(matched_diffs, size=n, replace=True) → CI from percentiles of i.i.d. resamples.
- rec: Use block bootstrap on matched pairs (e.g., 7-day blocks over calendar order) to form CIs, in line with the AIPW block-bootstrap approach.

### [stats/gpt-5/F-006] P2 (S) — Top-20 correlation heatmap not filtered by BH-FDR
- file_ref: `hrv_analysis.py:1470-1495`  | dimensions: Correctness
- desc: The visualization selects the top 20 by |r| regardless of whether those correlations survive BH-FDR, potentially highlighting noise as signal.
- evidence: top20 = corr_df.head(20); no filter on corr_df['passes_fdr'] before plotting the heatmap.
- rec: Limit the heatmap to FDR survivors (or visually flag non-survivors) to avoid overstating spurious associations.

### [stats/gpt-5/F-007] P2 (S) — Causal confounder ffill window is hard-coded and short
- file_ref: `causal_inference.py:510-548`  | dimensions: Robustness
- desc: Confounders are forward-filled with limit=2 before dropna; early tracking gaps can force disproportionate row loss or brittle fills that vary by feature sparsity.
- evidence: sub[list(confounders)] = sub[list(confounders)].ffill(limit=2); meta tracks substantial row loss when confounders are sparse.
- rec: Make ffill horizon configurable per confounder (e.g., 7 days for weekly aggregates), and prefer explicit missingness handling to avoid silent bias from overly short fills.

### [stats/gpt-5/F-008] P2 (S) — Backtest DM variance uses fixed 7-lag kernel across all series
- file_ref: `hrv_analysis.py:2205-2255`  | dimensions: Correctness
- desc: The Newey–West long-run variance uses a triangular kernel with fixed max lag=7 for all comparisons; if loss-differential autocorrelation extends beyond a week, test size can be mis-calibrated.
- evidence: for k in range(1, min(7, n_d - 1)): long_run += 2*(1 - k/7)*cov_k
- rec: Select the NW lag data-dependently (e.g., floor(4(n/100)^(2/9))) or test several lags and report sensitivity; alternatively use a package implementation.

### [stats/gpt-5/F-009] P2 (S) — Prophet/SARIMAX feature selection may still admit mediator-like signals
- file_ref: `hrv_analysis.py:2330-2360`  | dimensions: Correctness
- desc: Exogenous features are drawn from SHAP top features plus category seeds; while TARGET itself is excluded, some same-night sleep composites can slip in if not carefully filtered, risking over-attribution in interpretive plots (though exog is shifted by 1 for alignment).
- evidence: top_features composed from SHAP plus seeds; SARIMAX exog excludes TARGET but not necessarily all mediator composites unless absent/sparse.
- rec: Explicitly exclude same-night sleep/recovery composites from exog/regressor candidate lists (keep only day-N features that are truly pre-treatment for HRV(N+1)).

### [stats/gemini-2.5-pro/F-004] P2 (S) — Walk-forward backtest unnecessarily drops 28 days of training data
- file_ref: `hrv_analysis.py:2585-2586`  | dimensions: Correctness,Scalability
- desc: `GAP_DAYS = 28` creates a 28-day gap between the training and test sets to prevent leakage from 28-day rolling features. However, rolling features only look backward and do not leak future targets, so this gap unnecessarily discards valid training data.
- evidence: `test_start = start + GAP_DAYS` skips 28 days. The comment claims "the first ~21 test rows still overlapped the train tail via the 28d windows", which misunderstands rolling windows. Using past targets to compute features for the test set is not target leakage.
- rec: Set `GAP_DAYS = 0`. To prevent target leakage for `h > 1`, set the training end index to `test_start - h + 1` so the latest training target is fully observed before the test prediction date.

### [stats/deepseek-v4-pro/F-002] P2 (M) — Median‑split continuous treatments discard dose‑response information
- file_ref: `causal_inference.py:182-265`  | dimensions: Correctness,Robustness
- desc: All continuous treatments are dichotomised at the personal median, reducing power and changing the estimand from a dose‑response to an 'above‑median' contrast.  The resulting ATEs are not directly comparable to the binary treatments and may obscure genuine dose‑dependent effects.
- evidence: T = (sub[spec.name] > med).astype(int).values
- rec: Implement a continuous doubly‑robust estimator (e.g., AIPW with a linear outcome model) to retain the full continuous scale, and report the average derivative effect per unit of the treatment.

### [stats/deepseek-v4-pro/F-003] P2 (M) — SARIMAX walk‑forward reuses full‑sample fitted parameters, risking optimistic forecast intervals
- file_ref: `hrv_analysis.py:2700-2720`  | dimensions: Robustness
- desc: During the SARIMAX 7‑step ahead walk‑forward, each retrained model is initialised with `fit.params` from the full‑sample fit.  This transfers variance estimates that are not recalibrated from the smaller training windows, potentially making forecast intervals too narrow at longer horizons.
- evidence: m_step = SARIMAX(...); f_step = m_step.filter(fit.params)
- rec: Re‑estimate the model from scratch on each training window (without filtering previous parameters) or at least recompute the covariance matrix for the forecast intervals.

### [stats/deepseek-v4-pro/F-004] P3 (S) — Continuous treatment E‑value uses approximate d→RR transformation
- file_ref: `causal_inference.py:370-380`  | dimensions: Correctness
- desc: The E‑value relies on Cohen's d → RR ≈ exp(0.91·d) (Chinn 2000).  This approximation is intended for binary outcomes and may introduce bias when applied to a continuous outcome like HRV, especially for small effect sizes.
- evidence: rr = np.exp(0.91 * d)
- rec: Document the approximation more prominently and consider a sensitivity analysis that directly uses the continuous‑outcome guidelines from VanderWeele & Ding (2017) Appendix.

---
## BUNDLE: schema

### [schema/gpt-5/F-001] P0 (S) — Pre-lockdown RLS allowed habit writes via authenticated role
- file_ref: `sql/security_lockdown_2026_06_06.sql`  | dimensions: Correctness,Idiomaticness
- desc: Before the lockdown migration, habit_journal and habit_name_map had FOR ALL policies to authenticated plus table-level write grants, enabling public-key writes. This is a direct integrity and security risk if not already applied in prod.
- evidence: sql/security_lockdown_2026_06_06.sql comments: 'habit_journal / habit_name_map had ... FOR ALL to authenticated + anon/authenticated table-level write grants, so the public key could INSERT/UPDATE/DELETE...'.
- rec: Ensure the lockdown migration is applied: scope service_full_access to service_role only and revoke anon/authenticated writes on both tables as in sql/security_lockdown_2026_06_06.sql.

### [schema/gemini-2.5-pro/F-002] P0 (S) — RLS service policies target public role instead of service_role
- file_ref: `SCHEMA_DDL.md`  | dimensions: Correctness,Robustness
- desc: Several tables (e.g., `whoop_cycles`, `garmin_*`) have `service_full_access` policies that grant `ALL` to the `{public}` role. This technically allows the `anon` role to write data if they bypass the frontend.
- evidence: SCHEMA_DDL.md notes: 'Several (whoop_cycles, whoop_recovery... garmin_*) target {public} instead.'
- rec: Run `DROP POLICY` and recreate these policies to explicitly target `TO service_role` as defined in `sql/rls_policies.sql`.

### [schema/gpt-5/F-002] P1 (S) — Missing FK: habit_journal.question → habit_name_map.habit_name (prod)
- file_ref: `SCHEMA_DDL.md — Referential integrity; sql/audit_re_2026_05_26_habit_journal_question_fk.sql`  | dimensions: Correctness,Robustness
- desc: Production snapshot lists only six FKs and explicitly calls out this relationship as absent; the migration to add the FK exists but appears not applied. Without the FK, typos/renames can orphan rows.
- evidence: SCHEMA_DDL.md: 'Notably absent foreign keys — habit_journal.question ↔ habit_name_map.name'; migration present in sql/audit_re_2026_05_26_habit_journal_question_fk.sql.
- rec: Apply sql/audit_re_2026_05_26_habit_journal_question_fk.sql (adds UNIQUE on habit_name and FK with ON UPDATE CASCADE, ON DELETE RESTRICT). Validate no orphans exist first.

### [schema/gpt-5/F-003] P1 (M) — Cronometer tables lack set_onyx_dates triggers
- file_ref: `cronometer_schema.sql`  | dimensions: Correctness,Robustness,Idiomaticness
- desc: New Cronometer tables define onyx_* columns but no BEFORE triggers to populate them, diverging from ADR-0001’s trigger-enforced invariant and risking drift if ETL forgets to set them.
- evidence: cronometer_schema.sql creates onyx_* columns and indexes but no pds.set_onyx_dates_* triggers; SCHEMA_DDL lists 11 set_onyx_dates triggers for other sources, not Cronometer.
- rec: Add BEFORE INSERT/UPDATE triggers: for daily, set all onyx_* = calendar_date; for servings, call derive_onyx_dates(event_time) when present else default to calendar_date with explicit tz_source.

### [schema/gpt-5/F-004] P1 (S) — Inconsistent RLS: service_full_access granted TO public on some tables
- file_ref: `SCHEMA_DDL.md — Row-Level Security policies`  | dimensions: Correctness,Idiomaticness
- desc: Several service_full_access policies target the public role instead of service_role, widening the trust boundary and creating future risk if table grants change.
- evidence: SCHEMA_DDL.md: 'Several (whoop_*, garmin_*, sync_log) target {public} instead [of] {service_role}'.
- rec: Normalize to service_role-only per sql/rls_policies.sql; drop any public-targeted write policies.

### [schema/gpt-5/F-012] P1 (S) — Several tables lack explicit service_role write policies in prod
- file_ref: `SCHEMA_DDL.md — Row-Level Security policies`  | dimensions: Correctness,Robustness
- desc: Production notes tables with only anon_read and no service policy, relying on service-role bypass. This is brittle and non-idiomatic.
- evidence: SCHEMA_DDL.md: 'A few tables have RLS enabled with anon_read but no service_* policy... rely on the service-role’s bypass-RLS privilege.'
- rec: Apply sql/rls_policies.sql to add explicit FOR ALL TO service_role policies consistently across all writeable tables.

### [schema/gemini-2.5-pro/F-001] P1 (S) — Missing composite index for hrv_predictions_latest tiebreak
- file_ref: `pds.hrv_predictions`  | dimensions: Scalability,Correctness
- desc: The `hrv_predictions_latest` view relies on a complex `DISTINCT ON` with a `CASE` statement tiebreak. The supporting index `idx_hrv_predictions_tiebreak` defined in the SQL files is missing in production, causing full table sorts on the fastest-growing table.
- evidence: `sql/hrv_predictions_latest.sql` defines `idx_hrv_predictions_tiebreak`, but `SCHEMA_DDL.md` shows it is absent from `pds.hrv_predictions`.
- rec: Execute the `CREATE INDEX idx_hrv_predictions_tiebreak` statement from `sql/hrv_predictions_latest.sql` in production.

### [schema/gemini-2.5-pro/F-003] P1 (S) — Missing foreign key for habit_journal.question
- file_ref: `pds.habit_journal`  | dimensions: Correctness,Robustness
- desc: The foreign key linking `habit_journal.question` to `habit_name_map.habit_name` is missing in production, allowing Notion renames or typos to silently orphan journal entries.
- evidence: `sql/audit_re_2026_05_26_habit_journal_question_fk.sql` exists in the repo, but `SCHEMA_DDL.md` explicitly lists this FK as 'Notably absent'.
- rec: Apply `sql/audit_re_2026_05_26_habit_journal_question_fk.sql` to production to enforce `ON UPDATE CASCADE ON DELETE RESTRICT`.

### [schema/gpt-5/F-007] P2 (M) — Behavioral-spine view still unions garmin_daily_summary.calendar_date
- file_ref: `sql/daily_health_matrix_behavioral_main_session.sql`  | dimensions: Correctness,Robustness
- desc: The behavioral matrix spine unions GDS calendar_date (watch-local), which can diverge from onyx_behavioral_date on travel days. A comment notes a pending removal, but prod state suggests it’s still included.
- evidence: sql/daily_health_matrix_behavioral_main_session.sql NOTE: migration to remove GDS from UNION is pending; current UNION includes garmin_daily_summary.calendar_date.
- rec: Remove garmin_daily_summary from the UNION and regenerate the spine from behavioral onyx_* dates only; backfill any gaps via other sources.

### [schema/gpt-5/F-008] P2 (S) — Missing/uncertain HRV tiebreak index may force full scans
- file_ref: `SCHEMA_DDL.md — pds.hrv_predictions; sql/hrv_predictions_latest.sql`  | dimensions: Scalability,Correctness
- desc: The view orders by a CASE tiebreak; production index list only shows idx(input_data_hash). Without idx_hrv_predictions_tiebreak, DISTINCT ON queries may scan/sort the whole table.
- evidence: SCHEMA_DDL.md index list omits the composite tiebreak index; sql/hrv_predictions_latest.sql creates it explicitly.
- rec: Ensure sql/hrv_predictions_latest.sql has been applied and idx_hrv_predictions_tiebreak exists; ANALYZE the table after creation.

### [schema/gpt-5/F-009] P2 (S) — Hot-path partial/composite indexes not present in prod snapshot
- file_ref: `sql/audit_re_2026_05_26_covering_partial_indexes.sql`  | dimensions: Scalability
- desc: Indexes tailored to frequent filters (WHOOP score_state='SCORED', non-nap sleep, Garmin sleep best-of-day, Spotify featurized-join) aren’t listed in production.
- evidence: SCHEMA_DDL.md index inventory lacks idx_whoop_recovery_cycle_scored, idx_whoop_sleep_cycle_scored_main, idx_garmin_sleep_behavioral_score, idx_spotify_tracks_featurized.
- rec: Apply sql/audit_re_2026_05_26_covering_partial_indexes.sql to tighten join and aggregate performance.

### [schema/gpt-5/F-010] P2 (M) — Duplication in 11+ set_onyx_dates triggers invites drift
- file_ref: `SCHEMA_DDL.md — Functions and triggers`  | dimensions: Robustness,Idiomaticness
- desc: Each source table has a bespoke trigger function that mirrors the same ladder; fixes must be repeated across many functions, risking skew over time.
- evidence: SCHEMA_DDL.md: '11 of these' set_onyx_dates_* functions; ADR-0001 edits had to be repeated.
- rec: Refactor to a single generic trigger function with TG_ARGs (instant column, provenance) or a small set of shared helpers to centralize logic and reduce maintenance.

### [schema/gpt-5/F-011] P2 (S) — Legacy daily_health_matrix likely ready for deprecation
- file_ref: `sql/daily_health_matrix.sql; SCHEMA_DDL.md — Views`  | dimensions: Robustness,Idiomaticness
- desc: Two parallel matrix views increase maintenance surface and confusion; the behavioral one is canonical and already powers downstream methods.
- evidence: CONTEXT.md: legacy retained for migration; SCHEMA_DDL.md lists both; behavioral view has helper refactors and richer semantics.
- rec: Migrate remaining consumers and deprecate/drop the legacy view; keep a frozen snapshot if historical A/B comparisons are still needed.

### [schema/gemini-2.5-pro/F-004] P2 (S) — Production behavioral matrix view uses inline LATERALs instead of helper views
- file_ref: `pds.daily_health_matrix_behavioral`  | dimensions: Robustness,Idiomaticness
- desc: The intended DDL refactored the 135-column behavioral matrix to use helper views (e.g., `garmin_sleep_best_per_behavioral_date`) to remove repeated `LATERAL+LIMIT 1` blocks. These helper views are missing in production.
- evidence: `SCHEMA_DDL.md` lists 14 views, none of which are the helper views defined in `sql/adr_0001_08_daily_health_matrix_behavioral.sql`.
- rec: Apply `sql/adr_0001_08_daily_health_matrix_behavioral.sql` to create the helper views and update the main view definition.

### [schema/gemini-2.5-pro/F-005] P2 (M) — Legacy daily_health_matrix view is a drift liability
- file_ref: `pds.daily_health_matrix`  | dimensions: Robustness
- desc: Maintaining two parallel 130+ column matrix views guarantees drift. For example, Cronometer data was added to the behavioral view but not the legacy view, meaning consumers of the legacy view will silently miss nutrition data post-cutover.
- evidence: `sql/cronometer_matrix_view.sql` notes: 'the legacy pds.daily_health_matrix... is intentionally left unchanged'.
- rec: Deprecate `pds.daily_health_matrix`, migrate remaining consumers (like MFP energy-balance and /status) to the behavioral view, and drop the legacy view.

### [schema/deepseek-v4-pro/F-002] P2 (S) — Legacy service_full_access policies target public role
- file_ref: `pds.whoop_cycles, pds.whoop_sleep, pds.garmin_activities (and others)`  | dimensions: Correctness,Robustness
- desc: Several WHOOP and Garmin tables still have service_full_access policies defined for role public, not service_role.  This semantics grants full access to any user with the public role (including anon), which violates the intended trust boundary.
- evidence: SCHEMA_DDL.md section ‘Row‑Level Security policies’ notes: “Several … target {public} instead … granting ALL to public is semantically broader than service_role.”
- rec: Alter each affected policy to target service_role, e.g.: DROP POLICY service_full_access ON pds.whoop_cycles; CREATE POLICY service_full_access ON pds.whoop_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);

### [schema/deepseek-v4-pro/F-003] P2 (S) — Missing FK on hrv_model_metrics.input_data_hash → hrv_predictions.input_data_hash
- file_ref: `pds.hrv_model_metrics`  | dimensions: Correctness,Robustness
- desc: The cross‑reference between model metrics and prediction data is solely through an application‑level hash; no FK prevents orphaned metrics rows after a prediction batch is deleted, nor does it guarantee that the hash refers to a valid row in hrv_predictions.
- evidence: SCHEMA_DDL.md lists hrv_model_metrics with an index on input_data_hash but no FK to hrv_predictions.
- rec: Add a foreign key: ALTER TABLE pds.hrv_model_metrics ADD CONSTRAINT fk_hrv_model_metrics_input_hash FOREIGN KEY (input_data_hash) REFERENCES pds.hrv_predictions(input_data_hash) ON UPDATE CASCADE ON DELETE CASCADE; (after verifying no orphans).

### [schema/deepseek-v4-pro/F-006] P2 (M) — No partitioning plan for fastest‑growing tables
- file_ref: `pds.hrv_predictions, pds.whoop_journal`  | dimensions: Scalability
- desc: hrv_predictions grows ≈36 rows/day and will double in 9 months; whoop_journal is already 12K rows.  Without partitioning, maintenance operations and some query plans will gradually degrade.
- evidence: Table sizes from CONTEXT.md and SCHEMA_DDL.md; no partition declaration exists in the schema.
- rec: Implement range partitioning on prediction_date for hrv_predictions (monthly) and on cycle_date for whoop_journal in the next maintenance window.

### [schema/gpt-5/F-005] P3 (S) — Redundant single-column indexes that duplicate PKs
- file_ref: `SCHEMA_DDL.md (myfitnesspal_nutrition, weight_log, whoop_journal)`  | dimensions: Scalability,Idiomaticness
- desc: Indexes like idx_mfp_nutrition_date, idx_weight_log_date, and whoop_journal(cycle_date) duplicate the PK’s leading column and add maintenance/plan noise.
- evidence: SCHEMA_DDL.md flags 'duplicate?' next to these indexes.
- rec: Drop the redundant indexes; keep only the PK or a truly different composite/partial index. Use sql/audit_re_2026_05_26_drop_redundant_indexes.sql as a pattern.

### [schema/gpt-5/F-006] P3 (S) — garmin_activity_laps has redundant (activity_id, lap_index) index
- file_ref: `SCHEMA_DDL.md — pds.garmin_activity_laps`  | dimensions: Scalability,Idiomaticness
- desc: A separate index on (activity_id, lap_index) duplicates the leftmost prefix of the UNIQUE (activity_id, lap_index, ts) index and is likely unnecessary.
- evidence: SCHEMA_DDL.md shows UNIQUE(activity_id, lap_index, ts) and a separate idx(activity_id, lap_index).
- rec: Drop the two-column index unless you can show a measurable plan benefit; the UNIQUE index supports scans on the leftmost prefix.

### [schema/gemini-2.5-pro/F-006] P3 (S) — Redundant single-column indexes duplicate primary keys
- file_ref: `pds.myfitnesspal_nutrition`  | dimensions: Idiomaticness,Scalability
- desc: Tables like `myfitnesspal_nutrition` and `weight_log` have single-column indexes on their primary key columns. Postgres automatically creates a B-tree index for primary keys, making these explicit indexes redundant write overhead.
- evidence: `SCHEMA_DDL.md` shows `pds.myfitnesspal_nutrition` has `PK (calendar_date)` and `idx (calendar_date)`. `pds.weight_log` has `PK (log_date)` and `idx (log_date DESC)`.
- rec: Drop `idx_mfp_nutrition_date` and `idx_weight_log_date`.

### [schema/gemini-2.5-pro/F-007] P3 (S) — Missing explicit service_role RLS policies on multiple tables
- file_ref: `SCHEMA_DDL.md`  | dimensions: Robustness,Idiomaticness
- desc: Several tables have `anon_read` policies but no explicit `service_full_access` policy, relying entirely on Supabase's `service_role` bypass-RLS privilege. This breaks portability and schema consistency.
- evidence: `SCHEMA_DDL.md` notes `garmin_workouts`, `journal_entries`, `spotify_*`, and others lack a `service_*` policy.
- rec: Create explicit `service_full_access` policies for these tables targeting `service_role` to match the rest of the schema.

### [schema/deepseek-v4-pro/F-001] P3 (S) — Redundant indexes duplicate primary key columns
- file_ref: `pds.myfitnesspal_nutrition / pds.weight_log`  | dimensions: Scalability
- desc: Indexes idx_mfp_nutrition_date on calendar_date and idx_weight_log_date on log_date both duplicate the leading column of the primary key, providing no query benefit and wasting write overhead.
- evidence: SCHEMA_DDL.md shows idx_mfp_nutrition_date (calendar_date) where PK is (calendar_date); idx_weight_log_date (log_date DESC) where PK is (log_date).  These were not dropped by the previous cleanup script.
- rec: Drop both indexes: DROP INDEX IF EXISTS pds.idx_mfp_nutrition_date; DROP INDEX IF EXISTS pds.idx_weight_log_date;

### [schema/deepseek-v4-pro/F-004] P3 (S) — Some tables lack explicit service_role policy, relying on RLS bypass
- file_ref: `pds.garmin_workouts, pds.habit_metadata_history, pds.meal_events, pds.myfitnesspal_nutrition, etc.`  | dimensions: Robustness,Idiomaticness
- desc: Tables like garmin_workouts, habit_metadata_history, meal_events, and myfitnesspal_nutrition have RLS enabled with an anon_read policy but no explicit service_full_access; writes succeed only because service_role has the BypassRLS attribute on Supabase.  This is inconsistent and would break in a non‑Supabase environment.
- evidence: SCHEMA_DDL.md notes ‘A few tables have RLS enabled with… no service_* policy’ and the live production state confirms these tables lack an ALL TO service_role policy.
- rec: Create explicit service_full_access policies for each affected table: CREATE POLICY service_full_access ON pds.<table> FOR ALL TO service_role USING (true) WITH CHECK (true);

### [schema/deepseek-v4-pro/F-005] P3 (S) — Daily_health_matrix (legacy) should be formally deprecated
- file_ref: `pds.daily_health_matrix`  | dimensions: Robustness,Scalability
- desc: The original clock‑day matrix view still exists alongside the canonical behavioural matrix.  It confuses maintainers and consumes resources; all current consumers are on the behavioural view.
- evidence: The file sql/adr_0001_08_daily_health_matrix_behavioral.sql documents that the legacy view is frozen, and sql/daily_health_matrix.sql is still present.
- rec: Add a deprecation comment on the legacy view, announce a removal timeline, and eventually DROP VIEW pds.daily_health_matrix; after verifying no remaining dependencies.

### [schema/deepseek-v4-pro/F-007] P3 (M) — ADR‑0001 trigger functions nearly identical, leading to maintenance drift
- file_ref: `sql/adr_0001_02_whoop_onyx_dates.sql, sql/adr_0001_03_garmin_onyx_dates.sql, sql/adr_0001_04_other_onyx_dates.sql`  | dimensions: Robustness
- desc: Eleven BEFORE trigger functions exist (set_onyx_dates_whoop_cycles, set_onyx_dates_garmin_activities, etc.) that all call derive_onyx_dates with slightly different parameters.  Future changes to the derivation logic must be replicated across all of them, risking inconsistent behaviour.
- evidence: The files listed contain near‑identical trigger body patterns; the set of tables affected is enumerated in sql/adr_0001_04_other_onyx_dates.sql (lines 1–8).
- rec: Consolidate into a single generic trigger function that uses TG_TABLE_NAME and a mapping source_field → column name; register it on each table via a loop in a migration script.  This reduces the risk of drift.

### [schema/deepseek-v4-pro/F-008] P3 (M) — JSONB in meal_events and supplement_intake views forces repeated casting
- file_ref: `pds.supplement_intake_by_compound, pds.daily_supplement_matrix`  | dimensions: Scalability
- desc: The supplement_intake_by_compound view repeatedly casts JSONB fields to numeric and filters on regex matches; while correct, these operations add per‑query overhead.  As supplement data grows, materialising a derived table or adding CHECK constraints on underlying JSONB might be beneficial.
- evidence: supplement_schema.sql lines 105‑115 perform casts and regex checks; no index can assist the inline filtering inside the view.
- rec: Consider creating a materialised view for the most common compound rollups, refreshing it after supplement data changes; alternatively, promote highly‑filtered fields (quantity, unit) to typed columns in a new intake_detail table.

---
## BUNDLE: tz

### [tz/gpt-5/F-002] P1 (S) — whoop_journal behaviors_date picks earliest cycle, not longest/main
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:166`  | dimensions: Correctness
- desc: behaviors_date is computed from the earliest cycle on a given cycle_date. On transition days with an arrival nap and a main sleep, this can anchor behaviors_date to the nap’s TZ instead of the main cycle’s TZ.
- evidence: ORDER BY c.start_time LIMIT 1 in pds.set_onyx_dates_whoop_journal; elsewhere in the same function and in pds.whoop_main_cycle_per_behavioral_date the 'longest' cycle is preferred.
- rec: Switch behaviors_date cycle selection to match the 'longest (main) cycle' heuristic used elsewhere (ORDER BY (end_time - start_time) DESC, start_time DESC).

### [tz/gemini-2.5-pro/F-001] P1 (S) — WHOOP cycle anchor fails for daytime events due to strict 6h start_time bound
- file_ref: `sql/adr_0001_01_user_tz_log.sql:92`  | dimensions: Correctness
- desc: The `dist_sec` calculation measures distance strictly to the cycle's `start_time` (bedtime). The `<= 6 * 60 * 60` filter means any event occurring more than 6 hours after bedtime (which includes almost all waking daytime hours) will fail to match the cycle, causing daytime events like meals and supplements to fall back to ET.
- evidence: abs(extract(epoch from (start_time - ts))) <= 6 * 60 * 60
- rec: Remove the 6-hour filter and rely on `ORDER BY dist_sec ASC LIMIT 1` with a larger bound (e.g., 24 hours), or calculate distance to the closest of `start_time` or `end_time`.

### [tz/gemini-2.5-pro/F-003] P1 (S) — journal_entries backdating check compares local date to ET clock date
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:161`  | dimensions: Correctness
- desc: The trigger tries to prevent overwriting dates on backdated entries by checking if `entry_date` matches the ET date of `notion_created_at`. Since `entry_date` is typed in local time, real-time entries made in distant timezones (e.g., Tokyo) will fail this check and incorrectly fall back to ET.
- evidence: NEW.entry_date = (NEW.notion_created_at AT TIME ZONE 'America/New_York')::date
- rec: Call `derive_onyx_dates` first, then check if `NEW.entry_date` matches `d.onyx_behavioral_date` or `d.onyx_local_date` to determine if it was backdated.

### [tz/gemini-2.5-pro/F-004] P1 (S) — whoop_journal onyx_local_date is inconsistent for pre/post-midnight bedtimes
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:280`  | dimensions: Correctness
- desc: The trigger derives dates using the cycle's `start_time` (bedtime). While `onyx_behavioral_date` correctly uses the -6h rule, `onyx_local_date` is set to the literal clock date of the bedtime. This splits a single behavioral day's journals across two local dates depending on whether bedtime was before or after midnight.
- evidence: NEW.onyx_local_date := d.onyx_local_date; (where d is derived from cycle_start_time)
- rec: For date-only behavioral tables, `onyx_local_date` should either mirror `onyx_behavioral_date` or be explicitly derived from the wake time, rather than the bedtime instant.

### [tz/deepseek-v4-pro/F-001] P1 (M) — cycle_offset_for_instant can return a nap on transition days, picking wrong TZ
- file_ref: `sql/adr_0001_01_user_tz_log.sql: cycle_offset_for_instant function`  | dimensions: Robustness
- desc: When an event occurs during the day on a transition day, the nearest cycle within ±6h might be a short nap that still carries the old timezone_offset, not the main night sleep that has the new zone. This can silently attribute the event to the wrong TZ, causing incorrect behavioral and local dates.
- evidence: The function orders by in_window DESC, dist_sec ASC, effectively picking the nearest cycle. A 20-minute nap starting at 14:00 with offset -05:00 (old TZ) will be chosen over a main cycle starting at 23:00 with offset -08:00 (new TZ) if the event is at 15:00.
- rec: Modify the ordering to first prefer cycles within a 24-hour window of the same onyx_behavioral_date (using longest cycle as tiebreak), then fall back to nearest. Alternatively, restrict the search to cycles whose end_time–start_time exceed a minimum threshold to filter out naps.

### [tz/deepseek-v4-pro/F-002] P1 (M) — derive_onyx_dates does not prefer the longest cycle for tier-2 anchor
- file_ref: `sql/adr_0001_01_user_tz_log.sql: pds.cycle_offset_for_instant called by pds.derive_onyx_dates`  | dimensions: Correctness,Robustness
- desc: When no source offset is given, derive_onyx_dates falls back to cycle_offset_for_instant, which can select a nap instead of the main sleep cycle. This may confuse behavioral date attribution for events inserted after the nap but before the main sleep, especially on travel days.
- evidence: Lines 173-186 in the function: IF cycle_offset_text IS NOT NULL THEN uses cycle_offset_for_instant without any preference for the longest cycle. The cycle_offset_for_instant function itself (as described in F-001) can return a nap.
- rec: Either wrap the call with a preference for the longest cycle of the day (matching whoop_journal’s approach) or change cycle_offset_for_instant to filter out cycles where duration < a minimum (e.g., 2 hours) before considering them.

### [tz/deepseek-v4-pro/F-003] P1 (M) — garmin_hrv fallback uses noon-ET instant, may misattribute behavioral date
- file_ref: `sql/adr_0001_03_garmin_onyx_dates.sql: set_onyx_dates_garmin_hrv ELSE branch`  | dimensions: Correctness
- desc: When start_timestamp is NULL, the trigger synthesizes an instant at noon ET on the calendar_date. For travel days, this midpoint is in the user's local afternoon/evening, so the -6h rule pushes behavioral_date to same day, but the HRV reading is actually from the previous night. For example, a bed at 22:00 PT on May 19 would yield a calendar_date of May 20 (Garmin watch local). Using noon ET on May 20 and applying PT -6h gives May 20 behavioral, when the correct behavioral date is May 19.
- evidence: Lines: SELECT * INTO d FROM pds.derive_onyx_dates( (NEW.calendar_date + INTERVAL '12 hours') AT TIME ZONE 'America/New_York', NULL, 'garmin_calendar_date' ); The resulting behavioral_date can be off by one day.
- rec: If the garmin_sleep table is available, join to get the actual sleep_start instant for that night and use it instead of the synthesized noon. Fall back to noon only when no sleep data exists. This would fix the attribution for the majority of nights.

### [tz/deepseek-v4-pro/F-004] P1 (M) — Date-only triggers use a single noon-ET probe, can miss same‐day TZ changes
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql: habit_journal & whoop_journal fallback`  | dimensions: Correctness,Robustness
- desc: Both habit_journal and whoop_journal (when no cycle matches) compute noon_et on the given date and look up user_tz_log where effective_from <= noon_et. If a TZ change (e.g., a flight landing) occurs at 15:00 local on that same day, the noon probe will still return the old TZ. The habit/journal entries for that day would be labeled with the wrong local_date.
- evidence: noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'America/New_York'; SELECT tz … WHERE effective_from <= noon_et. This ignores any log row that starts later on the same calendar date.
- rec: If the source table had an actual instant (e.g., a tap timestamp), use it directly. Otherwise, consider probing at both start and end of the day (e.g., noon and 23:59:59 ET) and pick the most recent effective_from; or mark the date as ambiguous when multiple log rows exist on that day.

### [tz/gpt-5/F-001] P2 (S) — onyx_tz_source taxonomy drifts beyond ADR enum and is inconsistent
- file_ref: `sql/adr_0001_03_garmin_onyx_dates.sql:120`  | dimensions: Correctness,Idiomaticness,Robustness
- desc: Several triggers emit onyx_tz_source values not in the ADR’s documented set (e.g., 'garmin_calendar_date', 'missing_gmt_instant', 'user_tz_log_et'). This inconsistency can break consumers that expect the ADR-defined vocabulary.
- evidence: Examples: garmin_hrv sets 'garmin_calendar_date' (sql/adr_0001_03_garmin_onyx_dates.sql, set_onyx_dates_garmin_hrv); garmin_activities uses 'missing_gmt_instant' when start_time_gmt is NULL (same file); habit_journal and whoop_journal use 'user_tz_log_et' (sql/adr_0001_04_other_onyx_dates.sql).
- rec: Standardize on the ADR set and add a mapping: map 'garmin_calendar_date' → 'user_tz_log' (or a documented 'calendar_anchor'), 'missing_gmt_instant' → a documented 'missing_instant', and fold 'user_tz_log_et' into 'user_tz_log' with an auxiliary boolean if needed. Document all allowed values.

### [tz/gpt-5/F-003] P2 (S) — Cycle-anchor window (±6h) may miss many daytime events
- file_ref: `sql/adr_0001_01_user_tz_log.sql:79`  | dimensions: Robustness,Correctness
- desc: pds.cycle_offset_for_instant uses a narrow ±6h tolerance around cycle start when ts is outside [start,end). Midday/afternoon events commonly lie >6h from bedtime and thus fall back to user_tz_log/ET.
- evidence: Function pds.cycle_offset_for_instant conditions: abs(start_time - ts) <= 6h.
- rec: Increase the tolerance (e.g., ±18h or nearest start within 24h) or prefer the nearest adjacent cycle by absolute difference, to reduce unnecessary fallbacks on typical daytime events.

### [tz/gpt-5/F-004] P2 (S) — garmin_hrv local_date overridden to watch-local, not physical local
- file_ref: `sql/adr_0001_03_garmin_onyx_dates.sql:93`  | dimensions: Correctness
- desc: When start_timestamp is NULL, onyx_local_date is hard-set to Garmin’s calendar_date, which may not reflect the physical local day if the watch TZ lagged. ADR defines local_date as the clock day in the user’s actual TZ.
- evidence: In set_onyx_dates_garmin_hrv, onyx_local_date := NEW.calendar_date after derive_onyx_dates; provenance 'garmin_calendar_date'.
- rec: Prefer d.onyx_local_date (derived via noon-ET anchor and user_tz_log) for local_date; keep watch-local in a separate column if needed for provenance.

### [tz/gpt-5/F-005] P2 (S) — Inconsistent fallback labeling between derive_onyx_dates and ad-hoc fallbacks
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:118`  | dimensions: Robustness,Idiomaticness
- desc: Some tables use pds.derive_onyx_dates (with standardized labeling), others implement custom noon-ET + user_tz_log fallbacks and emit 'user_tz_log_et' or 'default_et_fallback'. This fragmentation complicates auditing.
- evidence: habit_journal and the whoop_journal orphan branch implement their own noon-ET logic and special-case labels; other tables rely on derive_onyx_dates.
- rec: Centralize all noon-ET/user_tz_log fallback paths inside derive_onyx_dates (e.g., add a safe helper) so labels and behavior are uniform across tables.

### [tz/gpt-5/F-006] P2 (S) — WHOOP backfill IANA inference silently uses generic defaults
- file_ref: `whoop_tz_backfill.py:31`  | dimensions: Robustness
- desc: GENERIC_OFFSET_IANA maps broad offsets to specific IANA zones (e.g., +02:00 → Europe/Berlin). While better than UTC, this can mislabel travel to different +02:00 locales without historical hints.
- evidence: GENERIC_OFFSET_IANA literal dict; infer_iana falls back to this when history has no match.
- rec: Log a clear warning and prefer skipping the insert unless a strong prior exists (history map); optionally prompt for manual confirmation for first-time offsets.

### [tz/gpt-5/F-009] P2 (S) — daily_health_matrix_behavioral spine includes gds.calendar_date
- file_ref: `sql/adr_0001_08_daily_health_matrix_behavioral.sql:69`  | dimensions: Correctness
- desc: The behavioral spine unions Garmin Daily Summary’s calendar_date, which is watch-local, not strictly behavioral. This can introduce dates absent from behavioral events and slightly dilute semantics.
- evidence: UNION … SELECT calendar_date FROM pds.garmin_daily_summary
- rec: Document this explicitly in the view comment and/or gate inclusion behind presence of at least one behavioral-anchored source that day, or add a flag indicating 'spine_from_gds'.

### [tz/gpt-5/F-010] P2 (M) — Derivation for date-only tables diverges from ADR D3 tiering
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:83`  | dimensions: Correctness,Idiomaticness
- desc: For habit_journal and journal_entries with backdated entries, ad-hoc logic sets et/local dates. Some cases bypass cycle-anchor opportunities that exist (e.g., deriving from main cycle of cycle_date).
- evidence: habit_journal uses noon-ET + user_tz_log only; journal_entries conditions treat backdating specially.
- rec: Where feasible, prefer a cycle-anchor lookup (longest cycle for that cycle_date) before falling back to noon-ET user_tz_log; centralize this in derive_onyx_dates or a helper to ensure uniformity.

### [tz/gemini-2.5-pro/F-002] P2 (S) — Unsafe TIMESTAMP minus TIMESTAMPTZ subtraction in garmin_activities
- file_ref: `sql/adr_0001_03_garmin_onyx_dates.sql:75`  | dimensions: Robustness,Idiomaticness
- desc: The trigger subtracts `start_time_gmt` (TIMESTAMPTZ) from `start_time_local` (TIMESTAMP). This implicitly casts the TIMESTAMP to TIMESTAMPTZ using the server's `TimeZone` setting, which produces an incorrect interval if the server is not set to UTC.
- evidence: tzd := pds.interval_to_tzd(NEW.start_time_local - NEW.start_time_gmt);
- rec: Explicitly cast the GMT timestamp to UTC before subtracting: `NEW.start_time_local - (NEW.start_time_gmt AT TIME ZONE 'UTC')`.

### [tz/gemini-2.5-pro/F-005] P2 (S) — habit_journal noon ET anchor shifts local dates in distant timezones
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql:206`  | dimensions: Robustness
- desc: When deriving `onyx_local_date` for a habit tap, the trigger anchors at noon ET of the `cycle_date` and converts to the local TZ. For timezones far from ET (like Tokyo +13h), noon ET falls into the next calendar day locally, shifting `onyx_local_date` forward by a day.
- evidence: noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'America/New_York'; NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
- rec: Date-only sources cannot reliably project local dates across the dateline. Consider adding a `TIMESTAMPTZ` column to `habit_journal` to capture the exact tap instant.

### [tz/deepseek-v4-pro/F-005] P2 (S) — Whoop journal behavioral_date double-assignment can hide a derivation mismatch
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql: set_onyx_dates_whoop_journal`  | dimensions: Correctness
- desc: The trigger sets NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, d.onyx_behavioral_date). Both values are computed from the same cycle offset, so they will always be identical. This coalesce gives a false sense of alternative source; if behaviors_date later diverges due to a logic change, it could silently replace the derived value without audit.
- evidence: Lines: SELECT (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval - INTERVAL '6 hours'))::date INTO NEW.behaviors_date … ; later NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, d.onyx_behavioral_date).
- rec: Since behaviors_date is always set in the same function, remove the COALESCE and assign directly from behaviors_date, or keep it but add a check/warning if they ever differ (impossible currently). This cleans up the intent.

### [tz/deepseek-v4-pro/F-006] P2 (S) — Same-offset GPS proposals may still insert ‘noise’ entries when IANA name differs but offset is identical
- file_ref: `gps_tz_backfill.py: same-offset filter uses offset equality at the instant`  | dimensions: Robustness
- desc: The script skips proposals when inferred TZ yields the same UTC offset as the logged TZ at the activity instant. However, if the logged TZ is a generic ‘America/New_York’ and the inferred TZ is ‘America/Toronto’, the offset will be equal, so the proposal is skipped. This is correct for now, but if a manual entry later changes the logged TZ to ‘America/Toronto’ (same offset), the same-offset check could inadvertently prevent a needed entry on a trip where the IANA name matters (though for behavioral attribution it doesn’t). No immediate harm.
- evidence: Code: off_inf = ts_aware.astimezone(ZoneInfo(inferred)).utcoffset(); off_log = ts_aware.astimezone(ZoneInfo(log_says)).utcoffset(); if off_inf == off_log: continue.
- rec: No fix needed; current behaviour avoids clutter. For full compliance, you could allow the proposal but mark it as soft. The current same-offset filter is intentional and documented.

### [tz/deepseek-v4-pro/F-007] P2 (S) — User_tz_log_et provenance label not recognized elsewhere
- file_ref: `sql/adr_0001_04_other_onyx_dates.sql: habit_journal and whoop_journal fallback`  | dimensions: Consistency
- desc: When the log_tz is 'America/New_York', the triggers set onyx_tz_source = 'user_tz_log_et'. This is a new provenance value not listed in ADR-0001's D6 enum (which only lists source_field, cycle_anchor, user_tz_log, gps_inferred, default_et_fallback). Dashboards filtering on 'user_tz_log' would miss these rows.
- evidence: NEW.onyx_tz_source := 'user_tz_log_et'; in both habit_journal and whoop_journal ELSE IF branches.
- rec: Either update the ADR to include this value, or map it to 'user_tz_log' with a note that the TZ is explicitly ET (the log confirmed it). The latter is simpler and keeps the enum closed.

### [tz/deepseek-v4-pro/F-009] P2 (S) — Transition day flag trigger may miss update of next cycle on a DST-shift insert
- file_ref: `sql/adr_0001_05_transition_day_flag.sql: refresh_next_transition_day trigger`  | dimensions: Correctness
- desc: The AFTER trigger refreshes the immediately following cycle’s transition flag. If a cycle is inserted that straddles a DST transition and its offset differs from both the preceding and following cycles, the next cycle’s flag will be updated. However, if the insert causes a chain where the next cycle’s flag changes, the propagation stops there (pg_trigger_depth check). If the next after that also should change, it won’t. In practice, cycles are chronological, so the true cascade is one hop; but if out-of-order inserts occur repeatedly, it could leave stale flags.
- evidence: Trigger uses pg_trigger_depth() > 1 to stop recursion. The update to the next cycle fires its BEFORE trigger, which recalculates its own flag based on preceding cycle (the newly inserted one). That’s correct. If the flag of that next cycle changes and it has a next cycle that was previously a transition, it would not be updated because the AFTER trigger does not fire again (depth >1).
- rec: If backfill is complete and inserts are chronological, this is not a problem. For extra safety, run the window-function backfill after any batch of out-of-order inserts.

### [tz/gpt-5/F-007] P3 (S) — Potential performance hotspot: cycle lookup lacks explicit index hint
- file_ref: `sql/adr_0001_01_user_tz_log.sql:61`  | dimensions: Scalability
- desc: pds.cycle_offset_for_instant scans whoop_cycles by start_time and end_time predicates. No explicit index on start_time is created in this bundle; at scale, repeated calls from triggers could degrade.
- evidence: WHERE ts >= start_time AND ts < end_time OR abs(start_time - ts) <= 6h without a declared index in this migration set.
- rec: Ensure a BTREE index exists on whoop_cycles(start_time) (and possibly (start_time,end_time)) to support this lookup pattern.

### [tz/gpt-5/F-008] P3 (S) — gps_tz_backfill RPC return handling may be fragile
- file_ref: `gps_tz_backfill.py:64`  | dimensions: Robustness,Idiomaticness
- desc: tz_for_instant_via_pg returns res.data directly; supabase-py RPC responses can vary (scalar vs list). A mismatch could default to ET silently.
- evidence: return res.data or 'America/New_York' without type normalization.
- rec: Normalize RPC results (expect a scalar TEXT, or handle single-row list) and raise on unexpected shapes to avoid silent ET fallbacks.

### [tz/deepseek-v4-pro/F-008] P3 (S) — interval_to_tzd may round sub-minute offsets up, but Postgres intervals from wall-clock subtraction are already minute-aligned
- file_ref: `sql/adr_0001_03_garmin_onyx_dates.sql: interval_to_tzd function`  | dimensions: Robustness
- desc: The function uses ROUND(EXTRACT(EPOCH FROM diff)::numeric / 60.0)::int to avoid truncation. This is defensive, but Garmin’s start_time_local and start_time_gmt are timestamptz values with second precision, so the difference is already an integer number of seconds, and division by 60 yields an integer. Rounding is harmless but unnecessary and could mask a real sub-minute offset that shouldn’t exist.
- evidence: total_min := ROUND(EXTRACT(EPOCH FROM diff)::numeric / 60.0)::int;
- rec: Change to a simple FLOOR or ::int after ensuring the diff is an exact number of seconds; or keep the round but add a comment that it’s purely defensive.

### [tz/deepseek-v4-pro/F-010] P3 (S) — tz_log_gaps view uses ROUND on EPOCH which is redundant for standard offsets
- file_ref: `sql/adr_0001_06_tz_log_gaps_view.sql: offset-minute calculations`  | dimensions: Consistency
- desc: The view computes log_offset_minutes with ROUND(…::numeric / 60.0)::int, but the extracted epoch from a timestamptz difference is an integer number of seconds for any real IANA offset, so division by 60 yields an integer after rounding. It works but adds unnecessary complexity.
- evidence: Multiple lines like ROUND(EXTRACT(EPOCH FROM …)::numeric / 60.0)::int
- rec: Use EXTRACT(EPOCH …)::int / 60 directly, as done in the whoop_tz_backfill.py. This keeps the integer division safe and avoids potential confusion.

---
## BUNDLE: etl

### [etl/gpt-5/F-002] P1 (M) — Eight Sleep calendar_date hinges on static TZ env; mis-attribution on travel
- file_ref: `eight_sleep_etl.py:42; eight_sleep_etl.py:238`  | dimensions: Correctness
- desc: calendar_date is derived using EIGHTSLEEP_TIMEZONE at fetch time (and passed to the API). On travel days, if the env isn’t updated, rows can be written under the wrong day. Because no authoritative event timestamp is stored in pds.eight_sleep_trends, this error can’t be deterministically corrected downstream.
- evidence: Config comment warns about TZ; parse_interval sets calendar_date = dt_utc.astimezone(ZoneInfo(EIGHTSLEEP_TIMEZONE)).date(). Primary key is (calendar_date, bed_side), so wrong keys persist.
- rec: Persist an event instant (e.g., presenceStart/sleepStart) and derive onyx_et_date/behavioral_date in DB via ADR-0001. Alternatively, call pds.tz_for_instant per record to compute the correct day using the user_tz_log ladder. Backfill by recomputing calendar_date from that instant.

### [etl/gpt-5/F-005] P1 (S) — spotify_artists table missing in schema; enrichment fails on fresh deploy
- file_ref: `spotify_etl.py:640; schemas/spotify_schema.sql:1`  | dimensions: Correctness,Robustness
- desc: The ETL upserts to pds.spotify_artists and later updates it with MusicBrainz tags, but the provided schema bundle defines only spotify_plays and spotify_tracks. On a new environment this will 404 and degrade runs to partial/fail for enrichment.
- evidence: upsert_artists() writes to pds.spotify_artists and existing_artist_ids() queries it; schemas/spotify_schema.sql lacks a CREATE TABLE for spotify_artists.
- rec: Add a migration for pds.spotify_artists (artist_id PK; name; genres JSONB; popularity; followers; image_url; raw_json; fetched_at; synced_at) + RLS + indexes. Ensure CI applies it before ETL runs.

### [etl/gemini-2.5-pro/F-001] P1 (S) — Spotify ETL advances high-water mark past skipped plays
- file_ref: `spotify_etl.py:461`  | dimensions: Correctness
- desc: If a track fails to fetch, its corresponding play is filtered out of `safe_items` and skipped. However, the remaining `safe_items` are upserted, and the next run's high-water mark (`MAX(played_at)`) will advance past the skipped play's timestamp. The skipped play will never be retried and is permanently lost.
- evidence: In `spotify_etl.py`, `safe_items` excludes plays with missing tracks, but `upsert_plays(sb, safe_items)` still runs. The next run queries `MAX(played_at)` from the database, which will now be newer than the skipped play.
- rec: Do not advance the high-water mark past the first skipped play, or fail the entire batch if any track fails to fetch so the whole batch is retried on the next cron run.

### [etl/gemini-2.5-pro/F-002] P1 (M) — Backfill detector misses updates because synced_at is not updated
- file_ref: `hrv_backfill_check.py:53`  | dimensions: Correctness
- desc: `hrv_backfill_check.py` relies on `synced_at` to detect backfills for `garmin_daily_summary`, `eight_sleep_trends`, `myfitnesspal_nutrition`, and `whoop_journal`. However, these ETLs do not include `synced_at` in their upsert payloads. Consequently, `synced_at` is only set on `INSERT` (via `DEFAULT NOW()`) and is never updated on `UPDATE`. Backfills that modify existing rows will be completely missed by the detector.
- evidence: In `garmin_etl.py`, `eight_sleep_etl.py`, etc., the `row` dict passed to `upsert_to_supabase` does not contain `synced_at`. Postgres `ON CONFLICT DO UPDATE` only updates the columns provided in the payload.
- rec: Explicitly include `"synced_at": datetime.now(timezone.utc).isoformat()` in the upsert payloads for all ETLs, or add an `ON UPDATE` trigger to the `synced_at` columns in the database schema.

### [etl/gpt-5/F-001] P2 (S) — SpotifyClient._request issues a duplicate API call on success
- file_ref: `spotify_etl.py:215`  | dimensions: Robustness,Scalability,Idiomaticness
- desc: For non-401 responses, _request first performs a direct httpx request, then unconditionally wraps a second identical request in retry_http and returns that. This doubles all successful GETs (recently_played, track, artists), wasting rate budget and increasing 429 risk.
- evidence: spotify_etl.py: in SpotifyClient._request, resp = self.http.request(...); if 401 refresh; for all other statuses: return retry_http(lambda: self.http.request(...)). The first successful resp is discarded.
- rec: Refactor _request to call retry_http exactly once for non-401 paths. Pseudocode: try request via retry_http; if 401, refresh then retry once; otherwise return the first (single) successful response.

### [etl/gpt-5/F-003] P2 (S) — Eight Sleep ETL lacks retry/backoff for HTTP errors
- file_ref: `eight_sleep_etl.py:100-140`  | dimensions: Robustness
- desc: All Eight Sleep API calls use httpx directly with raise_for_status and no retry. Transient 5xx/429/network errors will drop pages or entire day windows and mark the run partial without retrying.
- evidence: authenticate/get_me/get_device/get_trends/get_intervals call self.http.* and resp.raise_for_status(); no retry_helper used.
- rec: Wrap all HTTP calls in retry_helper.retry_http with 3–5 attempts and honor Retry-After on 429. Optionally add per-chunk retry in the trends loop to avoid losing a 30-day window on a single transient.

### [etl/gpt-5/F-004] P2 (S) — Garmin activities/laps upsert conflicts include ts; risk duplicate rows
- file_ref: `garmin_etl.py:468; garmin_etl.py:512`  | dimensions: Correctness,Idiomaticness
- desc: Upserts use ON CONFLICT (activity_id, ts) for activities and (activity_id, lap_index, ts) for laps. The natural keys are activity_id and (activity_id, lap_index). If ts changes (clock corrections, library drift), duplicates could be created.
- evidence: sync_activities upserts with on_conflict='activity_id,ts'; _sync_laps_for_activity uses 'activity_id,lap_index,ts'.
- rec: Change conflict keys to activity_id and (activity_id, lap_index). Ensure corresponding unique indexes exist. Keep ts as a regular column if needed for ordering.

### [etl/gpt-5/F-006] P2 (S) — WHOOP client has no generic 5xx/network retry
- file_ref: `whoop_etl.py:111-148`  | dimensions: Robustness
- desc: WhoopClient._request handles 401 refresh and 429 waits, but 5xx and network errors are not retried. A transient 500 during pagination can drop a whole endpoint for the window.
- evidence: After refresh/429 handling, resp.raise_for_status() is called without retry; get_paginated relies on .get(), which will raise and be caught as an endpoint error.
- rec: Adopt retry_helper-style backoff for all WHOOP requests (wrap session.request in a retry loop for 5xx/RequestException). Keep the existing 401/429 special handling.

### [etl/gpt-5/F-008] P2 (S) — Materialized view refresh likely no-op due to sb.schema('pds').rpc
- file_ref: `garmin_etl.py:621; whoop_etl.py:362`  | dimensions: Robustness,Idiomaticness
- desc: supabase-py’s rpc is a top-level method; calling sb.schema('pds').rpc(...).execute() probably fails or is ignored (and is warned in logs). Views won’t refresh post-run.
- evidence: Garmin/WHOOP use sb.schema('pds').rpc('refresh_materialized_views').execute(); Eight Sleep correctly calls sb.rpc('refresh_materialized_views', {}).
- rec: Call sb.rpc('refresh_materialized_views', {}) consistently (no schema()), and handle errors once. Optionally gate by env var to skip in CI if the function isn’t deployed.

### [etl/gpt-5/F-009] P2 (S) — Spotify high-water mark equal-timestamp edge case may miss plays
- file_ref: `spotify_etl.py:469; spotify_etl.py:786`  | dimensions: Correctness
- desc: recently_played(after=ms) is strictly greater than the provided ms. If multiple plays share the exact max played_at and a prior run partially wrote them, the remainder won’t be refetched.
- evidence: get_high_water_mark returns max(played_at) ms; next fetch uses after_ms=hwm_ms; strict > filter can skip siblings at the same millisecond.
- rec: Subtract 1 ms from the high-water mark (after_ms = hwm_ms - 1) or persist a tie-breaker (last (played_at, track_id)) and request a slightly earlier window.

### [etl/gemini-2.5-pro/F-003] P2 (S) — WHOOP journal import lacks export_received_at guard
- file_ref: `whoop_journal_import.py:221`  | dimensions: Correctness
- desc: Unlike `myfitnesspal_import.py`, `whoop_journal_import.py` does not check an `export_received_at` timestamp before upserting. If an older export email is processed after a newer one (e.g., due to a previous transient failure or IMAP ordering), it will silently overwrite the newer data with stale answers for overlapping dates.
- evidence: `whoop_journal_email.py` calls `import_journal(csv_path)` without passing the email's `Date` header, and `import_journal` blindly upserts all rows.
- rec: Pass the email's `Date` header to `import_journal` and skip upserting dates where the existing row's `synced_at` is newer than the export's received time, matching the MFP implementation.

### [etl/gemini-2.5-pro/F-004] P2 (S) — Journal ETL fails entire sync on single embedding error
- file_ref: `journal_etl.py:276`  | dimensions: Robustness
- desc: If Voyage AI embedding fails for a single batch of pages, the script returns 2 and exits immediately. None of the pages processed so far (including those that didn't need embedding) are upserted to Supabase. This blocks the entire journal sync until the embedding API recovers.
- evidence: In `journal_etl.py`, `except httpx.HTTPStatusError as e:` logs the error and calls `return 2`, bypassing the `upsert` block at the end of the script.
- rec: Catch the embedding error, log it, and continue to upsert the pages that succeeded or didn't require embedding. The failed pages will naturally be retried next run since their `notion_edited_at` in the DB won't have been updated.

### [etl/gemini-2.5-pro/F-005] P2 (S) — Garmin ETL ignores nested RepeatGroupDTOs in workouts
- file_ref: `garmin_etl.py:388`  | dimensions: Scalability,Robustness
- desc: `parse_interval_targets` only checks one level deep for `RepeatGroupDTO`. Garmin workouts can have nested repeats (e.g., Repeat 2x (Repeat 3x (Run, Rest))). If `sub` is another `RepeatGroupDTO`, `_maybe_capture_segment` will ignore it because its `stepType` is not in `_PACED_STEP_KINDS`, resulting in missing segment targets for nested intervals.
- evidence: The loop `for sub in step.get("workoutSteps", []): _maybe_capture_segment(...)` does not recurse if `sub` is itself a `RepeatGroupDTO`.
- rec: Make the segment extraction recursive to handle arbitrarily nested `RepeatGroupDTO`s.

### [etl/gemini-2.5-pro/F-006] P2 (M) — Journal ETL stores expiring Notion image URLs
- file_ref: `journal_etl.py:128`  | dimensions: Correctness
- desc: When converting Notion blocks to markdown, `_block_to_md` extracts the `url` from image blocks. For images hosted by Notion (the `file` object), these are signed S3 URLs that expire after 1 hour. Storing them directly in `content_md` means the images will be broken when viewed later in the Onyx frontend.
- evidence: `url = (img.get("file") or img.get("external") or {}).get("url", "")` captures the ephemeral AWS S3 URL provided by the Notion API.
- rec: Download the images and upload them to Supabase Storage, replacing the URL in the markdown with the permanent Supabase URL, or have the frontend re-fetch the block dynamically.

### [etl/gemini-2.5-pro/F-007] P2 (S) — WHOOP body measurement sync creates 24 identical rows per day
- file_ref: `whoop_etl.py:343`  | dimensions: Scalability,Idiomaticness
- desc: `sync_body_measurement` uses `datetime.now(timezone.utc).isoformat()` as the `measured_at` primary key for every upsert. Since the ETL runs hourly, this creates 24 new rows per day containing the exact same height, weight, and max HR data, bloating the table unnecessarily.
- evidence: The `row` dict sets `"measured_at": datetime.now(timezone.utc).isoformat()`, ensuring it never conflicts with an existing row during the `upsert_to_supabase` call.
- rec: Use the current calendar date as the primary key (or truncate `NOW()` to the day), or query the latest row and only insert a new one if the values have actually changed.

### [etl/deepseek-v4-pro/F-001] P2 (S) — Missing sync_log heartbeat on fatal exceptions in most ETLs
- file_ref: `garmin_etl.py:761 (end of file); eight_sleep_etl.py:561; spotify_etl.py:502; journal_etl.py:332`  | dimensions: Robustness
- desc: If an unhandled exception occurs in main() (e.g., import error, network failure after retries are exhausted), the script exits without writing a sync_log row. The status page then sees no heartbeat and reports staleness, even though the workflow run failed visibly. WHOOP ETL is the only one with a top-level try/except that writes a failure heartbeat.
- evidence: In garmin_etl.py, the entry point is `if __name__ == '__main__': main()` with no surrounding try/except. An uncaught exception propagates to the runner and no sync_log insert occurs. Contrast with whoop_etl.py lines 442-458 where a similar guard is present.
- rec: Add a `try: main() except Exception: log_failure_sync_log()` wrapper in every ETL's `__name__ == '__main__'` block. Use the shared sync_log_helper or a minimal inline insert.

### [etl/deepseek-v4-pro/F-005] P2 (M) — Cronometer serving import race condition if run concurrently
- file_ref: `cronometer_import.py:334-337 (delete-by-date + insert)`  | dimensions: Correctness
- desc: The import for servings deletes all rows for the affected dates and then inserts fresh data. If two instances of the importer run at the same time (e.g., manual watcher and a cron job), they could interleave: Run A deletes date X's rows, Run B deletes date X's rows (no-op), then both insert, leading to duplicate rows because the PK is SERIAL and not unique on natural keys. This is unlikely but possible for a user who triggers import while the watcher is active.
- evidence: `sb.schema('pds').table('cronometer_servings').delete().in_('calendar_date', chunk).execute()` followed by batch insert. The primary key serving_id is BIGSERIAL, so concurrent inserts will create new IDs with overlapping (calendar_date, food_name, amount_raw) data.
- rec: Wrap the delete+insert in a transaction using supabase-py's DB functions, or change deletion to use `on_conflict` upsert with a natural key (e.g., calendar_date, food_name, amount_raw, event_time).

### [etl/deepseek-v4-pro/F-007] P2 (M) — Lack of HTTP retry with backoff in Garmin, WHOOP, Eight Sleep ETLs
- file_ref: `garmin_etl.py:75-92 (login retries only), whoop_etl.py:123-142 (manual 429 sleep, no 5xx retry), eight_sleep_etl.py:106-141 (no explicit retry)`  | dimensions: Robustness
- desc: Transient 5xx errors or network timeouts from Garmin, WHOOP, or Eight Sleep APIs will cause the ETL to fail immediately without retry. Some libraries may have internal retries, but the WHOOP client only retries on 401 (token refresh) and 429 (rate limit), not on 500/502/503. This can cause avoidable sync failures.
- evidence: In WhoopClient._request, a 429 triggers a sleep-then-retry, but 500-599 are not handled; they raise HTTPError. Garmin's get_garmin_client has a login retry loop but all other API calls via the garminconnect library may not retry. Eight Sleep's EightSleepClient uses httpx directly without retry decorators.
- rec: Wrap all API calls with the shared retry_helper.retry_http, or add similar exponential backoff logic for 5xx and network errors in each ETL's client.

### [etl/deepseek-v4-pro/F-010] P2 (S) — WHOOP body measurement uses write time instead of API timestamp
- file_ref: `whoop_etl.py:397 (sync_body_measurement)`  | dimensions: Correctness
- desc: The sync_body_measurement function sets measured_at to datetime.now(timezone.utc) instead of using a timestamp from the WHOOP API response. If the measurement was taken hours or days ago (e.g., during a backfill), this stores an incorrect timestamp, potentially misaligning the weight/height record with the true measurement date.
- evidence: `row = { 'measured_at': datetime.now(timezone.utc).isoformat(), ... }` — no attempt to extract a field like `bm.get('updated_at')` or `bm.get('created_at')`.
- rec: Check the API response for a timestamp field (e.g., 'updated_at', 'created_at') and use it if available. Fall back to now() only if absent.

### [etl/gpt-5/F-007] P3 (S) — Cronometer watcher/import emits no heartbeat on no-op runs
- file_ref: `cronometer_watcher.py:66-112`  | dimensions: Robustness,Idiomaticness
- desc: When the inbox is empty, the watcher returns 0 and logs locally but never writes pds.sync_log. This diverges from other ETLs (IMAP, Spotify) that emit 0-record heartbeats, reducing /status visibility for the Cronometer path.
- evidence: process_inbox returns 0 without using sync_log_helper; only cronometer_import logs on actual parsed rows.
- rec: On each poll with no files, write a sync_log heartbeat (source='cronometer', data_type='watcher', status='success', records=0).

### [etl/gpt-5/F-010] P3 (S) — Upsert-counts rely on PostgREST returning representation
- file_ref: `cronometer_import.py:174-207; myfitnesspal_import.py:233-262`  | dimensions: Idiomaticness,Robustness
- desc: Inserted/updated row counts are computed as len(result.data). If the backend or client defaults change (e.g., returning=minimal), counts log as 0 even on success.
- evidence: import_servings/import_daily and MFP importer derive counts from result.data without enforcing Prefer: return=representation.
- rec: Explicitly set return=representation via supabase-py (if supported), or compute counts from input batch length and response status. Alternatively, follow with a cheap count(*) range check when needed for /status.

### [etl/gemini-2.5-pro/F-008] P3 (S) — Local folder watchers loop infinitely on malformed files
- file_ref: `whoop_journal_watcher.py:72`  | dimensions: Robustness
- desc: If `import_journal` or `run_import` raises an exception (e.g., due to a malformed CSV), the file is left in the inbox. The watcher scripts poll every 10 seconds and will repeatedly try to import the same broken file forever, spamming the logs.
- evidence: In `whoop_journal_watcher.py` and `cronometer_watcher.py`, the `except Exception:` block logs the error and returns, bypassing the `archive_file` step. The file remains in `INBOX` for the next poll.
- rec: Move files that fail to import to an `error/` directory, or implement a retry limit/backoff.

### [etl/deepseek-v4-pro/F-002] P3 (S) — Garmin standalone modes (--backfill-laps, --sync-workouts) do not write sync_log entries
- file_ref: `garmin_etl.py:650-668 (backfill-laps block), 671-690 (sync-workouts block)`  | dimensions: Robustness
- desc: When invoked with --backfill-laps or --sync-workouts, the script performs database writes but never calls log_sync(). This means the /status page won't reflect that lap backfill or workout sync ran successfully.
- evidence: In the conditional block for `args.backfill_laps`, the code calls `backfill_laps()`, prints a summary, and returns without any sync_log insert. Same for `args.sync_workouts`.
- rec: Add a log_sync() call at the end of each standalone mode, using appropriate source/data_type (e.g., 'garmin'/'lap_backfill').

### [etl/deepseek-v4-pro/F-003] P3 (S) — Spotify --refresh-genres mode lacks sync_log entry
- file_ref: `spotify_etl.py:502-512 (run_refresh_genres function)`  | dimensions: Robustness
- desc: The --refresh-genres command performs MusicBrainz updates but does not write any sync_log row. The main Spotify ETL flow writes heartbeats for plays, tracks, reccobeats, and musicbrainz; this auxiliary path is invisible to /status.
- evidence: run_refresh_genres() prints log lines but does not call log_sync_entry().
- rec: Call log_sync_entry(sb, source='musicbrainz', data_type='genre_refresh', status='success', ...) before returning.

### [etl/deepseek-v4-pro/F-004] P3 (M) — Inconsistent use of sync_log_helper across ETLs
- file_ref: `garmin_etl.py:142, whoop_etl.py:168, eight_sleep_etl.py:182, spotify_etl.py:306`  | dimensions: Idiomaticness
- desc: Some ETLs define their own log_sync() functions (copy-pasted) instead of importing sync_log_helper. This risks future drift (e.g., forgetting to populate sync_end). Currently all bespoke versions are correct, but consolidation would reduce maintenance.
- evidence: garmin_etl.py defines its own `log_sync` (lines 142-163), whoop_etl.py has another (lines 168-190), eight_sleep_etl.py another (lines 182-206). spotify_etl.py uses the shared helper via log_sync_entry but still has a thin wrapper.
- rec: Replace all bespoke log_sync functions with imports of sync_log_helper.log_sync. Ensure every call passes started_at.

### [etl/deepseek-v4-pro/F-006] P3 (L) — Eight Sleep TZ binding may mis-attribute travel days
- file_ref: `eight_sleep_etl.py:30-41 (EIGHTSLEEP_TIMEZONE env var)`  | dimensions: Correctness
- desc: The ETL uses a constant timezone for all date attribution, both in API queries and interval timestamp conversion. When Riley travels, non-ET sleeps may be attributed to the wrong calendar_date in the upsert row. The downstream ADR-0001 trigger on `start_time` corrects behavioral attributions for joins, but the raw `calendar_date` field remains wrong and could mislead direct queries. This is a known limitation documented in comments.
- evidence: `EIGHTSLEEP_TIMEZONE = os.environ.get('EIGHTSLEEP_TIMEZONE', 'America/New_York')` is used in both trend fetch params and interval conversion. Travel days will store the home TZ date, not the actual local date.
- rec: Consider calling the pds.tz_for_instant function for each fetch date to dynamically resolve the timezone, or derive calendar_date from the interval timestamps after localization via the user_tz_log ladder.

### [etl/deepseek-v4-pro/F-008] P3 (S) — MFP import ordering guard depends on potentially inaccurate email Date header
- file_ref: `myfitnesspal_email.py:128-131 (email_received_at parsing), myfitnesspal_import.py:219-235 (ordering check)`  | dimensions: Robustness
- desc: The guard that prevents an older export from overwriting a newer one uses the email's Date header as the received-at time. If the email was delayed (e.g., MFP sends export email but it sits in a queue), the Date header may be hours old, causing the guard to reject the export even if it is the newest data.
- evidence: `email_received_at = parsedate_to_datetime(raw_date)` is used to compare against synced_at of existing rows. An old Date header could make the guard think the export is stale.
- rec: Use the IMAP internaldate (msg.get('date') is often the MDN date) or the time the email was fetched. IMAP FETCH provides an INTERNALDATE field.

### [etl/deepseek-v4-pro/F-009] P3 (S) — WHOOP journal email subject matching fragility
- file_ref: `whoop_journal_email.py:99-102 (find_whoop_emails), 103-110 (fallback subject check)`  | dimensions: Robustness
- desc: The email search relies on a fallback FROM filter and a subject keyword check. If WHOOP changes the subject (e.g., 'Your WHOOP Data Export is Ready' vs current 'Your WHOOP Export is Ready'), the subject filter may fail, but the FROM filter catches it. However, if the email is forwarded from a personal inbox, the FROM may be masked, leaving only subject matching. The code already includes a diagnostic warning if FROM-unseen emails don't match subject, which is good, but the subject match itself is brittle.
- evidence: `find_whoop_emails` uses `'(UNSEEN SUBJECT "WHOOP Export")'` and checks for `'whoop' in s_lower and 'export' in s_lower`. A minor wording change could break both.
- rec: Broaden the subject check to `'whoop' in s_lower and ('export' in s_lower or 'data' in s_lower)`. Monitor the diagnostic warning to adjust if needed.
