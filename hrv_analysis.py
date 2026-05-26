#!/usr/bin/env python3
"""
Onyx HRV Deep Analysis Pipeline  — Phases 1–3.5
=================================================
Data pipeline, feature engineering, statistical analysis,
XGBoost / SARIMAX / Prophet prediction models, walk-forward evaluation,
and storage of all results in Supabase.

Usage
-----
    pip install -r requirements-analysis.txt
    python hrv_analysis.py
    python hrv_analysis.py --skip-analysis    # skip stat plots
    python hrv_analysis.py --skip-models      # skip ML (data + analysis only)
"""

import argparse
import json
import logging
import os
import pickle
import sys
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # headless backend
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd
import seaborn as sns
from dotenv import load_dotenv
from scipy import stats
from supabase import create_client

# ---------------------------------------------------------------------------
# Optional heavy dependencies – each guarded so the script degrades gracefully
# ---------------------------------------------------------------------------
try:
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

try:
    from xgboost import XGBRegressor
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    print("WARNING: xgboost not installed - skipping XGBoost model")

try:
    import shap
    HAS_SHAP = True
except ImportError:
    HAS_SHAP = False

try:
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    from statsmodels.graphics.tsaplots import plot_acf, plot_pacf
    from statsmodels.tsa.stattools import grangercausalitytests, adfuller
    HAS_STATSMODELS = True
except ImportError:
    HAS_STATSMODELS = False
    print("WARNING: statsmodels not installed - skipping SARIMAX & Granger")

try:
    from prophet import Prophet
    HAS_PROPHET = True
except ImportError:
    HAS_PROPHET = False
    print("WARNING: prophet not installed - skipping Prophet model")

try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except ImportError:
    HAS_OPTUNA = False

try:
    import pingouin as pg
    HAS_PINGOUIN = True
except ImportError:
    HAS_PINGOUIN = False

try:
    from statsmodels.stats.multitest import fdrcorrection
    HAS_FDR = True
except ImportError:
    HAS_FDR = False

try:
    import causal_inference as ci
    HAS_CAUSAL = True
except ImportError:
    HAS_CAUSAL = False
    print("WARNING: causal_inference module unavailable - skipping causal layer")

import hashlib

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hrv_analysis")

OUTPUT_DIR = Path("analysis_output")
OUTPUT_DIR.mkdir(exist_ok=True)
(OUTPUT_DIR / "evaluation").mkdir(exist_ok=True)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

MODEL_VERSION = f"{date.today().isoformat()}_behavioral_v1"
TARGET = "whoop_hrv_rmssd"

# Stage-1 BH-FDR threshold for promoting features to Stage 2 partial correlations.
FDR_Q_THRESHOLD = 0.05

# WHOOP journal date semantics — corrected 2026-05-23.
#
# The 2026-04-16 audit (finding 4.B) verified one data point (April 8, with a
# pre-midnight bedtime) and incorrectly generalized that cycle_date =
# behaviors-day always. In reality:
#
#   cycle_date    = the date bedtime began in WHOOP's local TZ.
#   behaviors_day = the day the user was awake answering the question about.
#
# For pre-midnight bedtimes those agree; for post-midnight bedtimes (Riley's
# consistent pattern in Atlanta and Spain) cycle_date = behaviors_day + 1.
# A "Feeling sick = Yes" answer for behaviors on Wed May 13 was stored with
# cycle_date = 2026-05-14 because Riley went to bed at 00:11 AM May 14 ET.
#
# Resolution: `pds.whoop_journal` now carries a `behaviors_date` column
# (computed by a DB trigger from each cycle's start_time − 6h in local TZ)
# and the unified `pds.journal` view exposes it for both WHOOP and habit
# sources. This pipeline reads `behaviors_date` directly so alignment is
# correct for all bedtime patterns without an in-Python shift.

# Features whose 5%-non-null filter is too strict — these are canonical HRV
# predictors and their NULLs are concentrated in the early dataset where Garmin
# hadn't yet populated baselines. Lower threshold to 2% so we can still feed
# them to the model with NaN-aware splits (XGBoost handles missingness).
HIGH_VALUE_SPARSE_FEATURES = {
    "garmin_acute_training_load", "garmin_chronic_training_load",
    "garmin_training_load_factor", "garmin_training_load_balance",
    "garmin_recovery_time_hours", "garmin_recovery_time_factor",
    "garmin_recovery_hr", "garmin_hrv_factor", "garmin_sleep_score_factor",
    "garmin_sleep_history_factor", "garmin_stress_history_factor",
    "garmin_vo2_max_running", "garmin_vo2_max_cycling", "garmin_fitness_age",
    "training_readiness_score",
    "garmin_training_readiness_level_ord",
    "atl_ctl_ratio",
    # Garmin HRV baselines — sparse in 2024 but populated continuously since
    "garmin_hrv_baseline_low", "garmin_hrv_baseline_high",
    "garmin_hrv_5min_high", "garmin_hrv_weekly_avg",
    "garmin_hrv_status_ord",
}

# Controllable / behavioral features for the actionable-only SHAP ranking
# (audit finding 7.K). Anything here is something Riley can change tomorrow.
CONTROLLABLE_FEATURE_PREFIXES = (
    "journal_", "habit_", "mfp_", "supplement_", "whoop_sleep_", "garmin_sleep_",
    "eight_sleep_", "whoop_workout_", "whoop_day_strain", "garmin_activity_",
    "rolling_3d_training_load", "rolling_7d_training_load", "sleep_debt",
    "moderate_intensity_minutes", "vigorous_intensity_minutes",
    "active_seconds", "highly_active_seconds", "sedentary_seconds",
    "total_steps", "protein_pct", "carb_pct", "fat_pct", "net_calories",
    "days_since_alcohol", "days_since_sauna", "days_since_hard_workout",
    "nj_",  # Notion Journal: mood / confidence / word_count / topic_count
    "sp_",  # Spotify daily signature (opt-in via ONYX_INCLUDE_SPOTIFY=1)
    "meal_",  # Meal timing: last_hour, first_hour, eating_window, last_meal_to_bedtime_min
)

# Computed once per run from the post-prepare_ml_data (X, y) and stamped onto every
# row written to pds.hrv_predictions / hrv_model_metrics / hrv_analysis_results so
# we can detect when a stored result was produced from a different snapshot of the
# input data (backfills, revisions, schema changes).
INPUT_DATA_HASH: str | None = None


def compute_input_data_hash(X: pd.DataFrame, y: pd.Series) -> str:
    """SHA-256 of the sorted feature matrix + target. Stable across pandas dtypes."""
    payload = pd.concat([X.reset_index(drop=True), y.reset_index(drop=True).rename("__target__")], axis=1)
    payload = payload.reindex(sorted(payload.columns), axis=1)
    csv_bytes = payload.to_csv(index=False, float_format="%.6f").encode("utf-8")
    return hashlib.sha256(csv_bytes).hexdigest()

# ---------------------------------------------------------------------------
# Human-readable feature labels (used in charts & stored in DB)
# ---------------------------------------------------------------------------
FEATURE_LABELS: dict[str, str] = {
    "hrv_lag1": "Previous Day HRV",
    "hrv_lag2": "HRV 2 Days Ago",
    "hrv_lag3": "HRV 3 Days Ago",
    "hrv_7d_mean": "7-Day HRV Average",
    "hrv_7d_std": "7-Day HRV Std Dev",
    "delta_hrv": "HRV Change from Yesterday",
    "whoop_hrv_rmssd": "WHOOP HRV (RMSSD)",
    "whoop_recovery_score": "WHOOP Recovery Score",
    "whoop_rhr": "WHOOP Resting HR",
    "whoop_spo2": "WHOOP SpO2",
    "whoop_skin_temp": "Skin Temperature",
    "whoop_sleep_duration_milli": "Sleep Duration (WHOOP)",
    "whoop_deep_sleep_milli": "Deep Sleep (WHOOP)",
    "whoop_rem_sleep_milli": "REM Sleep (WHOOP)",
    "whoop_light_sleep_milli": "Light Sleep (WHOOP)",
    "whoop_awake_milli": "Awake Time (WHOOP)",
    "whoop_sleep_performance": "Sleep Performance %",
    "whoop_sleep_efficiency": "Sleep Efficiency %",
    "whoop_sleep_consistency": "Sleep Consistency %",
    "whoop_respiratory_rate": "Respiratory Rate (WHOOP)",
    "whoop_disturbances": "Sleep Disturbances",
    "whoop_day_strain": "Day Strain",
    "whoop_kilojoule": "Daily Energy (kJ)",
    "whoop_deep_pct": "Deep Sleep % (WHOOP)",
    "whoop_rem_pct": "REM Sleep % (WHOOP)",
    "sleep_debt_ratio": "Sleep Debt Ratio",
    "delta_rhr": "RHR Change from Yesterday",
    "garmin_sleep_score": "Sleep Score (Garmin)",
    "garmin_sleep_duration_sec": "Sleep Duration (Garmin)",
    "garmin_deep_sleep_sec": "Deep Sleep (Garmin)",
    "garmin_hrv": "HRV (Garmin Sleep)",
    "garmin_deep_pct": "Deep Sleep % (Garmin)",
    "garmin_rem_pct": "REM Sleep % (Garmin)",
    "garmin_rhr": "Resting HR (Garmin)",
    "garmin_spo2": "SpO2 (Garmin)",
    "total_steps": "Daily Steps",
    "total_kilocalories": "Total Calories",
    "active_kilocalories": "Active Calories",
    "avg_stress_level": "Avg Stress Level",
    "max_stress_level": "Peak Stress Level",
    "high_stress_duration_min": "High Stress Duration (min)",
    "pct_high_stress": "High Stress % of Day",
    "stress_ratio": "High/Low Stress Ratio",
    "body_battery_highest": "Peak Body Battery",
    "body_battery_lowest": "Lowest Body Battery",
    "body_battery_charged": "Body Battery Charged",
    "body_battery_drained": "Body Battery Drained",
    "moderate_intensity_minutes": "Moderate Activity (min)",
    "vigorous_intensity_minutes": "Vigorous Activity (min)",
    "sedentary_seconds": "Sedentary Time (s)",
    "active_seconds": "Active Time (s)",
    "training_readiness_score": "Training Readiness Score",
    "garmin_training_readiness_level_ord": "Training Readiness Level (Garmin)",
    "garmin_hrv_status_ord": "HRV Status Ordinal (Garmin)",
    "sleep_score_factor": "Sleep Score Factor",
    "recovery_time_factor": "Recovery Time Factor",
    "hrv_factor": "HRV Readiness Factor",
    "acute_training_load": "Acute Training Load",
    "chronic_training_load": "Chronic Training Load",
    "atl_ctl_ratio": "Training Load Ratio (ATL/CTL)",
    "rolling_7d_training_load": "7-Day Rolling Training Load",
    "last_workout_end_to_sleep_min": "Minutes from Last Workout to Bedtime",
    "last_workout_whoop_strain": "Last Workout's WHOOP Strain (0-21)",
    "last_workout_garmin_load": "Last Workout's Garmin Training Load",
    "had_evening_workout": "Had Evening Workout (after 6pm)",
    "whoop_strain_per_hour_to_bed": "WHOOP Strain ÷ Hours-to-Bed",
    "recovery_time_hours": "Recovery Time (hours)",
    "vo2_max_running": "VO2 Max (Running)",
    "is_run_day": "Running Day",
    "is_rest_day": "Rest Day",
    "total_activity_duration_min": "Activity Duration (min)",
    "total_training_load": "Daily Training Load",
    "max_aerobic_te": "Aerobic Training Effect",
    "days_since_hard_workout": "Days Since Hard Workout",
    "days_since_rest_day": "Days Since Rest Day",
    "consecutive_run_days": "Consecutive Run Days",
    "is_transition_day": "Travel Transition Day",
    "days_since_transition": "Days Since Last Transition",
    "offset_delta_hours": "TZ Offset Change (h)",
    "is_outbound": "Outbound Travel",
    "is_return": "Return Home Travel",
    "last_night_avg_ms": "Garmin Last-Night HRV",
    "hrv_vs_baseline": "HRV vs Personal Baseline",
    "eight_sleep_score": "Eight Sleep Score",
    "eight_sleep_hrv": "HRV (Eight Sleep)",
    "eight_sleep_hr": "Heart Rate (Eight Sleep)",
    "eight_sleep_bed_temp": "Bed Temperature",
    "eight_sleep_room_temp": "Room Temperature",
    "bed_room_temp_delta": "Bed-Room Temp Delta",
    "eight_sleep_toss_turns": "Toss & Turns",
    "mfp_calories": "Calories (MFP)",
    "mfp_protein_g": "Protein (g)",
    "mfp_carbs_g": "Carbohydrates (g)",
    "mfp_fat_g": "Fat (g)",
    "protein_pct": "Protein % of Calories",
    "net_calories": "Net Calories",
    "day_of_week": "Day of Week",
    "is_weekend": "Weekend",
    "sleep_midpoint_hour": "Sleep Midpoint Hour",
    "bedtime_hour": "Bedtime Hour",
    "days_since_alcohol": "Days Since Alcohol",
    "days_since_last_rest_day": "Days Since Rest Day (Journal)",
    "days_since_sauna": "Days Since Sauna",
    "weight_kg": "Body Weight (kg)",
    "nj_mood_ord": "Notion Journal Mood (ordinal)",
    "nj_confidence_ord": "Notion Journal Confidence (ordinal)",
    "nj_word_count": "Notion Journal Word Count",
    "nj_topic_count": "Notion Journal Topic Count",
    "nj_entry_count": "Notion Journal Entry Count",
    "meal_last_hour": "Last Meal (ET hour)",
    "meal_first_hour": "First Meal (ET hour)",
    "meal_eating_window_hours": "Eating Window (h)",
    "meal_event_count": "Meal Events Logged",
    "meal_last_meal_to_bedtime_min": "Minutes from Last Meal to Bedtime",
}

# Journal boolean questions → clean labels
JOURNAL_LABELS: dict[str, str] = {
    "wore_mouth_tape": "Mouth Tape",
    "wore_ear_plugs": "Ear Plugs",
    "took_melatonin": "Melatonin",
    "have_any_alcoholic_drinks": "Alcohol",
    "consumed_caffeine": "Caffeine",
    "consumed_magnesium": "Magnesium",
    "took_anti-inflammatory_nsaids": "NSAIDs",
    "used_a_sauna": "Sauna",
    "took_a_cold_shower": "Cold Shower",
    "took_an_ice_bath": "Ice Bath",
    "did_zone_2_cardio": "Zone 2 Cardio",
    "took_a_rest_day": "Rest Day",
    "experienced_stress": "Experienced Stress",
    "felt_depressed_or_down": "Felt Depressed",
    "felt_nervous_or_anxious": "Felt Anxious",
    "feeling_sick_or_ill": "Feeling Sick",
    "traveled_on_a_plane": "Air Travel",
    "hydrated_sufficiently": "Hydrated Sufficiently",
    "spent_time_stretching": "Stretching",
    "meditated": "Meditation",
    "ate_food_close_to_bedtime": "Ate Near Bedtime",
    "viewed_screen_in_bed": "Screen in Bed",
    "worked_late": "Worked Late",
}

# Habits live in Notion (managed by Riley) and flow through pds.journal with
# source='habit'. Names are user-defined and may change at any time, so the
# label map is populated at runtime in build_feature_matrix() from the original
# question strings. This dict is the in-memory store the pivot fills; nothing
# is hard-coded here on purpose.
HABIT_LABELS: dict[str, str] = {}


# ===========================================================================
# PHASE 1 – DATA LOADING
# ===========================================================================

