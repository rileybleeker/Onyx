#!/usr/bin/env python3
"""
Causal Inference Module for Onyx HRV Analysis
==============================================
Companion to hrv_analysis.py. Computes treatment-effect estimates for each
behavioral variable (journal items, habits, supplements, nutrition, exercise)
on next-night HRV.

Why this exists
---------------
The base pipeline answers "what's *associated with* HRV" (Spearman, partial
correlation, Welch's t-test) and "what *predicts* HRV" (XGBoost SHAP). Neither
distinguishes association from causation.  Example: alcohol nights also tend to
be hard-training nights, late-meal nights, and weekend nights — so the naive
Yes-vs-No t-test conflates alcohol's effect with everything that co-occurs.

This module estimates *adjusted* treatment effects under an explicit DAG, so
the reported effect is "what would happen if we changed only X, holding the
other confounders fixed".

Methods (three estimators, reported side-by-side)
-------------------------------------------------
  1. **Naive**: mean(Y|T=1) - mean(Y|T=0). The Welch's t-test the existing
     pipeline already reports — included as the baseline being compared
     against.

  2. **Propensity Score Matching (PSM)**: For each treated day, find the
     control day with the closest logit-propensity. Estimate ATT (effect on
     the treated) as the mean within-pair Y difference. CI by paired
     bootstrap (B=500). Robust under common-support trimming.

  3. **Doubly Robust AIPW (Augmented IPW)**: Combine a logistic propensity
     model with two Ridge outcome models (one per treatment arm).  The
     influence function gives the per-unit pseudo-outcome psi_i; ATE is its
     sample mean; SE is sd(psi)/sqrt(n).  *Doubly robust* means the estimate
     is unbiased if EITHER the propensity model OR the outcome model is
     correctly specified.  Implemented with 5-fold cross-fitting so the
     models aren't evaluated on their training data.

Sensitivity analysis
--------------------
For every estimate we report the **E-value** (VanderWeele & Ding 2017):
the minimum strength (on the risk-ratio scale) that an unmeasured confounder
would need to have with both T and Y to fully explain the estimate away.
Higher E-value = more robust to unmeasured confounding.

For continuous outcomes we convert ATE → Cohen's d → approximate RR via
Chinn's (2000) transform RR ≈ exp(0.91·d), then apply the E-value formula
E = RR + sqrt(RR·(RR-1)).

DAG / confounder strategy
-------------------------
The default confounder set is *pre-treatment* (lag-1) features only — no
same-day or downstream variables, which would block the causal path we are
trying to measure (mediator-adjustment bias).

  COMMON confounders (every treatment family):
    hrv_lag1, hrv_7d_mean, day_of_week, is_weekend,
    whoop_day_strain_lag1, whoop_sleep_duration_milli_lag1,
    rolling_7d_training_load, sleep_debt_7d

  Extra confounders for SUPPLEMENT treatments:
    journal_have_any_alcoholic_drinks_lag1, journal_consumed_caffeine_lag1
    (supplement-conscious days tend to differ in lifestyle)

We DO NOT adjust for any same-night sleep, recovery, or HRV variables —
those are mediators (the pathway by which most behaviors affect HRV) and
adjusting for them would erase the effect being measured.

We report TOTAL effects (not direct effects), which is the actionable answer:
"if I take magnesium tonight, what happens to my HRV tomorrow?" includes the
sleep-quality channel by design.
"""
from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

try:
    from sklearn.linear_model import LogisticRegression, Ridge
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import KFold, TimeSeriesSplit
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

try:
    from scipy.stats import norm
    from statsmodels.stats.multitest import multipletests
    HAS_FDR = True
except ImportError:
    HAS_FDR = False

log = logging.getLogger("hrv_analysis.causal")
warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OUTCOME_COL = "hrv_target_t1"  # next-night HRV; created by prepare_ml_data
ALIGN_KEY = "calendar_date"

COMMON_CONFOUNDERS = (
    "hrv_lag1",
    "hrv_7d_mean",
    "whoop_day_strain_lag1",
    "whoop_sleep_duration_milli_lag1",
    "rolling_7d_training_load",
    "sleep_debt_7d",
    "day_of_week",
    "is_weekend",
)
SUPPLEMENT_EXTRA_CONFOUNDERS = (
    "journal_have_any_alcoholic_drinks_lag1",
    "journal_consumed_caffeine_lag1",
)

# Re-audit 2026-06-07 (stats/gemini/F-003): mediator exclusion for multi-day
# rolling/aggregate treatments. For a treatment that aggregates several past
# days (e.g. rolling_7d_training_load spans days N-7..N), HRV on night N-1
# (hrv_lag1) lies on the causal path from the EARLIER days of that window to
# the outcome — training load on day N-2 affects HRV on night N-1, so hrv_lag1
# is a MEDIATOR for those days, not a pre-treatment confounder. Conditioning on
# a mediator induces collider/over-control bias. For these treatments we drop
# the intermediate (post-window-start) variables from the confounder set.
# hrv_7d_mean is likewise a window-overlapping aggregate of the same days, so it
# is dropped too. We keep day_of_week / is_weekend / sleep_debt_7d (the latter
# is a slow-moving deficit that is reasonable to treat as a baseline covariate).
ROLLING_AGGREGATE_TREATMENTS = frozenset({
    "rolling_3d_training_load",
    "rolling_7d_training_load",
    "acute_training_load",
    "chronic_training_load",
    "atl_ctl_ratio",
    "total_training_load",
})
# Confounders that become mediators (or window-overlapping aggregates) once the
# treatment spans multiple past days. Dropped from the adjustment set for any
# treatment in ROLLING_AGGREGATE_TREATMENTS.
ROLLING_TREATMENT_MEDIATOR_CONFOUNDERS = frozenset({
    "hrv_lag1",
    "hrv_7d_mean",
    "whoop_day_strain_lag1",
})

# Re-audit 2026-06-07 (stats/gpt-5/F-007): forward-fill horizon for confounders,
# configurable per family instead of the prior hard-coded limit=2. Weekly /
# multi-day aggregate confounders (rolling load, sleep debt) are slow-moving and
# legitimately stable across a week, so a 2-day fill needlessly drops rows in
# early-tracking or sparse periods. We use a longer fill for confounder columns
# whose name marks them as multi-day aggregates, and keep the conservative
# 2-day fill for genuinely daily confounders (lag1 strain/sleep) where a long
# carry-forward would smear stale values across real gaps.
CONFOUNDER_FFILL_DEFAULT = 2
CONFOUNDER_FFILL_WEEKLY = 7
# Substrings that mark a confounder column as a multi-day / weekly aggregate.
_WEEKLY_CONFOUNDER_MARKERS = ("7d", "rolling", "debt", "ctl", "chronic", "7_mean", "7d_mean")


def _confounder_ffill_limit(col: str) -> int:
    """Re-audit 2026-06-07 (stats/gpt-5/F-007): per-confounder ffill horizon.

    Weekly/multi-day aggregate confounders get a 7-day carry-forward; daily
    confounders keep the conservative 2-day default so a stale value can't be
    smeared across a long gap.
    """
    name = col.lower()
    if any(m in name for m in _WEEKLY_CONFOUNDER_MARKERS):
        return CONFOUNDER_FFILL_WEEKLY
    return CONFOUNDER_FFILL_DEFAULT

# Minimum cell sizes
MIN_BINARY_PER_ARM_FULL = 20      # full causal estimates require this many in each arm
MIN_BINARY_PER_ARM_REPORT = 10    # below this we don't run estimators at all
# Continuous treatments are median-split, so the per-arm gate already implies
# n_total >= 2*MIN_BINARY_PER_ARM_REPORT = 20. This adds a separate floor on
# the total non-null sample (audit Finding #10 — previously declared but unused).
MIN_CONTINUOUS_N = 50
# (Dose-response causal estimation is not implemented; the descriptive
# dose-response Spearman lives in hrv_analysis.run_statistical_analysis.)

# Propensity trimming (common support)
PROPENSITY_TRIM_LOW = 0.05
PROPENSITY_TRIM_HIGH = 0.95

# AIPW cross-fitting
N_FOLDS_AIPW = 5

# Block-bootstrap parameters for AIPW CI. Per audit finding F-001's follow-up
# recommendation: resample contiguous time blocks of the influence values to
# preserve HRV autocorrelation that the IF-based SE assumes is i.i.d.
# Reported alongside the IF CI; meaningful divergence (>50% width gap) flags
# that the IF SE is unreliable for that treatment.
N_BOOTSTRAP_AIPW = 1000
AIPW_BOOTSTRAP_BLOCK_LEN = 7  # days; matches the weekly periodicity in HRV/training data

# BH-FDR q-threshold for the joint binary + continuous treatment family.
# Matches hrv_analysis.FDR_Q_THRESHOLD. At alpha=0.05 with ~150 treatments,
# ~7-8 false-positive interventions are expected by chance without correction —
# the BH step controls the false-discovery rate across the union.
FDR_Q_THRESHOLD = 0.05

# Bootstrap reps for PSM CI
N_BOOTSTRAP_PSM = 500

# Number of NN matches per treated unit
PSM_K = 3

RNG = np.random.default_rng(42)


# ---------------------------------------------------------------------------
# Treatment configuration
# ---------------------------------------------------------------------------

@dataclass
class TreatmentSpec:
    """Describes one causal estimand."""
    name: str                            # column name in df or special key
    family: str                          # 'journal' | 'habit' | 'supplement' | 'nutrition' | 'behavior'
    label: str                           # human-readable
    confounders: tuple                   # column names
    kind: str = "binary"                 # 'binary' or 'continuous_median_split'
    unit: str | None = None              # for continuous (mg, g, etc.)


