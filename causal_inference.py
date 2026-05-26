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
    # ── Nutrition (MyFitnessPal) ─────────────────────────────────────────────
    ("mfp_calories",        "nutrition", "Calories above median",        "kcal"),
    ("mfp_protein_g",       "nutrition", "Protein above median",         "g"),
    ("mfp_carbs_g",         "nutrition", "Carbs above median",           "g"),
    ("mfp_fat_g",           "nutrition", "Fat above median",             "g"),
    ("mfp_fiber_g",         "nutrition", "Fiber above median",           "g"),
    ("mfp_sugar_g",         "nutrition", "Sugar above median",           "g"),
    ("mfp_sodium_mg",       "nutrition", "Sodium above median",          "mg"),
    ("mfp_water_ml",        "nutrition", "Water intake above median",    "ml"),
    ("exercise_kcal",       "nutrition", "Exercise kcal above median",   "kcal"),
    ("net_calories",        "nutrition", "Net calories above median",    "kcal"),
    ("protein_pct",         "nutrition", "Protein % of cals above median", "%"),
    ("carb_pct",            "nutrition", "Carb % of cals above median",  "%"),
    ("fat_pct",             "nutrition", "Fat % of cals above median",   "%"),

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
    ("is_run_day",          "behavior", "Run day (any run logged)"),
    ("is_rest_day",         "behavior", "Rest day (no workouts)"),
    ("negative_split",      "behavior", "Negative split (second half faster)"),
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


def estimate_psm(X: np.ndarray, T: np.ndarray, Y: np.ndarray,
                 k: int = PSM_K, n_boot: int = N_BOOTSTRAP_PSM) -> dict:
    """1:k nearest-neighbor propensity matching. Returns ATT + bootstrap CI."""
    X_std = _standardize(X)
    p_hat = _fit_propensity(X_std, T)
    logit_p = np.log(p_hat / (1 - p_hat))

    treated_idx = np.where(T == 1)[0]
    control_idx = np.where(T == 0)[0]

    # Common-support filter: drop treated above 0.95 propensity (no real
    # comparable controls); drop controls below 0.05.
    in_support = (p_hat[treated_idx] < PROPENSITY_TRIM_HIGH)
    treated_idx = treated_idx[in_support]
    control_in_support = (p_hat[control_idx] > PROPENSITY_TRIM_LOW)
    control_idx = control_idx[control_in_support]

    if len(treated_idx) < 5 or len(control_idx) < k:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan"),
                "n_treated_matched": 0, "n_dropped_common_support": 0}

    # For each treated, k nearest controls on logit propensity
    matched_diffs = []
    for ti in treated_idx:
        dists = np.abs(logit_p[control_idx] - logit_p[ti])
        nn = control_idx[np.argsort(dists)[:k]]
        matched_diffs.append(Y[ti] - Y[nn].mean())
    matched_diffs = np.array(matched_diffs)

    att = float(matched_diffs.mean())

    # Paired bootstrap on matched pairs
    boot_ates = []
    n = len(matched_diffs)
    for _ in range(n_boot):
        sample = RNG.choice(matched_diffs, size=n, replace=True)
        boot_ates.append(sample.mean())
    boot_ates = np.array(boot_ates)
    ci_low = float(np.percentile(boot_ates, 2.5))
    ci_high = float(np.percentile(boot_ates, 97.5))
    se = float(boot_ates.std(ddof=1))

    n_dropped = int(np.sum(T) - len(treated_idx) + (T == 0).sum() - len(control_idx))
    return {
        "ate": att,
        "ci_low": ci_low,
        "ci_high": ci_high,
        "se": se,
        "n_treated_matched": int(len(treated_idx)),
        "n_dropped_common_support": n_dropped,
    }