def fetch_all(table: str, select: str = "*", filters: list | None = None,
              chunk: int = 1000) -> pd.DataFrame:
    """Paginate through a Supabase pds-schema table and return a DataFrame."""
    rows: list[dict] = []
    offset = 0
    while True:
        q = supa.schema("pds").from_(table).select(select)
        if filters:
            for f in filters:
                col, op, val = f
                if op == "eq":
                    q = q.eq(col, val)
                elif op == "neq":
                    q = q.neq(col, val)
                elif op == "gte":
                    q = q.gte(col, val)
                elif op == "lte":
                    q = q.lte(col, val)
        resp = q.range(offset, offset + chunk - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < chunk:
            break
        offset += chunk
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def to_date_str(s: pd.Series) -> pd.Series:
    """Coerce a series to 'YYYY-MM-DD' string dates.

    Use for Garmin `start_time_local`, which is stored as a local-wall-clock
    value labeled +00 — strftime against the parsed UTC value yields the ET
    calendar date directly.
    """
    return pd.to_datetime(s, utc=True, errors="coerce").dt.strftime("%Y-%m-%d")


def to_et_date_str(s: pd.Series) -> pd.Series:
    """Coerce a true-UTC timestamp series to ET (America/New_York) 'YYYY-MM-DD'.

    Use for point-in-time events (WHOOP workouts `start_time`, body measurements
    `measured_at`). Matches the view's `(... AT TIME ZONE 'America/New_York')::date`.
    Do NOT use for WHOOP cycles — see `to_cycle_et_date_str`.
    """
    return (
        pd.to_datetime(s, utc=True, errors="coerce")
        .dt.tz_convert("America/New_York")
        .dt.strftime("%Y-%m-%d")
    )


def to_cycle_et_date_str(s: pd.Series) -> pd.Series:
    """Canonical ET calendar date for a WHOOP cycle from its `start_time`.

    WHOOP cycles span bedtime-to-bedtime; `start_time` is the previous evening.
    Shifting by +12h before casting to ET date lands on midday of the cycle's
    "wake day" — the day whose recovery/HRV/strain the cycle represents.
    Matches the view's `((start_time + 12h) AT TIME ZONE 'America/New_York')::date`.
    """
    return (
        (pd.to_datetime(s, utc=True, errors="coerce") + pd.Timedelta(hours=12))
        .dt.tz_convert("America/New_York")
        .dt.strftime("%Y-%m-%d")
    )


def load_all_data() -> dict[str, pd.DataFrame]:
    """Load every relevant table from Supabase. Returns a dict of DataFrames."""
    data: dict[str, pd.DataFrame] = {}

    log.info("  Loading daily_health_matrix_behavioral (base view, ADR-0001)…")
    # Per ADR-0001: switched from pds.daily_health_matrix to
    # pds.daily_health_matrix_behavioral. The new view's `calendar_date`
    # column IS onyx_behavioral_date (same name retained for downstream
    # compatibility). Every per-source join in the view is keyed on
    # onyx_behavioral_date, so awake-tail behaviors align with the WHOOP
    # cycle that closes the day rather than splitting across two rows.
    data["matrix"] = fetch_all("daily_health_matrix_behavioral")
    if "calendar_date" in data["matrix"].columns:
        data["matrix"]["calendar_date"] = data["matrix"]["calendar_date"].astype(str)

    log.info("  Loading garmin_daily_summary…")
    gds_cols = ("calendar_date,total_distance_meters,floors_ascended,floors_descended,"
                "active_kilocalories,bmr_kilocalories,min_heart_rate,max_heart_rate,"
                "last_seven_days_avg_rhr,stress_duration_minutes,rest_stress_duration_min,"
                "low_stress_duration_min,medium_stress_duration_min,high_stress_duration_min,"
                "body_battery_charged,body_battery_drained,body_battery_most_recent,lowest_spo2,"
                "avg_waking_respiration,highest_respiration,lowest_respiration,"
                "highly_active_seconds,active_seconds,sedentary_seconds,sleeping_seconds,"
                "abnormal_hr_count,min_avg_heart_rate,max_avg_heart_rate")
    data["garmin_daily"] = fetch_all("garmin_daily_summary", select=gds_cols)
    if not data["garmin_daily"].empty:
        data["garmin_daily"]["calendar_date"] = data["garmin_daily"]["calendar_date"].astype(str)

    log.info("  Loading garmin_sleep…")
    gs_cols = ("calendar_date,sleep_id,light_sleep_seconds,rem_sleep_seconds,awake_seconds,"
               "unmeasurable_seconds,quality_score,duration_score,recovery_score,rem_score,"
               "light_score,deep_score,restlessness_score,avg_sleep_heart_rate,"
               "avg_respiration_rate,avg_spo2,lowest_spo2,avg_hrv,hrv_status,avg_sleep_stress,"
               "sleep_need_seconds,sleep_debt_seconds,sleep_start,sleep_end,is_nap")
    gs_raw = fetch_all("garmin_sleep", select=gs_cols, filters=[("is_nap", "eq", False)])
    if not gs_raw.empty:
        gs_raw["calendar_date"] = gs_raw["calendar_date"].astype(str)
        # One row per day (best sleep score first, matching view logic)
        for c in ["quality_score", "duration_score", "recovery_score"]:
            if c in gs_raw.columns:
                gs_raw[c] = pd.to_numeric(gs_raw[c], errors="coerce")
        data["garmin_sleep"] = (
            gs_raw.sort_values("quality_score", ascending=False, na_position="last")
            .drop_duplicates("calendar_date", keep="first")
        )
    else:
        data["garmin_sleep"] = pd.DataFrame()

    log.info("  Loading garmin_heart_rate…")
    data["garmin_hr"] = fetch_all(
        "garmin_heart_rate",
        select="calendar_date,zone_1_seconds,zone_2_seconds,zone_3_seconds,zone_4_seconds,zone_5_seconds",
    )
    if not data["garmin_hr"].empty:
        data["garmin_hr"]["calendar_date"] = data["garmin_hr"]["calendar_date"].astype(str)

    log.info("  Loading garmin_hrv…")
    data["garmin_hrv"] = fetch_all(
        "garmin_hrv",
        select="calendar_date,last_night_avg_ms,last_night_5min_high_ms,weekly_avg_ms,"
               "baseline_low_upper_ms,baseline_balanced_low_ms,baseline_balanced_upper_ms,"
               "baseline_marker_upper_ms,hrv_status",
    )
    if not data["garmin_hrv"].empty:
        data["garmin_hrv"]["calendar_date"] = data["garmin_hrv"]["calendar_date"].astype(str)

    log.info("  Loading garmin_stress…")
    data["garmin_stress"] = fetch_all(
        "garmin_stress",
        select="calendar_date,overall_stress_level,rest_stress_duration_sec,"
               "low_stress_duration_sec,medium_stress_duration_sec,high_stress_duration_sec,"
               "stress_qualifier",
    )
    if not data["garmin_stress"].empty:
        data["garmin_stress"]["calendar_date"] = data["garmin_stress"]["calendar_date"].astype(str)

    log.info("  Loading garmin_training_status…")
    # training_readiness_score / training_readiness_level were missing from this
    # select even though `training_readiness_score` is referenced in
    # HIGH_VALUE_SPARSE_FEATURES — added as part of the variable-coverage audit fix.
    data["garmin_ts"] = fetch_all(
        "garmin_training_status",
        select="calendar_date,sleep_score_factor,recovery_time_factor,hrv_factor,"
               "sleep_history_factor,stress_history_factor,training_load_factor,"
               "training_status,training_load_balance,acute_training_load,chronic_training_load,"
               "vo2_max_running,vo2_max_cycling,fitness_age,recovery_time_hours,recovery_heart_rate,"
               "training_readiness_score,training_readiness_level",
    )
    if not data["garmin_ts"].empty:
        data["garmin_ts"]["calendar_date"] = data["garmin_ts"]["calendar_date"].astype(str)

    log.info("  Loading garmin_activities…")
    # start_time_gmt added (true UTC) so we can derive end_time = start + duration
    # for the workout-to-sleep gap feature; start_time_local stays for date binning.
    data["garmin_acts"] = fetch_all(
        "garmin_activities",
        select="activity_id,start_time_local,start_time_gmt,activity_type,duration_seconds,distance_meters,"
               "avg_heart_rate,max_heart_rate,calories,elevation_gain_meters,"
               "aerobic_training_effect,anaerobic_training_effect,training_load,vo2_max,"
               "avg_speed_mps",
    )
    if not data["garmin_acts"].empty:
        data["garmin_acts"]["calendar_date"] = to_date_str(
            data["garmin_acts"]["start_time_local"]
        )

    log.info("  Loading garmin_activity_laps…")
    data["garmin_laps"] = fetch_all(
        "garmin_activity_laps",
        select="activity_id,lap_index,duration_seconds,distance_meters,avg_speed_mps,avg_heart_rate",
    )

    log.info("  Loading whoop_cycles…")
    data["whoop_cycles"] = fetch_all(
        "whoop_cycles",
        select="cycle_id,start_time,strain,kilojoule,average_heart_rate,max_heart_rate,timezone_offset,onyx_behavioral_date",
    )
    if not data["whoop_cycles"].empty:
        # Per ADR-0001 (post-Phase 1): the matrix spine is now
        # onyx_behavioral_date (from daily_health_matrix_behavioral). To
        # join correctly on transition days, use whoop_cycles'
        # onyx_behavioral_date directly instead of recomputing via the
        # legacy +12h ET rule (which gives wake-day and disagrees with
        # behavioral_date on transition cycles by 1 day — silently dropped
        # timezone_offset from those rows in earlier Phase A iteration).
        data["whoop_cycles"]["calendar_date"] = data["whoop_cycles"]["onyx_behavioral_date"].astype(str)

    log.info("  Loading whoop_sleep…")
    # start_time / end_time added for the workout-to-sleep gap feature.
    data["whoop_sleep"] = fetch_all(
        "whoop_sleep",
        select="cycle_id,start_time,end_time,sleep_cycle_count,baseline_milli,"
               "need_from_sleep_debt_milli,need_from_recent_strain_milli,"
               "need_from_recent_nap_milli,total_no_data_time_milli,is_nap,score_state",
        filters=[("is_nap", "eq", False), ("score_state", "eq", "SCORED")],
    )

    log.info("  Loading whoop_workouts…")
    # end_time added for the workout-to-sleep gap feature (true UTC; 100% populated).
    data["whoop_wk"] = fetch_all(
        "whoop_workouts",
        select="workout_id,start_time,end_time,sport_name,strain,kilojoule,average_heart_rate,max_heart_rate,"
               "zone_zero_milli,zone_one_milli,zone_two_milli,zone_three_milli,"
               "zone_four_milli,zone_five_milli,score_state",
        filters=[("score_state", "eq", "SCORED")],
    )
    if not data["whoop_wk"].empty:
        # Derive ET calendar_date from true-UTC start_time, matching view logic
        data["whoop_wk"]["calendar_date"] = to_et_date_str(data["whoop_wk"]["start_time"])

    log.info("  Loading whoop_body_measurements…")
    data["whoop_body"] = fetch_all(
        "whoop_body_measurements",
        select="measured_at,weight_kilogram,height_meter,max_heart_rate",
    )

    log.info("  Loading eight_sleep_trends…")
    data["eight_sleep"] = fetch_all(
        "eight_sleep_trends",
        select="calendar_date,sleep_quality_score,sleep_duration_score,latency_asleep_score,"
               "latency_out_score,wakeup_consistency_score,sleep_routine_score,"
               "light_sleep_seconds,awake_seconds,avg_breath_rate",
        filters=[("bed_side", "eq", "left")],
    )
    if not data["eight_sleep"].empty:
        data["eight_sleep"]["calendar_date"] = data["eight_sleep"]["calendar_date"].astype(str)

    log.info("  Loading myfitnesspal_nutrition…")
    data["mfp"] = fetch_all(
        "myfitnesspal_nutrition",
        select="calendar_date,fiber_g,sugar_g,sodium_mg,water_ml,exercise_kcal",
    )
    if not data["mfp"].empty:
        data["mfp"]["calendar_date"] = data["mfp"]["calendar_date"].astype(str)

    log.info("  Loading journal (WHOOP + habits)…")
    data["journal"] = fetch_all(
        "journal",
        select="cycle_date,behaviors_date,question,answer,source",
    )

    log.info("  Loading supplement_intake_by_compound…")
    data["supplements"] = fetch_all(
        "supplement_intake_by_compound",
        select="calendar_date,ingredient_group,categories,unit,total_amount",
    )
    if not data["supplements"].empty:
        data["supplements"]["calendar_date"] = data["supplements"]["calendar_date"].astype(str)
        data["supplements"]["total_amount"] = pd.to_numeric(
            data["supplements"]["total_amount"], errors="coerce"
        )
        # Flatten categories (text[] array from the view) into a single string
        # for downstream use. Multi-category compounds get comma-joined.
        data["supplements"]["category"] = data["supplements"]["categories"].apply(
            lambda c: ", ".join(c) if isinstance(c, list) and c else None
        )

    # Notion personal Journal: structured metadata (mood, confidence, word_count,
    # topic_count) joined into the matrix per the audit's Finding #8. The textual
    # content + embedding stay out (handled by the chat tool, not HRV analysis).
    log.info("  Loading journal_entries (Notion)…")
    data["notion_journal"] = fetch_all(
        "journal_entries",
        select="entry_date,mood,confidence,word_count,topics,archived",
    )
    if not data["notion_journal"].empty:
        nj = data["notion_journal"]
        nj = nj[nj["archived"].isna() | (nj["archived"] == False)].copy()  # noqa: E712
        nj["entry_date"] = nj["entry_date"].astype(str)
        data["notion_journal"] = nj

    # Spotify daily signature — opt-in via ONYX_INCLUDE_SPOTIFY=1.
    # Documented coverage gap: Garmin offline playback isn't reported to Spotify
    # so workout-heavy listening is under-counted. We require featurized_plays
    # >= 5 per day to filter out days with too-thin signal to bias the audio-
    # feature means.
    if os.environ.get("ONYX_INCLUDE_SPOTIFY") == "1":
        log.info("  Loading spotify_daily_signature (ONYX_INCLUDE_SPOTIFY=1)…")
        data["spotify_daily"] = fetch_all(
            "spotify_daily_signature",
            select="calendar_date,play_count,unique_tracks,unique_artists,total_minutes,"
                   "featurized_plays,avg_valence,avg_energy,avg_tempo,avg_danceability,"
                   "avg_acousticness,avg_instrumentalness,avg_loudness",
        )
        if not data["spotify_daily"].empty:
            data["spotify_daily"]["calendar_date"] = data["spotify_daily"]["calendar_date"].astype(str)
    else:
        data["spotify_daily"] = pd.DataFrame()

    log.info(f"  Data loaded. Tables: {list(data.keys())}")
    return data


# ===========================================================================
# PHASE 1 – FEATURE ENGINEERING
# ===========================================================================

def aggregate_activities(acts: pd.DataFrame, laps: pd.DataFrame) -> pd.DataFrame:
    """Aggregate garmin_activities + garmin_activity_laps to daily level."""
    if acts.empty:
        return pd.DataFrame()

    for c in ["duration_seconds", "distance_meters", "calories", "training_load",
              "aerobic_training_effect", "anaerobic_training_effect", "vo2_max",
              "avg_heart_rate", "max_heart_rate", "elevation_gain_meters"]:
        acts[c] = pd.to_numeric(acts.get(c), errors="coerce")

    daily = acts.groupby("calendar_date").agg(
        activity_count=("activity_id", "count"),
        total_activity_duration_min=("duration_seconds", lambda x: x.sum() / 60),
        total_activity_distance_km=("distance_meters", lambda x: x.sum() / 1000),
        total_activity_calories=("calories", "sum"),
        max_aerobic_te=("aerobic_training_effect", "max"),
        max_anaerobic_te=("anaerobic_training_effect", "max"),
        total_training_load=("training_load", "sum"),
        max_activity_hr=("max_heart_rate", "max"),
        total_elevation_gain_m=("elevation_gain_meters", "sum"),
        latest_vo2_max=("vo2_max", "max"),
    ).reset_index()

    # Weighted avg HR by duration
    acts["hr_dur"] = acts["avg_heart_rate"] * acts["duration_seconds"]
    hr_w = acts.groupby("calendar_date").agg(
        _hr_dur_sum=("hr_dur", "sum"),
        _dur_sum=("duration_seconds", "sum"),
    ).reset_index()
    hr_w["avg_activity_hr"] = hr_w["_hr_dur_sum"] / hr_w["_dur_sum"].replace(0, np.nan)
    daily = daily.merge(hr_w[["calendar_date", "avg_activity_hr"]], on="calendar_date", how="left")

    daily["is_run_day"] = acts.groupby("calendar_date")["activity_type"].apply(
        lambda x: int(any("run" in str(v).lower() for v in x))
    ).reset_index(drop=True)
    # Re-merge because groupby apply loses index alignment
    run_flag = acts.groupby("calendar_date").apply(
        lambda df: int(any("run" in str(v).lower() for v in df["activity_type"]))
    ).reset_index()
    run_flag.columns = ["calendar_date", "is_run_day"]
    daily = daily.drop(columns=["is_run_day"], errors="ignore").merge(
        run_flag, on="calendar_date", how="left"
    )

    # Lap metrics (pacing consistency, cardiac drift)
    if not laps.empty and "activity_id" in laps.columns:
        for c in ["duration_seconds", "distance_meters", "avg_speed_mps", "avg_heart_rate"]:
            laps[c] = pd.to_numeric(laps.get(c), errors="coerce")

        laps_w = laps.merge(acts[["activity_id", "calendar_date"]], on="activity_id", how="left")

        def lap_metrics(g):
            pace = g["avg_speed_mps"].dropna()
            hr = g["avg_heart_rate"].dropna()
            pace_cv = pace.std() / pace.mean() if len(pace) > 1 and pace.mean() > 0 else np.nan
            hr_range = hr.max() - hr.min() if len(hr) > 1 else np.nan
            # Negative split: second half faster (higher speed)
            if len(pace) >= 2:
                mid = len(pace) // 2
                neg_split = int(pace.iloc[mid:].mean() > pace.iloc[:mid].mean())
            else:
                neg_split = np.nan
            return pd.Series({"lap_pace_cv": pace_cv, "lap_hr_range": hr_range, "negative_split": neg_split})

        lap_daily = (
            laps_w.groupby(["calendar_date", "activity_id"])
            .apply(lap_metrics)
            .reset_index()
            .groupby("calendar_date")
            .agg(
                lap_pace_cv=("lap_pace_cv", "mean"),
                lap_hr_range=("lap_hr_range", "mean"),
                negative_split=("negative_split", "mean"),
            )
            .reset_index()
        )
        daily = daily.merge(lap_daily, on="calendar_date", how="left")

    return daily


def aggregate_whoop_workouts(wk: pd.DataFrame, cycles: pd.DataFrame) -> pd.DataFrame:
    """Aggregate whoop_workouts to daily level using start_time-derived date."""
    if wk.empty:
        return pd.DataFrame()
    # calendar_date already set from start_time in load_all_data
    wk = wk.dropna(subset=["calendar_date"])
    for c in ["strain", "kilojoule", "average_heart_rate", "max_heart_rate",
              "zone_four_milli", "zone_five_milli", "zone_zero_milli", "zone_one_milli"]:
        wk[c] = pd.to_numeric(wk.get(c), errors="coerce")
    return wk.groupby("calendar_date").agg(
        whoop_workout_count=("workout_id", "count"),
        total_whoop_strain=("strain", "sum"),
        total_whoop_kilojoule=("kilojoule", "sum"),
        max_whoop_workout_hr=("max_heart_rate", "max"),
        avg_whoop_workout_hr=("average_heart_rate", "mean"),
        total_zone4_5_milli=pd.NamedAgg(
            column="zone_four_milli",
            aggfunc=lambda x: x.sum() + wk.loc[x.index, "zone_five_milli"].sum()
        ),
        total_zone0_1_milli=pd.NamedAgg(
            column="zone_zero_milli",
            aggfunc=lambda x: x.sum() + wk.loc[x.index, "zone_one_milli"].sum()
        ),
    ).reset_index()


def _clean_question_col(prefix: str, question: str) -> str:
    """Normalize a question string into a stable column name with a category prefix."""
    return (prefix + str(question).lower()
            .replace("?", "").replace(" ", "_")
            .replace("/", "_").replace("-", "_")
            .replace("'", "").replace(",", "")
            .replace("(", "").replace(")", "")
            .strip("_"))


def pivot_journal(journal: pd.DataFrame) -> pd.DataFrame:
    """Pivot WHOOP journal rows into boolean columns per question per day.

    Filters source='whoop' when the source column is present (the unified
    pds.journal view UNIONs WHOOP + habits, and habits are pivoted separately
    by pivot_habits with their own habit_ prefix). When source is absent —
    e.g., older callers passing the raw whoop_journal table — every row is
    treated as WHOOP, preserving the historical behavior.

    Date alignment: keys on `behaviors_date` (the calendar day the answer
    describes), which the DB layer computes from each cycle's bedtime − 6h in
    local TZ. For pre-midnight bedtimes this equals cycle_date; for
    post-midnight bedtimes it's cycle_date − 1. The pipeline's downstream
    `hrv_next = whoop_hrv_rmssd.shift(-1)` then puts journal_* on row N
    (behaviors of day N) opposite hrv_next on row N (HRV from sleep N → N+1),
    which is the intended 1-day causal lag.

    Falls back to cycle_date if behaviors_date is missing (older rows pre-
    backfill or rows with no matching whoop_cycle).
    """
    if journal.empty:
        return pd.DataFrame()
    journal = journal.copy()
    if "source" in journal.columns:
        journal = journal[journal["source"] == "whoop"]
        if journal.empty:
            return pd.DataFrame()
    # Prefer behaviors_date (DB-computed via the (bedtime−6h)::date trigger);
    # fall back to cycle_date for rows where it's NULL.
    if "behaviors_date" in journal.columns:
        date_col = journal["behaviors_date"].fillna(journal["cycle_date"])
    else:
        date_col = journal["cycle_date"]
    journal["calendar_date"] = pd.to_datetime(date_col, errors="coerce").dt.date.astype(str)
    journal["is_yes"] = journal["answer"].str.lower().isin(["yes", "true", "1"]).astype(float)
    pivot = (
        journal.pivot_table(index="calendar_date", columns="question", values="is_yes", aggfunc="max")
        .reset_index()
    )
    pivot.columns = ["calendar_date"] + [_clean_question_col("journal_", c) for c in pivot.columns[1:]]
    return pivot


def pivot_habits(journal: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    """Pivot habit rows (source='habit' in the unified journal view) into
    one boolean column per habit per day, prefixed `habit_`.

    Date semantics: habit completions are recorded under the date Riley marks
    them complete (ET), with no WHOOP-style next-morning-asking offset, so no
    cycle_date shift is applied here — `habit_*` on calendar_date=N already
    means "Riley did this habit on day N", which lines up with the rest of the
    pipeline's behaviors-on-N → HRV(N+1) assumption.

    Returns (wide_df, label_map) where label_map carries the original habit
    name from Notion (preserving casing and special characters) keyed by the
    cleaned column name, for use in FEATURE_LABELS at display time.
    """
    if journal.empty or "source" not in journal.columns:
        return pd.DataFrame(), {}
    habits = journal[journal["source"] == "habit"].copy()
    if habits.empty:
        return pd.DataFrame(), {}
    # Per ADR-0001: key on behaviors_date (which for habits equals cycle_date
    # today via the pds.journal view's `habit_journal.cycle_date AS
    # behaviors_date` alias). Identical semantics today; gives a future hook
    # if habit_journal ever gains a smarter behavioral derivation (e.g.
    # WHOOP-cycle anchor for taps recorded close to a bedtime).
    if "behaviors_date" in habits.columns:
        date_col = habits["behaviors_date"].fillna(habits["cycle_date"])
    else:
        date_col = habits["cycle_date"]
    habits["cycle_date"] = pd.to_datetime(date_col, errors="coerce").dt.date.astype(str)
    habits["is_yes"] = habits["answer"].str.lower().isin(["yes", "true", "1"]).astype(float)
    pivot = (
        habits.pivot_table(index="cycle_date", columns="question", values="is_yes", aggfunc="max")
        .reset_index()
    )
    original_questions = list(pivot.columns[1:])
    cleaned = [_clean_question_col("habit_", c) for c in original_questions]
    pivot.columns = ["calendar_date"] + cleaned
    label_map = {col: str(orig) for col, orig in zip(cleaned, original_questions)}
    return pivot, label_map


def pivot_supplements(supplements: pd.DataFrame) -> tuple[pd.DataFrame, str | None]:
    """Pivot per-compound supplement intake into per-compound dose columns.

    Returns (wide_df, tracking_start) where:
      - wide_df has one row per calendar_date with columns:
            supplement_<compound>_amount  (sum across products that day)
        For dates within the tracking window where the compound wasn't taken,
        the value is 0. For dates outside the tracking window (before the
        first supplement record), the value stays NaN so the model can
        distinguish "untracked" from "took zero".
      - tracking_start is the earliest calendar_date in the supplements data,
        used by callers to fill NaN → 0 only within the tracking window.

    Caller is responsible for merging on calendar_date and applying the
    tracking-window fillna(0). We keep that here at the matrix layer rather
    than inside this function because the matrix has the full date spine.
    """
    if supplements is None or supplements.empty:
        return pd.DataFrame(), None

    def clean_col(c: str) -> str:
        return ("supplement_" + str(c).lower()
                .replace("?", "").replace(" ", "_")
                .replace("/", "_").replace("-", "_")
                .replace("'", "").replace(",", "")
                .replace("(", "").replace(")", "")
                .replace(".", "").replace("&", "and")
                .strip("_") + "_amount")

    supp = supplements.copy().dropna(subset=["calendar_date", "ingredient_group"])
    supp["total_amount"] = pd.to_numeric(supp["total_amount"], errors="coerce")
    tracking_start = str(supp["calendar_date"].min())

    grouped = (supp.groupby(["calendar_date", "ingredient_group"], as_index=False)
                   .agg(total_amount=("total_amount", "sum")))
    wide = grouped.pivot_table(
        index="calendar_date", columns="ingredient_group",
        values="total_amount", aggfunc="sum",
    ).reset_index()
    wide.columns = ["calendar_date"] + [clean_col(c) for c in wide.columns[1:]]
    # Distinct ingredient_group values can collapse to the same cleaned column
    # name (e.g. "Alpha Lipoic Acid" and "Alpha-Lipoic Acid" both -> alpha_lipoic_acid).
    # Sum across the duplicates so downstream merges don't choke on non-unique columns.
    if wide.columns.duplicated().any():
        dups = wide.columns[wide.columns.duplicated()].unique().tolist()
        log.warning(f"  pivot_supplements: merging duplicate cleaned-col names: {dups}")
        wide = wide.T.groupby(level=0).sum(min_count=1).T
        # groupby on transposed loses calendar_date column ordering; restore
        cols = ["calendar_date"] + [c for c in wide.columns if c != "calendar_date"]
        wide = wide[cols]
    return wide, tracking_start


def build_feature_matrix(data: dict) -> pd.DataFrame:
    """Join all tables onto the daily_health_matrix spine and engineer features."""
    log.info("Building feature matrix…")

    df = data["matrix"].copy()
    df["calendar_date"] = df["calendar_date"].astype(str)

    # Numeric conversion of all matrix columns
    for c in df.columns:
        if c != "calendar_date":
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # --- Join garmin_daily extra columns ---
    if not data["garmin_daily"].empty:
        df = df.merge(data["garmin_daily"], on="calendar_date", how="left", suffixes=("", "_gds"))

    # --- Join garmin_sleep extra columns ---
    if not data["garmin_sleep"].empty:
        gs = data["garmin_sleep"].copy()
        for c in gs.columns:
            if c not in ("calendar_date", "hrv_status", "is_nap", "sleep_start", "sleep_end"):
                gs[c] = pd.to_numeric(gs[c], errors="coerce")
        # Derive bedtime / wake-hour / midpoint from sleep_start / sleep_end
        if "sleep_start" in gs.columns:
            gs["bedtime_hour"] = pd.to_datetime(gs["sleep_start"], utc=True, errors="coerce").dt.hour + \
                                  pd.to_datetime(gs["sleep_start"], utc=True, errors="coerce").dt.minute / 60
        if "sleep_end" in gs.columns:
            gs["wake_hour"] = pd.to_datetime(gs["sleep_end"], utc=True, errors="coerce").dt.hour + \
                               pd.to_datetime(gs["sleep_end"], utc=True, errors="coerce").dt.minute / 60
        if "bedtime_hour" in gs.columns and "wake_hour" in gs.columns:
            gs["sleep_midpoint_hour"] = (gs["bedtime_hour"] + gs["wake_hour"]) / 2

        gs_drop = ["is_nap", "sleep_start", "sleep_end", "hrv_status"]
        gs = gs.drop(columns=[c for c in gs_drop if c in gs.columns])
        df = df.merge(gs, on="calendar_date", how="left", suffixes=("", "_gs"))

    # --- Join garmin_heart_rate ---
    if not data["garmin_hr"].empty:
        ghr = data["garmin_hr"].copy()
        for c in ["zone_1_seconds", "zone_2_seconds", "zone_3_seconds", "zone_4_seconds", "zone_5_seconds"]:
            ghr[c] = pd.to_numeric(ghr.get(c), errors="coerce")
        ghr["total_elevated_hr_sec"] = ghr[["zone_3_seconds", "zone_4_seconds", "zone_5_seconds"]].sum(axis=1)
        total = ghr[["zone_1_seconds", "zone_2_seconds", "zone_3_seconds", "zone_4_seconds", "zone_5_seconds"]].sum(axis=1)
        for i in range(1, 6):
            ghr[f"pct_zone_{i}"] = ghr[f"zone_{i}_seconds"] / total.replace(0, np.nan)
        df = df.merge(ghr, on="calendar_date", how="left", suffixes=("", "_ghr"))

    # --- Join garmin_hrv ---
    if not data["garmin_hrv"].empty:
        ghrv = data["garmin_hrv"].copy()
        for c in ghrv.columns:
            if c not in ("calendar_date", "hrv_status"):
                ghrv[c] = pd.to_numeric(ghrv[c], errors="coerce")
        ghrv["hrv_vs_baseline"] = ghrv["last_night_avg_ms"] - ghrv["baseline_balanced_low_ms"]
        # Ordinal-encode Garmin's qualitative HRV status (BALANCED/LOW/UNBALANCED/NONE).
        # The audit flagged that this column was being silently dropped — it carries
        # information that the numeric `last_night_avg_ms` alone doesn't (e.g. UNBALANCED
        # means "variable across the window", distinct from a pure value reading).
        HRV_STATUS_ORDINAL = {"LOW": 0, "UNBALANCED": 1, "BALANCED": 2}
        ghrv["garmin_hrv_status_ord"] = ghrv["hrv_status"].map(HRV_STATUS_ORDINAL)
        ghrv = ghrv.drop(columns=["hrv_status"], errors="ignore")
        df = df.merge(ghrv, on="calendar_date", how="left", suffixes=("", "_garminhrv"))

    # --- Join garmin_stress ---
    if not data["garmin_stress"].empty:
        gs2 = data["garmin_stress"].copy()
        for c in gs2.columns:
            if c not in ("calendar_date", "stress_qualifier"):
                gs2[c] = pd.to_numeric(gs2[c], errors="coerce")
        total_stress = gs2[["rest_stress_duration_sec", "low_stress_duration_sec",
                              "medium_stress_duration_sec", "high_stress_duration_sec"]].sum(axis=1)
        gs2["pct_high_stress"] = gs2["high_stress_duration_sec"] / total_stress.replace(0, np.nan)
        gs2["stress_ratio"] = gs2["high_stress_duration_sec"] / (
            gs2["rest_stress_duration_sec"] + gs2["low_stress_duration_sec"]
        ).replace(0, np.nan)
        gs2 = gs2.drop(columns=["stress_qualifier"], errors="ignore")
        df = df.merge(gs2, on="calendar_date", how="left", suffixes=("", "_stress"))

    # --- Join garmin_training_status ---
    if not data["garmin_ts"].empty:
        gts = data["garmin_ts"].copy()
        text_cols = ("calendar_date", "training_status", "training_load_balance",
                     "training_readiness_level")
        for c in gts.columns:
            if c not in text_cols:
                gts[c] = pd.to_numeric(gts[c], errors="coerce")
        # Ordinal-encode training_readiness_level (POOR<LOW<MODERATE<HIGH; NONE -> NaN).
        # Adds garmin_training_readiness_level_ord. The numeric *_score column is
        # already in this frame and rides alongside.
        READINESS_ORDINAL = {"POOR": 0, "LOW": 1, "MODERATE": 2, "HIGH": 3}
        if "training_readiness_level" in gts.columns:
            gts["garmin_training_readiness_level_ord"] = (
                gts["training_readiness_level"].map(READINESS_ORDINAL)
            )
        gts = gts.drop(columns=["training_status", "training_load_balance",
                                  "training_readiness_level"], errors="ignore")
        df = df.merge(gts, on="calendar_date", how="left", suffixes=("", "_gts"))

    # --- Join garmin activities (aggregated) ---
    if not data["garmin_acts"].empty:
        act_daily = aggregate_activities(data["garmin_acts"], data["garmin_laps"])
        if not act_daily.empty:
            df = df.merge(act_daily, on="calendar_date", how="left", suffixes=("", "_acts"))
            df["is_rest_day"] = df["activity_count"].isna().astype(float)
            df["activity_count"] = df["activity_count"].fillna(0)

    # --- Join whoop_cycles extra columns ---
    if not data["whoop_cycles"].empty:
        wc = data["whoop_cycles"][["calendar_date", "average_heart_rate", "max_heart_rate", "timezone_offset"]].copy()
        wc.columns = ["calendar_date", "whoop_cycle_avg_hr", "whoop_cycle_max_hr", "timezone_offset"]
        for c in ["whoop_cycle_avg_hr", "whoop_cycle_max_hr"]:
            wc[c] = pd.to_numeric(wc[c], errors="coerce")
        # On transition days WHOOP can have multiple cycles per behavioral
        # date; pick the LONGEST-offset row (matches the behavioral view's
        # LATERAL pick). Simpler proxy: just take last value per date.
        wc = wc.groupby("calendar_date", as_index=False).last()
        df = df.merge(wc, on="calendar_date", how="left", suffixes=("", "_wc"))

    # --- Join whoop_sleep extra columns ---
    if not data["whoop_sleep"].empty and not data["whoop_cycles"].empty:
        ws = data["whoop_sleep"].copy()
        ws = ws.merge(data["whoop_cycles"][["cycle_id", "calendar_date"]], on="cycle_id", how="left")
        ws = ws.dropna(subset=["calendar_date"])
        ws = ws.sort_values("cycle_id").drop_duplicates("calendar_date", keep="last")
        ws_cols = ["calendar_date", "sleep_cycle_count", "baseline_milli",
                   "need_from_sleep_debt_milli", "need_from_recent_strain_milli",
                   "need_from_recent_nap_milli", "total_no_data_time_milli"]
        ws = ws[[c for c in ws_cols if c in ws.columns]].copy()
        for c in ws.columns:
            if c != "calendar_date":
                ws[c] = pd.to_numeric(ws[c], errors="coerce")
        df = df.merge(ws, on="calendar_date", how="left", suffixes=("", "_ws"))

    # --- Join WHOOP workouts (aggregated) ---
    if not data["whoop_wk"].empty:
        ww_daily = aggregate_whoop_workouts(data["whoop_wk"], data.get("whoop_cycles", pd.DataFrame()))
        if not ww_daily.empty:
            df = df.merge(ww_daily, on="calendar_date", how="left", suffixes=("", "_ww"))

    # --- Join whoop_body_measurements (forward-fill) ---
    if not data["whoop_body"].empty:
        bm = data["whoop_body"].copy()
        bm["calendar_date"] = to_et_date_str(bm["measured_at"])
        bm = bm.dropna(subset=["calendar_date"])
        bm = bm.sort_values("calendar_date").drop_duplicates("calendar_date", keep="last")
        bm = bm.rename(columns={"weight_kilogram": "weight_kg", "height_meter": "height_m",
                                 "max_heart_rate": "whoop_max_hr_bm"})
        bm = bm[["calendar_date", "weight_kg", "height_m", "whoop_max_hr_bm"]].copy()
        bm["weight_kg"] = pd.to_numeric(bm["weight_kg"], errors="coerce")
        bm["height_m"] = pd.to_numeric(bm["height_m"], errors="coerce")

        # Forward-fill onto date spine
        all_dates = sorted(df["calendar_date"].unique())
        date_df = pd.DataFrame({"calendar_date": all_dates})
        bm_ff = date_df.merge(bm, on="calendar_date", how="left").sort_values("calendar_date")
        bm_ff[["weight_kg", "height_m"]] = bm_ff[["weight_kg", "height_m"]].ffill()
        bm_ff["bmi"] = bm_ff["weight_kg"] / (bm_ff["height_m"] ** 2).replace(0, np.nan)
        bm_ff["weight_change_7d"] = bm_ff["weight_kg"].diff(7)
        bm_ff = bm_ff.drop(columns=["height_m", "whoop_max_hr_bm"], errors="ignore")
        df = df.merge(bm_ff, on="calendar_date", how="left", suffixes=("", "_bm"))

    # --- Join eight_sleep extra columns ---
    if not data["eight_sleep"].empty:
        es = data["eight_sleep"].copy()
        for c in es.columns:
            if c != "calendar_date":
                es[c] = pd.to_numeric(es[c], errors="coerce")
        # Temp delta already needs bed/room from matrix, compute separately if present
        if "eight_sleep_bed_temp" in df.columns and "eight_sleep_room_temp" in df.columns:
            df["bed_room_temp_delta"] = (
                pd.to_numeric(df["eight_sleep_bed_temp"], errors="coerce") -
                pd.to_numeric(df["eight_sleep_room_temp"], errors="coerce")
            )
        df = df.merge(es, on="calendar_date", how="left", suffixes=("", "_es"))

    # --- Join MFP extra columns ---
    if not data["mfp"].empty:
        mfp = data["mfp"].copy()
        for c in mfp.columns:
            if c != "calendar_date":
                mfp[c] = pd.to_numeric(mfp[c], errors="coerce")
        df = df.merge(mfp, on="calendar_date", how="left", suffixes=("", "_mfp"))

    # --- Journal pivot ---
    # Skip if daily_health_matrix already includes journal_ columns (view-level pivot)
    existing_journal = [c for c in df.columns if c.startswith("journal_")]
    if not existing_journal and not data["journal"].empty:
        jdf = pivot_journal(data["journal"])
        if not jdf.empty:
            df = df.merge(jdf, on="calendar_date", how="left")

    # --- Habit pivot ---
    # Habits flow through the same pds.journal view as WHOOP journal entries
    # (UNION with a `source` column) but get their own habit_ prefix so all
    # downstream analyses can break them out separately from WHOOP behaviors.
    # Labels are populated dynamically from the Notion-managed habit names.
    #
    # Tracking-window semantics (mirrors pivot_supplements): a habit_journal
    # row only exists for dates Riley logged a completion, so a NaN after the
    # merge means "no completion logged" — which behaviorally is "did NOT do
    # the habit that day", i.e. should be 0 for the t-test/correlation. We
    # fill per-habit from the first completion forward; rows *before* a
    # habit's first completion stay NaN so we don't manufacture "No"s for
    # a habit that didn't exist yet.
    existing_habit = [c for c in df.columns if c.startswith("habit_")]
    if not existing_habit and not data["journal"].empty:
        hdf, habit_label_map = pivot_habits(data["journal"])
        if not hdf.empty:
            df = df.merge(hdf, on="calendar_date", how="left")
            HABIT_LABELS.update(habit_label_map)
            FEATURE_LABELS.update(habit_label_map)
            habit_cols = list(habit_label_map.keys())
            df = df.sort_values("calendar_date").reset_index(drop=True)
            for hcol in habit_cols:
                first_done_idx = df[hcol].first_valid_index()
                if first_done_idx is not None:
                    df.loc[first_done_idx:, hcol] = df.loc[first_done_idx:, hcol].fillna(0)
            log.info(f"  Habits pivoted: {len(habit_label_map)} habit columns "
                     f"({', '.join(habit_label_map.values())})")

    # --- Supplement pivot: per-compound amount columns ---
    # Within the tracking window, dates where a compound wasn't taken are
    # filled with 0 (real "no dose"). Dates before tracking started stay NaN
    # so XGBoost can distinguish "untracked era" from "took zero". The 5%
    # non-null floor in prepare_ml_data will drop sparse compounds until
    # tracking history accumulates, so this addition is a no-op for the
    # current model run but plumbs supplements through for the future.
    supp_data = data.get("supplements")
    if supp_data is not None and not supp_data.empty:
        sdf, supp_tracking_start = pivot_supplements(supp_data)
        if not sdf.empty:
            df = df.merge(sdf, on="calendar_date", how="left")
            supp_cols = [c for c in sdf.columns if c != "calendar_date"]
            in_window = df["calendar_date"] >= supp_tracking_start
            for col in supp_cols:
                df.loc[in_window, col] = df.loc[in_window, col].fillna(0)
            log.info(f"  Supplements pivoted: {len(supp_cols)} compound columns "
                     f"(tracking window from {supp_tracking_start})")

    # --- Join Notion personal Journal (mood / confidence / word_count) ---
    # Audit Finding #8: structured journal metadata was previously isolated from
    # the matrix on a blanket "Spotify-style isolation" principle. That principle
    # was for textual / embedding data — the ordinal mood and confidence ratings,
    # plus word_count as a "how much did I write" proxy, are clear daily-grain
    # signals worth letting the analysis see.
    # NOTE on prefix: use `nj_*` (Notion Journal) NOT `journal_*`. The latter
    # is reserved for boolean WHOOP journal questions and is scanned by Welch's
    # t-tests / causal-layer binary enumeration that assume 0/1 values.
    nj_data = data.get("notion_journal")
    if nj_data is not None and not nj_data.empty:
        MOOD_ORDINAL = {"low": 0, "neutral": 1, "good": 2, "great": 3}
        CONFIDENCE_ORDINAL = {"low": 0, "medium": 1, "high": 2}
        nj = nj_data.copy()
        nj["nj_mood_ord"] = nj["mood"].map(MOOD_ORDINAL)
        nj["nj_confidence_ord"] = nj["confidence"].map(CONFIDENCE_ORDINAL)
        nj["nj_word_count"] = pd.to_numeric(nj.get("word_count"), errors="coerce")
        nj["nj_topic_count"] = nj["topics"].apply(
            lambda t: len(t) if isinstance(t, list) else 0
        )
        # Multiple entries per day: take MAX mood (best of the day), MAX confidence,
        # SUM word_count (total writing volume), MAX topic_count.
        nj_daily = nj.groupby("entry_date").agg(
            nj_mood_ord=("nj_mood_ord", "max"),
            nj_confidence_ord=("nj_confidence_ord", "max"),
            nj_word_count=("nj_word_count", "sum"),
            nj_topic_count=("nj_topic_count", "max"),
            nj_entry_count=("entry_date", "count"),
        ).reset_index().rename(columns={"entry_date": "calendar_date"})
        df = df.merge(nj_daily, on="calendar_date", how="left")
        log.info(f"  Notion journal: {len(nj_daily)} days with entries merged "
                 f"({len(nj_daily['nj_mood_ord'].dropna())} with mood)")

    # --- Join Spotify daily signature (opt-in) ---
    # Documented coverage gap: Garmin offline playback is invisible, so
    # workout-heavy listening days under-count. Days with featurized_plays<5
    # have too-thin a sample to give reliable audio-feature means and are
    # zero'd out (treated as "no listening signal today" rather than biasing
    # the mean by 1-2 random tracks).
    sp_data = data.get("spotify_daily")
    if sp_data is not None and not sp_data.empty:
        sp = sp_data.copy()
        # Numeric coerce
        for c in sp.columns:
            if c != "calendar_date":
                sp[c] = pd.to_numeric(sp[c], errors="coerce")
        # Mask audio-feature means below the featurization threshold.
        low_coverage = sp["featurized_plays"].fillna(0) < 5
        for c in ("avg_valence", "avg_energy", "avg_tempo", "avg_danceability",
                  "avg_acousticness", "avg_instrumentalness", "avg_loudness"):
            if c in sp.columns:
                sp.loc[low_coverage, c] = np.nan
        # Prefix all spotify columns so they're distinguishable in SHAP / Spearman
        sp = sp.rename(columns={c: f"sp_{c}" for c in sp.columns if c != "calendar_date"})
        df = df.merge(sp, on="calendar_date", how="left")
        log.info(f"  Spotify daily signature: {len(sp)} days merged "
                 f"(audio features masked on {int(low_coverage.sum())} low-coverage days)")

    # --- Sort by date ---
    df = df.sort_values("calendar_date").reset_index(drop=True)

    # -----------------------------------------------------------------------
    # DERIVED FEATURES
    # -----------------------------------------------------------------------
    log.info("Engineering derived features…")

    # Numeric coerce all non-date columns
    for c in df.columns:
        if c != "calendar_date":
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # HRV lags & rolling stats
    df["hrv_lag1"] = df[TARGET].shift(1)
    df["hrv_lag2"] = df[TARGET].shift(2)
    df["hrv_lag3"] = df[TARGET].shift(3)
    df["hrv_7d_mean"] = df[TARGET].shift(1).rolling(7, min_periods=3).mean()
    df["hrv_7d_std"] = df[TARGET].shift(1).rolling(7, min_periods=3).std()
    # 28-day rolling baseline + personal z-score (audit findings 6.C, 6.D).
    # All windows shifted by 1 so row i only sees data from i-1 and earlier — no leakage.
    df["hrv_28d_mean"] = df[TARGET].shift(1).rolling(28, min_periods=10).mean()
    df["hrv_28d_std"] = df[TARGET].shift(1).rolling(28, min_periods=10).std()
    df["hrv_z_28d"] = (df[TARGET] - df["hrv_28d_mean"]) / df["hrv_28d_std"].replace(0, np.nan)
    df["delta_hrv"] = df[TARGET] - df["hrv_lag1"]
    df["delta_rhr"] = df.get("whoop_rhr", pd.Series(dtype=float)) - \
                       df.get("whoop_rhr", pd.Series(dtype=float)).shift(1)

    # Personal z-scores against a 28-day rolling baseline for non-HRV vitals
    # (audit finding 6.D). Unitless, comparable across subjects/devices.
    def _personal_z(col: str) -> pd.Series:
        if col not in df.columns:
            return None
        prior = df[col].shift(1)
        m = prior.rolling(28, min_periods=10).mean()
        s = prior.rolling(28, min_periods=10).std()
        return (df[col] - m) / s.replace(0, np.nan)

    for c in ("whoop_rhr", "whoop_sleep_duration_milli", "whoop_day_strain",
              "garmin_rhr", "whoop_recovery_score"):
        z = _personal_z(c)
        if z is not None:
            df[f"{c}_z28d"] = z

    # Behavior lags (audit finding 6.E) — only HRV had t-1/t-2/t-3 lags before;
    # cumulative effects of alcohol / caffeine / strain across multiple days
    # were invisible to the model.
    for col in ("whoop_day_strain", "rolling_7d_training_load",
                "whoop_sleep_duration_milli", "whoop_sleep_efficiency"):
        if col in df.columns:
            df[f"{col}_lag1"] = df[col].shift(1)
            df[f"{col}_lag2"] = df[col].shift(2)
    for jcol in ("journal_have_any_alcoholic_drinks", "journal_consumed_caffeine",
                 "journal_ate_food_close_to_bedtime"):
        if jcol in df.columns:
            df[f"{jcol}_lag1"] = df[jcol].shift(1)
    # Cumulative effects of habit completion: 1-day lag for every habit so the
    # model can detect "did this habit yesterday → today's HRV" relationships
    # without us having to hardcode habit names (they're user-defined in Notion).
    for hcol in [c for c in df.columns if c.startswith("habit_")]:
        df[f"{hcol}_lag1"] = df[hcol].shift(1)

    # Day-of-week
    dt = pd.to_datetime(df["calendar_date"], errors="coerce")
    df["day_of_week"] = dt.dt.dayofweek.astype(float)
    df["is_weekend"] = (dt.dt.dayofweek >= 5).astype(float)

    # Training load ratio (guard div-by-zero)
    if "acute_training_load" in df.columns and "chronic_training_load" in df.columns:
        df["atl_ctl_ratio"] = df["acute_training_load"] / df["chronic_training_load"].replace(0, np.nan)

    # Rolling activity load
    if "total_training_load" in df.columns:
        df["rolling_3d_training_load"] = df["total_training_load"].shift(1).rolling(3, min_periods=1).sum()
        df["rolling_7d_training_load"] = df["total_training_load"].shift(1).rolling(7, min_periods=1).sum()
        df["rolling_7d_activity_duration"] = df.get("total_activity_duration_min",
                                                       pd.Series(dtype=float)).shift(1).rolling(7, min_periods=1).sum()

    # Days since hard workout (aerobic TE >= 4.0)
    if "max_aerobic_te" in df.columns:
        hard_flag = (df["max_aerobic_te"] >= 4.0).astype(float)
        df["days_since_hard_workout"] = _days_since(hard_flag)
    if "is_rest_day" in df.columns:
        df["days_since_rest_day"] = _days_since(df["is_rest_day"].fillna(1))
    if "is_run_day" in df.columns:
        df["consecutive_run_days"] = _consecutive_days(df["is_run_day"].fillna(0))

    # ── ADR-0001 Travel features (Phase A) ──────────────────────────────────
    # Surface transition-day patterns to the model so it can learn travel-day
    # behavior rather than treating those rows as noise. All four features
    # derive from whoop_cycles.timezone_offset + transition flag already on
    # the behavioral view. Useful for both XGBoost (as direct features) and
    # the causal layer (Phase B treats is_transition_day as a treatment).
    if "onyx_is_transition_day" in df.columns:
        df["is_transition_day"] = df["onyx_is_transition_day"].fillna(False).astype(int)
        # Days since most recent transition. 0 on transition day itself,
        # 1 the day after, 2 the day after that, etc. Reset on every
        # transition. Captures the recovery curve from jet lag (most
        # severe day 0-1, fading over ~3-5 days).
        df["days_since_transition"] = _days_since(df["is_transition_day"].astype(float))
        # WHOOP timezone_offset is "+02:00" / "-04:00"; parse to signed
        # hours. Then offset_delta = this_day's_offset - prior_day's_offset
        # (zero on non-transition days, nonzero on transitions). Magnitude
        # = how big the jump was (Berlin = +6h east, Texas = -1h west).
        if "timezone_offset" in df.columns:
            def _parse_off_hours(s):
                if not s or pd.isna(s): return np.nan
                sign = 1 if str(s)[0] == "+" else -1
                try:
                    hh, mm = str(s)[1:].split(":")
                    return sign * (int(hh) + int(mm) / 60.0)
                except Exception:
                    return np.nan
            df["_offset_hours"] = df["timezone_offset"].apply(_parse_off_hours)
            df["offset_delta_hours"] = df["_offset_hours"] - df["_offset_hours"].shift(1)
            df["offset_delta_hours"] = df["offset_delta_hours"].fillna(0.0)
            # is_outbound: traveling AWAY from NY (offset != NY's offset on
            # transition day, and the prior day WAS NY's offset).
            # is_return: traveling BACK to NY (this day IS NY's offset, prior
            # day wasn't). NY offset varies with DST so we determine via
            # absolute magnitude: outbound usually means |delta| > 0 going
            # to non-NY; return means delta back toward 0.
            #
            # Simpler heuristic: outbound = transition AND moving offset
            # AWAY from 0 (or NY-typical -4/-5). Return = transition AND
            # moving offset TOWARD it.
            ny_typical_offsets = {-4.0, -5.0}
            def _classify(row):
                if not row["is_transition_day"]:
                    return 0, 0
                this_off = row["_offset_hours"]
                if pd.isna(this_off):
                    return 0, 0
                # outbound if THIS day's offset is NOT NY-typical
                outbound = 1 if this_off not in ny_typical_offsets else 0
                return_ = 1 if this_off in ny_typical_offsets else 0
                return outbound, return_
            classifications = df.apply(_classify, axis=1, result_type="expand")
            df["is_outbound"] = classifications[0]
            df["is_return"] = classifications[1]
            df.drop(columns=["_offset_hours"], inplace=True)

    # Cumulative sleep debt proxy (7-day rolling avg vs 8h baseline)
    if "whoop_sleep_duration_milli" in df.columns:
        eight_h_ms = 8 * 3600 * 1000
        df["sleep_debt_7d"] = (
            df["whoop_sleep_duration_milli"].shift(1).rolling(7, min_periods=3).mean() - eight_h_ms
        ) / (1000 * 3600)  # in hours

    # Sleep stage percentages
    if "whoop_sleep_duration_milli" in df.columns and df["whoop_sleep_duration_milli"].notna().any():
        total_ms = df["whoop_sleep_duration_milli"].replace(0, np.nan)
        df["whoop_deep_pct"] = df["whoop_deep_sleep_milli"] / total_ms
        df["whoop_rem_pct"] = df["whoop_rem_sleep_milli"] / total_ms
        df["whoop_light_pct"] = df["whoop_light_sleep_milli"] / total_ms

    if "garmin_sleep_duration_sec" in df.columns and df["garmin_sleep_duration_sec"].notna().any():
        total_s = df["garmin_sleep_duration_sec"].replace(0, np.nan)
        df["garmin_deep_pct"] = df["garmin_deep_sleep_sec"] / total_s
        if "rem_sleep_seconds" in df.columns:
            df["garmin_rem_pct"] = df["rem_sleep_seconds"] / total_s

    # WHOOP sleep debt ratio (actual / baseline need)
    if "whoop_sleep_duration_milli" in df.columns and "baseline_milli" in df.columns:
        df["sleep_debt_ratio"] = df["whoop_sleep_duration_milli"] / df["baseline_milli"].replace(0, np.nan)

    # Nutrition ratios
    if "mfp_calories" in df.columns:
        cals = df["mfp_calories"].replace(0, np.nan)
        if "mfp_protein_g" in df.columns:
            df["protein_pct"] = df["mfp_protein_g"] * 4 / cals
        if "mfp_carbs_g" in df.columns:
            df["carb_pct"] = df["mfp_carbs_g"] * 4 / cals
        if "mfp_fat_g" in df.columns:
            df["fat_pct"] = df["mfp_fat_g"] * 9 / cals
        if "exercise_kcal" in df.columns:
            df["net_calories"] = df["mfp_calories"] - df["exercise_kcal"].fillna(0)

    # Journal-derived "days since" features
    j_alcohol_col = next((c for c in df.columns if "alcoholic" in c or c == "journal_have_any_alcoholic_drinks"), None)
    j_sauna_col = next((c for c in df.columns if "sauna" in c), None)
    if j_alcohol_col:
        df["days_since_alcohol"] = _days_since(df[j_alcohol_col].fillna(0))
    if j_sauna_col:
        df["days_since_sauna"] = _days_since(df[j_sauna_col].fillna(0))

    # HR zone percentages from garmin_heart_rate
    for i in range(1, 6):
        c = f"zone_{i}_seconds"
        if c in df.columns:
            total_zones = sum(
                df.get(f"zone_{j}_seconds", pd.Series(0, index=df.index)) for j in range(1, 6)
            )
            df[f"pct_zone_{i}"] = df[c] / total_zones.replace(0, np.nan)

    # Workout-to-sleep timing — distance from last workout end to bedtime
    # (Riley's question, 2026-04-16). Late-evening workouts are known to delay
    # sleep onset and depress overnight HRV.
    try:
        wts = workout_to_sleep_gap(data)
        if not wts.empty:
            df = df.merge(wts, on="calendar_date", how="left", suffixes=("", "_wts"))
    except Exception as e:
        log.warning(f"  workout_to_sleep_gap failed: {e}")

    # Interaction terms (audit finding 6.F) — domain priors: alcohol amplified
    # by short sleep, late caffeine blunts post-strain recovery, hot bedroom
    # shortens deep sleep, ATL/CTL ratio matters more when HRV baseline is low.
    def _has(*cols): return all(c in df.columns for c in cols)
    if _has("journal_have_any_alcoholic_drinks", "whoop_sleep_duration_milli"):
        df["alcohol_x_sleep_duration"] = (
            df["journal_have_any_alcoholic_drinks"].fillna(0) *
            df["whoop_sleep_duration_milli"]
        )
    if _has("whoop_day_strain", "journal_consumed_caffeine"):
        df["strain_x_caffeine"] = (
            df["whoop_day_strain"] *
            df["journal_consumed_caffeine"].fillna(0)
        )
    if _has("rolling_7d_training_load", "hrv_lag1"):
        df["load_x_hrv_lag1"] = df["rolling_7d_training_load"] * df["hrv_lag1"]
    if _has("eight_sleep_room_temp", "whoop_sleep_efficiency"):
        df["room_temp_x_sleep_eff"] = df["eight_sleep_room_temp"] * df["whoop_sleep_efficiency"]
    if _has("mfp_sodium_mg", "mfp_water_ml"):
        df["sodium_per_water"] = df["mfp_sodium_mg"] / df["mfp_water_ml"].replace(0, np.nan)
    # Workout timing × intensity: a hard workout 30 min before bed should
    # depress HRV more than a hard workout 4 hours before bed.
    if _has("last_workout_end_to_sleep_min", "last_workout_whoop_strain"):
        df["whoop_strain_per_hour_to_bed"] = (
            df["last_workout_whoop_strain"]
            / (df["last_workout_end_to_sleep_min"].clip(lower=15) / 60)
        )

    # Drop duplicate columns from suffix merges
    dup_cols = [c for c in df.columns if c.endswith(("_gds", "_gs", "_ghr", "_garminhrv",
                                                       "_stress", "_gts", "_acts", "_wc",
                                                       "_ws", "_ww", "_bm", "_es", "_mfp"))]
    df = df.drop(columns=dup_cols, errors="ignore")

    log.info(f"Feature matrix shape: {df.shape}")
    return df


def _days_since(flag: pd.Series) -> pd.Series:
    """Return days elapsed since the last True/1 value in a binary series."""
    result = pd.Series(np.nan, index=flag.index, dtype=float)
    last = np.nan
    for i, v in enumerate(flag):
        if v == 1 or v is True:
            last = i
        result.iloc[i] = i - last if not np.isnan(last) else np.nan
    return result


def workout_to_sleep_gap(data: dict) -> pd.DataFrame:
    """Compute time between last workout end and sleep onset, per calendar_date.

    For row N (calendar_date = N), the gap measures: (sleep onset of the cycle
    that ends on the morning of N+1, i.e. the night sleep covering N→N+1)
    minus (end_time of the latest workout that finished within 18 hours
    before that sleep onset). The HRV pipeline uses N to predict HRV at the
    end of that sleep, so this feature describes "how late was your last
    workout relative to bedtime on day N".

    Returns a DataFrame keyed on calendar_date (str) with:
      last_workout_end_to_sleep_min : float, NULL if no workout in prior 18h
      last_workout_whoop_strain     : float, only set if last workout was WHOOP
      last_workout_garmin_load      : float, only set if last workout was Garmin
      had_evening_workout           : 1.0 if last workout ended after 18:00 ET
    Strain is split by source because WHOOP strain (0-21) and Garmin
    training_load (50-1000+) are not on comparable scales — a single mixed
    column would feed apples-to-oranges values into the model.
    """
    sleep = data.get("whoop_sleep", pd.DataFrame())
    cycles = data.get("whoop_cycles", pd.DataFrame())
    whoop_wk = data.get("whoop_wk", pd.DataFrame())
    gact = data.get("garmin_acts", pd.DataFrame())

    EMPTY_COLS = ["calendar_date", "last_workout_end_to_sleep_min",
                  "last_workout_whoop_strain", "last_workout_garmin_load",
                  "had_evening_workout"]
    if sleep.empty or "start_time" not in sleep.columns or cycles.empty:
        return pd.DataFrame(columns=EMPTY_COLS)

    # Sleep onset per cycle. cycles.calendar_date is the canonical ET "wake
    # day" already (computed via to_cycle_et_date_str at load time = midday
    # ET of the day the cycle represents). The sleep that BEGINS that cycle
    # is the night of cycle_date-1 → cycle_date, so behaviors causing it are
    # on cycle_date-1. Shift back by 1 to put sleep_onset on the row for the
    # day whose behaviors caused it.
    sleep_with_date = sleep.merge(
        cycles[["cycle_id", "calendar_date"]], on="cycle_id", how="inner"
    )
    sleep_with_date["sleep_onset"] = pd.to_datetime(
        sleep_with_date["start_time"], utc=True, errors="coerce", format="ISO8601"
    )
    sleep_with_date = sleep_with_date.dropna(subset=["sleep_onset", "calendar_date"])
    sleep_with_date["pred_date"] = (
        pd.to_datetime(sleep_with_date["calendar_date"]) - pd.Timedelta(days=1)
    ).dt.strftime("%Y-%m-%d")
    # Earliest sleep onset per pred_date (in case of multiple sleeps in a cycle)
    sleep_per_date = (
        sleep_with_date.sort_values("sleep_onset")
        .drop_duplicates("pred_date", keep="first")[["pred_date", "sleep_onset"]]
        .reset_index(drop=True)
    )

    # All workouts with a usable end_time, in true UTC. Tag source so we keep
    # WHOOP strain (0-21 scale) and Garmin training_load (50-1000+ scale)
    # in separate columns — never mix them.
    #
    # Both source timestamps are *true UTC* (WHOOP start_time/end_time directly,
    # Garmin start_time_gmt). We don't use to_et_date_str here because the
    # asof-merge against sleep_onset operates in raw UTC instants — only the
    # `had_evening_workout` boolean below converts to ET, matching the canonical
    # convention for point-in-time events.
    def _utc(s):
        return pd.to_datetime(s, utc=True, errors="coerce", format="ISO8601")

    workouts = []
    if not whoop_wk.empty and "end_time" in whoop_wk.columns:
        w = whoop_wk[["start_time", "end_time", "strain"]].copy()
        w["start_time"] = _utc(w["start_time"])
        w["end_time"] = _utc(w["end_time"])
        w["whoop_strain"] = pd.to_numeric(w["strain"], errors="coerce")
        w["garmin_load"] = float("nan")
        w["src_priority"] = 1  # WHOOP wins ties on de-dup
        workouts.append(w[["start_time", "end_time", "whoop_strain",
                            "garmin_load", "src_priority"]]
                        .dropna(subset=["end_time"]))
    if not gact.empty and "start_time_gmt" in gact.columns and "duration_seconds" in gact.columns:
        g = gact[["start_time_gmt", "duration_seconds", "training_load"]].copy()
        g["start_time"] = _utc(g["start_time_gmt"])
        g["end_time"] = g["start_time"] + pd.to_timedelta(
            pd.to_numeric(g["duration_seconds"], errors="coerce"), unit="s"
        )
        g["whoop_strain"] = float("nan")
        g["garmin_load"] = pd.to_numeric(g["training_load"], errors="coerce")
        g["src_priority"] = 0
        workouts.append(g[["start_time", "end_time", "whoop_strain",
                            "garmin_load", "src_priority"]]
                        .dropna(subset=["end_time"]))
    if not workouts:
        return pd.DataFrame(columns=EMPTY_COLS)
    all_w = pd.concat(workouts, ignore_index=True).dropna(subset=["end_time"])

    # WHOOP↔Garmin de-dup: collapse workouts whose end_time is within 5
    # minutes of another (= same session recorded twice). Prefer WHOOP since
    # its strain metric is the more validated signal for HRV impact.
    all_w = all_w.sort_values("end_time").reset_index(drop=True)
    all_w["dedup_key"] = (all_w["end_time"].astype("int64") // (5 * 60 * 10**9))
    all_w = (all_w.sort_values(["dedup_key", "src_priority"], ascending=[True, False])
                  .drop_duplicates("dedup_key", keep="first")
                  .sort_values("end_time")
                  .reset_index(drop=True))

    # asof-join: latest workout end <= sleep_onset, within 18h. merge_asof
    # requires identical datetime resolutions, so coerce both sides to ns.
    sleep_per_date = sleep_per_date.sort_values("sleep_onset")
    sleep_per_date["sleep_onset"] = sleep_per_date["sleep_onset"].astype("datetime64[ns, UTC]")
    all_w["end_time"] = all_w["end_time"].astype("datetime64[ns, UTC]")
    merged = pd.merge_asof(
        sleep_per_date,
        all_w[["end_time", "whoop_strain", "garmin_load"]]
            .rename(columns={"end_time": "last_wk_end"}),
        left_on="sleep_onset", right_on="last_wk_end",
        direction="backward",
        tolerance=pd.Timedelta(hours=18),
    )
    merged["last_workout_end_to_sleep_min"] = (
        (merged["sleep_onset"] - merged["last_wk_end"]).dt.total_seconds() / 60.0
    )
    et_hour = merged["last_wk_end"].dt.tz_convert("America/New_York").dt.hour
    merged["had_evening_workout"] = ((et_hour >= 18) & merged["last_wk_end"].notna()).astype(float)
    merged = merged.rename(columns={
        "pred_date": "calendar_date",
        "whoop_strain": "last_workout_whoop_strain",
        "garmin_load": "last_workout_garmin_load",
    })
    return merged[[
        "calendar_date", "last_workout_end_to_sleep_min",
        "last_workout_whoop_strain", "last_workout_garmin_load",
        "had_evening_workout",
    ]]


def _consecutive_days(flag: pd.Series) -> pd.Series:
    """Count consecutive 1s up to and including the current row."""
    result = pd.Series(0.0, index=flag.index)
    streak = 0
    for i, v in enumerate(flag):
        if v == 1:
            streak += 1
        else:
            streak = 0
        result.iloc[i] = streak
    return result


def print_completeness(df: pd.DataFrame) -> None:
    """Log per-column non-null percentages."""
    target_rows = df[TARGET].notna().sum()
    log.info(f"Rows with {TARGET}: {target_rows}")
    categories = {
        "Core WHOOP": [c for c in df.columns if c.startswith("whoop_")],
        "Garmin Core": ["total_steps", "avg_stress_level", "body_battery_highest",
                        "garmin_sleep_score", "training_readiness_score"],
        "Garmin HRV": [c for c in df.columns if "last_night" in c or "weekly_avg" in c or "baseline_" in c],
        "Eight Sleep": [c for c in df.columns if "eight_sleep" in c],
        "Nutrition":   [c for c in df.columns if "mfp_" in c],
        "Journal":     [c for c in df.columns if c.startswith("journal_")],
        "Habits":      [c for c in df.columns if c.startswith("habit_")],
        "Supplements": [c for c in df.columns if c.startswith("supplement_")],
    }
    for cat, cols in categories.items():
        valid = [c for c in cols if c in df.columns]
        if valid:
            pct = df[valid].notna().mean().mean() * 100
            log.info(f"  {cat}: {pct:.0f}% coverage ({len(valid)} features)")


# ===========================================================================
# PHASE 2 – STATISTICAL ANALYSIS
# ===========================================================================

def run_statistical_analysis(
    df: pd.DataFrame,
    skip: bool = False,
    supplements: pd.DataFrame | None = None,
) -> dict:
    """Correlation analysis, journal impact, Granger tests. Returns result dict.

    `supplements` is the long-format supplement_intake_by_compound DataFrame
    (one row per (calendar_date, ingredient_group)). When provided, runs
    per-compound Yes/No t-tests and dose-response Spearman correlations.
    """
    results: dict = {}

    # Use next-night HRV as the analysis target.
    # WHOOP cycles start ~1 AM (after midnight), so calendar_date N = sleep on morning of N.
    # The behaviors that drove that HRV happened on day N-1. By shifting the target forward
    # by one day we correctly ask: "do today's behaviors predict tonight's HRV?"
    df = df.copy()
    df["hrv_next"] = df[TARGET].shift(-1)
    STAT_TARGET = "hrv_next"

    hrv_valid = df.dropna(subset=[STAT_TARGET])
    # Exclude target + same-target-shifted-back + pure-autocorrelation transforms of HRV.
    # Including these in the descriptive driver chart crowds out behavioral signals with
    # trivial "yesterday's HRV correlates with tomorrow's HRV" results.
    # `whoop_hrv_rmssd` IS the target one row back. `whoop_recovery_score` is the WHOOP
    # composite of that same prior-night HRV/RHR pair. `hrv_*` lags/rolling/z-scores are
    # explicit HRV-history transforms and are already used as Stage-3 OLS controls.
    PHASE2_AUTOCORR_EXCLUDE = {
        TARGET,
        "whoop_recovery_score",
        "hrv_lag1", "hrv_lag2", "hrv_lag3",
        "hrv_7d_mean", "hrv_7d_std",
        "hrv_28d_mean", "hrv_28d_std", "hrv_z_28d",
        "delta_hrv", "hrv_vs_baseline",
    }
    numeric_cols = [c for c in hrv_valid.columns
                    if c not in ("calendar_date", STAT_TARGET)
                    and c not in PHASE2_AUTOCORR_EXCLUDE
                    and hrv_valid[c].nunique() >= 2
                    and hrv_valid[c].notna().sum() >= 30]

    log.info(f"Statistical analysis: {len(numeric_cols)} numeric features, {len(hrv_valid)} rows")

    # --- Spearman correlations ---
    corr_rows = []
    for c in numeric_cols:
        sub = hrv_valid[[STAT_TARGET, c]].dropna()
        if len(sub) < 20:
            continue
        try:
            res = stats.spearmanr(sub[STAT_TARGET], sub[c])
            r = float(res.statistic if hasattr(res, "statistic") else res[0])
            p = float(res.pvalue if hasattr(res, "pvalue") else res[1])
            corr_rows.append({"feature": c, "spearman_r": r, "p_value": p,
                               "n": int(len(sub)), "label": FEATURE_LABELS.get(c, c)})
        except Exception:
            pass

    if corr_rows:
        corr_df = pd.DataFrame(corr_rows)
        # Apply Benjamini-Hochberg FDR correction across the full candidate set.
        # Without this, ~10 of the top-25 by raw p-value are expected false positives at alpha=0.05.
        if HAS_FDR and len(corr_df) > 1:
            passes, q_values = fdrcorrection(corr_df["p_value"].values, alpha=FDR_Q_THRESHOLD)
            corr_df["q_value"] = q_values
            corr_df["passes_fdr"] = passes
        else:
            corr_df["q_value"] = corr_df["p_value"]
            corr_df["passes_fdr"] = corr_df["p_value"] < FDR_Q_THRESHOLD
        n_survivors = int(corr_df["passes_fdr"].sum())
        log.info(f"  BH-FDR (q<={FDR_Q_THRESHOLD}): {n_survivors}/{len(corr_df)} features survive")
        order = np.argsort(np.abs(corr_df["spearman_r"].values))[::-1]
        corr_df = corr_df.iloc[order].reset_index(drop=True)
        results["correlations"] = corr_df
        results["n_fdr_survivors"] = n_survivors

    if skip:
        return results

    # --- Correlation heatmap (top 20 by abs correlation) ---
    try:
        top20 = corr_df.head(20)["feature"].tolist()
        heat_df = hrv_valid[[STAT_TARGET] + [c for c in top20 if c in hrv_valid.columns]].dropna(how="all")
        pearson_mat = heat_df.corr(method="pearson")
        fig, ax = plt.subplots(figsize=(12, 10))
        sns.heatmap(pearson_mat, cmap="RdBu_r", center=0, vmin=-1, vmax=1,
                    annot=True, fmt=".2f", annot_kws={"size": 7},
                    xticklabels=[FEATURE_LABELS.get(c, c) for c in pearson_mat.columns],
                    yticklabels=[FEATURE_LABELS.get(c, c) for c in pearson_mat.index],
                    ax=ax)
        ax.set_title("Pearson Correlation Heatmap (Top-20 HRV Features)")
        plt.tight_layout()
        fig.savefig(OUTPUT_DIR / "correlation_heatmap.png", dpi=120)
        plt.close(fig)
        log.info("  Saved: correlation_heatmap.png")
    except Exception as e:
        log.warning(f"  Heatmap failed: {e}")

    # --- Top-25 driver bar chart ---
    try:
        top25 = corr_df.head(25).copy()
        top25["label"] = top25["feature"].map(lambda x: FEATURE_LABELS.get(x, x))
        fig, ax = plt.subplots(figsize=(10, 8))
        colors = ["#22c55e" if r > 0 else "#ef4444" for r in top25["spearman_r"]]
        ax.barh(top25["label"][::-1], top25["spearman_r"][::-1], color=colors[::-1])
        ax.axvline(0, color="#ffffff", linewidth=0.5, alpha=0.4)
        ax.set_xlabel("Spearman r with next-night WHOOP HRV")
        ax.set_title("Top 25 HRV Drivers — Spearman Correlation (behaviors -> next night)")
        ax.set_facecolor("#1a1a1d")
        fig.patch.set_facecolor("#0a0a0b")
        ax.tick_params(colors="#a1a1aa")
        ax.xaxis.label.set_color("#a1a1aa")
        ax.title.set_color("#f4f4f5")
        plt.tight_layout()
        fig.savefig(OUTPUT_DIR / "top25_drivers.png", dpi=120)
        plt.close(fig)
        log.info("  Saved: top25_drivers.png")
    except Exception as e:
        log.warning(f"  Top-25 chart failed: {e}")

    # --- Partial correlations (pingouin) ---
    # Restrict to BH-FDR survivors so we don't waste partial-correlation power on
    # features that already failed the multiple-comparison gate.
    if HAS_PINGOUIN:
        try:
            partial_results = []
            controls = [c for c in ["hrv_lag1", "whoop_sleep_duration_milli"]
                        if c in hrv_valid.columns]
            survivors_df = corr_df[corr_df["passes_fdr"]] if "passes_fdr" in corr_df.columns else corr_df
            top15_feats = survivors_df.head(15)["feature"].tolist()
            for feat in top15_feats:
                if feat in controls:
                    continue
                cols_needed = [STAT_TARGET, feat] + controls
                sub = hrv_valid[cols_needed].dropna()
                if len(sub) < 30:
                    continue
                try:
                    r_partial = pg.partial_corr(data=sub, x=feat, y=STAT_TARGET, covar=controls)
                    partial_results.append({
                        "feature": feat, "label": FEATURE_LABELS.get(feat, feat),
                        "partial_r": float(r_partial["r"].iloc[0]),
                        "p_value": float(r_partial["p-val"].iloc[0]),
                    })
                except Exception:
                    pass
            if partial_results:
                pd.DataFrame(partial_results).to_csv(OUTPUT_DIR / "partial_correlations.csv", index=False)
                log.info("  Saved: partial_correlations.csv")
        except Exception as e:
            log.warning(f"  Partial correlations failed: {e}")

    # --- Stage 3: standardized OLS with Cohen's f² (audit finding 2.C) ---
    # For every BH-FDR survivor, fit y ~ all_survivors and y ~ all_survivors\{feat},
    # report standardized beta + f² so we can compare effect sizes on a
    # comparable scale. Newey-West HAC SEs handle the autocorrelation we know
    # exists in HRV residuals (audit Phase 2 DW = 2.91 on persistence).
    #
    # Predictor cap (self-review fix): the audit's own finding 1.A said this
    # dataset is 5-10× under-powered for OLS without dimensionality reduction.
    # The previous version capped k=30 anyway, giving ~3 obs/predictor on the
    # joint-non-null subset (n=98) — severely overfit. Now we enforce the
    # 20-obs/predictor floor explicitly, and surface a warning row in the
    # stored JSON so consumers know how reliable the betas are.
    try:
        if HAS_STATSMODELS and "passes_fdr" in corr_df.columns:
            from sklearn.preprocessing import StandardScaler
            import statsmodels.api as sm

            survivors = corr_df[corr_df["passes_fdr"]]["feature"].tolist()
            survivors = [c for c in survivors if c in hrv_valid.columns]
            # Probe the joint-non-null sample size for the top 30 candidates,
            # then pick the largest k satisfying n / k >= 20.
            probe = hrv_valid[[STAT_TARGET] + survivors[:30]].dropna()
            n_probe = len(probe)
            k_max_for_n = max(2, n_probe // 20)
            k = min(len(survivors), k_max_for_n, 15)
            survivors = survivors[:k]
            stage3_df = hrv_valid[[STAT_TARGET] + survivors].dropna()
            if len(stage3_df) >= 60 and len(survivors) >= 2:
                X_full = stage3_df[survivors].astype(float).values
                y = stage3_df[STAT_TARGET].astype(float).values
                X_full_std = StandardScaler().fit_transform(X_full)
                X_full_const = sm.add_constant(X_full_std)
                full_fit = sm.OLS(y, X_full_const).fit(
                    cov_type="HAC", cov_kwds={"maxlags": 7}
                )
                r2_full = float(full_fit.rsquared)
                stage3_rows = []
                for i, feat in enumerate(survivors):
                    # Reduced model omits predictor i
                    X_red = np.delete(X_full_std, i, axis=1)
                    X_red_const = sm.add_constant(X_red)
                    red_fit = sm.OLS(y, X_red_const).fit()
                    r2_red = float(red_fit.rsquared)
                    f2 = (r2_full - r2_red) / max(1.0 - r2_full, 1e-9)
                    stage3_rows.append({
                        "feature": feat,
                        "label": FEATURE_LABELS.get(feat, feat),
                        # +1 because const is at index 0
                        "beta_std": float(full_fit.params[i + 1]),
                        "se_hac": float(full_fit.bse[i + 1]),
                        "p_value": float(full_fit.pvalues[i + 1]),
                        "cohens_f2": float(f2),
                        "r2_full": r2_full,
                        "r2_reduced": r2_red,
                        "n": int(len(stage3_df)),
                        "k": int(len(survivors)),
                        "obs_per_predictor": round(len(stage3_df) / max(len(survivors), 1), 1),
                    })
                if stage3_rows:
                    s3 = pd.DataFrame(stage3_rows)
                    s3 = s3.iloc[np.argsort(np.abs(s3["beta_std"].values))[::-1]].reset_index(drop=True)
                    s3.to_csv(OUTPUT_DIR / "stage3_standardized_ols.csv", index=False)
                    obs_pp = len(stage3_df) / max(len(survivors), 1)
                    log.info(f"  Stage 3 OLS (HAC SE): n={len(stage3_df)}, k={len(survivors)}, "
                             f"obs/predictor={obs_pp:.1f}, R²={r2_full:.3f}")
                    if obs_pp < 20:
                        log.warning(f"  Stage 3 obs/predictor={obs_pp:.1f} < 20 — betas may be unstable")
                    log.info("  Saved: stage3_standardized_ols.csv")
                    results["stage3_ols"] = stage3_rows
    except Exception as e:
        log.warning(f"  Stage 3 OLS failed: {e}")

    # --- Journal conditional analysis ---
    journal_cols = [c for c in hrv_valid.columns if c.startswith("journal_")]
    journal_impact = []
    if journal_cols:
        try:
            for jc in journal_cols:
                sub = hrv_valid[[STAT_TARGET, jc]].dropna()
                yes = sub.loc[sub[jc] == 1, STAT_TARGET]
                no = sub.loc[sub[jc] == 0, STAT_TARGET]
                if len(yes) < 5 or len(no) < 5:
                    continue
                t_stat, p_val = stats.ttest_ind(yes, no, equal_var=False)
                diff = yes.mean() - no.mean()
                pooled_std = np.sqrt((yes.std()**2 + no.std()**2) / 2)
                cohen_d = diff / pooled_std if pooled_std > 0 else 0
                se = np.sqrt(yes.var() / len(yes) + no.var() / len(no))
                ci_low = diff - 1.96 * se
                ci_high = diff + 1.96 * se
                clean_name = jc.replace("journal_", "")
                label = JOURNAL_LABELS.get(clean_name, clean_name.replace("_", " ").title())
                journal_impact.append({
                    "feature": jc, "label": label,
                    "mean_yes": float(yes.mean()), "mean_no": float(no.mean()),
                    "diff_ms": float(diff), "ci_low": float(ci_low), "ci_high": float(ci_high),
                    "p_value": float(p_val), "cohen_d": float(cohen_d),
                    "n_yes": int(len(yes)), "n_no": int(len(no)),
                })

            # BH-FDR across the ~57 journal questions. Without correction we'd
            # expect ~3 false positives at alpha=0.05, which the UI would surface
            # as "real" drivers. Mirrors the supplement/nutrition correction.
            if journal_impact and HAS_FDR and len(journal_impact) > 1:
                p_values = np.array([r["p_value"] for r in journal_impact])
                passes, q_values = fdrcorrection(p_values, alpha=FDR_Q_THRESHOLD)
                for row, q, p_pass in zip(journal_impact, q_values, passes):
                    row["q_value"] = float(q)
                    row["passes_fdr"] = bool(p_pass)
                n_surv = int(passes.sum())
                log.info(f"  Journal impact BH-FDR (q<={FDR_Q_THRESHOLD}): "
                         f"{n_surv}/{len(journal_impact)} survive")
            if journal_impact:
                ji_df = pd.DataFrame(journal_impact)
                ji_order = np.argsort(np.abs(ji_df["diff_ms"].values))[::-1]
                ji_df = ji_df.iloc[ji_order].reset_index(drop=True)
                ji_df.to_csv(OUTPUT_DIR / "journal_impact.csv", index=False)
                results["journal_impact"] = journal_impact

                # Bar chart
                fig, ax = plt.subplots(figsize=(10, 8))
                colors = ["#22c55e" if d > 0 else "#ef4444" for d in ji_df["diff_ms"]]
                y_pos = range(len(ji_df))
                ax.barh(list(y_pos), ji_df["diff_ms"].tolist(), color=colors, alpha=0.85)
                ax.set_yticks(list(y_pos))
                ax.set_yticklabels(ji_df["label"].tolist(), fontsize=9)
                ax.axvline(0, color="#ffffff", linewidth=0.5, alpha=0.4)
                ax.set_xlabel("HRV Difference: Yes vs No (ms)")
                ax.set_title("Journal Behavior Impact on Next-Day HRV")
                ax.set_facecolor("#1a1a1d")
                fig.patch.set_facecolor("#0a0a0b")
                ax.tick_params(colors="#a1a1aa")
                ax.xaxis.label.set_color("#a1a1aa")
                ax.title.set_color("#f4f4f5")
                plt.tight_layout()
                fig.savefig(OUTPUT_DIR / "journal_impact.png", dpi=120)
                plt.close(fig)
                log.info("  Saved: journal_impact.png")
        except Exception as e:
            log.warning(f"  Journal analysis failed: {e}")

    # --- Habit conditional analysis ---
    # Mirrors the journal Yes/No t-test but on habit_ columns sourced from
    # pds.habit_journal (Notion-managed habit completions). Habits are user-
    # defined so the column set is dynamic; the analysis is otherwise identical.
    habit_cols = [c for c in hrv_valid.columns if c.startswith("habit_")
                  and not c.endswith("_lag1")]
    habit_impact = []
    if habit_cols:
        try:
            for hc in habit_cols:
                sub = hrv_valid[[STAT_TARGET, hc]].dropna()
                yes = sub.loc[sub[hc] == 1, STAT_TARGET]
                no = sub.loc[sub[hc] == 0, STAT_TARGET]
                if len(yes) < 5 or len(no) < 5:
                    continue
                t_stat, p_val = stats.ttest_ind(yes, no, equal_var=False)
                diff = yes.mean() - no.mean()
                pooled_std = np.sqrt((yes.std()**2 + no.std()**2) / 2)
                cohen_d = diff / pooled_std if pooled_std > 0 else 0
                se = np.sqrt(yes.var() / len(yes) + no.var() / len(no))
                ci_low = diff - 1.96 * se
                ci_high = diff + 1.96 * se
                clean_name = hc.replace("habit_", "")
                label = HABIT_LABELS.get(hc, clean_name.replace("_", " ").title())
                habit_impact.append({
                    "feature": hc, "label": label,
                    "mean_yes": float(yes.mean()), "mean_no": float(no.mean()),
                    "diff_ms": float(diff), "ci_low": float(ci_low), "ci_high": float(ci_high),
                    "p_value": float(p_val), "cohen_d": float(cohen_d),
                    "n_yes": int(len(yes)), "n_no": int(len(no)),
                })

            # BH-FDR across habit columns. Same rationale as journal_impact.
            if habit_impact and HAS_FDR and len(habit_impact) > 1:
                p_values = np.array([r["p_value"] for r in habit_impact])
                passes, q_values = fdrcorrection(p_values, alpha=FDR_Q_THRESHOLD)
                for row, q, p_pass in zip(habit_impact, q_values, passes):
                    row["q_value"] = float(q)
                    row["passes_fdr"] = bool(p_pass)
                n_surv = int(passes.sum())
                log.info(f"  Habit impact BH-FDR (q<={FDR_Q_THRESHOLD}): "
                         f"{n_surv}/{len(habit_impact)} survive")
            if habit_impact:
                hi_df = pd.DataFrame(habit_impact)
                hi_order = np.argsort(np.abs(hi_df["diff_ms"].values))[::-1]
                hi_df = hi_df.iloc[hi_order].reset_index(drop=True)
                hi_df.to_csv(OUTPUT_DIR / "habit_impact.csv", index=False)
                results["habit_impact"] = habit_impact

                fig, ax = plt.subplots(figsize=(10, max(3, len(hi_df) * 0.6)))
                colors = ["#22c55e" if d > 0 else "#ef4444" for d in hi_df["diff_ms"]]
                y_pos = range(len(hi_df))
                ax.barh(list(y_pos), hi_df["diff_ms"].tolist(), color=colors, alpha=0.85)
                ax.set_yticks(list(y_pos))
                ax.set_yticklabels(hi_df["label"].tolist(), fontsize=9)
                ax.axvline(0, color="#ffffff", linewidth=0.5, alpha=0.4)
                ax.set_xlabel("HRV Difference: Yes vs No (ms)")
                ax.set_title("Habit Impact on Next-Day HRV")
                ax.set_facecolor("#1a1a1d")
                fig.patch.set_facecolor("#0a0a0b")
                ax.tick_params(colors="#a1a1aa")
                ax.xaxis.label.set_color("#a1a1aa")
                ax.title.set_color("#f4f4f5")
                plt.tight_layout()
                fig.savefig(OUTPUT_DIR / "habit_impact.png", dpi=120)
                plt.close(fig)
                log.info("  Saved: habit_impact.png")
            else:
                log.info(f"  Habit analysis: {len(habit_cols)} habits found but none "
                         f"met the n_yes>=5, n_no>=5 threshold yet")
        except Exception as e:
            log.warning(f"  Habit analysis failed: {e}")

    # --- Supplement Yes/No impact ---
    # Welch's two-sample t-test on next-night HRV for each compound (Yes vs No
    # nights), with Cohen's d and 95% CI. Yes/No framing is the headline because
    # most compounds are taken at a near-constant dose, so the actionable
    # question is "does taking it help?" rather than a dose-response one.
    # Restricted to dates within the supplement-tracking window so untracked
    # history isn't miscoded as No. BH-FDR corrected across compounds.
    supplement_impact: list[dict] = []
    if supplements is not None and not supplements.empty:
        try:
            supp = supplements.copy()
            supp = supp.dropna(subset=["ingredient_group", "calendar_date"])
            tracking_start = supp["calendar_date"].min()
            tracked = hrv_valid[hrv_valid["calendar_date"] >= tracking_start].copy()
            tracked = tracked[["calendar_date", STAT_TARGET]].dropna()

            for compound, comp_rows in supp.groupby("ingredient_group"):
                yes_dates = set(comp_rows["calendar_date"])
                sub = tracked.copy()
                sub["taken"] = sub["calendar_date"].isin(yes_dates).astype(int)
                yes = sub.loc[sub["taken"] == 1, STAT_TARGET]
                no = sub.loc[sub["taken"] == 0, STAT_TARGET]
                if len(yes) < 3 or len(no) < 3:
                    continue
                try:
                    _, p_val = stats.ttest_ind(yes, no, equal_var=False)
                    diff = yes.mean() - no.mean()
                    pooled_std = np.sqrt((yes.std() ** 2 + no.std() ** 2) / 2)
                    cohen_d = diff / pooled_std if pooled_std > 0 else 0
                    se = np.sqrt(yes.var() / len(yes) + no.var() / len(no))
                    category = (comp_rows["category"].dropna().iloc[0]
                                if not comp_rows["category"].dropna().empty else None)
                    supplement_impact.append({
                        "compound": str(compound),
                        "category": str(category) if category else None,
                        "mean_yes": float(yes.mean()),
                        "mean_no": float(no.mean()),
                        "diff_ms": float(diff),
                        "ci_low": float(diff - 1.96 * se),
                        "ci_high": float(diff + 1.96 * se),
                        "p_value": float(p_val),
                        "cohen_d": float(cohen_d),
                        "n_yes": int(len(yes)),
                        "n_no": int(len(no)),
                        "low_n": bool(min(len(yes), len(no)) < 20),
                    })
                except Exception:
                    continue

            if supplement_impact and HAS_FDR and len(supplement_impact) > 1:
                p_values = np.array([r["p_value"] for r in supplement_impact])
                passes, q_values = fdrcorrection(p_values, alpha=FDR_Q_THRESHOLD)
                for row, q, p_pass in zip(supplement_impact, q_values, passes):
                    row["q_value"] = float(q)
                    row["passes_fdr"] = bool(p_pass)

            if supplement_impact:
                supplement_impact.sort(key=lambda r: abs(r["diff_ms"]), reverse=True)
                results["supplement_impact"] = supplement_impact
                log.info(f"  Supplement impact: {len(supplement_impact)} compounds analyzed "
                         f"(tracking window from {tracking_start})")
            else:
                n_compounds = supp["ingredient_group"].nunique()
                tracked_days = supp["calendar_date"].nunique()
                log.info(f"  Supplement impact: 0 compounds met n>=3 Yes/No threshold "
                         f"({n_compounds} distinct compounds, {tracked_days} tracked days; "
                         f"need more history)")
        except Exception as e:
            log.warning(f"  Supplement Yes/No analysis failed: {e}")

    # --- Supplement dose-response ---
    # Spearman rank correlation between daily total_amount and next-night HRV,
    # for compounds where the dose actually varies (≥3 distinct non-zero amounts).
    # Captures monotonic dose-response effects that Yes/No collapses on.
    # Rank-based to handle outliers and non-linear monotonic responses.
    supplement_dose_response: list[dict] = []
    if supplements is not None and not supplements.empty:
        try:
            supp = supplements.copy()
            supp = supp.dropna(subset=["ingredient_group", "calendar_date", "total_amount"])
            tracking_start = supp["calendar_date"].min()
            tracked = hrv_valid[hrv_valid["calendar_date"] >= tracking_start].copy()
            tracked = tracked[["calendar_date", STAT_TARGET]].dropna()

            for compound, comp_rows in supp.groupby("ingredient_group"):
                distinct_doses = comp_rows["total_amount"].dropna().unique()
                if len(distinct_doses) < 3:
                    continue
                # Build amount-per-date series; days with no intake = 0.
                amt_by_date = comp_rows.groupby("calendar_date")["total_amount"].sum()
                merged = tracked.merge(
                    amt_by_date.rename("amount").reset_index(),
                    on="calendar_date", how="left",
                )
                merged["amount"] = merged["amount"].fillna(0.0)
                if merged["amount"].nunique() < 3 or len(merged) < 20:
                    continue
                try:
                    res = stats.spearmanr(merged[STAT_TARGET], merged["amount"])
                    r = float(res.statistic if hasattr(res, "statistic") else res[0])
                    p = float(res.pvalue if hasattr(res, "pvalue") else res[1])
                    unit = (comp_rows["unit"].dropna().iloc[0]
                            if not comp_rows["unit"].dropna().empty else None)
                    category = (comp_rows["category"].dropna().iloc[0]
                                if not comp_rows["category"].dropna().empty else None)
                    supplement_dose_response.append({
                        "compound": str(compound),
                        "category": str(category) if category else None,
                        "unit": str(unit) if unit else None,
                        "spearman_r": r,
                        "p_value": p,
                        "n": int(len(merged)),
                        "n_distinct_doses": int(len(distinct_doses)),
                        "low_n": bool(len(merged) < 20),
                    })
                except Exception:
                    continue

            if supplement_dose_response and HAS_FDR and len(supplement_dose_response) > 1:
                p_values = np.array([r["p_value"] for r in supplement_dose_response])
                passes, q_values = fdrcorrection(p_values, alpha=FDR_Q_THRESHOLD)
                for row, q, p_pass in zip(supplement_dose_response, q_values, passes):
                    row["q_value"] = float(q)
                    row["passes_fdr"] = bool(p_pass)

            if supplement_dose_response:
                supplement_dose_response.sort(key=lambda r: abs(r["spearman_r"]), reverse=True)
                results["supplement_dose_response"] = supplement_dose_response
                log.info(f"  Supplement dose-response: {len(supplement_dose_response)} compounds (≥3 distinct doses)")
            else:
                log.info("  Supplement dose-response: 0 compounds with ≥3 distinct doses + n≥20 rows")
        except Exception as e:
            log.warning(f"  Supplement dose-response analysis failed: {e}")

    # --- Nutrition Spearman correlation ---
    # Per-nutrient rank correlation with next-night HRV. Spearman (not Pearson)
    # because nutrition data is heavy-tailed (occasional restaurant blowouts),
    # non-normal, and relationships are likely monotonic but not necessarily
    # linear across the full range (e.g. HRV vs sodium 1g→8g).
    # BH-FDR corrected across the nutrient set.
    # Aligned with the `nutrition` family in causal_inference.CONTINUOUS_TREATMENTS.
    # The audit flagged that the descriptive Spearman chart was a 7-column subset
    # of what the causal layer treats as nutrition treatments, so the dashboard
    # silently understated coverage.
    NUTRITION_COLS = {
        "mfp_calories": ("Calories", "kcal"),
        "mfp_protein_g": ("Protein", "g"),
        "mfp_carbs_g": ("Carbohydrates", "g"),
        "mfp_fat_g": ("Fat", "g"),
        "mfp_fiber_g": ("Fiber", "g"),
        "mfp_sugar_g": ("Sugar", "g"),
        "mfp_sodium_mg": ("Sodium", "mg"),
        "mfp_water_ml": ("Water", "ml"),
        "mfp_exercise_kcal": ("Exercise kcal (MFP)", "kcal"),
        "net_calories": ("Net Calories", "kcal"),
        "protein_pct": ("Protein % of Calories", "%"),
        "carb_pct": ("Carb % of Calories", "%"),
        "fat_pct": ("Fat % of Calories", "%"),
    }
    nutrition_impact: list[dict] = []
    try:
        for col, (label, unit) in NUTRITION_COLS.items():
            if col not in hrv_valid.columns:
                continue
            sub = hrv_valid[[STAT_TARGET, col]].dropna()
            if len(sub) < 20 or sub[col].nunique() < 5:
                continue
            try:
                res = stats.spearmanr(sub[STAT_TARGET], sub[col])
                r = float(res.statistic if hasattr(res, "statistic") else res[0])
                p = float(res.pvalue if hasattr(res, "pvalue") else res[1])
                nutrition_impact.append({
                    "feature": col,
                    "label": label,
                    "unit": unit,
                    "spearman_r": r,
                    "p_value": p,
                    "n": int(len(sub)),
                    "low_n": bool(len(sub) < 20),
                })
            except Exception:
                continue

        if nutrition_impact and HAS_FDR and len(nutrition_impact) > 1:
            p_values = np.array([r["p_value"] for r in nutrition_impact])
            passes, q_values = fdrcorrection(p_values, alpha=FDR_Q_THRESHOLD)
            for row, q, p_pass in zip(nutrition_impact, q_values, passes):
                row["q_value"] = float(q)
                row["passes_fdr"] = bool(p_pass)

        if nutrition_impact:
            nutrition_impact.sort(key=lambda r: abs(r["spearman_r"]), reverse=True)
            results["nutrition_impact"] = nutrition_impact
            log.info(f"  Nutrition correlations: {len(nutrition_impact)} nutrients analyzed")
    except Exception as e:
        log.warning(f"  Nutrition analysis failed: {e}")

    # --- ACF / PACF ---
    if HAS_STATSMODELS:
        try:
            hrv_series = hrv_valid[STAT_TARGET].dropna().values
            fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4))
            plot_acf(hrv_series, lags=30, ax=ax1)
            plot_pacf(hrv_series, lags=30, ax=ax2)
            ax1.set_title("ACF — WHOOP HRV")
            ax2.set_title("PACF — WHOOP HRV")
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "acf_pacf.png", dpi=120)
            plt.close(fig)
            log.info("  Saved: acf_pacf.png")
        except Exception as e:
            log.warning(f"  ACF/PACF failed: {e}")

    # --- Granger causality for top 10 features ---
    # Restricted to BH-FDR survivors so Granger isn't inheriting the multiple-
    # comparison bias of the raw top-10 by |r|.
    if HAS_STATSMODELS and corr_rows:
        try:
            granger_pool = (corr_df[corr_df["passes_fdr"]]
                            if "passes_fdr" in corr_df.columns else corr_df)
            top10 = granger_pool.head(10)["feature"].tolist()
            granger_results = []
            for feat in top10:
                sub = hrv_valid[[STAT_TARGET, feat]].dropna()
                if len(sub) < 50:
                    continue
                try:
                    gc = grangercausalitytests(sub[[STAT_TARGET, feat]], maxlag=3, verbose=False)
                    for lag in range(1, 4):
                        f_stat = gc[lag][0]["ssr_ftest"][0]
                        p_val = gc[lag][0]["ssr_ftest"][1]
                        granger_results.append({
                            "feature": feat, "label": FEATURE_LABELS.get(feat, feat),
                            "lag": lag, "f_stat": float(f_stat), "p_value": float(p_val),
                        })
                except Exception:
                    pass
            if granger_results:
                pd.DataFrame(granger_results).to_csv(OUTPUT_DIR / "granger_causality.csv", index=False)
                log.info("  Saved: granger_causality.csv")
        except Exception as e:
            log.warning(f"  Granger causality failed: {e}")

    # --- Rolling correlation (top 5 vs HRV) ---
    if corr_rows:
        try:
            top5 = corr_df.head(5)["feature"].tolist()
            fig, ax = plt.subplots(figsize=(12, 5))
            for feat in top5:
                if feat not in hrv_valid.columns:
                    continue
                roll = hrv_valid[[STAT_TARGET, feat]].dropna().copy()
                if len(roll) < 70:
                    continue
                roll_corr = roll[feat].rolling(60).corr(roll[STAT_TARGET])
                ax.plot(range(len(roll_corr)), roll_corr.values,
                        label=FEATURE_LABELS.get(feat, feat), linewidth=1.5)
            ax.axhline(0, color="#ffffff", linewidth=0.5, alpha=0.4)
            ax.set_xlabel("Day Index")
            ax.set_ylabel("60-Day Rolling Spearman r")
            ax.set_title("Rolling Correlation: Top 5 Features vs HRV")
            ax.legend(fontsize=8)
            ax.set_facecolor("#1a1a1d")
            fig.patch.set_facecolor("#0a0a0b")
            ax.tick_params(colors="#a1a1aa")
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "rolling_correlation.png", dpi=120)
            plt.close(fig)
            log.info("  Saved: rolling_correlation.png")
        except Exception as e:
            log.warning(f"  Rolling correlation failed: {e}")

    log.info("  Statistical analysis complete.")
    return results