# Continuous variables we binarize at the personal median to get a clean
# "above/below your usual" treatment contrast. Median-split is a deliberate
# trade-off — it loses dose information but produces an ATE on the same scale
# as the binary treatments, which makes the forest plot directly comparable.
# Continuous nutrition is already covered by the Spearman card in the base
# pipeline; this layer adds the *adjusted* contrast.
#
# Coverage: every controllable daytime variable from every data source.
# Source families:
#   nutrition  — MyFitnessPal (calories, macros, water, micros, ratios)
#   behavior   — daytime activity / strain / training load / stress / body-battery /
#                workout timing / days-since recovery markers
#                (sourced from Garmin daily summary + Garmin training status +
#                Garmin heart-rate zones + WHOOP cycles + WHOOP workouts +
#                derived "days since" features)
#
# DELIBERATE EXCLUSIONS — these are not treatments, even though they exist in
# the feature matrix:
#   - Same-night sleep variables (whoop_sleep_*, garmin_sleep_*, eight_sleep_*,
#     whoop_deep_pct, sleep_debt_ratio, etc.). These are MEDIATORS on the very
#     path being estimated (e.g. alcohol → bad sleep → low HRV). Including them
#     as treatments under the lagged framing also doesn't fit cleanly — the
#     metric is contemporaneous with the outcome, not pre-treatment.
#   - HRV-derived variables (whoop_recovery_score, whoop_rhr, garmin_rhr,
#     whoop_skin_temp, hrv_z_28d, hrv_28d_mean, etc.). These are the outcome
#     itself or near-tautological measurements of overnight physiology.
#   - Body composition (weight_kg, bmi). Changes too slowly for a daily ATE.
#   - Time-of-day "sleep timing" (bedtime_hour, wake_hour, sleep_midpoint_hour).
#     Measured AT the sleep event, contemporaneous with the outcome.
CONTINUOUS_TREATMENTS: tuple[tuple[str, str, str, str | None], ...] = (
    # ── Nutrition macros (Cronometer→MFP COALESCE via nutrition_* aliases) ────
    # MFP→Cronometer migration 2026-05-31: mfp_* repointed to nutrition_*;
    # exercise_kcal dropped (Cronometer has none — net_calories is now WHOOP-based).
    ("nutrition_calories",  "nutrition", "Calories above median",        "kcal"),
    ("nutrition_protein_g", "nutrition", "Protein above median",         "g"),
    ("nutrition_carbs_g",   "nutrition", "Carbs above median",           "g"),
    ("nutrition_fat_g",     "nutrition", "Fat above median",             "g"),
    ("nutrition_fiber_g",   "nutrition", "Fiber above median",           "g"),
    ("nutrition_sugar_g",   "nutrition", "Sugar above median",           "g"),
    ("nutrition_sodium_mg", "nutrition", "Sodium above median",          "mg"),
    ("nutrition_water_ml",  "nutrition", "Water intake above median",    "ml"),
    ("net_calories",        "nutrition", "Net calories above median",    "kcal"),
    ("protein_pct",         "nutrition", "Protein % of cals above median", "%"),
    ("carb_pct",            "nutrition", "Carb % of cals above median",  "%"),
    ("fat_pct",             "nutrition", "Fat % of cals above median",   "%"),

    # ── Cronometer micronutrients (vitamins / minerals / omega) ───────────────
    # MFP→Cronometer migration 2026-05-31. Family='nutrition' → same lifestyle-
    # clustering confounder routing. Most are dropped via MIN_CONTINUOUS_N=50 (or
    # flagged low_n) until Cronometer history accrues — intended graceful degradation.
    # nutrition_caffeine_mg (dietary-only) replaced 2026-06-09 by the unified
    # caffeine_total_mg treatment in the caffeine block below — keeping both
    # would put two copies of one signal into the FDR family.
    ("vit_a_rae_mcg",       "nutrition", "Vitamin A (RAE) above median",  "µg"),
    ("vit_c_mg",            "nutrition", "Vitamin C above median",        "mg"),
    ("vit_d_iu",            "nutrition", "Vitamin D above median",        "IU"),
    ("vit_e_mg",            "nutrition", "Vitamin E above median",        "mg"),
    ("vit_k_mcg",           "nutrition", "Vitamin K above median",        "µg"),
    ("b1_thiamine_mg",      "nutrition", "B1 (Thiamine) above median",    "mg"),
    ("b2_riboflavin_mg",    "nutrition", "B2 (Riboflavin) above median",  "mg"),
    ("b3_niacin_mg",        "nutrition", "B3 (Niacin) above median",      "mg"),
    ("b5_pantothenic_mg",   "nutrition", "B5 (Pantothenic) above median", "mg"),
    ("b6_pyridoxine_mg",    "nutrition", "B6 (Pyridoxine) above median",  "mg"),
    ("b12_cobalamin_mcg",   "nutrition", "B12 (Cobalamin) above median",  "µg"),
    ("folate_mcg",          "nutrition", "Folate above median",           "µg"),
    ("calcium_mg",          "nutrition", "Calcium above median",          "mg"),
    ("iron_mg",             "nutrition", "Iron above median",             "mg"),
    ("magnesium_mg",        "nutrition", "Magnesium above median",        "mg"),
    ("phosphorus_mg",       "nutrition", "Phosphorus above median",       "mg"),
    ("potassium_mg",        "nutrition", "Potassium above median",        "mg"),
    ("zinc_mg",             "nutrition", "Zinc above median",             "mg"),
    ("copper_mg",           "nutrition", "Copper above median",           "mg"),
    ("manganese_mg",        "nutrition", "Manganese above median",        "mg"),
    ("selenium_mcg",        "nutrition", "Selenium above median",         "µg"),
    ("omega3_g",            "nutrition", "Omega-3 above median",          "g"),
    ("omega6_g",            "nutrition", "Omega-6 above median",          "g"),
    ("epa_g",               "nutrition", "EPA above median",              "g"),
    ("dha_g",               "nutrition", "DHA above median",              "g"),
    ("ala_g",               "nutrition", "ALA above median",              "g"),

    # ── Daytime strain / activity (WHOOP + Garmin) ───────────────────────────
    ("whoop_day_strain",            "behavior", "WHOOP day strain above median",      None),
    ("whoop_kilojoule",             "behavior", "Daily energy (kJ) above median",      "kJ"),
    ("total_steps",                 "behavior", "Steps above median",                  None),
    ("total_kilocalories",          "behavior", "Total kcal burned above median",      "kcal"),
    ("active_kilocalories",         "behavior", "Active kcal burned above median",     "kcal"),
    ("moderate_intensity_minutes",  "behavior", "Moderate-intensity min above median", "min"),
    ("vigorous_intensity_minutes",  "behavior", "Vigorous-intensity min above median", "min"),
    ("highly_active_seconds",       "behavior", "Highly-active seconds above median",  "s"),
    ("active_seconds",              "behavior", "Active seconds above median",         "s"),
    ("sedentary_seconds",           "behavior", "Sedentary seconds above median",      "s"),

    # ── Training load (acute / chronic / rolling) ────────────────────────────
    ("rolling_3d_training_load",    "behavior", "3-day training load above median",    None),
    ("rolling_7d_training_load",    "behavior", "7-day training load above median",    None),
    ("acute_training_load",         "behavior", "Acute training load above median",    None),
    ("chronic_training_load",       "behavior", "Chronic training load above median",  None),
    ("atl_ctl_ratio",               "behavior", "ATL/CTL ratio above median",          None),
    ("total_training_load",         "behavior", "Daily training load above median",    None),

    # ── Daytime stress (Garmin) ──────────────────────────────────────────────
    ("avg_stress_level",            "behavior", "Avg stress level above median",       None),
    ("max_stress_level",            "behavior", "Peak stress level above median",      None),
    ("high_stress_duration_min",    "behavior", "High-stress minutes above median",    "min"),
    ("pct_high_stress",             "behavior", "High-stress % of day above median",   "%"),
    ("stress_ratio",                "behavior", "High/low stress ratio above median",  None),

    # ── Body Battery (Garmin) ────────────────────────────────────────────────
    ("body_battery_charged",        "behavior", "Body Battery charged above median",   None),
    ("body_battery_drained",        "behavior", "Body Battery drained above median",   None),

    # ── Workout timing (last workout → bedtime) ──────────────────────────────
    ("last_workout_end_to_sleep_min", "behavior", "Workout-to-bed minutes above median", "min"),
    ("whoop_strain_per_hour_to_bed",  "behavior", "Strain ÷ hours-to-bed above median",  None),

    # ── Workout aggregates (Garmin activities) ───────────────────────────────
    ("activity_count",              "behavior", "Workout count above median",          None),
    ("total_activity_duration_min", "behavior", "Total workout minutes above median",  "min"),
    ("total_activity_distance_km",  "behavior", "Total workout distance above median", "km"),
    ("total_activity_calories",     "behavior", "Total workout kcal above median",     "kcal"),
    ("max_aerobic_te",              "behavior", "Peak aerobic TE above median",        None),
    ("max_anaerobic_te",            "behavior", "Peak anaerobic TE above median",      None),
    ("max_activity_hr",             "behavior", "Peak workout HR above median",        "bpm"),
    ("avg_activity_hr",             "behavior", "Avg workout HR above median",         "bpm"),
    ("total_elevation_gain_m",      "behavior", "Total elevation gain above median",   "m"),

    # ── Workout aggregates (WHOOP workouts) ──────────────────────────────────
    ("whoop_workout_count",         "behavior", "WHOOP workout count above median",     None),
    ("total_whoop_strain",          "behavior", "Total workout WHOOP strain above median", None),
    ("total_whoop_kilojoule",       "behavior", "Total workout kJ above median",        "kJ"),
    ("max_whoop_workout_hr",        "behavior", "Peak WHOOP workout HR above median",   "bpm"),
    ("avg_whoop_workout_hr",        "behavior", "Avg WHOOP workout HR above median",    "bpm"),
    ("total_zone4_5_milli",         "behavior", "Time in HR zones 4-5 (WHOOP) above median", "ms"),
    ("total_zone0_1_milli",         "behavior", "Time in HR zones 0-1 (WHOOP) above median", "ms"),

    # ── HR zone time (Garmin daily) ──────────────────────────────────────────
    ("zone_2_seconds",              "behavior", "HR Zone 2 seconds above median",      "s"),
    ("zone_3_seconds",              "behavior", "HR Zone 3 seconds above median",      "s"),
    ("zone_4_seconds",              "behavior", "HR Zone 4 seconds above median",      "s"),
    ("zone_5_seconds",              "behavior", "HR Zone 5 seconds above median",      "s"),

    # ── Recovery state (days since event) ────────────────────────────────────
    ("days_since_alcohol",          "behavior", "Days since last alcohol above median", "days"),
    ("days_since_sauna",            "behavior", "Days since last sauna above median",   "days"),
    ("days_since_hard_workout",     "behavior", "Days since hard workout above median", "days"),
    ("days_since_rest_day",         "behavior", "Days since rest day above median",     "days"),
    ("consecutive_run_days",        "behavior", "Consecutive run days above median",    "days"),

    # ── Additions from variable-coverage audit ───────────────────────────────
    # Stress buckets that were missing from CIc (only high_stress_duration was covered).
    ("rest_stress_duration_min",    "behavior", "Rest-stress minutes above median",    "min"),
    ("low_stress_duration_min",     "behavior", "Low-stress minutes above median",     "min"),
    ("medium_stress_duration_min",  "behavior", "Medium-stress minutes above median",  "min"),
    # Stair climbing — distinct activity dimension from steps.
    ("floors_ascended",             "behavior", "Floors ascended above median",        "floors"),
    # WHOOP daytime HR (cycle-wide), not just workout HR.
    ("whoop_cycle_avg_hr",          "behavior", "WHOOP cycle avg HR above median",     "bpm"),
    ("whoop_cycle_max_hr",          "behavior", "WHOOP cycle peak HR above median",    "bpm"),
    # Pacing consistency from lap-level data (the laps merge is already in build_feature_matrix).
    ("lap_pace_cv",                 "behavior", "Lap-pace CV above median",            None),
    ("lap_hr_range",                "behavior", "Lap HR range above median",           "bpm"),
    # Stack volume — independent of per-compound effects.
    ("supplement_distinct_compounds", "behavior", "Distinct supplements taken above median", None),
    ("supplement_total_doses",      "behavior", "Total supplement doses above median", None),
    # Eight Sleep ambient bedroom temp — genuinely upstream (a control input), not a mediator.
    ("eight_sleep_room_temp",       "behavior", "Bedroom temperature above median",    "C"),
    # Notion Journal structured metadata (audit Finding #8). Family='behavior'
    # because the journal entry is a daily self-report behavior, not nutrition.
    ("nj_mood_ord",                 "behavior", "Journaled mood (ordinal) above median", None),
    ("nj_confidence_ord",           "behavior", "Journaled confidence above median",     None),
    ("nj_word_count",               "behavior", "Notion journal words above median",     "words"),

    # ── Meal timing (pds.meal_timing_daily, joined in daily_health_matrix) ──
    # last_meal_to_bedtime is bedtime-anchored, so it stays monotonic in
    # physiological lateness even when the meal lands after midnight. Family
    # is 'nutrition' so the causal layer attaches the supplement-style
    # confounders (lifestyle clustering around late meals).
    ("meal_last_meal_to_bedtime_min", "nutrition", "Last meal → bedtime minutes above median", "min"),
    ("meal_eating_window_hours",      "nutrition", "Eating window above median",               "h"),
    ("meal_last_hour",                "nutrition", "Last meal clock hour above median",        "ET hr"),
    ("meal_first_hour",               "nutrition", "First meal clock hour above median",       "ET hr"),

    # ── Caffeine timing (pds.caffeine_timing_daily, joined into the matrix) ──
    # caffeine_to_bedtime_min is bedtime-anchored — monotonic across midnight,
    # mirrors meal_last_meal_to_bedtime_min. Clock-hour fields included so
    # SHAP/causal can compare "afternoon-only caffeine" vs "evening caffeine"
    # patterns. Family is 'nutrition' so the same lifestyle-clustering
    # confounder set (alcohol_lag1, caffeine_lag1, etc.) applies.
    ("caffeine_to_bedtime_min",       "nutrition", "Last caffeine → bedtime minutes above median", "min"),
    ("caffeine_last_hour",            "nutrition", "Last caffeine clock hour above median",    "ET hr"),
    ("caffeine_first_hour",           "nutrition", "First caffeine clock hour above median",   "ET hr"),
    ("caffeine_window_hours",         "nutrition", "Caffeine intake window above median",      "h"),
    ("caffeine_intake_count",         "nutrition", "Caffeine events per day above median",     None),
    # Unified caffeine quantity (2026-06-09): dietary (Cronometer servings) +
    # supplement (UNII rollup) merged in pds.caffeine_timing_daily.
    # caffeine_total_mg is THE canonical caffeine dose treatment;
    # caffeine_mg_at_bedtime is the dose-x-timing composite (5h half-life
    # residual at sleep onset) — the best single proxy for "caffeine still
    # on board when sleep started".
    ("caffeine_total_mg",             "nutrition", "Total caffeine (diet+suppl) above median", "mg"),
    ("caffeine_mg_at_bedtime",        "nutrition", "Caffeine load at bedtime above median",    "mg"),
    # ADR-0001 Phase B travel treatments — magnitude/recovery
    ("offset_delta_hours",            "travel",    "TZ offset shift magnitude above median",   "h"),
    ("days_since_transition",         "travel",    "Days since last transition above median",  "days"),
)

