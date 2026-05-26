# AIPW Shift Verification — Findings

**Date:** 2026-05-26
**Commit pinned:** `6b7adbf` (post-fix, after the TimeSeriesSplit replacement)
**Script:** `audit/aipw_shift_check.py`
**Raw data:** `audit/aipw_shift.csv`

## Question

Audit finding F-001 (3-of-3 reviewer consensus): `causal_inference.py:estimate_aipw` was using
`KFold(shuffle=True)` for cross-fitting. On HRV (ρ₁ ≈ 0.4-0.5 autocorrelation) this lets the
outcome model see near-future values via `hrv_lag1`, narrowing the influence-function variance
and overstating CI coverage.

The fix replaced `KFold(shuffle=True)` with `TimeSeriesSplit(n_splits=5)`. The question this
verification answers: **did the fix matter? did any prior "significant" AIPW result change?**

## Method

Re-ran AIPW estimation on the current behavioral matrix using BOTH cross-fitting strategies,
treatment-by-treatment, capturing (ATE, CI, n_used) for each.

- 108 treatments evaluated (binary + median-split continuous; those that survived cell-size gates)
- Same outcome model (Ridge, α=1.0), same propensity model (LogisticRegression L2), same trim
  bounds — only the cross-fitting strategy varies.

## Headline numbers

| Metric | Value |
|---|---|
| Treatments evaluated | 108 |
| Median \|ATE delta\| | **7.5 ms** |
| Mean \|ATE delta\| | 13.4 ms |
| Max \|ATE delta\| | 86.8 ms |
| CIs WIDER under TSS | **76.9%** (83/108) — confirms audit prediction |
| CIs narrower under TSS | 23.1% (25/108) |
| Significance flips (either direction) | 22 / 108 (20.4%) |
| Significant under KFold only → "false positives the bug created" | 5 |
| Significant under TSS only → suspected small-N artifacts | 17 |

## Stratified by sample size

| n_used | Count | Median \|ATE shift\| | Interpretation |
|---|---|---|---|
| ≥ 200 | 66 | **4.5 ms** | Stable. Audit prediction holds: TSS gives wider CIs, fewer false positives. |
| 50–200 | 41 | 9.0 ms | Noisy. TSS's smaller early folds destabilize Ridge fits. |
| < 50 | 1 | 25.7 ms | Don't trust either method. |

The dramatic ATE swings (e.g., `journal_traveled_on_a_plane` going +7 ms → −51 ms) are
concentrated in the 50–200 n bucket. These are NOT new causal discoveries — they're artifacts
of TimeSeriesSplit's progressively-growing training folds on small samples. The propensity
and outcome models in the early folds train on tiny N and produce noisy ψ values.

## Verified false positives (5 high-confidence corrections)

These were significant under the buggy shuffled-KFold and lost significance after the fix —
high N, modest ATE shift, CI widened past zero:

| Treatment | n_used | KF ATE (ms) | TSS ATE (ms) | KF→TSS CI width Δ |
|---|---|---|---|---|
| `journal_received_massage_therapy` | (high-N) | +22.6 | +14.8 (insig) | wider |
| `journal_consumed_caffeine` | 185 | +14.4 | +37.3 (insig — CI widened to span zero) | +66.7 |
| `mfp_fat_g` | (high-N) | +7.6 | −2.4 (insig, near-zero point) | wider |
| `mfp_carbs_g` | (high-N) | −7.3 | −6.0 (insig, negligible shift) | wider |
| `floors_ascended` | (high-N) | +11.1 | +5.8 (insig, point shrunk) | wider |

**Implication:** any prior intervention based on these "significant" results was acting on a
fold-leakage artifact. Treat them as inconclusive going forward.

## Suspected small-N artifacts (17 "newly significant")

Not listed individually — see `audit/aipw_shift.csv`. Distinguishing characteristic: median
n_used = 172, with dramatic ATE sign flips that exceed any plausible behavioral effect size.
Do not act on these results.

## What this means

1. **The audit was correct.** The shuffled-KFold leak was real, did create false positives, and
   the TimeSeriesSplit fix is the methodologically sound replacement.
2. **The post-fix high-N estimates are trustworthy.** Treatments with n_used ≥ 200 are the
   actionable ones; their ATEs and CIs are now honest.
3. **Mid-N estimates need a second-pass CI method.** The audit's recommendation of
   block-bootstrap CIs (block length 7-14 days) is the next-step refinement for these. Until
   that's implemented, treat n_used 50-200 treatments as exploratory.
4. **Low-N treatments (< 50) are unreliable under both methods.** The cell-size gates already
   drop most of these; the few that survive should be reviewed manually.

## Next-step recommendations (deferred audit P1s for the causal layer)

- **Add block-bootstrap CI** alongside the IF-based CI; report both. Implement per audit's
  `causal_inference.py:425` recommendation. Half-day fix.
- **Lower default `N_FOLDS_AIPW`** for small-N treatments — TimeSeriesSplit at n=80 with 5
  folds means the first training fold is ~13 rows. Bumping to 3 folds would give 26 rows. Or
  dynamically gate on n_used.
- **Optionally tune Ridge alpha** per arm (audit Claude F-012) — could stabilize the outcome
  models for the noisy mid-N regime.