# ===========================================================================
# PHASE 3 – PREDICTION MODELS
# ===========================================================================

def prepare_ml_data(df: pd.DataFrame, horizon: int = 1) -> tuple[pd.DataFrame, list[str], pd.Series]:
    """Build X, feature_cols, y for ML. Target = HRV `horizon` days ahead.

    horizon=1 (default) trains/scores a next-day model; horizon=h>1 produces
    the same feature matrix paired with HRV h days into the future, used by
    the multi-horizon backtest in run_evaluation(). Each horizon-specific
    target column is named hrv_target_t{h} so a single dataframe can carry
    multiple horizons side-by-side without colliding, and every hrv_target_t*
    column is excluded from the feature set to prevent target leakage.
    """
    df = df.copy()
    target_col = f"hrv_target_t{horizon}"
    df[target_col] = df[TARGET].shift(-horizon)

    # Filter to rows with a valid target
    model_df = df.dropna(subset=[target_col, "hrv_lag1"])

    # Feature columns: all numeric except the training target, date, and future-leaking columns.
    # NOTE: TARGET (whoop_hrv_rmssd) is intentionally kept as a feature — it represents
    # this morning's HRV score, which is known at prediction time and is the strongest
    # same-day predictor of tonight's HRV.
    # whoop_recovery_score is excluded because it is derived from the same sleep's HRV
    # (circular leak). Other same-night WHOOP/Garmin sleep metrics are kept — they represent
    # yesterday's sleep quality, valid context for tonight's prediction.
    exclude = {"calendar_date", "hrv_next",
               "whoop_recovery_score",  # derived from same sleep's HRV — circular
               }
    # Drop every hrv_target_t* column (any horizon's target — they all leak the future)
    exclude |= {c for c in model_df.columns if c.startswith("hrv_target_t")}
    feat_cols = [c for c in model_df.columns
                 if c not in exclude and pd.api.types.is_numeric_dtype(model_df[c])]

    # Forward-fill HIGH_VALUE_SPARSE_FEATURES within a 7-day window (audit
    # finding 6.A + self-review fix). Garmin training-state metrics (ATL/CTL,
    # hrv_factor, etc.) are stable over short windows, so a 7-day ffill is
    # physiologically defensible. After ffill we apply the standard 5%
    # threshold — the previous "lower threshold to 2% (= 10 obs)" rescue
    # produced too-noisy SHAP attributions on those columns.
    for col in HIGH_VALUE_SPARSE_FEATURES:
        if col in model_df.columns:
            model_df[col] = model_df[col].ffill(limit=7)

    feat_cols = [c for c in feat_cols if model_df[c].notna().mean() >= 0.05]

    X = model_df[feat_cols].copy()
    y = model_df[target_col].copy()

    return model_df, feat_cols, X, y


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray,
                    y_lower: np.ndarray | None = None,
                    y_upper: np.ndarray | None = None) -> dict:
    """Compute MAE, RMSE, MAPE, R², directional accuracy, CI coverage."""
    y_true = np.array(y_true, dtype=float)
    y_pred = np.array(y_pred, dtype=float)
    mask = ~(np.isnan(y_true) | np.isnan(y_pred))
    yt, yp = y_true[mask], y_pred[mask]
    if len(yt) < 3:
        return {}
    mae = float(mean_absolute_error(yt, yp))
    rmse = float(np.sqrt(mean_squared_error(yt, yp)))
    mape = float(np.mean(np.abs((yt - yp) / np.where(yt != 0, yt, 1))) * 100)
    r2 = float(r2_score(yt, yp))
    # Directional accuracy — emit BOTH definitions:
    #   directional_accuracy        : pred(t) − actual(t−1) vs actual(t) − actual(t−1)
    #     (standard "next-step direction from known yesterday")
    #   directional_accuracy_legacy : sign(diff(pred)) == sign(diff(actual))
    #     (the original metric — kept for chart continuity since dashboards built
    #     before 2026-04-16 use this number; the two answer different questions
    #     and shouldn't be compared across the changeover boundary)
    dir_acc = np.nan
    dir_acc_legacy = np.nan
    if len(yt) > 1:
        actual_change = np.diff(yt)
        pred_change_from_prev_actual = yp[1:] - yt[:-1]
        dir_acc = float(np.mean(np.sign(actual_change) == np.sign(pred_change_from_prev_actual)) * 100)
        dir_acc_legacy = float(np.mean(np.sign(actual_change) == np.sign(np.diff(yp))) * 100)
    # CI coverage
    ci_cov = np.nan
    ci_width = np.nan
    if y_lower is not None and y_upper is not None:
        yl = np.array(y_lower, dtype=float)[mask]
        yu = np.array(y_upper, dtype=float)[mask]
        ci_cov = float(np.mean((yt >= yl) & (yt <= yu)) * 100)
        ci_width = float(np.nanmean(yu - yl))
    return {"mae": mae, "rmse": rmse, "mape": mape, "r2": r2,
            "directional_accuracy": dir_acc,
            "directional_accuracy_legacy": dir_acc_legacy,
            "ci_coverage": ci_cov, "ci_avg_width": ci_width}