# Explicit binary treatments — derived 0/1 flags that don't match the
# journal_/habit_/supplement_ prefix scan. Listed here so a future column
# rename doesn't silently drop them.
EXPLICIT_BINARY_TREATMENTS: tuple[tuple[str, str, str], ...] = (
    # (column, family, label)
    ("had_evening_workout", "behavior", "Had evening workout (after 6pm)"),
    # NOTE: is_run_day is intentionally NOT a treatment — superseded by act_run
    # below. is_run_day is Garmin-only and left NaN on rest days, so its control arm
    # is "active-but-didn't-run" only (a different counterfactual than act_run's
    # "any non-run day"). Dropping it here avoids a duplicate, ambiguous forest-plot
    # row + a redundant FDR-family member. The column still exists in the matrix
    # (consecutive_run_days and XGBoost use it) — only its treatment is removed.
    ("is_rest_day",         "behavior", "Rest day (no workouts)"),
    ("negative_split",      "behavior", "Negative split (second half faster)"),
    # Activity taxonomy — auto run/sauna from device sport labels; the strength
    # tags (coarse split leg/pull/push + granular muscle groups) from the manual
    # multi-select on /activities (split_labels / muscle_groups TEXT[]). Derived in
    # hrv_analysis aggregate_activity_categories (act_ / act_mg_ prefix, both under
    # the act_ family). Sparse until ~3 weeks of labels accrue — the muscle groups
    # especially have no history, so they sit in dropped_low_n until enough tagged
    # sessions accumulate (cell-size gates), then enter the FDR family.
    ("act_run",             "behavior", "Run day (WHOOP + Garmin)"),
    ("act_sauna",           "behavior", "Sauna session"),
    ("act_leg_day",         "behavior", "Leg day"),
    ("act_pull_day",        "behavior", "Pull day"),
    ("act_push_day",        "behavior", "Push day"),
    ("act_mg_chest",        "behavior", "Chest (muscle group)"),
    ("act_mg_back",         "behavior", "Back (muscle group)"),
    ("act_mg_shoulders",    "behavior", "Shoulders (muscle group)"),
    ("act_mg_biceps",       "behavior", "Biceps (muscle group)"),
    ("act_mg_triceps",      "behavior", "Triceps (muscle group)"),
    ("act_mg_forearms",     "behavior", "Forearms (muscle group)"),
    ("act_mg_quads",        "behavior", "Quads (muscle group)"),
    ("act_mg_hamstrings",   "behavior", "Hamstrings (muscle group)"),
    ("act_mg_glutes",       "behavior", "Glutes (muscle group)"),
    ("act_mg_calves",       "behavior", "Calves (muscle group)"),
    ("act_mg_core",         "behavior", "Core (muscle group)"),
    # ADR-0001 Phase B travel treatments
    ("is_transition_day",   "travel",   "Travel transition day"),
    ("is_outbound",         "travel",   "Outbound travel (NY → away)"),
    ("is_return",           "travel",   "Return travel (away → NY)"),
)


# ===========================================================================
# Estimators
# ===========================================================================

def _trim_propensity(p: np.ndarray) -> np.ndarray:
    return np.clip(p, PROPENSITY_TRIM_LOW, PROPENSITY_TRIM_HIGH)


def _fit_propensity(X: np.ndarray, T: np.ndarray) -> np.ndarray:
    """Logistic regression propensity model. Returns trimmed P(T=1|X)."""
    model = LogisticRegression(
        penalty="l2", C=1.0, solver="lbfgs", max_iter=200,
    )
    model.fit(X, T)
    p = model.predict_proba(X)[:, 1]
    return _trim_propensity(p)


def _standardize(X: np.ndarray) -> np.ndarray:
    scaler = StandardScaler()
    return scaler.fit_transform(X)


