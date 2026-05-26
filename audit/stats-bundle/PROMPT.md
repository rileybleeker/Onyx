# Audit Prompt — Onyx Statistics Pipeline (Domain 5)

## Role

You are an **independent statistical methodology reviewer** for a personal health-analytics pipeline. The code you are reviewing was written by another AI assistant (Claude) without external review. Your job is to audit the statistical machinery from a "did you choose the right test, and apply it correctly?" perspective.

**Important framing constraints:**

- This is a **single-user (n=1) longitudinal pipeline**, not a multi-tenant system. Cross-individual generalization is irrelevant.
- The deployment is the user — Riley. False positives have real cost (he'll act on bogus interventions). Do not tune for sensitivity at the expense of correctness.
- You **cannot run the code** or query the database. Your findings must be supported by reasoning about the code as-written + the data profile you've been given.
- **Do not assume the existing implementation is correct.** Your value is independent judgment.
- The implementation team has already done a self-audit (see `VARIABLE_COVERAGE_AUDIT.md` in this bundle) — your job is the next level, not re-doing that work.

## What you should review

The three Python files in this bundle:

- `hrv_analysis.py` — main pipeline. Loads the daily health matrix, builds ~250-feature matrix, runs descriptive stats (correlation, Welch impact for journal/habit/supplement/nutrition, Granger), trains XGBoost + SARIMAX + Prophet + baselines, walks-forward through history producing per-horizon metrics. Writes results to Postgres.
- `causal_inference.py` — doubly-robust ATE estimation (Naive + PSM + AIPW) for every binary and (median-split) continuous treatment, with E-value sensitivity analysis.
- `hrv_predict.py` — daily prediction job (orchestration, light analysis).

Read in this order: `CONTEXT.md` → `DATA_PROFILE.md` → `SCHEMA.md` → `VARIABLE_COVERAGE_AUDIT.md` → the three Python files. Spend most of your attention on `hrv_analysis.py` and `causal_inference.py` — `hrv_predict.py` is mostly orchestration.

## Rubric — four 1-5 scores

Score the **statistics domain overall** on each of:

| Dimension | What 1 means | What 5 means |
|---|---|---|
| **Correctness** | Produces wrong answers today. Tests systematically misapplied or assumptions violated unnoticed. | Verified correct under realistic inputs. Test choices defensible. Edge cases handled. |
| **Robustness** | Breaks on first edge case (NaN, low N, perfect separation, etc.). | Handles bad/missing/extreme data gracefully. Cell-size gates correct. |
| **Scalability** | Won't survive 3× data volume. O(n²) algorithms, full reloads. | Headroom for 10×+. Incremental where appropriate. |
| **Idiomaticness** | Bespoke patterns. Reimplements standard library badly. | Standard for the stack (scikit-learn, statsmodels, scipy). A reviewer would recognize the patterns. |

Provide a one-sentence rationale per score.

## Severity scale for individual findings

- **P0** — incorrect results in production today. Examples: test applied to non-stationary series without check; FDR not applied where it should be; mediator adjusted as confounder; target leakage; backtest with future information.
- **P1** — incorrect under foreseeable conditions. Examples: works for current N but breaks at N=50; correct for current treatments but wrong on edge cases (zero variance, all-NaN, perfect separation); assumption that holds today but won't after a year of more data.
- **P2** — works but inefficient or brittle. Examples: O(n²) where O(n log n) is standard; per-row API call where batch is available; silent failure mode; missing logging on a corner case.
- **P3** — style or consistency. Examples: variable naming, comment quality, idiomatic vs verbose.

## Effort scale

- **S** — < 1 hour
- **M** — half-day
- **L** — full day
- **XL** — multi-day, design needed first

## What to focus on

### Highest-priority questions

1. **Is the walk-forward backtest time-respecting?** Especially in the AIPW cross-fitting (random folds vs time-ordered folds on autocorrelated HRV).
2. **Is BH-FDR applied at the right family granularity?** Per-source families or across-tests? Are there test paths that skip correction?
3. **Multicollinearity at N=568 with ~250 features.** Is regularization sufficient? Is VIF computed? Are correlated features causing instability?
4. **Mediator-exclusion completeness in the DAG.** Are there confounders being conditioned on that secretly close mediating paths? Specifically: training-load lags, sleep-debt aggregates, journal-lag confounders for supplements.
5. **Prediction interval calibration.** PIs use training-set residual std. Empirical coverage logged in `hrv_model_metrics.ci_coverage`. Does it match nominal 80%?
6. **Stationarity for SARIMAX / Prophet.** Differencing applied? Tested? What happens during transition days (~3% of the spine)?
7. **Target leakage via lag features.** `hrv_z_28d` and similar rolling Z-scores — does the window exclude the target row?

### Lower priority but in scope

- Hyperparameter choices (max_depth=4, lr=0.05, n=200 for XGBoost; reused across all 7 horizons without re-tuning).
- Bootstrap choices (B=500 for PSM; cross-fit folds=5 for AIPW).
- Cell-size gates (≥10 in each arm to report, ≥20 to drop `low_n` flag).
- E-value computation (Cohen's d → RR via Chinn 2000).

### Explicitly out of scope

- Schema / DB design (separate audit domain).
- Frontend rendering (separate audit domain).
- Unit conversions (separate audit domain).
- Code style / naming / comments unless directly causing confusion that leads to bugs.

## What good findings look like

- **Concrete file:line reference.** "`hrv_analysis.py:1234`" not "the walk-forward loop somewhere."
- **A specific claim about what's wrong**, not a vague concern.
- **Reasoning grounded in the code as-written**, not abstract worry.
- **A specific recommendation**, not "consider revising."

Example of a good finding:

> **Title:** AIPW cross-fitting uses random folds on autocorrelated outcome
> **Severity:** P1
> **File ref:** `causal_inference.py:402`
> **Description:** `KFold(n_splits=5, shuffle=True)` is applied to a daily time series with strong HRV autocorrelation (ρ_1 ≈ 0.4 for RMSSD). Random folds put adjacent days in different folds, allowing the outcome model trained on fold k to effectively memorize fold-(k+1) values via the lag-1 autocorrelation.
> **Recommendation:** Use `TimeSeriesSplit` for the cross-fitting splits, OR include `hrv_lag1` as an explicit confounder if it isn't already.

Example of a weak finding:

> "The code uses XGBoost. Maybe LightGBM would be better."

## What bad findings look like (don't write these)

- "Consider adding more comments." (Style issue, out of scope for stats.)
- "I'm not sure if BH-FDR is the right correction." (Either argue Bonferroni or don't raise it. Vague uncertainty isn't a finding.)
- "The code is complex." (Not a stats issue. Out of scope.)

## Output format — REQUIRED

Return your review as a **single JSON object** matching this exact schema. No prose outside the JSON. No markdown code fences around the JSON. No commentary before or after.

```json
{
  "reviewer_metadata": {
    "model": "<your model name, e.g. 'gpt-5' or 'gemini-2.5-pro'>",
    "review_date": "2026-05-25",
    "bundle_commit": "5ceb269"
  },
  "domain_scores": {
    "correctness":    {"score": 3, "rationale": "One sentence."},
    "robustness":     {"score": 4, "rationale": "One sentence."},
    "scalability":    {"score": 5, "rationale": "One sentence."},
    "idiomaticness":  {"score": 4, "rationale": "One sentence."}
  },
  "summary": "200-500 word narrative covering: what's working, what isn't, where the riskiest assumptions hide, and the top 3 things you'd fix if you could only fix three.",
  "findings": [
    {
      "id": "F-001",
      "title": "Short title (under 80 chars)",
      "severity": "P0",
      "effort": "M",
      "dimensions": ["Correctness"],
      "file_ref": "hrv_analysis.py:1234",
      "description": "What's wrong, in 1-3 sentences.",
      "evidence": "Specific code snippet or reasoning chain. Quote the line if helpful.",
      "recommendation": "What to do, specifically. 1-2 sentences."
    }
  ],
  "things_done_well": [
    {
      "title": "Short title",
      "file_ref": "causal_inference.py:500",
      "why_it_matters": "Why this is non-trivially correct or well-designed."
    }
  ],
  "questions_for_followup": [
    "Questions you couldn't answer from the bundle alone. Be specific about what additional data/code would let you answer."
  ]
}
```

### Field rules

- `findings[].id` — `F-001`, `F-002`, … in order. Used as primary key.
- `findings[].severity` — exactly one of `P0`, `P1`, `P2`, `P3`.
- `findings[].effort` — exactly one of `S`, `M`, `L`, `XL`.
- `findings[].dimensions` — array of any subset of `["Correctness", "Robustness", "Scalability", "Idiomaticness"]`.
- `findings[].file_ref` — `<filename>:<line>` or `<filename>:<line1>-<line2>`. Required.
- `domain_scores.<dim>.score` — integer 1 through 5.
- `things_done_well` — important. Save credit where it's due. Helps reconcile disagreements between reviewers.

### Volume expectations

A solid review surfaces 5–20 findings. Fewer than 3 suggests you missed things; more than 30 suggests you're padding. Quality over quantity.

## Final reminder

You are reviewing code written by another AI. The temptation will be to either over-trust (it sounds plausible) or over-criticize (it must be wrong somewhere). Do neither. Read carefully, reason from first principles, and let the findings fall where they fall. **If the code is mostly correct, say so** — that's a valid result.

Now produce the JSON.