def train_xgboost(df: pd.DataFrame) -> tuple:
    """Train XGBoost next-day HRV predictor. Returns (model, results_dict)."""
    if not HAS_XGB:
        return None, {}

    log.info("Training XGBoost model…")
    model_df, feat_cols, X, y = prepare_ml_data(df)

    n = len(X)
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)

    X_train, y_train = X.iloc[:train_end], y.iloc[:train_end]
    X_val, y_val = X.iloc[train_end:val_end], y.iloc[train_end:val_end]
    X_test, y_test = X.iloc[val_end:], y.iloc[val_end:]
    dates_test = model_df["calendar_date"].iloc[val_end:].values

    log.info(f"  Train: {train_end} rows | Val: {val_end - train_end} | Test: {n - val_end}")

    # Hyperparameter tuning with Optuna (20 trials) or simple defaults
    best_params = {
        "max_depth": 4, "learning_rate": 0.05, "n_estimators": 300,
        "min_child_weight": 3, "subsample": 0.8, "colsample_bytree": 0.8,
        "reg_alpha": 0.1, "reg_lambda": 1.0,
    }
    if HAS_OPTUNA:
        def objective(trial):
            params = {
                "max_depth": trial.suggest_int("max_depth", 3, 6),
                "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.15, log=True),
                "n_estimators": trial.suggest_int("n_estimators", 100, 500),
                "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
                "subsample": trial.suggest_float("subsample", 0.6, 1.0),
                "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
                "reg_alpha": trial.suggest_float("reg_alpha", 0.0, 1.0),
                "reg_lambda": trial.suggest_float("reg_lambda", 0.5, 3.0),
                "tree_method": "hist", "random_state": 42,
            }
            m = XGBRegressor(**params, early_stopping_rounds=30)
            m.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
            val_pred = m.predict(X_val)
            return float(mean_absolute_error(y_val, val_pred))

        study = optuna.create_study(direction="minimize")
        study.optimize(objective, n_trials=20, timeout=180, show_progress_bar=False)
        best_params.update(study.best_params)
        log.info(f"  Optuna best val MAE: {study.best_value:.2f} ms")

    best_params.update({"tree_method": "hist", "random_state": 42})
    final_model = XGBRegressor(**best_params, early_stopping_rounds=50)
    final_model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    # Evaluate on test set
    test_pred = final_model.predict(X_test)
    test_metrics = compute_metrics(y_test.values, test_pred)
    log.info(f"  Test MAE: {test_metrics.get('mae', '—'):.2f} ms  "
             f"R²: {test_metrics.get('r2', '—'):.3f}  "
             f"Dir: {test_metrics.get('directional_accuracy', '—'):.1f}%")

    # SHAP analysis
    shap_df = pd.DataFrame()
    feature_importance_dict: dict = {}
    feature_importance_full: dict = {}
    if HAS_SHAP:
        try:
            explainer = shap.TreeExplainer(final_model)
            shap_vals = explainer(X_test)
            shap_mean_abs = np.abs(shap_vals.values).mean(axis=0)
            fi = sorted(zip(feat_cols, shap_mean_abs), key=lambda x: x[1], reverse=True)
            feature_importance_dict = {f: float(v) for f, v in fi[:30]}
            # Keep full dict so journal features (ranked outside top 30) can be stored separately
            feature_importance_full = {f: float(v) for f, v in fi}

            # Save SHAP plots
            try:
                fig, ax = plt.subplots(figsize=(10, 7))
                shap.plots.bar(shap_vals, max_display=20, ax=ax, show=False)
                ax.set_title("SHAP Feature Importance (test set)")
                plt.tight_layout()
                fig.savefig(OUTPUT_DIR / "shap_importance.png", dpi=120)
                plt.close(fig)
            except Exception:
                pass

            # Top drivers for the latest observation
            X_latest = X.iloc[[-1]]
            latest_shap = explainer(X_latest)
            top_drivers = [
                {"feature": f, "label": FEATURE_LABELS.get(f, f),
                 "shap_value": float(latest_shap.values[0, i])}
                for i, f in enumerate(feat_cols)
                if not np.isnan(latest_shap.values[0, i])
            ]
            top_drivers = sorted(top_drivers, key=lambda x: abs(x["shap_value"]), reverse=True)[:10]
            log.info("  SHAP analysis complete.")
        except Exception as e:
            log.warning(f"  SHAP failed: {e}")
            top_drivers = []
            top_drivers = _fallback_feature_importance(final_model, feat_cols)
    else:
        top_drivers = _fallback_feature_importance(final_model, feat_cols)

    # Prediction intervals: σ from out-of-fold residuals across the training
    # window (audit finding 7.D + self-review fix). Tier 2 #2 switched from
    # test-set σ to val-set σ — eliminated the tautology but a single 15% val
    # slice can still over- or under-estimate σ if it falls on an unusually
    # quiet/volatile period. Using TimeSeriesSplit out-of-fold residuals
    # across the entire training window gives a much more representative σ
    # and is what production-grade conformal prediction does.
    pred_std = None
    try:
        from sklearn.model_selection import TimeSeriesSplit
        tscv = TimeSeriesSplit(n_splits=5)
        oof_residuals = []
        for tr_idx, va_idx in tscv.split(X_train):
            if len(tr_idx) < 30 or len(va_idx) < 5:
                continue
            X_tr_fold = X_train.iloc[tr_idx]
            y_tr_fold = y_train.iloc[tr_idx]
            X_va_fold = X_train.iloc[va_idx]
            y_va_fold = y_train.iloc[va_idx]
            fold_model = XGBRegressor(
                **{k: v for k, v in best_params.items() if k != "n_estimators"},
                n_estimators=200,
            )
            fold_model.fit(X_tr_fold, y_tr_fold, verbose=False)
            oof_residuals.extend((y_va_fold.values - fold_model.predict(X_va_fold)).tolist())
        if len(oof_residuals) >= 30:
            pred_std = float(np.std(oof_residuals))
            log.info(f"  pred_std (TimeSeries 5-fold OOF, n_resid={len(oof_residuals)}): {pred_std:.2f} ms")
    except Exception as e:
        log.warning(f"  TimeSeriesSplit pred_std failed: {e}")

    if pred_std is None:
        # Fallback to val-set σ if K-fold path failed
        val_pred = final_model.predict(X_val)
        pred_std = float(np.std(y_val.values - val_pred))
        log.info(f"  pred_std (val-fit fallback): {pred_std:.2f} ms")

    test_lower = test_pred - 1.645 * pred_std  # ~90% CI
    test_upper = test_pred + 1.645 * pred_std
    ci_metrics = compute_metrics(y_test.values, test_pred, test_lower, test_upper)
    log.info(f"  test CI coverage at ±1.645·σ: {ci_metrics.get('ci_coverage', float('nan')):.1f}% "
             f"(target: 90%)")

    # Permutation importance as an independent cross-check on SHAP (audit 7.L).
    # SHAP can over-credit features the model overfits; permutation importance
    # measures actual loss change when each column is shuffled.
    permutation_importance: dict = {}
    try:
        from sklearn.inspection import permutation_importance as _perm
        perm = _perm(final_model, X_test, y_test, n_repeats=5,
                     scoring="neg_mean_absolute_error", random_state=42, n_jobs=1)
        order = np.argsort(perm.importances_mean)[::-1]
        for idx in order[:30]:
            permutation_importance[feat_cols[idx]] = float(perm.importances_mean[idx])
    except Exception as e:
        log.debug(f"  Permutation importance failed: {e}")

    # Controllable-only SHAP ranking (audit finding 7.K). For recovery
    # recommendations, only rank features Riley can actually change tomorrow.
    controllable_importance: dict = {}
    if HAS_SHAP and feature_importance_full:
        controllable_importance = {
            f: v for f, v in feature_importance_full.items()
            if any(f.startswith(p) for p in CONTROLLABLE_FEATURE_PREFIXES)
        }
        # Keep top 20
        controllable_importance = dict(
            sorted(controllable_importance.items(), key=lambda kv: kv[1], reverse=True)[:20]
        )

    # Tomorrow's prediction (latest available data)
    tomorrow_pred = float(final_model.predict(X.iloc[[-1]])[0])
    today_hrv = float(df[TARGET].dropna().iloc[-1]) if df[TARGET].dropna().shape[0] > 0 else None

    # Save model
    model_path = OUTPUT_DIR / "xgboost_hrv_model.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"model": final_model, "feat_cols": feat_cols,
                     "pred_std": pred_std, "model_version": MODEL_VERSION}, f)
    log.info(f"  Model saved: {model_path}")

    results = {
        "model": final_model,
        "feat_cols": feat_cols,
        "test_pred": test_pred,
        "test_actual": y_test.values,
        "test_dates": dates_test,
        "test_lower": test_lower,
        "test_upper": test_upper,
        "test_metrics": test_metrics | ci_metrics,
        "feature_importance": feature_importance_dict,
        "feature_importance_full": feature_importance_full if HAS_SHAP else feature_importance_dict,
        "permutation_importance": permutation_importance,
        "controllable_importance": controllable_importance,
        "top_drivers": top_drivers,
        "tomorrow_pred": tomorrow_pred,
        "today_hrv": today_hrv,
        "pred_std": pred_std,
        "train_start": model_df["calendar_date"].iloc[0],
        "train_end": model_df["calendar_date"].iloc[train_end - 1],
        "test_start": model_df["calendar_date"].iloc[val_end],
        "test_end": model_df["calendar_date"].iloc[-1],
    }
    return final_model, results