# Re-audit 2026-06-07 (stats/gpt-5/F-004): day_of_week was an ordinal 0-6 in
# COMMON_CONFOUNDERS, which forces both the logistic propensity model and the
# Ridge outcome models to assume a LINEAR effect across weekdays (Monday→Sunday
# differ by a constant slope) — misspecified for what is a cyclic/categorical
# structure. We expand day_of_week into cyclic sin/cos terms before any model
# sees it. Two smooth terms capture the weekly cycle (Sunday adjacent to Monday)
# without the dimensionality blow-up of a 6-column one-hot, and they keep the
# confounder design matrix purely numeric for the existing ndarray flow.
DOW_COL = "day_of_week"


def _expand_cyclic_day_of_week(X_df: pd.DataFrame) -> pd.DataFrame:
    """Replace an ordinal ``day_of_week`` column with cyclic sin/cos terms.

    No-op if the column is absent. Returns a new frame; the original column is
    dropped and ``day_of_week_sin`` / ``day_of_week_cos`` appended in its place.
    """
    if DOW_COL not in X_df.columns:
        return X_df
    out = X_df.copy()
    dow = pd.to_numeric(out[DOW_COL], errors="coerce").fillna(0.0).to_numpy(dtype=float)
    angle = 2.0 * np.pi * dow / 7.0
    out = out.drop(columns=[DOW_COL])
    out[f"{DOW_COL}_sin"] = np.sin(angle)
    out[f"{DOW_COL}_cos"] = np.cos(angle)
    return out


def estimate_naive(T: np.ndarray, Y: np.ndarray) -> dict:
    """Mean(Y|T=1) − Mean(Y|T=0) with Welch's CI."""
    y1 = Y[T == 1]
    y0 = Y[T == 0]
    diff = float(y1.mean() - y0.mean())
    se = float(np.sqrt(y1.var(ddof=1) / len(y1) + y0.var(ddof=1) / len(y0)))
    return {
        "ate": diff,
        "ci_low": diff - 1.96 * se,
        "ci_high": diff + 1.96 * se,
        "se": se,
        "n_treated": int(len(y1)),
        "n_control": int(len(y0)),
    }


def _psm_match_once(X: np.ndarray, T: np.ndarray, Y: np.ndarray, k: int) -> dict | None:
    """Run the FULL PSM procedure once: standardize → fit propensity →
    common-support trim → caliper NN matching → ATT.

    Returns a dict with att / matched_diffs / caliper / caliper_drops /
    n_treated_matched / n_dropped, or None when there is not enough material to
    match (caller decides what to do). Factored out of estimate_psm so the
    bootstrap can re-run the ENTIRE estimation (propensity fit + matching) on
    each resample rather than just resampling the final matched_diffs.
    """
    # Need both arms present to fit a propensity model at all.
    if int(T.sum()) < 2 or int((T == 0).sum()) < 2:
        return None
    try:
        X_std = _standardize(X)
        p_hat = _fit_propensity(X_std, T)
    except Exception:
        return None
    logit_p = np.log(p_hat / (1 - p_hat))

    treated_idx = np.where(T == 1)[0]
    control_idx = np.where(T == 0)[0]

    # Common-support filter: drop treated above 0.95 propensity (no real
    # comparable controls); drop controls below 0.05.
    treated_idx = treated_idx[p_hat[treated_idx] < PROPENSITY_TRIM_HIGH]
    control_idx = control_idx[p_hat[control_idx] > PROPENSITY_TRIM_LOW]
    n_dropped = int(np.sum(T) - len(treated_idx) + (T == 0).sum() - len(control_idx))

    if len(treated_idx) < 5 or len(control_idx) < k:
        return {"att": float("nan"), "matched_diffs": np.array([]),
                "caliper": float("nan"), "caliper_drops": 0,
                "n_treated_matched": 0, "n_dropped": n_dropped}

    # Audit re-2026-05-26 P2 (gpt-5 stats F-006): caliper = 0.2·SD(logit p);
    # a treated unit whose nearest control sits outside the caliper is dropped
    # rather than force-matched to a materially different propensity.
    caliper = float(0.2 * np.std(logit_p))

    matched_diffs: list[float] = []
    caliper_drops = 0
    for ti in treated_idx:
        dists = np.abs(logit_p[control_idx] - logit_p[ti])
        order = np.argsort(dists)
        in_cal = dists[order] <= caliper
        nn_idx = order[in_cal][:k]
        if len(nn_idx) == 0:
            caliper_drops += 1
            continue
        nn = control_idx[nn_idx]
        matched_diffs.append(Y[ti] - Y[nn].mean())
    matched_diffs = np.array(matched_diffs)
    att = float(matched_diffs.mean()) if len(matched_diffs) else float("nan")
    return {"att": att, "matched_diffs": matched_diffs, "caliper": caliper,
            "caliper_drops": int(caliper_drops),
            "n_treated_matched": int(len(matched_diffs)), "n_dropped": n_dropped}


def _block_resample_indices(n: int, block_len: int, rng: np.random.Generator) -> np.ndarray:
    """Re-audit 2026-06-07 (stats/gpt-5/F-005): moving-block bootstrap index
    sampler. Returns ~n row indices assembled from contiguous blocks of length
    block_len drawn (with replacement) over calendar order, preserving the
    short-range temporal dependence an i.i.d. resample destroys."""
    if n < block_len:
        return rng.integers(0, n, size=n)
    n_blocks = int(np.ceil(n / block_len))
    starts = rng.integers(0, n - block_len + 1, size=n_blocks)
    idx = (starts[:, None] + np.arange(block_len)[None, :]).reshape(-1)[:n]
    return idx


def estimate_psm(X: np.ndarray, T: np.ndarray, Y: np.ndarray,
                 k: int = PSM_K, n_boot: int = N_BOOTSTRAP_PSM) -> dict:
    """1:k nearest-neighbor propensity matching. Returns ATT + bootstrap CI.

    Re-audit 2026-06-07 (stats/gemini/F-002 + stats/gpt-5/F-005): the bootstrap
    now re-estimates the ENTIRE procedure — propensity fit AND nearest-neighbor
    matching — on each resample, instead of resampling only the final
    matched_diffs. Resampling matched_diffs alone treated the matching and
    propensity model as fixed/known, which ignores their sampling variability
    and produced artificially narrow CIs. In addition, the resample is now a
    7-day BLOCK bootstrap over calendar order (rows arrive in calendar order
    from _prepare_treatment), so the autocorrelation in daily HRV/behavior is
    preserved rather than destroyed by i.i.d. row sampling.
    """
    # Point estimate: full procedure on the observed sample.
    point = _psm_match_once(X, T, Y, k)
    if point is None or point["n_treated_matched"] < 5:
        nm = 0 if point is None else point["n_treated_matched"]
        nd = 0 if point is None else point["n_dropped"]
        cal = float("nan") if point is None else point["caliper"]
        cdr = 0 if point is None else point["caliper_drops"]
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan"),
                "n_treated_matched": int(nm), "n_dropped_common_support": int(nd),
                "caliper_value": cal, "caliper_drops": int(cdr)}

    att = point["att"]

    # Block bootstrap: resample contiguous 7-day blocks of ROWS, then re-run
    # propensity + matching on each resampled dataset. Bootstrap draws that
    # collapse to one arm (or otherwise fail to match) are skipped.
    n = len(T)
    rng = np.random.default_rng(42)
    boot_ates: list[float] = []
    for _ in range(n_boot):
        idx = _block_resample_indices(n, AIPW_BOOTSTRAP_BLOCK_LEN, rng)
        res = _psm_match_once(X[idx], T[idx], Y[idx], k)
        if res is None or res["n_treated_matched"] < 1 or np.isnan(res["att"]):
            continue
        boot_ates.append(res["att"])

    if len(boot_ates) < 100:
        # Too few valid bootstrap draws for a trustworthy CI — report the point
        # estimate with NaN interval rather than a misleadingly tight one.
        return {"ate": att, "ci_low": float("nan"), "ci_high": float("nan"),
                "se": float("nan"),
                "n_treated_matched": point["n_treated_matched"],
                "n_dropped_common_support": point["n_dropped"],
                "caliper_value": point["caliper"],
                "caliper_drops": point["caliper_drops"],
                "n_boot_valid": int(len(boot_ates))}

    boot_ates = np.array(boot_ates)
    ci_low = float(np.percentile(boot_ates, 2.5))
    ci_high = float(np.percentile(boot_ates, 97.5))
    se = float(boot_ates.std(ddof=1))

    return {
        "ate": att,
        "ci_low": ci_low,
        "ci_high": ci_high,
        "se": se,
        "n_treated_matched": point["n_treated_matched"],
        "n_dropped_common_support": point["n_dropped"],
        "caliper_value": point["caliper"],
        "caliper_drops": point["caliper_drops"],
        "n_boot_valid": int(len(boot_ates)),
    }


def _block_bootstrap_ci(psi: np.ndarray, block_len: int = AIPW_BOOTSTRAP_BLOCK_LEN,
                         n_boot: int = N_BOOTSTRAP_AIPW, seed: int = 42,
                         alpha: float = 0.05) -> tuple[float, float]:
    """Block bootstrap CI for the mean of a time-ordered influence-function array.

    Resamples contiguous blocks of length `block_len` with replacement to preserve
    autocorrelation structure. Returns (ci_low, ci_high) at (1-alpha) confidence.

    Audit re-2026-05-26 P2 (gemini stats F-007): psi may carry NaN at index
    positions where the cross-fitting fold was skipped (class imbalance) or
    the upstream row was dropped (e.g. confounder ffill couldn't fill).
    Densifying with ``psi_valid = psi[~isnan(psi)]`` before bootstrapping
    re-glues non-adjacent calendar days, breaking the autocorrelation
    structure the block bootstrap is designed to preserve. The new contract:
    callers pass the FULL psi (calendar-contiguous order, NaN where missing),
    and ``np.nanmean`` over each bootstrap row skips the gaps without
    re-densifying. Bootstrap rows whose 7-day blocks are entirely NaN are
    discarded; if too few survive (<100), we return NaN.

    Returns (NaN, NaN) when fewer than 2*block_len non-NaN psi values exist
    (not enough material for a meaningful block bootstrap).
    """
    ci_low, ci_high, _ = _block_bootstrap_stats(psi, block_len, n_boot, seed, alpha)
    return (ci_low, ci_high)


