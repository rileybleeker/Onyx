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
from datetime import date, datetime, timedelta
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

MODEL_VERSION = f"{date.today().isoformat()}_v1"
TARGET = "whoop_hrv_rmssd"

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
    "sleep_score_factor": "Sleep Score Factor",
    "recovery_time_factor": "Recovery Time Factor",
    "hrv_factor": "HRV Readiness Factor",
    "acute_training_load": "Acute Training Load",
    "chronic_training_load": "Chronic Training Load",
    "atl_ctl_ratio": "Training Load Ratio (ATL/CTL)",
    "rolling_7d_training_load": "7-Day Rolling Training Load",
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
    """Coerce a series to 'YYYY-MM-DD' string dates."""
    return pd.to_datetime(s, utc=True, errors="coerce").dt.strftime("%Y-%m-%d")


def load_all_data() -> dict[str, pd.DataFrame]:
    """Load every relevant table from Supabase. Returns a dict of DataFrames."""
    data: dict[str, pd.DataFrame] = {}

    log.info("  Loading daily_health_matrix (base view)…")
    data["matrix"] = fetch_all("daily_health_matrix")
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
    data["garmin_ts"] = fetch_all(
        "garmin_training_status",
        select="calendar_date,sleep_score_factor,recovery_time_factor,hrv_factor,"
               "sleep_history_factor,stress_history_factor,training_load_factor,"
               "training_status,training_load_balance,acute_training_load,chronic_training_load,"
               "vo2_max_running,vo2_max_cycling,fitness_age,recovery_time_hours,recovery_heart_rate",
    )
    if not data["garmin_ts"].empty:
        data["garmin_ts"]["calendar_date"] = data["garmin_ts"]["calendar_date"].astype(str)

    log.info("  Loading garmin_activities…")
    data["garmin_acts"] = fetch_all(
        "garmin_activities",
        select="activity_id,start_time_local,activity_type,duration_seconds,distance_meters,"
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
        select="cycle_id,start_time,strain,kilojoule,average_heart_rate,max_heart_rate",
    )
    if not data["whoop_cycles"].empty:
        # Match matrix view join: (start_time AT TIME ZONE 'UTC')::date
        data["whoop_cycles"]["calendar_date"] = to_date_str(
            data["whoop_cycles"]["start_time"]
        )

    log.info("  Loading whoop_sleep…")
    data["whoop_sleep"] = fetch_all(
        "whoop_sleep",
        select="cycle_id,sleep_cycle_count,baseline_milli,need_from_sleep_debt_milli,"
               "need_from_recent_strain_milli,need_from_recent_nap_milli,total_no_data_time_milli,is_nap,score_state",
        filters=[("is_nap", "eq", False), ("score_state", "eq", "SCORED")],
    )

    log.info("  Loading whoop_workouts…")
    data["whoop_wk"] = fetch_all(
        "whoop_workouts",
        select="workout_id,start_time,sport_name,strain,kilojoule,average_heart_rate,max_heart_rate,"
               "zone_zero_milli,zone_one_milli,zone_two_milli,zone_three_milli,"
               "zone_four_milli,zone_five_milli,score_state",
        filters=[("score_state", "eq", "SCORED")],
    )
    if not data["whoop_wk"].empty:
        # Derive calendar_date from start_time (UTC date matching view logic)
        data["whoop_wk"]["calendar_date"] = to_date_str(data["whoop_wk"]["start_time"])

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
               "light_sleep_seconds,awake_seconds,avg_resp_rate",
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
    data["journal"] = fetch_all("journal", select="cycle_date,question,answer")

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


def pivot_journal(journal: pd.DataFrame) -> pd.DataFrame:
    """Pivot journal rows into boolean columns per question per day."""
    if journal.empty:
        return pd.DataFrame()
    journal = journal.copy()
    journal["cycle_date"] = journal["cycle_date"].astype(str)
    journal["is_yes"] = journal["answer"].str.lower().isin(["yes", "true", "1"]).astype(float)
    pivot = (
        journal.pivot_table(index="cycle_date", columns="question", values="is_yes", aggfunc="max")
        .reset_index()
    )
    # Clean column names
    def clean_col(c: str) -> str:
        return ("journal_" + c.lower()
                .replace("?", "").replace(" ", "_")
                .replace("/", "_").replace("-", "_")
                .replace("'", "").replace(",", "")
                .replace("(", "").replace(")", "")
                .strip("_"))
    pivot.columns = ["calendar_date"] + [clean_col(c) for c in pivot.columns[1:]]
    return pivot


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
        for c in gts.columns:
            if c not in ("calendar_date", "training_status", "training_load_balance"):
                gts[c] = pd.to_numeric(gts[c], errors="coerce")
        gts = gts.drop(columns=["training_status", "training_load_balance"], errors="ignore")
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
        wc = data["whoop_cycles"][["calendar_date", "average_heart_rate", "max_heart_rate"]].copy()
        wc.columns = ["calendar_date", "whoop_cycle_avg_hr", "whoop_cycle_max_hr"]
        for c in ["whoop_cycle_avg_hr", "whoop_cycle_max_hr"]:
            wc[c] = pd.to_numeric(wc[c], errors="coerce")
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
        bm["calendar_date"] = to_date_str(bm["measured_at"])
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
    if not data["journal"].empty:
        jdf = pivot_journal(data["journal"])
        if not jdf.empty:
            df = df.merge(jdf, on="calendar_date", how="left")

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
    df["delta_hrv"] = df[TARGET] - df["hrv_lag1"]
    df["delta_rhr"] = df.get("whoop_rhr", pd.Series(dtype=float)) - \
                       df.get("whoop_rhr", pd.Series(dtype=float)).shift(1)

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
    }
    for cat, cols in categories.items():
        valid = [c for c in cols if c in df.columns]
        if valid:
            pct = df[valid].notna().mean().mean() * 100
            log.info(f"  {cat}: {pct:.0f}% coverage ({len(valid)} features)")