def _fallback_feature_importance(model, feat_cols: list) -> list:
    """Fallback: use XGBoost built-in feature importance when SHAP is unavailable."""
    scores = model.feature_importances_
    fi = sorted(zip(feat_cols, scores), key=lambda x: x[1], reverse=True)[:10]
    return [{"feature": f, "label": FEATURE_LABELS.get(f, f), "shap_value": float(v)}
            for f, v in fi]


def train_sarimax(df: pd.DataFrame, top_features: list) -> dict:
    """Train SARIMAX model for 1–7 day forecasting."""
    if not HAS_STATSMODELS:
        return {}
    log.info("Training SARIMAX model…")
    try:
        hrv_valid = df.dropna(subset=[TARGET]).set_index("calendar_date")
        hrv_series = hrv_valid[TARGET].copy().astype(float)

        # Exogenous: top features with sufficient coverage.
        # Shift by 1 day so that HRV[N] is modelled using features[N-1].
        # This corrects the causal alignment: behaviors on day N-1 drive HRV on night N.
        # Exclude whoop_hrv_rmssd from exog (it's the endogenous variable itself).
        # Coverage threshold lowered from 0.5 → 0.2 so behavioral features
        # (journal/mfp/supplement, typically 20-30% coverage) are eligible;
        # ffill+bfill on the chosen series still produces a continuous exog.
        # Slot count raised from 5 → 7 so the category-seeded features fit
        # alongside the global SHAP top.
        exog_feats = [f for f in top_features
                      if f in hrv_valid.columns
                      and f != TARGET
                      and hrv_valid[f].notna().mean() >= 0.2][:7]
        log.info(f"  SARIMAX exog features ({len(exog_feats)}): {exog_feats}")
        original_exog = hrv_valid[exog_feats].copy().ffill().bfill() if exog_feats else None
        # Shift forward 1 row: exog for row N = original feature values from row N-1
        exog = original_exog.shift(1).ffill().bfill() if original_exog is not None else None

        n = len(hrv_series)
        split = int(n * 0.85)
        train_endog = hrv_series.iloc[:split]
        test_endog = hrv_series.iloc[split:]
        train_exog = exog.iloc[:split] if exog is not None else None
        test_exog = exog.iloc[split:] if exog is not None else None

        model = SARIMAX(train_endog, exog=train_exog, order=(1, 1, 1),
                        seasonal_order=(1, 0, 1, 7),
                        enforce_stationarity=False, enforce_invertibility=False)
        fit = model.fit(disp=False, maxiter=200)

        # Residual diagnostics (audit finding 7.H): Ljung-Box on residuals — if p<0.05
        # at lag 7 there is unexploited structure (the model is under-specified).
        # ADF on the differenced series confirms stationarity assumption holds.
        try:
            from statsmodels.stats.diagnostic import acorr_ljungbox
            from statsmodels.tsa.stattools import adfuller as _adf
            resid = fit.resid.dropna().values
            if len(resid) > 20:
                lb = acorr_ljungbox(resid, lags=[7, 14], return_df=True)
                lb_p7 = float(lb.iloc[0, 1])
                lb_p14 = float(lb.iloc[1, 1])
                log.info(f"  SARIMAX Ljung-Box residuals: p(lag7)={lb_p7:.3g}, p(lag14)={lb_p14:.3g}")
                if lb_p7 < 0.05:
                    log.warning("  SARIMAX residual autocorrelation present (p<0.05) — "
                                "model under-specified; consider re-tuning order")
            adf = _adf(np.diff(train_endog.values), autolag="AIC")
            log.info(f"  ADF on differenced HRV: stat={adf[0]:.2f}, p={adf[1]:.3g}")
            # ACF of residuals chart
            try:
                fig, ax = plt.subplots(figsize=(10, 3.5))
                plot_acf(resid, lags=min(30, len(resid) // 4), ax=ax)
                ax.set_title("ACF — SARIMAX Residuals")
                plt.tight_layout()
                fig.savefig(OUTPUT_DIR / "sarimax_residual_acf.png", dpi=120)
                plt.close(fig)
            except Exception:
                pass
        except Exception as _e:
            log.debug(f"  SARIMAX residual diagnostics failed: {_e}")

        # 7-step-ahead walk-forward predictions
        preds_by_horizon: dict[int, list] = {h: [] for h in range(1, 8)}
        actuals_by_horizon: dict[int, list] = {h: [] for h in range(1, 8)}

        for i in range(len(test_endog)):
            hist_endog = hrv_series.iloc[: split + i]
            hist_exog = exog.iloc[: split + i] if exog is not None else None
            try:
                m_step = SARIMAX(hist_endog, exog=hist_exog, order=(1, 1, 1),
                                 seasonal_order=(1, 0, 1, 7),
                                 enforce_stationarity=False, enforce_invertibility=False)
                f_step = m_step.filter(fit.params)
                for h in range(1, min(8, len(test_endog) - i + 1)):
                    fut_exog = (exog.iloc[split + i: split + i + h]
                                if exog is not None else None)
                    fc = f_step.forecast(steps=h, exog=fut_exog)
                    pred_val = float(fc.iloc[-1]) if hasattr(fc, "iloc") else float(fc[-1])
                    act_idx = split + i + h - 1
                    if act_idx < n:
                        preds_by_horizon[h].append(pred_val)
                        actuals_by_horizon[h].append(float(hrv_series.iloc[act_idx]))
            except Exception:
                pass

        sarimax_metrics: dict[int, dict] = {}
        for h in range(1, 8):
            if len(preds_by_horizon[h]) >= 5:
                sarimax_metrics[h] = compute_metrics(
                    np.array(actuals_by_horizon[h]),
                    np.array(preds_by_horizon[h])
                )
                sarimax_metrics[h]["n"] = len(preds_by_horizon[h])
                log.info(f"  SARIMAX h={h}: MAE={sarimax_metrics[h].get('mae', '?'):.2f}")

        # Full-data forecast for next 7 days
        full_model = SARIMAX(hrv_series, exog=exog, order=(1, 1, 1),
                             seasonal_order=(1, 0, 1, 7),
                             enforce_stationarity=False, enforce_invertibility=False)
        full_fit = full_model.fit(disp=False, maxiter=200)
        # For the h-step-ahead forecast, the shifted exog at step h uses original_exog[N+h-1].
        # We use the last 7 days of original_exog as a proxy for unknown future values.
        fut_exog_all = original_exog.iloc[-7:] if original_exog is not None else None
        fc_full = full_fit.get_forecast(steps=7, exog=fut_exog_all)
        fc_mean = fc_full.predicted_mean
        fc_ci = fc_full.conf_int(alpha=0.10)  # 90% CI

        # Save forecast plot
        try:
            fig, ax = plt.subplots(figsize=(12, 5))
            ax.plot(hrv_series.index[-60:], hrv_series.values[-60:],
                    color="#22c55e", linewidth=1.5, label="Actual HRV")
            future_dates = pd.date_range(start=hrv_series.index[-1], periods=8, freq="D")[1:]
            ax.plot(future_dates, fc_mean.values, color="#3b82f6",
                    linewidth=2, linestyle="--", label="SARIMAX Forecast")
            ax.fill_between(future_dates, fc_ci.iloc[:, 0], fc_ci.iloc[:, 1],
                            alpha=0.2, color="#3b82f6")
            ax.set_title("SARIMAX 7-Day HRV Forecast")
            ax.set_facecolor("#1a1a1d")
            fig.patch.set_facecolor("#0a0a0b")
            ax.tick_params(colors="#a1a1aa")
            ax.legend(fontsize=9)
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "sarimax_forecast.png", dpi=120)
            plt.close(fig)
            log.info("  Saved: sarimax_forecast.png")
        except Exception as e:
            log.warning(f"  SARIMAX plot failed: {e}")

        return {
            "metrics_by_horizon": sarimax_metrics,
            "forecast_mean": fc_mean.tolist() if hasattr(fc_mean, "tolist") else list(fc_mean),
            "forecast_lower": fc_ci.iloc[:, 0].tolist(),
            "forecast_upper": fc_ci.iloc[:, 1].tolist(),
            "forecast_dates": [str(d.date()) for d in future_dates],
            "t1_pred": float(fc_mean.iloc[0]) if len(fc_mean) > 0 else None,
        }
    except Exception as e:
        log.warning(f"  SARIMAX failed: {e}")
        return {}


def train_prophet(df: pd.DataFrame, top_features: list) -> dict:
    """Train Facebook Prophet for 30-day trend forecast."""
    if not HAS_PROPHET:
        return {}
    log.info("Training Prophet model…")
    try:
        # Use next-night HRV as y (causal alignment: today's behaviors -> tonight's HRV)
        df_p = df.copy()
        df_p["hrv_target_t1"] = df_p[TARGET].shift(-1)
        hrv_df = df_p[["calendar_date", "hrv_target_t1"]].dropna(subset=["hrv_target_t1"]).copy()
        hrv_df = hrv_df.rename(columns={"calendar_date": "ds", "hrv_target_t1": "y"})
        hrv_df["ds"] = pd.to_datetime(hrv_df["ds"])
        hrv_df["y"] = hrv_df["y"].astype(float)

        # Regressor columns: exclude TARGET itself (it would be a perfect predictor of hrv_target_t1
        # in the holdout since both come from the same dataset — circular leakage).
        # Coverage threshold lowered from 0.6 → 0.25 so behavioral features
        # (journal/mfp/supplement) are eligible; ffill+bfill on the chosen
        # series still produces a continuous regressor. Slot count held at 3
        # — empirically Prophet's holdout MAE degraded ~4ms when widened to
        # 5 (sparser ffilled regressors weakened the seasonal fit); since
        # top_features is composed with behavioral seeds first, the first 3
        # slots reliably include the category seeds anyway.
        reg_feats = [f for f in top_features if f in df_p.columns
                     and f != TARGET
                     and df_p.dropna(subset=["hrv_target_t1"])[f].notna().mean() >= 0.25][:3]
        log.info(f"  Prophet regressors ({len(reg_feats)}): {reg_feats}")

        if reg_feats:
            feat_df = df_p[["calendar_date"] + reg_feats].copy()
            feat_df["calendar_date"] = pd.to_datetime(feat_df["calendar_date"])
            feat_df = feat_df.rename(columns={"calendar_date": "ds"})
            hrv_df = hrv_df.merge(feat_df, on="ds", how="left")
            for rf in reg_feats:
                # ffill only — bfill would pull future values into past regressor
                # rows, leaking signal into Prophet's training set. Audit finding F-004.
                hrv_df[rf] = hrv_df[rf].ffill().astype(float)
                # Drop any leading rows still missing (no past value to forward-fill from).
                # Prophet handles NaN regressors gracefully; this just keeps semantics clean.

        # Validation: fit on all but last 30 days, predict last 30
        cutoff = len(hrv_df) - 30
        train_df = hrv_df.iloc[:cutoff].copy()
        holdout_df = hrv_df.iloc[cutoff:].copy()

        m = Prophet(
            changepoint_prior_scale=0.05,
            seasonality_mode="additive",
            weekly_seasonality=True,
            daily_seasonality=False,
            yearly_seasonality=False,
        )
        for rf in reg_feats:
            m.add_regressor(rf)
        m.fit(train_df)

        # Forecast holdout period
        future_holdout = m.make_future_dataframe(periods=30)
        for rf in reg_feats:
            feat_col_df = hrv_df[["ds", rf]].copy()
            future_holdout = future_holdout.merge(feat_col_df, on="ds", how="left").ffill()
        fc_holdout = m.predict(future_holdout)
        fc_30 = fc_holdout.tail(30)
        holdout_preds = fc_30["yhat"].values[: len(holdout_df)]
        holdout_lower = fc_30["yhat_lower"].values[: len(holdout_df)]
        holdout_upper = fc_30["yhat_upper"].values[: len(holdout_df)]
        holdout_actuals = holdout_df["y"].values

        val_metrics = compute_metrics(holdout_actuals, holdout_preds, holdout_lower, holdout_upper)
        log.info(f"  Prophet 30-day holdout MAE: {val_metrics.get('mae', '?'):.2f} ms  "
                 f"CI coverage: {val_metrics.get('ci_coverage', '?'):.1f}%")

        # Full model (all data) + next-30-day forecast
        m_full = Prophet(
            changepoint_prior_scale=0.05,
            seasonality_mode="additive",
            weekly_seasonality=True,
            daily_seasonality=False,
            yearly_seasonality=False,
        )
        for rf in reg_feats:
            m_full.add_regressor(rf)
        m_full.fit(hrv_df)
        future_full = m_full.make_future_dataframe(periods=30)
        for rf in reg_feats:
            feat_col_df = hrv_df[["ds", rf]].copy()
            future_full = future_full.merge(feat_col_df, on="ds", how="left").ffill()
        fc_full = m_full.predict(future_full)
        fc_future = fc_full.tail(30)

        # Save forecast plot
        try:
            fig, ax = plt.subplots(figsize=(12, 5))
            last_180 = hrv_df.tail(180)
            ax.plot(last_180["ds"], last_180["y"], color="#22c55e",
                    linewidth=1.5, label="Actual HRV", alpha=0.9)
            ax.plot(fc_future["ds"], fc_future["yhat"], color="#f59e0b",
                    linewidth=2, linestyle="--", label="Prophet Forecast")
            ax.fill_between(fc_future["ds"], fc_future["yhat_lower"], fc_future["yhat_upper"],
                            alpha=0.2, color="#f59e0b", label="80% CI")
            ax.set_title("Prophet 30-Day HRV Forecast")
            ax.set_facecolor("#1a1a1d")
            fig.patch.set_facecolor("#0a0a0b")
            ax.tick_params(colors="#a1a1aa")
            ax.legend(fontsize=9)
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "prophet_forecast.png", dpi=120)
            plt.close(fig)
            log.info("  Saved: prophet_forecast.png")
        except Exception as e:
            log.warning(f"  Prophet plot failed: {e}")

        return {
            "val_metrics": val_metrics,
            "forecast_dates": fc_future["ds"].dt.strftime("%Y-%m-%d").tolist(),
            "forecast_mean": fc_future["yhat"].tolist(),
            "forecast_lower": fc_future["yhat_lower"].tolist(),
            "forecast_upper": fc_future["yhat_upper"].tolist(),
            "t1_pred": float(fc_future["yhat"].iloc[0]),
            "t1_lower": float(fc_future["yhat_lower"].iloc[0]),
            "t1_upper": float(fc_future["yhat_upper"].iloc[0]),
        }
    except Exception as e:
        log.warning(f"  Prophet failed: {e}")
        return {}