def _block_bootstrap_stats(psi: np.ndarray, block_len: int = AIPW_BOOTSTRAP_BLOCK_LEN,
                           n_boot: int = N_BOOTSTRAP_AIPW, seed: int = 42,
                           alpha: float = 0.05) -> tuple[float, float, float]:
    """Re-audit 2026-06-07 (stats/gpt-5/F-003 + stats/deepseek/F-001): block
    bootstrap of the IF mean returning (ci_low, ci_high, p_value).

    The p-value is the 2-sided autocorrelation-aware significance level for
    H0: ATE = 0, computed by INVERTING the block-bootstrap distribution of the
    influence-function mean. We recentre the bootstrap means on the observed
    ATE (psi mean) so the distribution approximates the sampling distribution
    of the estimator UNDER THE NULL, then measure the tail mass at/under zero:

        p = 2 · min( P(centred_mean <= 0), P(centred_mean >= 0) ),  clipped to [~0,1].

    This replaces the IF-Wald p (2·(1-Φ(|ate/se_if|))) used by the FDR screen,
    which assumes i.i.d. influence values and is anti-conservative under HRV
    autocorrelation. Returns (NaN, NaN, NaN) when there isn't enough material.
    """
    psi = np.asarray(psi, dtype=float)
    n = len(psi)
    n_valid = int((~np.isnan(psi)).sum())
    if n < 2 * block_len or n_valid < 2 * block_len:
        return (float("nan"), float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    n_blocks = int(np.ceil(n / block_len))
    # Vectorized block resample: pick n_blocks random starting indices, gather contiguous slices.
    starts = rng.integers(0, n - block_len + 1, size=(n_boot, n_blocks))
    # Build the index matrix: for each row, the indices of its sampled blocks concatenated.
    offsets = np.arange(block_len)
    idx_matrix = (starts[:, :, None] + offsets[None, None, :]).reshape(n_boot, -1)[:, :n]
    boot_samples = psi[idx_matrix]
    with np.errstate(invalid="ignore"):
        boot_means = np.nanmean(boot_samples, axis=1)
    boot_means = boot_means[~np.isnan(boot_means)]
    if len(boot_means) < 100:
        return (float("nan"), float("nan"), float("nan"))
    ci_low = float(np.quantile(boot_means, alpha / 2))
    ci_high = float(np.quantile(boot_means, 1 - alpha / 2))

    # 2-sided bootstrap p-value via distribution inversion. Recentre on the
    # observed ATE so the reference distribution is null-consistent, then take
    # the smaller tail at zero. Floor at 1/(B+1) so a p of exactly 0 (no
    # bootstrap draw crossed zero) isn't reported as impossibly significant.
    ate_obs = float(np.nanmean(psi))
    centred = boot_means - ate_obs
    b = len(centred)
    p_left = float(np.mean(centred <= -abs(ate_obs)))
    p_right = float(np.mean(centred >= abs(ate_obs)))
    p_val = 2.0 * min(p_left, p_right)
    p_val = float(min(1.0, max(p_val, 1.0 / (b + 1))))
    return (ci_low, ci_high, p_val)


def estimate_aipw(X: np.ndarray, T: np.ndarray, Y: np.ndarray,
                  n_folds: int = N_FOLDS_AIPW) -> dict:
    """Doubly robust AIPW with k-fold cross-fitting. Returns ATE + IF-based CI."""
    n = len(T)
    if n < n_folds * 4:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan")}

    # TimeSeriesSplit (not shuffled KFold) — HRV is autocorrelated (ρ₁ ≈ 0.4-0.5);
    # shuffled folds let the outcome model see near-future values via hrv_lag1,
    # narrowing the IF variance and overstating CI coverage. Audit finding F-001.
    #
    # Audit re-2026-05-26 P1 (gemini F-004, gpt-5 F-001) follow-up: the
    # StandardScaler is now fit FRESH on the training rows of each fold and
    # applied to that fold's validation rows. The previous full-data scaler
    # leaked the validation fold's mean/variance back into training — small
    # numerical effect on point estimates, but a strict violation of time-
    # respecting cross-fitting. Verified empirically with the existing
    # AIPW shift harness (audit/aipw_shift_findings.md).
    kf = TimeSeriesSplit(n_splits=n_folds)
    psi = np.zeros(n)
    # Audit re-2026-05-26 P2 (gpt-5 stats F-007): track per-fold class-balance
    # skips. Previously NaN'd silently; with sparse treatments many folds can
    # drop without alerting the user. Log once at the end and flag the result
    # as `unreliable` when > 2 of n_folds are skipped.
    fold_failures = 0

    for fold_idx, (train_idx, test_idx) in enumerate(kf.split(X)):
        # Per-fold scaler fit on training rows only (no leakage from val).
        scaler = StandardScaler().fit(X[train_idx])
        Xt = scaler.transform(X[train_idx])
        Xv = scaler.transform(X[test_idx])
        Tt, Yt = T[train_idx], Y[train_idx]

        # Need at least one treated and one control in the training fold to fit
        n_treated_tr = int(Tt.sum())
        n_control_tr = int((Tt == 0).sum())
        if n_treated_tr < 2 or n_control_tr < 2:
            log.warning(
                f"  AIPW fold {fold_idx}: class imbalance "
                f"(T={n_treated_tr}, C={n_control_tr}); skipping"
            )
            fold_failures += 1
            psi[test_idx] = np.nan
            continue

        try:
            ps_model = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=200)
            ps_model.fit(Xt, Tt)
            e = _trim_propensity(ps_model.predict_proba(Xv)[:, 1])

            # Two outcome models, one per arm
            X1, Y1 = Xt[Tt == 1], Yt[Tt == 1]
            X0, Y0 = Xt[Tt == 0], Yt[Tt == 0]
            mu1_model = Ridge(alpha=1.0).fit(X1, Y1)
            mu0_model = Ridge(alpha=1.0).fit(X0, Y0)
            mu1 = mu1_model.predict(Xv)
            mu0 = mu0_model.predict(Xv)

            Tv, Yv = T[test_idx], Y[test_idx]
            psi[test_idx] = (
                mu1 - mu0
                + Tv * (Yv - mu1) / e
                - (1 - Tv) * (Yv - mu0) / (1 - e)
            )
        except Exception as ex:
            log.warning(f"  AIPW fold {fold_idx} failed: {ex}")
            fold_failures += 1
            psi[test_idx] = np.nan

    psi_valid = psi[~np.isnan(psi)]
    if len(psi_valid) < 10:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan"),
                "fold_failures": int(fold_failures), "n_folds": int(n_folds),
                "unreliable": True}

    ate = float(psi_valid.mean())
    se = float(psi_valid.std(ddof=1) / np.sqrt(len(psi_valid)))
    ci_low_if = ate - 1.96 * se
    ci_high_if = ate + 1.96 * se

    # Block-bootstrap CI alongside the IF-based one. Per audit finding F-001
    # follow-up: HRV is autocorrelated; the IF SE assumes i.i.d. influence values,
    # which is violated by hrv_lag1 + temporal residual structure. Block bootstrap
    # over 7-day blocks gives an autocorrelation-aware CI for comparison.
    #
    # Audit re-2026-05-26 P2 (gemini stats F-007): pass the FULL psi (with
    # NaN gaps preserved) so the 7-day blocks correspond to calendar-
    # contiguous days. Densifying via psi_valid would glue non-adjacent days
    # and break the autocorrelation structure the bootstrap relies on.
    # Re-audit 2026-06-07 (stats/gpt-5/F-003 + deepseek/F-001): also derive an
    # autocorrelation-aware 2-sided p-value from the block-bootstrap distribution
    # so the BH-FDR screen no longer relies on the i.i.d. IF-Wald p (which is
    # anti-conservative under HRV autocorrelation). The IF numbers are kept too.
    ci_low_bb, ci_high_bb, p_bb = _block_bootstrap_stats(psi)

    # Compare CI widths. If they diverge meaningfully, the IF SE is unreliable.
    width_if = ci_high_if - ci_low_if
    width_bb = ci_high_bb - ci_low_bb if not np.isnan(ci_low_bb) else float("nan")
    bb_width_ratio = float(width_bb / width_if) if width_if > 0 and not np.isnan(width_bb) else float("nan")

    # AIPW unreliable when > 2 of n_folds were skipped (class imbalance or
    # estimator failure). Frontend renders these with a ⚠ marker similar to
    # the existing low_n badge.
    unreliable = fold_failures > 2

    return {
        "ate": ate,
        "ci_low": ci_low_if,
        "ci_high": ci_high_if,
        "se": se,
        "n_used": int(len(psi_valid)),
        "ci_low_bb": ci_low_bb,
        "ci_high_bb": ci_high_bb,
        "bb_width_ratio": bb_width_ratio,  # bb_width / if_width; >1 means BB is wider (IF too narrow)
        # Re-audit 2026-06-07 (stats/gpt-5/F-003 + deepseek/F-001): block-
        # bootstrap 2-sided p-value (autocorrelation-aware) — the FDR-preferred p.
        "p_bb": p_bb,
        "fold_failures": int(fold_failures),
        "n_folds": int(n_folds),
        "unreliable": bool(unreliable),
    }