# ===========================================================================
# PHASE 2 – STATISTICAL ANALYSIS
# ===========================================================================

def run_statistical_analysis(df: pd.DataFrame, skip: bool = False) -> dict:
    """Correlation analysis, journal impact, Granger tests. Returns result dict."""
    results: dict = {}

    # Use next-night HRV as the analysis target.
    # WHOOP cycles start ~1 AM (after midnight), so calendar_date N = sleep on morning of N.
    # The behaviors that drove that HRV happened on day N-1. By shifting the target forward
    # by one day we correctly ask: "do today's behaviors predict tonight's HRV?"
    df = df.copy()
    df["hrv_next"] = df[TARGET].shift(-1)
    STAT_TARGET = "hrv_next"

    hrv_valid = df.dropna(subset=[STAT_TARGET])
    numeric_cols = [c for c in hrv_valid.columns
                    if c not in ("calendar_date", STAT_TARGET) and hrv_valid[c].nunique() > 2
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
        order = np.argsort(np.abs(corr_df["spearman_r"].values))[::-1]
        corr_df = corr_df.iloc[order].reset_index(drop=True)
        results["correlations"] = corr_df

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
    if HAS_PINGOUIN:
        try:
            partial_results = []
            controls = [c for c in ["hrv_lag1", "whoop_sleep_duration_milli"]
                        if c in hrv_valid.columns]
            top15_feats = corr_df.head(15)["feature"].tolist()
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
    if HAS_STATSMODELS and corr_rows:
        try:
            top10 = corr_df.head(10)["feature"].tolist()
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

def prepare_ml_data(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], pd.Series]:
    """Build X, feature_cols, y for ML (target = next-day HRV)."""
    # Create next-day target
    df = df.copy()
    df["hrv_target_t1"] = df[TARGET].shift(-1)

    # Filter to rows with a valid target
    model_df = df.dropna(subset=["hrv_target_t1", "hrv_lag1"])

    # Feature columns: all numeric except the training target, date, and future-leaking columns.
    # NOTE: TARGET (whoop_hrv_rmssd) is intentionally kept as a feature — it represents
    # this morning's HRV score, which is known at prediction time and is the strongest
    # same-day predictor of tonight's HRV.
    # whoop_recovery_score is excluded because it is derived from the same sleep's HRV
    # (circular leak). Other same-night WHOOP/Garmin sleep metrics are kept — they represent
    # yesterday's sleep quality, valid context for tonight's prediction.
    exclude = {"calendar_date", "hrv_target_t1", "hrv_next",
               "whoop_recovery_score",  # derived from same sleep's HRV — circular
               }
    feat_cols = [c for c in model_df.columns
                 if c not in exclude and pd.api.types.is_numeric_dtype(model_df[c])]

    # Drop features with <5% non-null (too sparse for meaningful prediction)
    feat_cols = [c for c in feat_cols if model_df[c].notna().mean() >= 0.05]

    X = model_df[feat_cols].copy()
    y = model_df["hrv_target_t1"].copy()

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
    # Directional accuracy: did predicted direction (vs yesterday) match actual?
    dir_acc = np.nan
    if len(yt) > 1:
        actual_dir = np.sign(np.diff(yt))
        pred_dir = np.sign(np.diff(yp))
        dir_acc = float(np.mean(actual_dir == pred_dir) * 100)
    # CI coverage
    ci_cov = np.nan
    ci_width = np.nan
    if y_lower is not None and y_upper is not None:
        yl = np.array(y_lower, dtype=float)[mask]
        yu = np.array(y_upper, dtype=float)[mask]
        ci_cov = float(np.mean((yt >= yl) & (yt <= yu)) * 100)
        ci_width = float(np.nanmean(yu - yl))
    return {"mae": mae, "rmse": rmse, "mape": mape, "r2": r2,
            "directional_accuracy": dir_acc, "ci_coverage": ci_cov, "ci_avg_width": ci_width}


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

    # Prediction intervals via quantile regression (approximate via ± residual std)
    residuals = y_test.values - test_pred
    pred_std = np.std(residuals)
    test_lower = test_pred - 1.645 * pred_std  # ~90% CI
    test_upper = test_pred + 1.645 * pred_std
    ci_metrics = compute_metrics(y_test.values, test_pred, test_lower, test_upper)

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
        exog_feats = [f for f in top_features
                      if f in hrv_valid.columns
                      and f != TARGET
                      and hrv_valid[f].notna().mean() >= 0.5][:5]
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
        # in the holdout since both come from the same dataset — circular leakage)
        reg_feats = [f for f in top_features if f in df_p.columns
                     and f != TARGET
                     and df_p.dropna(subset=["hrv_target_t1"])[f].notna().mean() >= 0.6][:3]

        if reg_feats:
            feat_df = df_p[["calendar_date"] + reg_feats].copy()
            feat_df["calendar_date"] = pd.to_datetime(feat_df["calendar_date"])
            feat_df = feat_df.rename(columns={"calendar_date": "ds"})
            hrv_df = hrv_df.merge(feat_df, on="ds", how="left")
            for rf in reg_feats:
                hrv_df[rf] = hrv_df[rf].ffill().bfill().astype(float)

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

    all_preds: list[dict] = []

    # -----------------------------------------------------------------------
    # XGBoost walk-forward backtest
    # -----------------------------------------------------------------------
    if HAS_XGB and xgb_model is not None:
        log.info(f"  XGBoost expanding-window backtest (step={step})…")
        for start in range(min_train, n - 1, step):
            end = min(start + step, n - 1)
            X_tr, y_tr = X.iloc[:start], y.iloc[:start]
            X_pred_block = X.iloc[start:end]
            y_actual_block = y.iloc[start:end]
            dates_block = model_df["calendar_date"].iloc[start:end].values
            train_start_d = model_df["calendar_date"].iloc[0]
            train_end_d = model_df["calendar_date"].iloc[start - 1]

            try:
                m = XGBRegressor(
                    max_depth=4, learning_rate=0.05, n_estimators=200,
                    min_child_weight=3, subsample=0.8, colsample_bytree=0.8,
                    tree_method="hist", random_state=42,
                )
                m.fit(X_tr, y_tr, verbose=False)
                preds = m.predict(X_pred_block)
                residuals_std = np.std(y_tr.values - m.predict(X_tr))
                for i, (pred, actual, d) in enumerate(
                        zip(preds, y_actual_block.values, dates_block)):
                    all_preds.append({
                        "prediction_date": str(d),
                        "model": "xgboost",
                        "predicted_hrv": float(pred),
                        "prediction_lower": float(pred - 1.645 * residuals_std),
                        "prediction_upper": float(pred + 1.645 * residuals_std),
                        "actual_hrv": float(actual),
                        "residual": float(actual - pred),
                        "horizon_days": 1,
                        "model_version": "backtest_initial",
                        "training_window_start": str(train_start_d),
                        "training_window_end": str(train_end_d),
                    })
            except Exception:
                pass

    # -----------------------------------------------------------------------
    # Naive baselines
    # -----------------------------------------------------------------------
    log.info("  Computing naive baselines…")
    for i in range(min_train, n - 1):
        pred_date = model_df["calendar_date"].iloc[i]
        actual = float(y.iloc[i])
        hrv_hist = model_df[TARGET].iloc[:i + 1].values.astype(float)

        # Naive persistence: predict = last known HRV
        naive_pred = float(hrv_hist[-1])
        all_preds.append({
            "prediction_date": str(pred_date), "model": "baseline_naive",
            "predicted_hrv": naive_pred, "actual_hrv": actual,
            "residual": actual - naive_pred, "horizon_days": 1,
            "model_version": "backtest_initial",
        })

        # 7-day rolling mean
        roll7 = float(np.nanmean(hrv_hist[-7:])) if len(hrv_hist) >= 7 else naive_pred
        all_preds.append({
            "prediction_date": str(pred_date), "model": "baseline_7d_avg",
            "predicted_hrv": roll7, "actual_hrv": actual,
            "residual": actual - roll7, "horizon_days": 1,
            "model_version": "backtest_initial",
        })

        # Day-of-week historical mean
        dow = pd.Timestamp(pred_date).dayofweek
        dow_mask = (pd.to_datetime(model_df["calendar_date"].iloc[:i]).dt.dayofweek == dow)
        dow_vals = model_df[TARGET].iloc[:i][dow_mask.values].dropna().values
        dow_pred = float(np.mean(dow_vals)) if len(dow_vals) >= 5 else naive_pred
        all_preds.append({
            "prediction_date": str(pred_date), "model": "baseline_dow",
            "predicted_hrv": dow_pred, "actual_hrv": actual,
            "residual": actual - dow_pred, "horizon_days": 1,
            "model_version": "backtest_initial",
        })

    # -----------------------------------------------------------------------
    # Aggregate metrics per model
    # -----------------------------------------------------------------------
    bt_df = pd.DataFrame(all_preds)
    eval_results: dict = {"backtest_df": bt_df}

    model_metrics_rows: list[dict] = []
    today_str = str(date.today())

    for m_name in bt_df["model"].unique():
        sub = bt_df[bt_df["model"] == m_name].dropna(subset=["actual_hrv", "predicted_hrv"])
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
        m_metrics["n"] = len(sub)
        eval_results[m_name] = m_metrics
        model_metrics_rows.append({
            "eval_date": today_str, "model": m_name, "horizon_days": 1,
            "mae": m_metrics.get("mae"), "rmse": m_metrics.get("rmse"),
            "mape": m_metrics.get("mape"), "r_squared": m_metrics.get("r2"),
            "directional_accuracy": m_metrics.get("directional_accuracy"),
            "ci_coverage": m_metrics.get("ci_coverage"),
            "ci_avg_width": m_metrics.get("ci_avg_width"),
            "n_predictions": m_metrics.get("n"),
            "model_version": "backtest_initial",
        })

    eval_results["model_metrics_rows"] = model_metrics_rows

    # -----------------------------------------------------------------------
    # Residual plots
    # -----------------------------------------------------------------------
    try:
        xgb_bt = bt_df[bt_df["model"] == "xgboost"].dropna(subset=["residual"])
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

            # Rolling 30-day MAE comparison
            fig, ax = plt.subplots(figsize=(12, 5))
            for m_name, color in [("xgboost", "#3b82f6"), ("baseline_naive", "#f59e0b"),
                                   ("baseline_7d_avg", "#ef4444")]:
                sub = bt_df[(bt_df["model"] == m_name)].dropna(subset=["residual"])
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
            })

    log.info(f"  Upserting {len(rows)} prediction rows…")
    upsert_batch("hrv_predictions", rows, "prediction_date,model,horizon_days")