# ===========================================================================
# PHASE 3.5 – EVALUATION & BACKTESTING
# ===========================================================================

def run_evaluation(df: pd.DataFrame, xgb_model, xgb_results: dict) -> dict:
    """Walk-forward backtest, naive baselines, residual analysis."""
    log.info("Running walk-forward backtest…")

    model_df, feat_cols, X, y = prepare_ml_data(df)
    n = len(X)
    min_train = min(200, int(n * 0.5))
    step = 7  # retrain every 7 days
    # Embargo gap (audit finding 7.A + follow-up self-review): the largest
    # feature lag is 28 days (hrv_28d_mean/std + the personal z-score block
    # added in Tier 3 #26). 7 days only covered the rolling-7 features and
    # was a real leakage bug — the first ~21 test rows still overlapped the
    # train tail via the 28d windows. Trade ~28 test points per fold for
    # genuinely leakage-free generalization.
    GAP_DAYS = 28

    all_preds: list[dict] = []

    # Horizons evaluated for every multi-horizon model + baseline. Matches
    # SARIMAX's horizon range so the /analytics/hrv "Accuracy by Forecast
    # Horizon" chart has XGBoost + naive bars at every t+h alongside SARIMAX.
    HORIZONS = [1, 2, 3, 4, 5, 6, 7]

    # -----------------------------------------------------------------------
    # XGBoost walk-forward backtest — multi-horizon (h=1..7)
    #
    # Each horizon trains its own model: same feature matrix (today's signals)
    # but target = HRV shifted -h days. The expected pattern is MAE rising with
    # h as the predictive signal in today's features decays. We reuse the
    # h=1 hyperparameter shape (no per-horizon Optuna) so the multi-horizon
    # sweep stays under a few minutes; h=1 already had Optuna tuning in
    # train_xgboost().
    # -----------------------------------------------------------------------
    if HAS_XGB and xgb_model is not None:
        for h in HORIZONS:
            model_df_h, feat_cols_h, X_h, y_h = prepare_ml_data(df, horizon=h)
            n_h = len(X_h)
            if n_h <= min_train + GAP_DAYS + 5:
                log.warning(f"  XGBoost h={h}: insufficient rows ({n_h}) — skipped")
                continue
            log.info(f"  XGBoost h={h} expanding-window backtest "
                     f"(n={n_h}, step={step}, gap={GAP_DAYS}d)…")
            for start in range(min_train, n_h - 1, step):
                test_start = start + GAP_DAYS
                if test_start >= n_h - 1:
                    break
                end = min(test_start + step, n_h - 1)
                X_tr, y_tr = X_h.iloc[:start], y_h.iloc[:start]
                X_pred_block = X_h.iloc[test_start:end]
                y_actual_block = y_h.iloc[test_start:end]
                # Target dates = feature dates + h (y is shifted(-h), so y.iloc[i]
                # is the HRV h days AFTER model_df_h.calendar_date.iloc[i]).
                dates_block = (
                    pd.to_datetime(model_df_h["calendar_date"].iloc[test_start:end])
                    + pd.Timedelta(days=h)
                ).dt.strftime("%Y-%m-%d").values
                train_start_d = model_df_h["calendar_date"].iloc[0]
                train_end_d = model_df_h["calendar_date"].iloc[start - 1]

                try:
                    m = XGBRegressor(
                        max_depth=4, learning_rate=0.05, n_estimators=200,
                        min_child_weight=3, subsample=0.8, colsample_bytree=0.8,
                        tree_method="hist", random_state=42,
                    )
                    m.fit(X_tr, y_tr, verbose=False)
                    preds = m.predict(X_pred_block)
                    residuals_std = np.std(y_tr.values - m.predict(X_tr))
                    for pred, actual, d in zip(
                            preds, y_actual_block.values, dates_block):
                        all_preds.append({
                            "prediction_date": str(d),
                            "model": "xgboost",
                            "predicted_hrv": float(pred),
                            "prediction_lower": float(pred - 1.645 * residuals_std),
                            "prediction_upper": float(pred + 1.645 * residuals_std),
                            "actual_hrv": float(actual),
                            "residual": float(actual - pred),
                            "horizon_days": h,
                            "model_version": "backtest_initial",
                            "training_window_start": str(train_start_d),
                            "training_window_end": str(train_end_d),
                        })
                except Exception:
                    pass

    # -----------------------------------------------------------------------
    # Naive baselines — multi-horizon (h=1..7)
    #
    # Naive persistence and 7d_avg are constant across h (the prediction is
    # the same regardless of how far you look ahead), so their MAE rises with
    # h purely because HRV drifts further from today. DOW depends on the
    # target weekday, which shifts with h. Each baseline must beat noise at
    # every horizon to claim signal — that's what the chart will show.
    # -----------------------------------------------------------------------
    log.info("  Computing naive baselines (multi-horizon)…")
    hrv_arr = model_df[TARGET].values.astype(float)
    dates_arr = pd.to_datetime(model_df["calendar_date"]).values
    for h in HORIZONS:
        for i in range(min_train, n - h):
            actual_idx = i + h
            if actual_idx >= len(hrv_arr) or np.isnan(hrv_arr[actual_idx]):
                continue
            actual = float(hrv_arr[actual_idx])
            feat_date = pd.Timestamp(dates_arr[i])
            pred_date = (feat_date + pd.Timedelta(days=h)).strftime("%Y-%m-%d")
            hrv_hist = hrv_arr[:i + 1]

            # Naive persistence: predict = last known HRV (constant across h)
            naive_pred = float(hrv_hist[-1])
            all_preds.append({
                "prediction_date": pred_date, "model": "baseline_naive",
                "predicted_hrv": naive_pred, "actual_hrv": actual,
                "residual": actual - naive_pred, "horizon_days": h,
                "model_version": "backtest_initial",
            })

            # 7-day rolling mean (constant across h)
            roll7 = float(np.nanmean(hrv_hist[-7:])) if len(hrv_hist) >= 7 else naive_pred
            all_preds.append({
                "prediction_date": pred_date, "model": "baseline_7d_avg",
                "predicted_hrv": roll7, "actual_hrv": actual,
                "residual": actual - roll7, "horizon_days": h,
                "model_version": "backtest_initial",
            })

            # Day-of-week historical mean — DOW of the TARGET date (i+h),
            # not of the feature date, so the prediction is appropriate for
            # the day being forecast.
            dow = (feat_date + pd.Timedelta(days=h)).dayofweek
            past_dows = pd.DatetimeIndex(dates_arr[:i]).dayofweek
            dow_mask = past_dows == dow
            dow_vals = hrv_arr[:i][dow_mask]
            dow_vals = dow_vals[~np.isnan(dow_vals)]
            dow_pred = float(np.mean(dow_vals)) if len(dow_vals) >= 5 else naive_pred
            all_preds.append({
                "prediction_date": pred_date, "model": "baseline_dow",
                "predicted_hrv": dow_pred, "actual_hrv": actual,
                "residual": actual - dow_pred, "horizon_days": h,
                "model_version": "backtest_initial",
            })

    # -----------------------------------------------------------------------
    # Aggregate metrics per model
    # -----------------------------------------------------------------------
    bt_df = pd.DataFrame(all_preds)
    eval_results: dict = {"backtest_df": bt_df}

    model_metrics_rows: list[dict] = []
    today_str = str(date.today())

    # Aggregate per (model, horizon) so the Accuracy-by-Horizon chart can plot
    # bars for every (model × t+h) combination. The h=1 row of each model is
    # additionally stashed in eval_results[m_name] for backward-compat with
    # downstream prints / "Model Comparison" table that report headline MAE.
    for (m_name, h_val), sub in bt_df.groupby(["model", "horizon_days"]):
        sub = sub.dropna(subset=["actual_hrv", "predicted_hrv"])
        if len(sub) < 5:
            continue
        yt = sub["actual_hrv"].values
        yp = sub["predicted_hrv"].values
        yl = sub["prediction_lower"].values if "prediction_lower" in sub.columns else None
        yu = sub["prediction_upper"].values if "prediction_upper" in sub.columns else None
        m_metrics = compute_metrics(yt, yp,
                                    yl if yl is not None and not np.all(np.isnan(yl)) else None,
                                    yu if yu is not None and not np.all(np.isnan(yu)) else None)
        m_metrics["model"] = m_name
        m_metrics["horizon_days"] = int(h_val)
        m_metrics["n"] = len(sub)
        if int(h_val) == 1:
            eval_results[m_name] = m_metrics
        model_metrics_rows.append({
            "eval_date": today_str, "model": m_name, "horizon_days": int(h_val),
            "mae": m_metrics.get("mae"), "rmse": m_metrics.get("rmse"),
            "mape": m_metrics.get("mape"), "r_squared": m_metrics.get("r2"),
            "directional_accuracy": m_metrics.get("directional_accuracy"),
            "directional_accuracy_legacy": m_metrics.get("directional_accuracy_legacy"),
            "ci_coverage": m_metrics.get("ci_coverage"),
            "ci_avg_width": m_metrics.get("ci_avg_width"),
            "n_predictions": m_metrics.get("n"),
            "model_version": "backtest_initial",
        })

    eval_results["model_metrics_rows"] = model_metrics_rows

    # -----------------------------------------------------------------------
    # Diebold-Mariano test (audit finding 7.I): pairwise MAE comparison
    # between models on the matched test set. p<0.05 means the difference in
    # accuracy is statistically meaningful, not noise.
    # -----------------------------------------------------------------------
    try:
        # DM test is a paired comparison on matched (model_a, model_b) predictions
        # for the same target date — restrict to h=1 so we're not joining h=1
        # XGBoost predictions against h=7 baseline predictions on the same date.
        dm_df = bt_df[bt_df["horizon_days"] == 1]
        dm_rows = []
        models_present = [m for m in
                          ["xgboost", "baseline_7d_avg", "baseline_naive", "baseline_dow"]
                          if m in dm_df["model"].unique()]
        for i, a in enumerate(models_present):
            for b in models_present[i + 1:]:
                sa = dm_df[dm_df["model"] == a].set_index("prediction_date")
                sb = dm_df[dm_df["model"] == b].set_index("prediction_date")
                joined = sa[["actual_hrv", "predicted_hrv"]].rename(
                    columns={"predicted_hrv": "pred_a"}
                ).join(
                    sb[["predicted_hrv"]].rename(columns={"predicted_hrv": "pred_b"}),
                    how="inner",
                ).dropna()
                if len(joined) < 30:
                    continue
                # Loss differential under absolute loss
                loss_a = (joined["actual_hrv"] - joined["pred_a"]).abs().values
                loss_b = (joined["actual_hrv"] - joined["pred_b"]).abs().values
                d = loss_a - loss_b
                d_mean = float(np.mean(d))
                # Newey-West variance with h-1 lags (h=1 step ahead -> lag 0,
                # but allow up to 7 for weekly autocorrelation in residuals)
                n_d = len(d)
                gamma0 = float(np.var(d, ddof=1))
                long_run = gamma0
                for k in range(1, min(7, n_d - 1)):
                    cov_k = float(np.mean((d[:-k] - d_mean) * (d[k:] - d_mean)))
                    long_run += 2 * (1 - k / 7) * cov_k
                if long_run <= 0:
                    continue
                dm_stat = d_mean / np.sqrt(long_run / n_d)
                # Two-sided p via standard normal
                from scipy.stats import norm as _norm
                p = float(2 * (1 - _norm.cdf(abs(dm_stat))))
                dm_rows.append({
                    "model_a": a, "model_b": b,
                    "n_paired": int(n_d),
                    "mae_a": float(np.mean(loss_a)),
                    "mae_b": float(np.mean(loss_b)),
                    "mean_loss_diff": d_mean,
                    "dm_stat": float(dm_stat),
                    "p_value": p,
                })
        if dm_rows:
            pd.DataFrame(dm_rows).to_csv(OUTPUT_DIR / "evaluation" / "diebold_mariano.csv",
                                          index=False)
            log.info(f"  Diebold-Mariano: {len(dm_rows)} pairwise comparisons saved")
            eval_results["dm_test"] = dm_rows
    except Exception as e:
        log.warning(f"  Diebold-Mariano failed: {e}")

    # -----------------------------------------------------------------------
    # Error-mode analysis (audit finding 7.J): cluster XGBoost residuals by
    # journal flags so we know where the model struggles. Saves a CSV per
    # behavior with sample sizes + mean absolute residual.
    # -----------------------------------------------------------------------
    try:
        # Error-mode analysis joins each XGBoost residual to that day's
        # journal/habit flags. Restrict to h=1 so the join is unambiguous
        # (each prediction_date appears once per model) and the residual
        # distribution reflects the headline next-day model only.
        xgb_bt = bt_df[(bt_df["model"] == "xgboost") & (bt_df["horizon_days"] == 1)] \
                    .dropna(subset=["residual"]).copy()
        if not xgb_bt.empty:
            xgb_bt["pred_date"] = pd.to_datetime(xgb_bt["prediction_date"]).dt.strftime("%Y-%m-%d")
            jcols = [c for c in df.columns if c.startswith("journal_")]
            if jcols:
                # Lookup table: calendar_date -> journal flags. journal_*[N] = behaviors
                # on day N (pivot_journal keys on behaviors_date from the DB trigger).
                jdf = df[["calendar_date"] + jcols].copy()
                jdf["calendar_date"] = jdf["calendar_date"].astype(str)
                joined = xgb_bt.merge(
                    jdf, left_on="pred_date", right_on="calendar_date", how="left",
                )
                em_rows = []
                for jc in jcols:
                    yes = joined.loc[joined[jc] == 1, "residual"]
                    no = joined.loc[joined[jc] == 0, "residual"]
                    if len(yes) < 5 or len(no) < 5:
                        continue
                    em_rows.append({
                        "behavior": jc.replace("journal_", ""),
                        "n_yes": int(len(yes)), "n_no": int(len(no)),
                        "mae_yes": float(yes.abs().mean()),
                        "mae_no": float(no.abs().mean()),
                        "mean_residual_yes": float(yes.mean()),
                        "mean_residual_no": float(no.mean()),
                        "mae_diff_yes_minus_no": float(yes.abs().mean() - no.abs().mean()),
                    })
                if em_rows:
                    em_df = pd.DataFrame(em_rows)
                    em_df = em_df.iloc[
                        np.argsort(np.abs(em_df["mae_diff_yes_minus_no"].values))[::-1]
                    ].reset_index(drop=True)
                    em_df.to_csv(OUTPUT_DIR / "evaluation" / "error_modes.csv", index=False)
                    log.info(f"  Error modes: {len(em_df)} behaviors saved")
                    eval_results["error_modes"] = em_rows
            # Mirror the same residual decomposition for habit_ columns so we can
            # see where the model is well- or poorly-calibrated by habit completion.
            hcols = [c for c in df.columns if c.startswith("habit_") and not c.endswith("_lag1")]
            if hcols:
                hdf = df[["calendar_date"] + hcols].copy()
                hdf["calendar_date"] = hdf["calendar_date"].astype(str)
                joined_h = xgb_bt.merge(
                    hdf, left_on="pred_date", right_on="calendar_date", how="left",
                )
                em_h_rows = []
                for hc in hcols:
                    yes = joined_h.loc[joined_h[hc] == 1, "residual"]
                    no = joined_h.loc[joined_h[hc] == 0, "residual"]
                    if len(yes) < 5 or len(no) < 5:
                        continue
                    em_h_rows.append({
                        "behavior": hc.replace("habit_", ""),
                        "label": HABIT_LABELS.get(hc, hc.replace("habit_", "").replace("_", " ").title()),
                        "n_yes": int(len(yes)), "n_no": int(len(no)),
                        "mae_yes": float(yes.abs().mean()),
                        "mae_no": float(no.abs().mean()),
                        "mean_residual_yes": float(yes.mean()),
                        "mean_residual_no": float(no.mean()),
                        "mae_diff_yes_minus_no": float(yes.abs().mean() - no.abs().mean()),
                    })
                if em_h_rows:
                    em_h_df = pd.DataFrame(em_h_rows)
                    em_h_df = em_h_df.iloc[
                        np.argsort(np.abs(em_h_df["mae_diff_yes_minus_no"].values))[::-1]
                    ].reset_index(drop=True)
                    em_h_df.to_csv(OUTPUT_DIR / "evaluation" / "error_modes_habits.csv", index=False)
                    log.info(f"  Error modes (habits): {len(em_h_df)} habits saved")
                    eval_results["error_modes_habits"] = em_h_rows
    except Exception as e:
        log.warning(f"  Error-mode analysis failed: {e}")

    # -----------------------------------------------------------------------
    # Residual plots
    # -----------------------------------------------------------------------
    try:
        # Residual plots are h=1-only — the histogram / vs-predicted / DOW
        # plots are interpretable for the headline next-day model; mixing
        # h=1..7 residuals would smear the distribution by horizon.
        xgb_bt = bt_df[(bt_df["model"] == "xgboost") & (bt_df["horizon_days"] == 1)] \
                    .dropna(subset=["residual"])
        if not xgb_bt.empty:
            fig, axes = plt.subplots(2, 2, figsize=(12, 8))

            # Histogram
            axes[0, 0].hist(xgb_bt["residual"], bins=30, color="#3b82f6", alpha=0.8)
            axes[0, 0].axvline(0, color="#ef4444", linewidth=1.5)
            axes[0, 0].set_title("Residual Distribution (XGBoost)")
            axes[0, 0].set_xlabel("Residual (ms)")

            # Residuals vs predicted
            axes[0, 1].scatter(xgb_bt["predicted_hrv"], xgb_bt["residual"],
                               alpha=0.4, s=15, color="#8b5cf6")
            axes[0, 1].axhline(0, color="#ef4444", linewidth=1)
            axes[0, 1].set_title("Residuals vs Predicted HRV")
            axes[0, 1].set_xlabel("Predicted HRV (ms)")

            # Residuals over time
            axes[1, 0].plot(range(len(xgb_bt)), xgb_bt["residual"].values,
                            color="#22c55e", linewidth=0.8, alpha=0.8)
            axes[1, 0].axhline(0, color="#ef4444", linewidth=1)
            axes[1, 0].set_title("Residuals Over Time")
            axes[1, 0].set_xlabel("Day Index")

            # Residuals by day of week
            xgb_bt["dow"] = pd.to_datetime(xgb_bt["prediction_date"]).dt.dayofweek
            dow_data = [xgb_bt[xgb_bt["dow"] == d]["residual"].values for d in range(7)]
            axes[1, 1].boxplot(dow_data, labels=["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
            axes[1, 1].axhline(0, color="#ef4444", linewidth=1)
            axes[1, 1].set_title("Residuals by Day of Week")

            for ax in axes.flat:
                ax.set_facecolor("#1a1a1d")
            fig.patch.set_facecolor("#0a0a0b")
            for ax in axes.flat:
                ax.tick_params(colors="#a1a1aa")
                ax.title.set_color("#f4f4f5")
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "evaluation" / "residual_analysis.png", dpi=120)
            plt.close(fig)

            # Rolling 30-day MAE comparison — h=1 only so the rolling line
            # tracks next-day accuracy over time, not a blend of horizons.
            fig, ax = plt.subplots(figsize=(12, 5))
            for m_name, color in [("xgboost", "#3b82f6"), ("baseline_naive", "#f59e0b"),
                                   ("baseline_7d_avg", "#ef4444")]:
                sub = bt_df[(bt_df["model"] == m_name) & (bt_df["horizon_days"] == 1)] \
                          .dropna(subset=["residual"])
                if len(sub) < 30:
                    continue
                sub = sub.sort_values("prediction_date")
                roll_mae = sub["residual"].abs().rolling(30, min_periods=15).mean()
                ax.plot(range(len(roll_mae)), roll_mae.values, color=color,
                        label=m_name, linewidth=1.8)
            ax.set_title("Rolling 30-Day MAE Over Time")
            ax.set_xlabel("Day Index")
            ax.set_ylabel("MAE (ms)")
            ax.legend(fontsize=9)
            ax.set_facecolor("#1a1a1d")
            fig.patch.set_facecolor("#0a0a0b")
            ax.tick_params(colors="#a1a1aa")
            ax.title.set_color("#f4f4f5")
            plt.tight_layout()
            fig.savefig(OUTPUT_DIR / "evaluation" / "rolling_mae.png", dpi=120)
            plt.close(fig)
            log.info("  Saved: evaluation/residual_analysis.png, evaluation/rolling_mae.png")
    except Exception as e:
        log.warning(f"  Residual plots failed: {e}")

    # Accuracy-by-horizon bar chart
    try:
        fig, ax = plt.subplots(figsize=(8, 5))
        mae_values = {}
        for m_name, color in [("xgboost", "#3b82f6"), ("baseline_naive", "#f59e0b")]:
            if m_name in eval_results:
                mae_values[m_name] = eval_results[m_name].get("mae", None)
        x = list(mae_values.keys())
        y = [mae_values[k] for k in x]
        bars = ax.bar(x, y, color=["#3b82f6", "#f59e0b"][:len(x)])
        ax.set_ylabel("MAE (ms)")
        ax.set_title("Model vs Naive Baseline — MAE (ms)")
        ax.set_facecolor("#1a1a1d")
        fig.patch.set_facecolor("#0a0a0b")
        ax.tick_params(colors="#a1a1aa")
        ax.title.set_color("#f4f4f5")
        plt.tight_layout()
        fig.savefig(OUTPUT_DIR / "evaluation" / "model_comparison.png", dpi=120)
        plt.close(fig)
    except Exception as e:
        log.warning(f"  Model comparison chart failed: {e}")

    return eval_results


# ===========================================================================
# DB STORAGE
# ===========================================================================

def upsert_batch(table: str, rows: list[dict], conflict_cols: str) -> None:
    """Upsert a list of dicts into a Supabase table in batches of 500."""
    if not rows:
        return
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i: i + batch_size]
        # Remove None values for cleaner upsert
        cleaned = [{k: v for k, v in r.items() if v is not None and v == v} for r in batch]
        supa.schema("pds").from_(table).upsert(cleaned, on_conflict=conflict_cols).execute()