# ===========================================================================
# Sensitivity Analysis (E-value)
# ===========================================================================

def compute_e_value(ate: float, ci_low: float, ci_high: float,
                     pooled_sd: float) -> dict:
    """E-value for continuous outcomes via Chinn (2000) d→RR transform.

    Returns the E-value for the point estimate AND for the CI bound nearest
    to the null — the latter is what's usually quoted for robustness.

    Audit P1 fix: previous signature took ci_low only and reused it for both
    positive and negative ATEs. For a negative ATE the bound nearest zero is
    ci_high (the UPPER bound), not ci_low — the old version reported the
    E-value at the FARTHER bound, overstating robustness. Now picks ci_low
    for positive ATE and ci_high for negative ATE explicitly.
    """
    if pooled_sd <= 0 or np.isnan(ate):
        return {"e_value": float("nan"), "e_value_ci": float("nan")}

    def _e(rr: float) -> float:
        if rr < 1:
            rr = 1 / rr
        return float(rr + np.sqrt(rr * (rr - 1)))

    d = ate / pooled_sd
    rr = np.exp(0.91 * d)
    e_point = _e(rr)

    # CI bound nearest the null:
    #   positive ATE → ci_low (lower bound is closer to zero)
    #   negative ATE → ci_high (upper bound is closer to zero)
    # CI crosses the null → E-value collapses to 1.0 (no robustness).
    if ate > 0:
        if ci_low <= 0:
            e_ci = 1.0
        else:
            d_ci = ci_low / pooled_sd
            e_ci = _e(np.exp(0.91 * d_ci))
    else:
        if ci_high >= 0:
            e_ci = 1.0
        else:
            d_ci = ci_high / pooled_sd  # negative; _e handles rr<1
            e_ci = _e(np.exp(0.91 * d_ci))

    return {"e_value": e_point, "e_value_ci": e_ci}


# ===========================================================================
# Pipeline
# ===========================================================================