def estimate_aipw(X: np.ndarray, T: np.ndarray, Y: np.ndarray,
                  n_folds: int = N_FOLDS_AIPW) -> dict:
    """Doubly robust AIPW with k-fold cross-fitting. Returns ATE + IF-based CI."""
    n = len(T)
    if n < n_folds * 4:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan")}

    X_std = _standardize(X)
    # TimeSeriesSplit (not shuffled KFold) — HRV is autocorrelated (ρ₁ ≈ 0.4-0.5);
    # shuffled folds let the outcome model see near-future values via hrv_lag1,
    # narrowing the IF variance and overstating CI coverage. Audit finding F-001.
    kf = TimeSeriesSplit(n_splits=n_folds)
    psi = np.zeros(n)

    for train_idx, test_idx in kf.split(X_std):
        Xt, Tt, Yt = X_std[train_idx], T[train_idx], Y[train_idx]
        Xv = X_std[test_idx]

        # Need at least one treated and one control in the training fold to fit
        if Tt.sum() < 2 or (Tt == 0).sum() < 2:
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
            log.warning(f"  AIPW fold failed: {ex}")
            psi[test_idx] = np.nan

    psi_valid = psi[~np.isnan(psi)]
    if len(psi_valid) < 10:
        return {"ate": float("nan"), "ci_low": float("nan"),
                "ci_high": float("nan"), "se": float("nan")}

    ate = float(psi_valid.mean())
    se = float(psi_valid.std(ddof=1) / np.sqrt(len(psi_valid)))
    return {
        "ate": ate,
        "ci_low": ate - 1.96 * se,
        "ci_high": ate + 1.96 * se,
        "se": se,
        "n_used": int(len(psi_valid)),
    }


# ===========================================================================
# Sensitivity Analysis (E-value)
# ===========================================================================

def compute_e_value(ate: float, ci_low: float, pooled_sd: float) -> dict:
    """E-value for continuous outcomes via Chinn (2000) d→RR transform.

    Returns the E-value for the point estimate AND for the CI bound nearest
    to the null — the latter is what's usually quoted for robustness.
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

    # E-value for the CI bound nearest the null
    if ate > 0:
        d_ci = ci_low / pooled_sd
    else:
        d_ci = -ci_low / pooled_sd if ci_low < 0 else 0.0
    rr_ci = np.exp(0.91 * abs(d_ci))
    if (ate > 0 and ci_low <= 0) or (ate < 0 and ci_low >= 0):
        e_ci = 1.0  # CI crosses null
    else:
        e_ci = _e(rr_ci)

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

    cols_needed = [spec.name, OUTCOME_COL] + list(confounders)
    sub = df[cols_needed].copy()

    # Drop rows with missing outcome or treatment
    sub = sub.dropna(subset=[spec.name, OUTCOME_COL])

    # Build treatment vector
    if spec.kind == "binary":
        T = (sub[spec.name].fillna(0) > 0).astype(int).values
    else:  # continuous_median_split
        med = sub[spec.name].median()
        T = (sub[spec.name] > med).astype(int).values

    # Outcome
    Y = sub[OUTCOME_COL].astype(float).values

    # Confounders — forward-fill only; bfill would pull future values into past
    # confounders, violating temporal ordering required for AIPW identification.
    # Audit finding F-003.
    X_df = sub[list(confounders)].copy()
    X_df = X_df.ffill(limit=2)
    keep_mask = X_df.notna().all(axis=1).values
    X_df = X_df.loc[keep_mask]
    T = T[keep_mask]
    Y = Y[keep_mask]

    n_treated = int(T.sum())
    n_control = int((T == 0).sum())
    meta = {
        "n_total": int(len(T)),
        "n_treated": n_treated,
        "n_control": n_control,
        "treatment_prevalence": float(T.mean()) if len(T) else 0.0,
    }
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
    ev = compute_e_value(aipw["ate"], aipw["ci_low"], pooled_sd)

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
            dropped_low_n.append({
                "treatment": spec.name, "family": spec.family, "label": spec.label,
                "n_treated": meta["n_treated"], "n_control": meta["n_control"],
                "reason": reason,
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
        ],
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
        "aipw_n_folds": N_FOLDS_AIPW,
        "propensity_trim": [PROPENSITY_TRIM_LOW, PROPENSITY_TRIM_HIGH],
        "min_per_arm_full": MIN_BINARY_PER_ARM_FULL,
        "min_per_arm_reported": MIN_BINARY_PER_ARM_REPORT,
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