def store_predictions(xgb_results: dict, sarimax_results: dict,
                      prophet_results: dict, eval_results: dict) -> None:
    """Upsert all predictions into pds.hrv_predictions."""
    rows: list[dict] = []
    today_str = str(date.today())

    # XGBoost tomorrow's prediction
    if xgb_results:
        tomorrow = str(date.today() + timedelta(days=1))
        rows.append({
            "prediction_date": tomorrow,
            "model": "xgboost",
            "predicted_hrv": xgb_results.get("tomorrow_pred"),
            "prediction_lower": (xgb_results.get("tomorrow_pred", 0) -
                                 1.645 * xgb_results.get("pred_std", 0)),
            "prediction_upper": (xgb_results.get("tomorrow_pred", 0) +
                                 1.645 * xgb_results.get("pred_std", 0)),
            "actual_hrv": None,
            "horizon_days": 1,
            "top_drivers": json.dumps(xgb_results.get("top_drivers", [])),
            "model_version": MODEL_VERSION,
            "training_window_start": xgb_results.get("train_start"),
            "training_window_end": xgb_results.get("train_end"),
            "input_data_hash": INPUT_DATA_HASH,
        })

    # SARIMAX 1–7 day forecasts
    if sarimax_results:
        for i, (d, pred, lo, hi) in enumerate(zip(
            sarimax_results.get("forecast_dates", []),
            sarimax_results.get("forecast_mean", []),
            sarimax_results.get("forecast_lower", []),
            sarimax_results.get("forecast_upper", []),
        ), start=1):
            rows.append({
                "prediction_date": str(d),
                "model": "sarimax",
                "predicted_hrv": float(pred),
                "prediction_lower": float(lo),
                "prediction_upper": float(hi),
                "horizon_days": i,
                "model_version": MODEL_VERSION,
                "input_data_hash": INPUT_DATA_HASH,
            })

    # Prophet 30-day forecast
    if prophet_results:
        for i, (d, pred, lo, hi) in enumerate(zip(
            prophet_results.get("forecast_dates", []),
            prophet_results.get("forecast_mean", []),
            prophet_results.get("forecast_lower", []),
            prophet_results.get("forecast_upper", []),
        ), start=1):
            rows.append({
                "prediction_date": str(d),
                "model": "prophet",
                "predicted_hrv": float(pred),
                "prediction_lower": float(lo),
                "prediction_upper": float(hi),
                "horizon_days": i,
                "model_version": MODEL_VERSION,
                "input_data_hash": INPUT_DATA_HASH,
            })

    # Backtest predictions
    if "backtest_df" in eval_results:
        bt = eval_results["backtest_df"]
        for _, row in bt.iterrows():
            if pd.isna(row.get("actual_hrv")) or pd.isna(row.get("predicted_hrv")):
                continue
            rows.append({
                "prediction_date": str(row["prediction_date"]),
                "model": str(row["model"]),
                "predicted_hrv": float(row["predicted_hrv"]),
                "prediction_lower": float(row["prediction_lower"]) if not pd.isna(row.get("prediction_lower", float("nan"))) else None,
                "prediction_upper": float(row["prediction_upper"]) if not pd.isna(row.get("prediction_upper", float("nan"))) else None,
                "actual_hrv": float(row["actual_hrv"]),
                "residual": float(row["residual"]),
                "horizon_days": int(row.get("horizon_days", 1)),
                "model_version": str(row.get("model_version", "backtest_initial")),
                "training_window_start": str(row["training_window_start"]) if not pd.isna(row.get("training_window_start", float("nan"))) else None,
                "training_window_end": str(row["training_window_end"]) if not pd.isna(row.get("training_window_end", float("nan"))) else None,
                "input_data_hash": INPUT_DATA_HASH,
            })

    log.info(f"  Upserting {len(rows)} prediction rows…")
    upsert_batch("hrv_predictions", rows, "prediction_date,model,horizon_days")