def _build_outcome_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Create a copy of df with the next-night outcome column attached."""
    out = df.copy()
    if OUTCOME_COL not in out.columns:
        # Same convention as prepare_ml_data: outcome is the next day's HRV
        target_col = "whoop_hrv_rmssd"
        if target_col not in out.columns:
            raise RuntimeError(f"Outcome target {target_col} missing from feature matrix")
        out = out.sort_values(ALIGN_KEY).reset_index(drop=True)
        out[OUTCOME_COL] = out[target_col].shift(-1)
    return out


_CONFOUNDER_MISSING_WARNED: set[str] = set()


def _confounders_for(family: str, available_cols: set[str]) -> list[str]:
    """Pick the confounder set for a treatment family, dropping any that
    aren't in the matrix.

    Logs a one-shot warning per family if any declared confounder is missing
    (audit Finding #11 — previously they were silently dropped, so a schema
    rename of e.g. sleep_debt_7d would degrade adjustment quality without notice).
    """
    base = list(COMMON_CONFOUNDERS)
    if family == "supplement":
        base += list(SUPPLEMENT_EXTRA_CONFOUNDERS)
    kept = [c for c in base if c in available_cols]
    missing = [c for c in base if c not in available_cols]
    if missing and family not in _CONFOUNDER_MISSING_WARNED:
        log.warning(
            f"Causal: family={family!r} is missing declared confounders {missing} "
            f"from the matrix; adjustment quality degraded. Used: {kept}"
        )
        _CONFOUNDER_MISSING_WARNED.add(family)
    return kept


def _enumerate_binary_treatments(df: pd.DataFrame) -> list[TreatmentSpec]:
    """Find all binary treatment candidates in the feature matrix:
    journal_*, habit_*, supplement_*_amount (binarized to taken/not)."""
    specs: list[TreatmentSpec] = []
    available = set(df.columns)

    # Journal — every journal_ column that's truly 0/1
    for col in df.columns:
        if col.startswith("journal_") and not col.endswith("_lag1"):
            vals = df[col].dropna().unique()
            if set(vals).issubset({0, 1, 0.0, 1.0}):
                label = col.replace("journal_", "").replace("_", " ").title()
                specs.append(TreatmentSpec(
                    name=col, family="journal", label=label,
                    confounders=tuple(_confounders_for("journal", available)),
                    kind="binary",
                ))

    # Habits
    for col in df.columns:
        if col.startswith("habit_") and not col.endswith("_lag1"):
            vals = df[col].dropna().unique()
            if set(vals).issubset({0, 1, 0.0, 1.0}):
                label = col.replace("habit_", "").replace("_", " ").title()
                specs.append(TreatmentSpec(
                    name=col, family="habit", label=label,
                    confounders=tuple(_confounders_for("habit", available)),
                    kind="binary",
                ))

    # Supplements — binarize amount column to taken (>0) / not
    for col in df.columns:
        if col.startswith("supplement_") and col.endswith("_amount"):
            # extract compound name from supplement_<compound>_amount
            compound = col[len("supplement_"):-len("_amount")]
            label = compound.replace("_", " ").title()
            specs.append(TreatmentSpec(
                name=col, family="supplement", label=label,
                confounders=tuple(_confounders_for("supplement", available)),
                kind="binary",
            ))

    # Explicit behavior binaries (had_evening_workout, is_run_day, is_rest_day)
    for col, family, label in EXPLICIT_BINARY_TREATMENTS:
        if col in df.columns:
            vals = df[col].dropna().unique()
            if set(vals).issubset({0, 1, 0.0, 1.0}):
                specs.append(TreatmentSpec(
                    name=col, family=family, label=label,
                    confounders=tuple(_confounders_for(family, available)),
                    kind="binary",
                ))

    return specs


def _enumerate_continuous_treatments(df: pd.DataFrame) -> list[TreatmentSpec]:
    """Continuous treatments are binarized at their personal median and
    treated as 'above median' contrasts."""
    specs: list[TreatmentSpec] = []
    available = set(df.columns)
    for col, family, label, unit in CONTINUOUS_TREATMENTS:
        if col in df.columns:
            specs.append(TreatmentSpec(
                name=col, family=family, label=label,
                confounders=tuple(_confounders_for(family, available)),
                kind="continuous_median_split",
                unit=unit,
            ))
    return specs


def _prepare_treatment(df: pd.DataFrame, spec: TreatmentSpec) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict] | None:
    """Build (X, T, Y) arrays for one treatment + a metadata dict.
    Returns None if there isn't enough data.

    Tracking-window semantics for supplements:
      build_feature_matrix already fills NaN→0 for dates within the supplement
      tracking window and leaves pre-tracking dates as NaN. The dropna(subset=
      [spec.name, ...]) below therefore handles the window restriction
      automatically — we don't slice here, which would incorrectly drop
      in-window days when the compound wasn't taken (those are valid controls).
    """
    # Drop the treatment column from confounders if it appears there — happens
    # e.g. when rolling_7d_training_load is the treatment AND in the common
    # confounder set, which would perfectly separate the propensity model.
    confounders = tuple(c for c in spec.confounders if c != spec.name)

    # Re-audit 2026-06-07 (stats/gemini/F-003): for multi-day rolling/aggregate
    # treatments, the lagged-HRV / lagged-strain / weekly-HRV-mean confounders
    # are MEDIATORS (training load on day N-2 → HRV on night N-1 → outcome), or
    # are window-overlapping aggregates of the treatment's own days. Adjusting
    # for a mediator blocks part of the effect being estimated. Drop those
    # intermediate variables from the confounder set for these treatments only.
    if spec.name in ROLLING_AGGREGATE_TREATMENTS:
        confounders = tuple(
            c for c in confounders if c not in ROLLING_TREATMENT_MEDIATOR_CONFOUNDERS
        )

    cols_needed = [spec.name, OUTCOME_COL] + list(confounders)
    sub = df[cols_needed].copy()

    # Audit re-2026-05-26 P1 (deepseek F-003 + gemini F-006): ffill confounders
    # on the FULL daily spine BEFORE filtering for missing treatment/outcome.
    # Previously, the pipeline dropped rows for missing outcome first and then
    # ffilled — which made the ffill window count "rows since last observed
    # day with HRV" instead of "actual previous calendar day". Days where HRV
    # was missing were silently treated as absent, so a 2-day-gap with two
    # missing HRV nights ffilled across what was really 4 calendar days. The
    # order swap below preserves the bfill-prohibition (temporal ordering for
    # AIPW identification, audit finding F-003) while making the ffill window
    # mean what it says.
    if confounders:
        # Re-audit 2026-06-07 (stats/gpt-5/F-007): ffill horizon is now per-
        # confounder (was hard-coded limit=2). Weekly aggregates (rolling load,
        # sleep debt, hrv_7d_mean) get a 7-day carry-forward since they're slow-
        # moving and legitimately stable across a week; daily lag-1 confounders
        # keep the conservative 2-day fill so stale values aren't smeared across
        # long gaps. Filling each column with its own limit rather than one
        # global value avoids dropping rows in early-tracking/sparse periods.
        for c in confounders:
            sub[c] = sub[c].ffill(limit=_confounder_ffill_limit(c))

    n_pre_drop = int(len(sub))
    # Drop rows with missing outcome or treatment
    sub = sub.dropna(subset=[spec.name, OUTCOME_COL])
    n_after_outcome_drop = int(len(sub))

    # Build treatment vector
    if spec.kind == "binary":
        T = (sub[spec.name].fillna(0) > 0).astype(int).values
    else:  # continuous_median_split
        med = sub[spec.name].median()
        T = (sub[spec.name] > med).astype(int).values

    # Outcome
    Y = sub[OUTCOME_COL].astype(float).values

    # Confounders already ffilled above; this is just the alignment slice.
    X_df = sub[list(confounders)].copy()
    keep_mask = X_df.notna().all(axis=1).values
    n_dropped_confounder = int((~keep_mask).sum())
    # Re-audit 2026-06-07 (stats/gpt-5/F-004): replace the ordinal day_of_week
    # column with cyclic sin/cos terms AFTER the completeness mask is computed
    # from the raw confounders (so the mask still reflects original missingness)
    # but BEFORE handing X to the propensity / outcome models. This removes the
    # implicit "weekdays differ by a constant linear step" assumption.
    X_df = _expand_cyclic_day_of_week(X_df)
    X_df = X_df.loc[keep_mask]
    T = T[keep_mask]
    Y = Y[keep_mask]

    n_treated = int(T.sum())
    n_control = int((T == 0).sum())
    fraction_dropped = (
        float(n_dropped_confounder) / float(n_after_outcome_drop)
        if n_after_outcome_drop > 0
        else 0.0
    )
    meta = {
        "n_total": int(len(T)),
        "n_treated": n_treated,
        "n_control": n_control,
        "treatment_prevalence": float(T.mean()) if len(T) else 0.0,
        # Audit re-2026-05-26 P1 (deepseek F-005): expose confounder-loss
        # diagnostics so dropped_low_n can flag treatments where confounders
        # rather than per-arm cell-size drove the exclusion.
        "n_pre_drop": n_pre_drop,
        "n_after_outcome_drop": n_after_outcome_drop,
        "n_dropped_for_confounder_missing": n_dropped_confounder,
        "fraction_dropped_confounder": fraction_dropped,
    }
    if fraction_dropped > 0.10:
        log.warning(
            f"  Causal {spec.name!r}: confounder ffill dropped "
            f"{n_dropped_confounder}/{n_after_outcome_drop} rows "
            f"({fraction_dropped:.1%}) — early-tracking periods may be lost"
        )
    if n_treated < MIN_BINARY_PER_ARM_REPORT or n_control < MIN_BINARY_PER_ARM_REPORT:
        return X_df.values, T, Y, {**meta, "too_few_obs": True}

    # Continuous treatments get an additional floor on total non-null observations
    # (post median-split). Audit Finding #10 — gate was declared but unused.
    if spec.kind == "continuous_median_split" and len(T) < MIN_CONTINUOUS_N:
        return X_df.values, T, Y, {
            **meta,
            "too_few_obs": True,
            "reason_detail": f"continuous n={len(T)} < MIN_CONTINUOUS_N={MIN_CONTINUOUS_N}",
        }

    return X_df.values, T, Y, meta


def _estimate_one(X: np.ndarray, T: np.ndarray, Y: np.ndarray) -> dict:
    """Run all three estimators for one treatment."""
    naive = estimate_naive(T, Y)
    psm = estimate_psm(X, T, Y)
    aipw = estimate_aipw(X, T, Y)

    pooled_sd = float(Y.std(ddof=1)) if len(Y) > 1 else float("nan")
    ev = compute_e_value(aipw["ate"], aipw["ci_low"], aipw["ci_high"], pooled_sd)

    return {
        "naive": naive,
        "psm": psm,
        "aipw": aipw,
        "sensitivity": ev,
        "pooled_outcome_sd": pooled_sd,
    }


def _significance_flags(aipw: dict) -> dict:
    """Determine whether AIPW estimate excludes zero."""
    ci_low = aipw.get("ci_low", float("nan"))
    ci_high = aipw.get("ci_high", float("nan"))
    if np.isnan(ci_low) or np.isnan(ci_high):
        return {"significant": False, "direction": "none"}
    significant = (ci_low > 0) or (ci_high < 0)
    if not significant:
        direction = "null"
    elif ci_low > 0:
        direction = "positive"
    else:
        direction = "negative"
    return {"significant": bool(significant), "direction": direction}


def run_causal_battery(df: pd.DataFrame, supplements: pd.DataFrame | None = None) -> dict:
    """Top-level entry. Returns the full causal-results payload."""
    if not HAS_SKLEARN:
        log.warning("  Causal inference: sklearn not available; skipping")
        return {}

    out = _build_outcome_frame(df)
    available = set(out.columns)
    binary_specs = _enumerate_binary_treatments(out)
    continuous_specs = _enumerate_continuous_treatments(out)

    log.info(f"  Causal inference: {len(binary_specs)} binary + {len(continuous_specs)} "
             f"continuous treatments enumerated")

    binary_results: list[dict] = []
    continuous_results: list[dict] = []
    dropped_low_n: list[dict] = []

    for spec in binary_specs + continuous_specs:
        prep = _prepare_treatment(out, spec)
        if prep is None:
            continue
        X, T, Y, meta = prep
        if meta.get("too_few_obs"):
            # Prefer the specific reason (e.g. continuous-n gate) when set,
            # otherwise fall back to the binary per-arm gate text.
            reason = meta.get("reason_detail") or (
                f"n_treated<{MIN_BINARY_PER_ARM_REPORT} or n_control<{MIN_BINARY_PER_ARM_REPORT}"
            )
            # Audit re-2026-05-26 P1: when the per-arm gate would have passed
            # before the confounder-ffill drop, surface that so the UI can
            # distinguish "data ran out" from "confounders incomplete in
            # tracking window."
            n_dropped_cf = int(meta.get("n_dropped_for_confounder_missing", 0))
            frac_cf = float(meta.get("fraction_dropped_confounder", 0.0))
            dropped_low_n.append({
                "treatment": spec.name, "family": spec.family, "label": spec.label,
                "n_treated": meta["n_treated"], "n_control": meta["n_control"],
                "reason": reason,
                "n_after_outcome_drop": int(meta.get("n_after_outcome_drop", 0)),
                "n_dropped_for_confounder_missing": n_dropped_cf,
                "fraction_dropped_confounder": frac_cf,
            })
            continue

        try:
            est = _estimate_one(X, T, Y)
        except Exception as ex:
            log.warning(f"  Estimator failed for {spec.name}: {ex}")
            continue

        flags = _significance_flags(est["aipw"])
        low_n = meta["n_treated"] < MIN_BINARY_PER_ARM_FULL or meta["n_control"] < MIN_BINARY_PER_ARM_FULL

        result_row = {
            "treatment": spec.name,
            "family": spec.family,
            "label": spec.label,
            "kind": spec.kind,
            "unit": spec.unit,
            "confounders": list(spec.confounders),
            "naive_ate": est["naive"]["ate"],
            "naive_ci_low": est["naive"]["ci_low"],
            "naive_ci_high": est["naive"]["ci_high"],
            "psm_ate": est["psm"]["ate"],
            "psm_ci_low": est["psm"]["ci_low"],
            "psm_ci_high": est["psm"]["ci_high"],
            "aipw_ate": est["aipw"]["ate"],
            "aipw_ci_low": est["aipw"]["ci_low"],
            "aipw_ci_high": est["aipw"]["ci_high"],
            "aipw_se": est["aipw"]["se"],
            # Block-bootstrap CI (autocorrelation-aware sanity check) — reported
            # alongside the IF CI. bb_width_ratio > 1 means the IF CI is too
            # narrow relative to what the temporal structure of psi justifies.
            "aipw_ci_low_bb": est["aipw"].get("ci_low_bb"),
            "aipw_ci_high_bb": est["aipw"].get("ci_high_bb"),
            "aipw_bb_width_ratio": est["aipw"].get("bb_width_ratio"),
            # Re-audit 2026-06-07 (stats/gpt-5/F-003 + deepseek/F-001): block-
            # bootstrap p-value (autocorrelation-aware), the FDR-preferred p.
            "aipw_p_bb": est["aipw"].get("p_bb"),
            # Audit re-2026-05-26 P2 (gpt-5 F-007): per-treatment fold-failure
            # accounting + unreliable flag for AIPW cross-fitting.
            "aipw_fold_failures": est["aipw"].get("fold_failures", 0),
            "aipw_n_folds": est["aipw"].get("n_folds", N_FOLDS_AIPW),
            "aipw_unreliable": bool(est["aipw"].get("unreliable", False)),
            # PSM caliper bookkeeping (gpt-5 F-006).
            "psm_caliper_value": est["psm"].get("caliper_value"),
            "psm_caliper_drops": est["psm"].get("caliper_drops", 0),
            "e_value": est["sensitivity"]["e_value"],
            "e_value_ci": est["sensitivity"]["e_value_ci"],
            "n_treated": meta["n_treated"],
            "n_control": meta["n_control"],
            "n_total": meta["n_total"],
            "treatment_prevalence": meta["treatment_prevalence"],
            "low_n": bool(low_n),
            "significant": flags["significant"],
            "direction": flags["direction"],
            "attenuation_pct": _attenuation(est["naive"]["ate"], est["aipw"]["ate"]),
            "pooled_outcome_sd": est["pooled_outcome_sd"],
        }
        if spec.kind == "binary":
            binary_results.append(result_row)
        else:
            continuous_results.append(result_row)

    # BH-FDR across the joint binary + continuous family. Audit re-2026-05-26
    # finding stats/gemini/F-002 (P0): ~150 simultaneous AIPW estimates at
    # alpha=0.05 produce ~7-8 false-positive interventions by chance unless
    # multiple-testing-corrected. Journal / habit / supplement / nutrition
    # Welch tests in hrv_analysis.py have been BH-corrected since 2026-05-21;
    # the causal layer was the last uncorrected test family.
    #
    # Re-audit 2026-06-07 (stats/gpt-5/F-003 + deepseek/F-001): the FDR screen
    # now derives each per-treatment p from the BLOCK-BOOTSTRAP distribution of
    # the ATE (aipw_p_bb), which preserves the HRV autocorrelation the IF-based
    # Wald p (2·(1-Φ(|ate/se_if|))) wrongly assumes away. The IF-Wald p is still
    # computed and stored (p_raw_if) for comparison, and is used as a FALLBACK
    # only when the bootstrap p couldn't be formed (too few valid bootstrap
    # draws). We pool binary + continuous into one family because both answer
    # the same decision question ("which intervention should I make?").
    all_results = binary_results + continuous_results
    # Suppress an FDR pass when the block-bootstrap CI is much wider than the IF
    # CI (aipw_bb_width_ratio >> 1): that signals the IF SE — and any inference
    # leaning on it — is too narrow because of temporal dependence. Even with a
    # bootstrap p, a ratio this extreme means the estimate is fragile; we keep
    # the q-value but withhold the binary "passes" flag.
    BB_WIDTH_RATIO_SUPPRESS = 2.0
    if HAS_FDR and all_results:
        p_raws: list[float] = []       # p used for FDR (bootstrap-preferred)
        p_raws_if: list[float] = []    # IF-Wald p, stored alongside for comparison
        p_sources: list[str] = []
        for r in all_results:
            ate = r.get("aipw_ate")
            se = r.get("aipw_se")
            if (ate is None or se is None
                    or (isinstance(ate, float) and np.isnan(ate))
                    or (isinstance(se, float) and np.isnan(se))
                    or se <= 0):
                p_if = float("nan")
            else:
                z = abs(float(ate) / float(se))
                p_if = float(2.0 * (1.0 - norm.cdf(z)))
            p_raws_if.append(p_if)

            # Prefer the autocorrelation-aware bootstrap p; fall back to IF-Wald.
            p_bb = r.get("aipw_p_bb")
            if p_bb is not None and not (isinstance(p_bb, float) and np.isnan(p_bb)):
                p_raws.append(float(p_bb))
                p_sources.append("block_bootstrap")
            else:
                p_raws.append(p_if)
                p_sources.append("if_wald_fallback")

        valid_idx = [i for i, p in enumerate(p_raws) if not np.isnan(p)]
        if valid_idx:
            valid_ps = [p_raws[i] for i in valid_idx]
            reject, p_adj, *_ = multipletests(valid_ps, alpha=FDR_Q_THRESHOLD,
                                              method="fdr_bh")
            adj_by_idx = {i: (float(q), bool(ok))
                          for i, q, ok in zip(valid_idx, p_adj, reject)}
        else:
            adj_by_idx = {}

        n_pass = 0
        n_suppressed = 0
        for i, r in enumerate(all_results):
            q, ok = adj_by_idx.get(i, (float("nan"), False))
            r["p_raw"] = p_raws[i]
            r["p_raw_if"] = p_raws_if[i]
            r["p_source"] = p_sources[i]
            r["p_fdr_adjusted"] = q
            # Width-ratio suppression: a hugely wider bootstrap CI means the
            # inference is unreliable regardless of which p won — withhold pass.
            ratio = r.get("aipw_bb_width_ratio")
            suppress = (ratio is not None
                        and not (isinstance(ratio, float) and np.isnan(ratio))
                        and float(ratio) >= BB_WIDTH_RATIO_SUPPRESS)
            if ok and suppress:
                ok = False
                n_suppressed += 1
            r["passes_fdr"] = ok
            r["fdr_suppressed_by_bb_width"] = bool(suppress)
            if ok:
                n_pass += 1
        log.info(f"  Causal BH-FDR (q<={FDR_Q_THRESHOLD}, p=block-bootstrap): "
                 f"{n_pass}/{len(all_results)} treatments survive "
                 f"({n_suppressed} suppressed by bb_width_ratio>={BB_WIDTH_RATIO_SUPPRESS})")
    else:
        # No statsmodels/scipy available — mark every row as un-evaluated so
        # downstream consumers can detect the gap explicitly.
        for r in all_results:
            r.setdefault("p_raw", float("nan"))
            r.setdefault("p_fdr_adjusted", float("nan"))
            r.setdefault("passes_fdr", False)
        if not HAS_FDR:
            log.warning("  Causal BH-FDR skipped: scipy/statsmodels unavailable")

    # Sort by absolute AIPW ATE so the strongest effects float to the top.
    binary_results.sort(key=lambda r: -abs(r.get("aipw_ate") or 0.0))
    continuous_results.sort(key=lambda r: -abs(r.get("aipw_ate") or 0.0))

    dag_payload = {
        "common_confounders": list(COMMON_CONFOUNDERS),
        "supplement_extra_confounders": list(SUPPLEMENT_EXTRA_CONFOUNDERS),
        "outcome": OUTCOME_COL,
        "outcome_description": "Next-night WHOOP HRV (RMSSD, ms)",
        "treatment_families": ["journal", "habit", "supplement", "nutrition", "behavior"],
        "mediator_exclusions": [
            "Any same-night sleep, recovery, or HRV-derived variable. These "
            "lie on the causal path from treatment to outcome; adjusting for "
            "them would block the very effect we are estimating (mediator-"
            "adjustment bias).",
            # Re-audit 2026-06-07 (stats/gemini/F-003)
            "For multi-day rolling/aggregate treatments (rolling_3d/7d load, "
            "acute/chronic load, ATL/CTL ratio, total training load), hrv_lag1, "
            "hrv_7d_mean and whoop_day_strain_lag1 are dropped from the "
            "confounder set: they are mediators for the earlier days inside the "
            "treatment window (load on day N-2 → HRV on night N-1 → outcome) or "
            "window-overlapping aggregates of the treatment's own days.",
        ],
        # Re-audit 2026-06-07 (stats/gpt-5/F-004): day_of_week is expanded into
        # cyclic sin/cos terms before the propensity + outcome models, replacing
        # the previous ordinal 0-6 encoding (which assumed a linear weekday effect).
        "encoding_notes": [
            "day_of_week entered as cyclic (sin, cos) terms, not an ordinal 0-6.",
        ],
        # Re-audit 2026-06-07 (stats/gpt-5/F-007): confounder ffill horizon is
        # per-family — 7 days for weekly aggregates (rolling load, sleep debt,
        # hrv_7d_mean), 2 days for daily lag-1 confounders.
        "confounder_ffill_horizon_days": {
            "weekly_aggregates": CONFOUNDER_FFILL_WEEKLY,
            "daily_lag1": CONFOUNDER_FFILL_DEFAULT,
        },
        "estimand": "ATE (population average) for AIPW; ATT (effect on the treated) for PSM",
        "identifying_assumptions": [
            "Conditional ignorability: treatment is independent of potential outcomes given the listed confounders.",
            "Positivity (common support): every confounder profile has non-trivial probability of both treatment values (enforced via propensity trimming to [0.05, 0.95]).",
            "SUTVA: no interference between days; one day's behavior doesn't affect another day's outcome (mild violation for chronic adherence patterns — interpret with care).",
        ],
        "sensitivity": {
            "method": "E-value (VanderWeele & Ding 2017) — minimum strength on the risk-ratio scale that an unmeasured confounder would need to share with both treatment and outcome to fully explain the estimate away.",
            "transform": "Continuous outcome: Cohen's d → RR ≈ exp(0.91·d) via Chinn (2000), then E = RR + sqrt(RR·(RR-1)).",
        },
    }

    meta_payload = {
        "outcome": OUTCOME_COL,
        "n_binary_treatments_analyzed": len(binary_results),
        "n_continuous_treatments_analyzed": len(continuous_results),
        "n_treatments_dropped_low_n": len(dropped_low_n),
        "estimators": ["naive_welch", "psm_nn_propensity", "aipw_cross_fit"],
        "psm_k": PSM_K,
        "psm_bootstrap_reps": N_BOOTSTRAP_PSM,
        # Re-audit 2026-06-07 (stats/gemini/F-002 + stats/gpt-5/F-005): PSM CI is
        # now a 7-day BLOCK bootstrap that re-fits propensity + re-runs matching
        # on each resample (not an i.i.d. resample of the final matched_diffs).
        "psm_bootstrap": "block(7d)_refit_propensity_and_match",
        "aipw_n_folds": N_FOLDS_AIPW,
        "propensity_trim": [PROPENSITY_TRIM_LOW, PROPENSITY_TRIM_HIGH],
        "min_per_arm_full": MIN_BINARY_PER_ARM_FULL,
        "min_per_arm_reported": MIN_BINARY_PER_ARM_REPORT,
        # Multiple-testing correction applied across the binary+continuous union
        "multiple_testing": {
            "method": "BH-FDR",
            "family": "binary + continuous (one family)",
            "q_threshold": FDR_Q_THRESHOLD,
            # Re-audit 2026-06-07 (stats/gpt-5/F-003 + deepseek/F-001)
            "p_source": "block-bootstrap 2-sided p of the AIPW ATE (7d blocks); "
                        "IF-Wald |ate/se_if| vs N(0,1) kept as p_raw_if and used "
                        "only as fallback when the bootstrap p is unavailable",
            "passes_fdr_suppressed_when": "aipw_bb_width_ratio >= 2.0 "
                        "(IF inference too narrow under temporal dependence)",
        },
    }

    return {
        "binary_treatments": binary_results,
        "continuous_treatments": continuous_results,
        "dropped_low_n": dropped_low_n,
        "dag": dag_payload,
        "meta": meta_payload,
    }


def _attenuation(naive: float, adjusted: float) -> float | None:
    """% by which adjustment shrinks (or grows) the naive estimate.
    Positive = adjustment shrunk the effect toward zero (confounding was
    inflating the naive estimate). Negative = adjustment grew it
    (confounding was masking it)."""
    if naive == 0 or naive is None or adjusted is None:
        return None
    return float((abs(naive) - abs(adjusted)) / abs(naive) * 100.0)