def store_metrics(eval_results: dict) -> None:
    """Upsert model metrics into pds.hrv_model_metrics."""
    rows = eval_results.get("model_metrics_rows", [])
    if rows:
        log.info(f"  Upserting {len(rows)} metric rows…")
        upsert_batch("hrv_model_metrics", rows, "eval_date,model,horizon_days")


def store_analysis_results(stat_results: dict, feature_importance: dict, feature_importance_full: dict | None = None) -> None:
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

    # Journal impact
    if "journal_impact" in stat_results:
        rows.append({
            "result_type": "journal_impact",
            "result_key": "all",
            "result_json": json.dumps(stat_results["journal_impact"]),
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

    # Feature label map
    rows.append({
        "result_type": "feature_labels",
        "result_key": "all",
        "result_json": json.dumps(FEATURE_LABELS),
    })

    if rows:
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

    # ---------- Phase 2: Statistical Analysis ----------
    log.info("=== PHASE 2: STATISTICAL ANALYSIS ===")
    stat_results = run_statistical_analysis(df, skip=args.skip_analysis)

    if args.skip_models:
        log.info("Skipping ML models (--skip-models set).")
        print_summary(df, {}, {}, {}, {}, stat_results)
        return

    # ---------- Phase 3: Models ----------
    log.info("=== PHASE 3: PREDICTION MODELS ===")
    xgb_model, xgb_results = train_xgboost(df)

    top_features = list(xgb_results.get("feature_importance", {}).keys())[:10]
    if not top_features and "correlations" in stat_results:
        top_features = stat_results["correlations"].head(10)["feature"].tolist()

    sarimax_results = train_sarimax(df, top_features)
    prophet_results = train_prophet(df, top_features)

    # ---------- Phase 3.5: Evaluation ----------
    log.info("=== PHASE 3.5: EVALUATION ===")
    eval_results = run_evaluation(df, xgb_model, xgb_results)

    # ---------- Store Results ----------
    log.info("=== STORING RESULTS IN SUPABASE ===")
    store_predictions(xgb_results, sarimax_results, prophet_results, eval_results)
    store_metrics(eval_results)
    store_analysis_results(stat_results, xgb_results.get("feature_importance", {}), xgb_results.get("feature_importance_full", {}))

    # ---------- Summary ----------
    print_summary(df, xgb_results, sarimax_results, prophet_results, eval_results, stat_results)


if __name__ == "__main__":
    main()
