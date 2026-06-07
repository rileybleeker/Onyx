# Data Profile — Onyx HRV Analytics

Snapshot taken from production Supabase as of 2026-05-25 23:00 ET. The audit reviewers should use these numbers when assessing statistical power, multicollinearity risk, missingness patterns, and sample-size adequacy of the tests in `hrv_analysis.py` / `causal_inference.py`.

This is n=1 longitudinal — one subject (Riley), multiple years of daily observations. There is no cross-individual generalization concern.

## Spine: `pds.daily_health_matrix_behavioral`

One row per behavioral day (the bedtime-to-bedtime "day of Riley's life" per ADR-0001). 135 columns wide. This is what `hrv_analysis.py:load_data` reads as its base.

| Metric | Value |
|---|---|
| Total rows | **836** |
| Date range | 2019-04-14 → 2026-05-25 |
| Transition days (flagged `onyx_is_transition_day`) | 28 (~3.3%) |

## HRV target coverage

The pipeline can target any of three HRV sources. Whichever is chosen sets the effective N.

| HRV source | Non-null days | % of spine | Notes |
|---|---|---|---|
| `whoop_hrv_rmssd` (WHOOP RMSSD, ms) | **568** | 68% | **Canonical target.** WHOOP since 2024. Most continuous. |
| `garmin_hrv_last_night` (Garmin time-weighted, ms) | 234 | 28% | Garmin Venu 3 since ~Sep 2025. Algorithm-different from RMSSD. |
| `eight_sleep_hrv` (Eight Sleep avg, ms — undocumented algorithm) | 117 | 14% | Pod 4 since ~Jan 2026. Coverage gap on travel days. |

WHOOP recovery score (the downstream WHOOP composite) covers the same 568 days.

## Daytime / behavioral feature coverage

| Source | Non-null days | First observation |
|---|---|---|
| WHOOP day strain | 572 | ~2024-09 |
| Garmin sleep score | 234 | ~2025-09 |
| Eight Sleep sleep score | 117 | ~2026-01 |
| MyFitnessPal nutrition (mfp_*) | 247 | mid-2025 |
| Meal timing (clock-time logs) | **3** | 2026-05-22 (new feature) |

## Journal coverage (WHOOP behavioral questions)

`pds.whoop_journal` — boolean yes/no answers to WHOOP's daily journal prompts.

| Metric | Value |
|---|---|
| Distinct journal questions ever asked | **59** |
| Days with ≥1 journal entry | 270 |
| Total question-answers | 11,910 |
| Range | 2024-10-27 → 2026-05-24 |
| Avg answers per day-with-journal | ~44 |

Important: each question has its own non-null subset. A question like `journal_have_any_alcoholic_drinks` may only have ~150 days of yes/no answers, with the rest as NaN. The Welch's t-test and AIPW estimators apply the `≥5 yes-nights and ≥5 no-nights` gate before reporting an effect, but the **multiple-comparison surface is 59 questions × 1 target = 59 tests** in the journal family alone. BH-FDR was added in the May 21 variable-coverage audit; reviewers should verify it's applied consistently.

## Habit coverage

`pds.habit_journal` — Notion-managed habit completions, bidirectional sync.

| Metric | Value |
|---|---|
| Distinct habits | **2** |
| Total completion events | 29 |
| Range | 2026-03-30 → 2026-05-24 |

**Habit data is extremely sparse — fewer than 60 days of history.** Any habit-driven AIPW estimate will almost certainly be flagged `low_n=true` (the gate is ≥10 in each arm). Reviewers should expect habit findings to be weak across the board and judge the *machinery* rather than the *effect sizes*.

## Supplement coverage

`pds.supplement_intake` (fact) + `pds.supplement_products` (dim with ingredient JSONB).

| Metric | Value |
|---|---|
| Distinct products | **22** |
| Intake events | 119 |
| Range | 2026-05-18 → 2026-05-25 (**~8 days**) |

**Supplement tracking is one week old.** The HRV pipeline includes supplement_* binary treatments in the causal layer, but every one of them will currently fail the cell-size gate. Reviewers should evaluate whether the *infrastructure* (the cross-product UNII rollup, the behavioral-day attribution, the cell-size guards) is correct, not whether any particular finding is.

## HRV output tables

These are *outputs* of the pipeline, included so reviewers can see how results are stored.

| Table | Rows | Purpose |
|---|---|---|
| `pds.hrv_predictions` | 10,980 | One row per (date × model × horizon × version). Multi-horizon backtest produces ~36 rows/eval_date. |
| `pds.hrv_model_metrics` | 569 | Rolling eval metrics (MAE, RMSE, R², directional accuracy, CI coverage) per model × horizon. |
| `pds.hrv_analysis_results` | 22 | JSON blobs keyed by `result_type` — correlations, journal/habit/supplement/nutrition impact, causal, model_comparison. |

`pds.hrv_predictions_latest` is a view: DISTINCT ON `(prediction_date, model, horizon_days)` returning freshest non-backtest row per forecast. See [CONTEXT.md](CONTEXT.md) for the tie-break logic — it's load-bearing.

## Implications the reviewer should keep in mind

1. **Effective N is 568, not 836.** Anything that uses WHOOP HRV as the target loses every day before WHOOP started.
2. **Eight Sleep HRV / Garmin HRV as targets gives much smaller N** (117 / 234). The pipeline supports any target but practically operates on WHOOP.
3. **Habits and supplements are too new for causal inference today.** This is expected and the cell-size gates are doing their job.
4. **The 59 journal questions create the biggest multiple-comparison surface.** BH-FDR coverage is the single most consequential statistical-machinery question for this pipeline.
5. **`onyx_is_transition_day` flags travel/timezone-shift days** (~3% of the spine). These have legitimate behavioral discontinuity; the reviewer should check whether the pipeline excludes or flags them in any analyses.
6. **Walk-forward backtest:** the pipeline uses time-ordered folds. With N=568 and multiple horizons (h=1..7), the per-horizon test sample is small. Reviewers should assess whether the residual-variance estimates are stable.