def store_metrics(eval_results: dict) -> None:
    """Upsert model metrics into pds.hrv_model_metrics."""
    rows = eval_results.get("model_metrics_rows", [])
    if rows:
        for r in rows:
            r.setdefault("input_data_hash", INPUT_DATA_HASH)
        log.info(f"  Upserting {len(rows)} metric rows…")
        upsert_batch("hrv_model_metrics", rows, "eval_date,model,horizon_days")


def store_analysis_results(stat_results: dict, feature_importance: dict,
                           feature_importance_full: dict | None = None,
                           controllable_importance: dict | None = None,
                           permutation_importance: dict | None = None,
                           dm_test: list | None = None,
                           error_modes: list | None = None,
                           error_modes_habits: list | None = None,
                           causal_results: dict | None = None) -> None:
    """Store pre-computed analysis results for the frontend."""
    rows: list[dict] = []

    # Spearman correlations (top 50, all features)
    if "correlations" in stat_results:
        corr_df = stat_results["correlations"]
        corr_list = corr_df.head(50).to_dict(orient="records")
        rows.append({
            "result_type": "correlation",
            "result_key": "spearman_top50",
            "result_json": json.dumps(corr_list),
        })

        # Journal-specific correlations (all journal_ features, sorted by abs r)
        journal_corr = corr_df[corr_df["feature"].str.startswith("journal_")].copy()
        if not journal_corr.empty:
            journal_corr_list = journal_corr.to_dict(orient="records")
            rows.append({
                "result_type": "correlation",
                "result_key": "spearman_journal",
                "result_json": json.dumps(journal_corr_list),
            })

        # Habit-specific correlations — same treatment as journal_, just on
        # habit_ prefixed columns from pds.habit_journal.
        habit_corr = corr_df[corr_df["feature"].str.startswith("habit_")].copy()
        if not habit_corr.empty:
            habit_corr_list = habit_corr.to_dict(orient="records")
            rows.append({
                "result_type": "correlation",
                "result_key": "spearman_habit",
                "result_json": json.dumps(habit_corr_list),
            })

    # Journal impact
    if "journal_impact" in stat_results:
        rows.append({
            "result_type": "journal_impact",
            "result_key": "all",
            "result_json": json.dumps(stat_results["journal_impact"]),
        })

    # Habit impact (Yes/No t-test mirroring journal_impact)
    if "habit_impact" in stat_results:
        rows.append({
            "result_type": "habit_impact",
            "result_key": "all",
            "result_json": json.dumps(stat_results["habit_impact"]),
        })

    # Supplement Yes/No impact
    if "supplement_impact" in stat_results:
        rows.append({
            "result_type": "supplement_impact",
            "result_key": "yes_no",
            "result_json": json.dumps(stat_results["supplement_impact"]),
        })

    # Supplement dose-response
    if "supplement_dose_response" in stat_results:
        rows.append({
            "result_type": "supplement_impact",
            "result_key": "dose_response",
            "result_json": json.dumps(stat_results["supplement_dose_response"]),
        })

    # Nutrition Spearman
    if "nutrition_impact" in stat_results:
        rows.append({
            "result_type": "nutrition_impact",
            "result_key": "spearman",
            "result_json": json.dumps(stat_results["nutrition_impact"]),
        })

    # Feature importance (SHAP or XGB, top 30, all features)
    if feature_importance:
        fi_list = [{"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": v}
                   for k, v in feature_importance.items()]
        rows.append({
            "result_type": "feature_importance",
            "result_key": "shap_mean_abs",
            "result_json": json.dumps(fi_list),
        })

        # Journal-specific SHAP importance — use full dict so features outside top-30 are included
        fi_source = feature_importance_full if feature_importance_full else feature_importance
        journal_fi = [(k, v) for k, v in fi_source.items() if k.startswith("journal_")]
        if journal_fi:
            journal_fi_list = [{"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": v}
                                for k, v in sorted(journal_fi, key=lambda x: x[1], reverse=True)]
            rows.append({
                "result_type": "feature_importance",
                "result_key": "shap_journal",
                "result_json": json.dumps(journal_fi_list),
            })

        # Habit-specific SHAP importance — mirrors journal block
        habit_fi = [(k, v) for k, v in fi_source.items() if k.startswith("habit_")]
        if habit_fi:
            habit_fi_list = [{"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": v}
                              for k, v in sorted(habit_fi, key=lambda x: x[1], reverse=True)]
            rows.append({
                "result_type": "feature_importance",
                "result_key": "shap_habit",
                "result_json": json.dumps(habit_fi_list),
            })

    # Stage 3 standardized OLS results (audit fix 2.C)
    if "stage3_ols" in stat_results:
        rows.append({
            "result_type": "regression",
            "result_key": "stage3_standardized_ols",
            "result_json": json.dumps(stat_results["stage3_ols"]),
        })

    # Controllable-only SHAP ranking (audit fix 7.K) — what's actionable
    if controllable_importance:
        rows.append({
            "result_type": "feature_importance",
            "result_key": "shap_controllable",
            "result_json": json.dumps([
                {"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": v}
                for k, v in controllable_importance.items()
            ]),
        })

    # Permutation importance cross-check (audit fix 7.L)
    if permutation_importance:
        rows.append({
            "result_type": "feature_importance",
            "result_key": "permutation",
            "result_json": json.dumps([
                {"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": v}
                for k, v in permutation_importance.items()
            ]),
        })

    # Diebold-Mariano pairwise model comparison (audit fix 7.I)
    if dm_test:
        rows.append({
            "result_type": "model_comparison",
            "result_key": "diebold_mariano",
            "result_json": json.dumps(dm_test),
        })

    # Error-mode analysis (audit fix 7.J): per-behavior MAE
    if error_modes:
        rows.append({
            "result_type": "model_comparison",
            "result_key": "error_modes_by_journal",
            "result_json": json.dumps(error_modes),
        })

    # Error-mode analysis for habits — mirrors error_modes_by_journal
    if error_modes_habits:
        rows.append({
            "result_type": "model_comparison",
            "result_key": "error_modes_by_habit",
            "result_json": json.dumps(error_modes_habits),
        })

    # Causal inference results — separate rows per family so the frontend
    # can fetch what it needs without parsing the whole payload.
    if causal_results:
        if causal_results.get("binary_treatments"):
            rows.append({
                "result_type": "causal",
                "result_key": "binary_treatments",
                "result_json": json.dumps(causal_results["binary_treatments"]),
            })
        if causal_results.get("continuous_treatments"):
            rows.append({
                "result_type": "causal",
                "result_key": "continuous_treatments",
                "result_json": json.dumps(causal_results["continuous_treatments"]),
            })
        if causal_results.get("dag"):
            rows.append({
                "result_type": "causal",
                "result_key": "dag",
                "result_json": json.dumps(causal_results["dag"]),
            })
        if causal_results.get("meta"):
            rows.append({
                "result_type": "causal",
                "result_key": "meta",
                "result_json": json.dumps(causal_results["meta"]),
            })
        if causal_results.get("dropped_low_n"):
            rows.append({
                "result_type": "causal",
                "result_key": "dropped_low_n",
                "result_json": json.dumps(causal_results["dropped_low_n"]),
            })

    # Feature label map
    rows.append({
        "result_type": "feature_labels",
        "result_key": "all",
        "result_json": json.dumps(FEATURE_LABELS),
    })

    if rows:
        # Stamp computed_at so backfill-detection jobs can tell when the last
        # full analysis ran (Postgres default now() only fires on INSERT, not UPSERT).
        now_iso = datetime.now(timezone.utc).isoformat()
        for row in rows:
            row["computed_at"] = now_iso
            row["input_data_hash"] = INPUT_DATA_HASH

        log.info(f"  Storing {len(rows)} analysis result rows…")
        # Upsert each row individually to avoid bulk insert dropping rows
        for row in rows:
            supa.schema("pds").from_("hrv_analysis_results").upsert(
                row, on_conflict="result_type,result_key"
            ).execute()
            log.info(f"    Upserted: {row['result_type']}/{row['result_key']}")


# ===========================================================================
# SUMMARY REPORT
# ===========================================================================

def print_summary(df: pd.DataFrame, xgb_results: dict,
                  sarimax_results: dict, prophet_results: dict,
                  eval_results: dict, stat_results: dict) -> None:
    """Print a structured summary of all findings."""
    sep = "=" * 70
    print(f"\n{sep}")
    print("  ONYX HRV DEEP ANALYSIS - SUMMARY REPORT")
    print(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(sep)

    # Dataset
    hrv_rows = df[TARGET].notna().sum()
    print(f"\nDATASET")
    print(f"  Total rows (Garmin spine):  {len(df)}")
    print(f"  Rows with WHOOP HRV:        {hrv_rows}")
    print(f"  Date range:                 {df['calendar_date'].min()} -> {df['calendar_date'].max()}")
    print(f"  Feature columns:            {len([c for c in df.columns if c != 'calendar_date'])}")

    # Model performance
    print(f"\nMODEL PERFORMANCE (test set / backtest)")
    print(f"  {'Model':<22} {'MAE':>7} {'RMSE':>7} {'R2':>7} {'Dir%':>7} {'n':>5}")
    print(f"  {'-'*52}")
    for m_name in ["xgboost", "sarimax", "prophet", "baseline_naive", "baseline_7d_avg"]:
        if m_name == "xgboost" and xgb_results:
            m = xgb_results.get("test_metrics", {})
            n = len(xgb_results.get("test_actual", []))
        elif m_name in eval_results:
            m = eval_results[m_name]
            n = m.get("n", "—")
        else:
            continue
        mae = f"{m.get('mae', float('nan')):.1f}" if m.get("mae") else "—"
        rmse = f"{m.get('rmse', float('nan')):.1f}" if m.get("rmse") else "—"
        r2 = f"{m.get('r2', float('nan')):.3f}" if m.get("r2") is not None else "—"
        da = f"{m.get('directional_accuracy', float('nan')):.1f}" if m.get("directional_accuracy") else "—"
        print(f"  {m_name:<22} {mae:>7} {rmse:>7} {r2:>7} {da:>7} {str(n):>5}")

    # Top correlations
    if "correlations" in stat_results:
        corr_df = stat_results["correlations"]
        print(f"\nTOP 10 HRV DRIVERS (Spearman correlation)")
        for i, row in corr_df.head(10).iterrows():
            sig = "***" if row["p_value"] < 0.001 else "** " if row["p_value"] < 0.01 else "*  "
            label = FEATURE_LABELS.get(row["feature"], row["feature"])
            print(f"  {i+1:>2}. {label:<35} r={row['spearman_r']:+.3f} {sig}")

    # Top SHAP features
    if xgb_results and xgb_results.get("feature_importance"):
        print(f"\nTOP 10 SHAP FEATURES (avg |SHAP| on test set)")
        for i, (feat, val) in enumerate(
                list(xgb_results["feature_importance"].items())[:10]):
            label = FEATURE_LABELS.get(feat, feat)
            print(f"  {i+1:>2}. {label:<35} {val:+.2f} ms")

    # Journal impact
    if "journal_impact" in stat_results:
        print(f"\nTOP 10 JOURNAL BEHAVIORS (HRV impact)")
        sorted_ji = sorted(stat_results["journal_impact"],
                           key=lambda x: abs(x["diff_ms"]), reverse=True)[:10]
        for j in sorted_ji:
            sig = "***" if j["p_value"] < 0.001 else "** " if j["p_value"] < 0.01 else "*  " if j["p_value"] < 0.05 else "   "
            print(f"  {j['label']:<30} d={j['diff_ms']:+.1f}ms  {sig}  "
                  f"(Yes={j['n_yes']}, No={j['n_no']})")

    # Habit impact
    if "habit_impact" in stat_results:
        print(f"\nTOP HABITS (HRV impact)")
        sorted_hi = sorted(stat_results["habit_impact"],
                           key=lambda x: abs(x["diff_ms"]), reverse=True)[:10]
        for h in sorted_hi:
            sig = "***" if h["p_value"] < 0.001 else "** " if h["p_value"] < 0.01 else "*  " if h["p_value"] < 0.05 else "   "
            print(f"  {h['label']:<30} d={h['diff_ms']:+.1f}ms  {sig}  "
                  f"(Yes={h['n_yes']}, No={h['n_no']})")

    # Tomorrow's prediction
    print(f"\nTOMORROW'S PREDICTION ({str(date.today() + timedelta(days=1))})")
    if xgb_results and xgb_results.get("tomorrow_pred"):
        p = xgb_results["tomorrow_pred"]
        std = xgb_results.get("pred_std", 0)
        print(f"  XGBoost:   {p:.1f} ms  (90% CI: {p - 1.645*std:.1f} - {p + 1.645*std:.1f})")
    if sarimax_results.get("t1_pred"):
        print(f"  SARIMAX:   {sarimax_results['t1_pred']:.1f} ms  (horizon=1)")
    if prophet_results.get("t1_pred"):
        p = prophet_results["t1_pred"]
        lo = prophet_results.get("t1_lower", p)
        hi = prophet_results.get("t1_upper", p)
        print(f"  Prophet:   {p:.1f} ms  (80% CI: {lo:.1f} - {hi:.1f})")
    if xgb_results and xgb_results.get("today_hrv"):
        print(f"  Today's actual HRV:  {xgb_results['today_hrv']:.1f} ms")

    print(f"\nOUTPUTS")
    print(f"  Analysis plots:  {OUTPUT_DIR}/")
    print(f"  Evaluation plots: {OUTPUT_DIR}/evaluation/")
    print(f"  XGBoost model:   {OUTPUT_DIR}/xgboost_hrv_model.pkl")
    print(f"  DB tables populated:  pds.hrv_predictions, pds.hrv_model_metrics, pds.hrv_analysis_results")
    print(f"\n{sep}\n")


# ===========================================================================
# MAIN
# ===========================================================================

def main() -> None:
    global INPUT_DATA_HASH

    parser = argparse.ArgumentParser(description="Onyx HRV Deep Analysis Pipeline")
    parser.add_argument("--skip-analysis", action="store_true",
                        help="Skip statistical analysis plots")
    parser.add_argument("--skip-models", action="store_true",
                        help="Skip ML models entirely")
    args = parser.parse_args()

    # ---------- Phase 1: Data Pipeline ----------
    log.info("=== PHASE 1: DATA PIPELINE ===")
    data = load_all_data()
    df = build_feature_matrix(data)
    print_completeness(df)

    # Compute the input-data hash once for the run so every Supabase write
    # (predictions, metrics, analysis results) carries the same fingerprint.
    try:
        _, _, X_hash, y_hash = prepare_ml_data(df)
        INPUT_DATA_HASH = compute_input_data_hash(X_hash, y_hash)
        log.info(f"  input_data_hash = {INPUT_DATA_HASH[:12]}…")
    except Exception as e:
        log.warning(f"  input_data_hash compute failed: {e}")
        INPUT_DATA_HASH = None

    # ---------- Phase 2: Statistical Analysis ----------
    log.info("=== PHASE 2: STATISTICAL ANALYSIS ===")
    stat_results = run_statistical_analysis(
        df,
        skip=args.skip_analysis,
        supplements=data.get("supplements"),
    )

    # ---------- Phase 2.5: Causal Inference ----------
    # Runs after the descriptive stats and before the predictive models so its
    # results sit alongside Spearman/Welch in the analysis_results table. The
    # estimators (PSM, AIPW) are O(n_treatments × n_rows × n_bootstrap) — for
    # ~50 binary treatments × ~500 rows × 500 bootstrap reps this takes a few
    # minutes, which we accept once-per-retrain.
    causal_results: dict | None = None
    if HAS_CAUSAL and not args.skip_analysis:
        log.info("=== PHASE 2.5: CAUSAL INFERENCE ===")
        try:
            causal_results = ci.run_causal_battery(df, supplements=data.get("supplements"))
            n_bin = len(causal_results.get("binary_treatments", [])) if causal_results else 0
            n_cont = len(causal_results.get("continuous_treatments", [])) if causal_results else 0
            log.info(f"  Causal battery complete: {n_bin} binary + {n_cont} continuous "
                     f"treatments estimated")
        except Exception as e:
            log.warning(f"  Causal inference failed: {e}")
            causal_results = None

    if args.skip_models:
        log.info("Skipping ML models (--skip-models set).")
        print_summary(df, {}, {}, {}, {}, stat_results)
        return

    # ---------- Phase 3: Models ----------
    log.info("=== PHASE 3: PREDICTION MODELS ===")
    xgb_model, xgb_results = train_xgboost(df)

    # Compose top_features for SARIMAX/Prophet. Default: XGBoost SHAP top-10.
    # Enrichment: also seed in the top-ranked controllable feature from each
    # major category (journal, habit, mfp, supplement) — so behavioral signals get
    # a fair shot at the SARIMAX exog / Prophet regressor slots even when the
    # global SHAP top is dominated by sleep/HRV-lag features. We use the FULL
    # SHAP ranking (feature_importance_full, all features) for the category
    # search — the truncated top-30 dict can miss category leaders that rank
    # 31st-50th. Fallback: Spearman correlation ranking from stat_results.
    xgb_importance_full = xgb_results.get("feature_importance_full", {})
    xgb_importance_top = xgb_results.get("feature_importance", {})

    if xgb_importance_full:
        full_ranked = list(xgb_importance_full.keys())
    elif "correlations" in stat_results:
        full_ranked = stat_results["correlations"]["feature"].tolist()
    else:
        full_ranked = []

    top10_global = (list(xgb_importance_top.keys())[:10]
                    if xgb_importance_top else full_ranked[:10])

    def first_with_prefix(prefix: str) -> str | None:
        return next((f for f in full_ranked if f.startswith(prefix)), None)

    seeds: list[str] = []
    for prefix in ("journal_", "habit_", "mfp_", "supplement_"):
        f = first_with_prefix(prefix)
        if f and f not in seeds:
            seeds.append(f)

    top_features = list(dict.fromkeys(seeds + top10_global))[:12]
    log.info(f"  Model exog/regressor candidates ({len(top_features)}): "
             f"seeded={seeds}, top10_global={top10_global}")

    sarimax_results = train_sarimax(df, top_features)
    prophet_results = train_prophet(df, top_features)

    # ---------- Phase 3.5: Evaluation ----------
    log.info("=== PHASE 3.5: EVALUATION ===")
    eval_results = run_evaluation(df, xgb_model, xgb_results)

    # Append SARIMAX per-horizon metrics so the frontend horizon chart can render them
    sarimax_horizon_metrics = sarimax_results.get("metrics_by_horizon", {}) if sarimax_results else {}
    if sarimax_horizon_metrics:
        today_str = str(date.today())
        for h, m in sarimax_horizon_metrics.items():
            eval_results.setdefault("model_metrics_rows", []).append({
                "eval_date": today_str, "model": "sarimax", "horizon_days": int(h),
                "mae": m.get("mae"), "rmse": m.get("rmse"),
                "mape": m.get("mape"), "r_squared": m.get("r2"),
                "directional_accuracy": m.get("directional_accuracy"),
                "ci_coverage": m.get("ci_coverage"),
                "ci_avg_width": m.get("ci_avg_width"),
                "n_predictions": m.get("n"),
                "model_version": "backtest_initial",
            })
        log.info(f"  Added {len(sarimax_horizon_metrics)} SARIMAX horizon metric rows")

    # ---------- Store Results ----------
    log.info("=== STORING RESULTS IN SUPABASE ===")
    store_predictions(xgb_results, sarimax_results, prophet_results, eval_results)
    store_metrics(eval_results)
    store_analysis_results(
        stat_results,
        xgb_results.get("feature_importance", {}),
        xgb_results.get("feature_importance_full", {}),
        controllable_importance=xgb_results.get("controllable_importance"),
        permutation_importance=xgb_results.get("permutation_importance"),
        dm_test=eval_results.get("dm_test"),
        error_modes=eval_results.get("error_modes"),
        error_modes_habits=eval_results.get("error_modes_habits"),
        causal_results=causal_results,
    )

    # ---------- Run-Manifest Artifact (audit fix 4#38) ----------
    # Dump the full feature list + top-20 SHAP / permutation / controllable lists
    # alongside the run, so that "what did this model see + value" is reproducible
    # without re-loading Supabase JSON columns. Pairs with input_data_hash.
    try:
        manifest = {
            "model_version": MODEL_VERSION,
            "input_data_hash": INPUT_DATA_HASH,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "feat_cols": xgb_results.get("feat_cols", []),
            "n_feat_cols": len(xgb_results.get("feat_cols", [])),
            "n_rows_target": int(df[TARGET].notna().sum()),
            "n_fdr_survivors": stat_results.get("n_fdr_survivors"),
            "shap_top20": list(xgb_results.get("feature_importance", {}).items())[:20],
            "permutation_top20": list(xgb_results.get("permutation_importance", {}).items())[:20],
            "controllable_top20": list(xgb_results.get("controllable_importance", {}).items())[:20],
            "test_metrics": xgb_results.get("test_metrics", {}),
        }
        manifest_path = OUTPUT_DIR / f"run_manifest_{MODEL_VERSION}.json"
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, default=str)
        log.info(f"  Run manifest: {manifest_path}")
    except Exception as e:
        log.warning(f"  Run-manifest dump failed: {e}")

    # ---------- Summary ----------
    print_summary(df, xgb_results, sarimax_results, prophet_results, eval_results, stat_results)


if __name__ == "__main__":
    main()
