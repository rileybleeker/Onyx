# Stats Re-Audit Confirmation Classification — 2026-05-27 (b54c99f)

Bundle commit: `b54c99f` (HEAD). Reviewers: gpt-5, gemini-3.1-pro-preview, deepseek-v4-pro. Total findings: 20.

Bundle files identical to current code (verified via `cmp` on hrv_analysis.py / causal_inference.py / hrv_predict.py).

## Per-finding classification

### gpt-5 (8 findings)

| ID  | Sev | Title                                                          | Classification    | Note |
|-----|-----|----------------------------------------------------------------|-------------------|------|
| F-001 | P1 | Nutrition Spearman uses non-existent column names              | new-in-touched    | NUTRITION_COLS keys `mfp_exercise_kcal` / `mfp_water_ml` don't match build_feature_matrix output (`exercise_kcal` / `water_ml`). Not from prior re-audit; pre-existing in touched file. |
| F-002 | P2 | SHAP-stability check fails silently — missing StandardScaler import | new-in-touched    | **BUG IN SHIPPED FIX**: 93a7323 added the condition-number warning but referenced StandardScaler without importing it. NameError swallowed by broad except, so feature_condition_number stays NaN and shap_unstable=False even with severe collinearity. |
| F-003 | P1 | Journal/habit pivot assumes string answers; schema is BOOLEAN  | new-in-touched    | pivot_journal/pivot_habits use `.str.lower().isin([...])` on what schema says is BOOLEAN. Pre-existing; not in prior re-audit. |
| F-004 | P2 | Causal confounder ffill not surfaced beyond counts             | new-in-touched    | Refinement of fb1ecf6: counts surfaced in dropped_low_n, but reviewer wants per-treatment confounder list + 'confounder_loss_driven' flag. Existing warning + counts acknowledged. |
| F-005 | P2 | Stage-3 OLS HAC SEs on gappy rows approximate daily lags        | same-as-before    | **DEFERRAL** per d260da9 commit msg ("Stage 3 OLS HAC… keep the dropna and pass use_correction=True… Comment explicitly documents the limitation"). Reviewer disagrees with deferral. |
| F-006 | P2 | AIPW FDR uses IF-based SE p-values even when block CI is wider | new-in-touched    | New critique of 2203b2e: BH-FDR uses Wald(ate/se_if) but BB CI is wider under autocorrelation; reviewer suggests gating FDR inclusion on bb_width_ratio. |
| F-007 | P3 | Nutrition family meal-timing treatments missing alcohol/caffeine confounders | new-in-touched | SUPPLEMENT_EXTRA_CONFOUNDERS only added for family=='supplement'; meal timing should arguably get them too. |
| F-008 | P2 | Prophet backtest uses flat ffilled regressors in holdout       | new-in-touched    | Critique of fa68c24's design choice: naive ffill (the chosen fix) → reviewer prefers rolling-origin. Tradeoff was deliberate. |

### gemini-3.1-pro-preview (filename `gemini-2.5-pro`, 6 findings)

| ID  | Sev | Title                                                          | Classification    | Note |
|-----|-----|----------------------------------------------------------------|-------------------|------|
| F-001 | P0 | Target shift(-1) causes 1-day misalignment with behavioral spine | **DISPUTED**     | Reviewer argues ADR-0001 puts behaviors + tonight's HRV on the same row, so shift(-1) predicts 2 nights ahead. **Contradicts** CONTEXT.md ("predicts HRV(N+1) from behaviors(N)") and the test_phase2_alignment.py regression test. **Highest-stakes claim; needs matrix view + regression test inspection.** |
| F-002 | P1 | PI calibration leaks future variance via full-dataset OOF residuals | same-as-before | **DEFERRAL**: exactly prior gemini-stats-F-005 (deferred per EC-3). pred_std_by_horizon still computed once on X_h_full. |
| F-003 | P1 | SARIMAX full-data forecast crashes due to DatetimeIndex mismatch | **DISPUTED**     | `fut_exog_all = exog.iloc[-7:]` retains historical index. Claim is that statsmodels alignment will raise ValueError on get_forecast. d260da9/1d9a4eb didn't strip the index for the full-data path. **Needs a quick runtime check or close read of the full-data forecast call.** |
| F-004 | P2 | Block bootstrap for AIPW CI breaks autocorr by resampling compressed psi | same-as-before | **PARTIAL FIX**: 93a7323 addressed within-fold NaN handling, but psi is built on rows AFTER `_prepare_treatment.dropna(subset=[T, Y])` upstream — so 7-day blocks still span non-adjacent calendar days. Fix's stated contract ("calendar-contiguous order, NaN where missing") isn't actually met. |
| F-005 | P2 | SARIMAX ADF test silently fails due to NaNs in differenced series | new-in-touched   | **BUG IN SHIPPED FIX**: d260da9's asfreq('D') introduces NaN for missing HRV days. `adfuller(np.diff(train_endog.values), …)` propagates NaN → exception swallowed by outer try/except → stationarity diagnostic silently lost. |
| F-006 | P3 | Categorical training_status / training_load_balance silently dropped | new-in-touched | May-21 audit promoted garmin_hrv_status_ord + garmin_training_readiness_level_ord but training_status/training_load_balance still in explicit drop list. |

### deepseek-v4-pro (6 findings)

| ID  | Sev | Title                                                          | Classification    | Note |
|-----|-----|----------------------------------------------------------------|-------------------|------|
| F-001 | P1 | Granger causality test on possibly non-stationary series        | new-in-touched    | hrv_analysis.py:~1939 calls grangercausalitytests on raw levels; ADF is run for SARIMAX but not reused for Granger pairs. 98792f1 (Holm-per-feature) touched Granger but not stationarity. |
| F-002 | P1 | AIPW significance relies on IF-based CI; BB CI not used         | new-in-touched    | Duplicate angle on gpt-5 F-006. _significance_flags uses aipw['ci_low']/['ci_high'] (IF), not bb. |
| F-003 | P2 | Wald p-values for causal BH-FDR assume asymptotic normality with small n | new-in-touched | Critique of 2203b2e: for treatments with n_total<30, normal approximation may be inaccurate; suggests bootstrap p-values or permutation test. |
| F-004 | P2 | SARIMAX walk-forward assumes exog repeats last known values     | new-in-touched    | Critique of fa68c24's design choice; same family as gpt-5 F-008. Documented design choice, but reviewer wants AR or historical-mean of exog. |
| F-005 | P3 | XGBoost hyperparameters reused for all forecast horizons        | same-as-before    | **DEFERRAL** per CONTEXT.md ("Per-horizon Optuna tuning. Deliberate cost/benefit decision."). |
| F-006 | P3 | Supplement tracking window fill may miscode missing intake data | new-in-untouched  | fillna(0) inside the tracking window could be wrong on sync-gap days. Code path not touched in recent fixes. |

## Summary table — Reviewer × Classification × Severity

```
Reviewer            | same-as-before | new-in-touched | new-in-untouched | disputed | total
                    | P0 P1 P2 P3    | P0 P1 P2 P3    | P0 P1 P2 P3      | P0 P1 P2 P3 |
gpt-5               |  0  0  1  0    |  0  2  4  1    |  0  0  0  0      |  0  0  0  0 |  8
gemini-3.1-pro-prev |  0  1  1  0    |  0  0  1  1    |  0  0  0  0      |  1  1  0  0 |  6
deepseek-v4-pro     |  0  0  0  1    |  0  2  2  0    |  0  0  0  1      |  0  0  0  0 |  6
TOTAL               |  0  1  2  1    |  0  4  7  2    |  0  0  0  1      |  1  1  0  0 | 20
```

By classification: same-as-before=4, new-in-touched=13, new-in-untouched=1, disputed=2.
By severity: P0=1, P1=6, P2=9, P3=4.

## Same-as-before — regression check on shipped fixes

4 same-as-before findings; **3 are explicit pre-documented deferrals, 1 is a partial-fix issue**:

| Finding | Status | Action needed |
|---|---|---|
| gpt-5 F-005 (P2) — OLS HAC gappy rows | DEFERRED per d260da9 comment | None — reviewer disagrees with deferral; original ticket accepted the compromise |
| gemini F-002 (P1) — PI calib full-matrix pred_std | DEFERRED per EC-3 | None — same as prior gemini-stats-F-005; deferral stands |
| gemini F-004 (P2) — BB CI psi compression | **PARTIAL FIX** | Re-examine: 93a7323's contract ("callers pass FULL psi calendar-contiguous") not actually met because `_prepare_treatment` upstream drops non-treated/non-outcome rows. The autocorrelation-preservation goal isn't achieved on compressed psi. |
| deepseek F-005 (P3) — XGBoost per-horizon Optuna | DEFERRED per CONTEXT.md | None — documented deliberate cost/benefit decision |

**Audit chapter cannot close cleanly** — gemini F-004 represents a partial fix where the shipped 93a7323 didn't achieve the stated autocorrelation-preservation contract on compressed psi.

## Disputed claims worth DB / runtime verification

| Finding | Severity | Why disputed |
|---|---|---|
| gemini F-001 — Target shift(-1) misalignment | **P0** | Contradicts CONTEXT.md + test_phase2_alignment.py regression test. If reviewer is right, every model + causal estimate currently predicts 2 nights ahead instead of 1. Highest-stakes claim of the cycle. Needs: matrix view definition for whoop_hrv_rmssd attribution + inspection of test_phase2_alignment.py. |
| gemini F-003 — SARIMAX index mismatch | P1 | Claim is concrete: `fut_exog_all = exog.iloc[-7:]` retains historical DatetimeIndex; statsmodels `get_forecast(steps=7, exog=fut_exog_all)` will fail alignment. d260da9/1d9a4eb didn't strip the index. Needs: read the actual line + try the call. |

## Bugs effectively introduced by overnight fixes

These are classified new-in-touched (per the prior CLASSIFY convention) but worth surfacing because they represent silent failures in code the overnight cycle shipped:

| Bug | Shipped in | Failure mode |
|---|---|---|
| gpt-5 F-002 — SHAP-stability NameError | 93a7323 | feature_condition_number stays NaN; shap_unstable always False — the diagnostic is dead. |
| gemini F-005 — ADF NaN crash | d260da9 (asfreq) | adfuller raises on NaN-bearing diff; outer except logs but stationarity diagnostic silently lost. |
