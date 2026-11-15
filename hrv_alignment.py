"""The one alignment rule for Onyx's HRV analysis (2026-11-10).

THE RULE
--------
Row D of pds.daily_health_matrix_behavioral is behavioral day D (bedtime to bedtime,
ADR-0001). Its whoop_hrv_rmssd is the HRV of the sleep that CLOSES day D: the WHOOP
cycle is dated by its sleep onset - 6 h, so the night that starts at ~2 AM on clock day
D+1 is dated D. Every consumer -- the descriptive statistics, the causal layer and the
forecast -- scores a day-D behaviour against the HRV on the SAME row.

Horizon h means "the sleep that closes day D + (h - 1)": h = 1 is tonight's sleep.
The forecast made on behavioral day T predicts row T's HRV, i.e. the HRV Riley wakes up
to on clock day T + 1. pds.hrv_predictions.prediction_date stores the behavioral date of
the predicted sleep (T) -- the same key the matrix, the backtest and SARIMAX/Prophet use --
and the page shows the wake-up date (prediction_date + 1).

History: commit b0828fa (2026-04-04) compared row D with row D+1's HRV, which was right
while the matrix dated a WHOOP cycle by its wake-up day. ADR-0001 (2026-05-25) re-dated
the matrix to bedtime - 6 h and the D+1 comparison stayed, so for ~5 months every
behaviour was scored against the night AFTER the one it preceded. This module replaces
every one of those shifts.

COLUMNS THE MATRIX KEEPS ON ANOTHER DAY (re-keyed here by date, before any feature is
derived; verified on live data 2026-11-10)
------------------------------------------------------------------------------------
* WHOOP cycle totals (whoop_day_strain, whoop_kilojoule, whoop_cycle_avg_hr,
  whoop_cycle_max_hr). A WHOOP cycle starts at the sleep that closes day D and runs
  through the NEXT waking day, so row D shows day D+1's strain (strain on row D vs WHOOP
  workouts on row D+1: r = 0.83; same row: r = -0.01). Moved one day later, so row D
  holds day D's strain. Without this, a same-row outcome would make strain reverse-causal.
  whoop_steps (pds.whoop_cycles.step_count, merged in pandas by
  hrv_analysis.merge_whoop_steps_features, not a matrix column) is the same kind of total,
  but it is dated from each cycle's OWN start, not from the matrix's cycle pick:
  cycle_waking_day() = the behavioral day (-6 h rule, in the cycle's local time) of the
  instant 12 h after the cycle's opening sleep onset, i.e. (local start + 6 h)'s date. For
  the usual night-time onset that is cycle date + 1, the same move as strain. It differs
  only for an onset between 06:00 and 18:00 local: the -6 h rule dates that sleep to its own
  clock day D, and the next onset (after midnight) is dated D as well, so two cycles share
  behavioral date D, but the first one's waking hours are clock day D. Cycles that land on
  the same day are summed (they are consecutive, non-overlapping spans). Live check
  2026-11-14, 739 closed cycles: cycle date + 1 put two cycles on one day 7 times; this rule
  0 times, and it equals "the behavioral day of the cycle's END" (the sleep the steps
  precede) on 732 of 739. Steps of the day vs Garmin steps of the same clock day: r = 0.949
  (507 days; cycle date + 1: 0.945, 505). Earlier check 2026-11-13: the cycle dated D vs
  Garmin steps of clock day D+1 r = 0.94 (451 days), D-2, D-1, D, D+2, D+3 between -0.11 and
  0.22; against WHOOP running distance of day D+1 r = 0.75, other offsets |r| < 0.14.
* Eight Sleep and Garmin HRV (matrix columns eight_sleep_* and garmin_hrv_*): both are
  dated by the wake-up day, so row D shows the night that closes day D-1 (Eight Sleep HRV
  on row D+1 vs WHOOP HRV on row D: r = 0.84; Garmin HRV on row D vs WHOOP row D-1:
  r = 0.82). Moved one day earlier, so they describe the same sleep as row D's WHOOP HRV.
* Source frames hrv_analysis.load_all_data merges by their own calendar_date, which is the
  wake-up day: garmin_sleep (onyx_behavioral_date = calendar_date - 1 in 233/236 rows),
  garmin_hrv and eight_sleep_trends. wake_date_to_closing_day() re-keys them.

Left as they are (all describe something BEFORE row D's sleep):
* behaviour families journal_ / habit_ / supplement_ / nutrition_ / caffeine_ / meal_ /
  act_ / delivery_ / screen_ / nj_ and the workout gap: day D. (Timed events of day D fall between
  the previous sleep and row D's sleep in 99-100% of cases; supplements 89% -- the rest
  are retro-logs.)
* aqi_ (outdoor PM2.5 / AQI, pds.air_quality_daily): the ET clock day's hourly mean on row D.
  It is not re-keyed and not a mediator: every hour but possibly the last one before
  midnight precedes the sleep that closes day D. It is kept out of the forecast only because
  today's row is partial when the evening forecast runs (hrv_analysis.NOT_FORECAST_PREFIXES).
* wx_ (outdoor weather, pds.weather_daily): the daytime aggregates of ET clock day D on row D,
  for the same reason as aqi_. The two wx_night_* columns are the exception and ARE re-keyed, in
  hrv_analysis.merge_weather_features: the table stores the 01:00-08:00 ET temperatures on their
  own clock day, and for the sleep that closes day D that is clock day D + 1, so they are moved
  one day earlier. They are concurrent with the outcome sleep but exogenous and not measured
  from it, so they are not mediators. The clock day's minimum temperature is not used at all:
  it usually falls near dawn, inside the previous row's sleep. Out of the forecast like aqi_.
* Garmin daily summary / stress / HR zones / training status: the clock day. Their activity
  fields are day D; their overnight fields (RHR, body-battery charge, sleeping seconds,
  readiness) describe the night that closes day D-1 -- earlier than row D's sleep.
* WHOOP workouts and Garmin activities: their onyx_behavioral_date (day D).
* lags and rolling windows (hrv_lag1, hrv_7d_mean, *_lag1, sleep_debt_7d, rolling load):
  strictly earlier days, so they stay valid confounders.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

TARGET = "whoop_hrv_rmssd"
DATE_COL = "calendar_date"
ET = ZoneInfo("America/New_York")
BEHAVIORAL_DAY_OFFSET = timedelta(hours=6)

# Bumped whenever the rule changes. Stored in the model pickle and the causal payload so a
# model trained under one rule is never served under another.
ALIGNMENT_VERSION = "same_night_v1"
# First day whose live forecasts follow this rule (model_version starts with the run date).
ALIGNMENT_CUTOVER_DATE = "2026-11-11"

# Matrix columns that describe the waking day AFTER row D's sleep (see module docstring).
NEXT_DAY_COLS = ("whoop_day_strain", "whoop_kilojoule", "whoop_cycle_avg_hr", "whoop_cycle_max_hr")
# Cycle totals hrv_analysis builds from pds.whoop_cycles itself, dated with
# cycle_waking_day() before the merge, so they are already on the rule when they reach the
# frame (never passed through realign_matrix).
CYCLE_TOTAL_FEATURES = ("whoop_steps",)
# A cycle's waking hours start about one sleep after its opening onset; 12 h is the point
# whose behavioral day (-6 h rule) names the waking day (cycle_waking_day).
WAKING_DAY_FROM_ONSET = timedelta(hours=12)
# Matrix columns keyed by the wake-up day (they show the night BEFORE row D's sleep).
PREVIOUS_NIGHT_PREFIXES = ("eight_sleep_", "garmin_hrv_")


class AlignmentError(RuntimeError):
    """The live matrix no longer matches the dating this module assumes."""


# ---------------------------------------------------------------------------
# Re-keying
# ---------------------------------------------------------------------------

def _move_by_days(df: pd.DataFrame, cols: list[str], days: int) -> pd.DataFrame:
    """Values for `cols` with every value moved `days` later by date: the result's row D
    holds what the input had on row D - days. Date-based, so gaps in the spine are safe."""
    dates = pd.to_datetime(df[DATE_COL])
    src = df[cols].copy()
    src.index = dates + pd.Timedelta(days=days)
    src = src[~src.index.duplicated(keep="last")]
    out = src.reindex(dates)
    out.index = df.index
    return out


def realign_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Put every matrix column on the rule: row D = day D, sleep = the one closing day D."""
    df = df.copy()
    nd = [c for c in NEXT_DAY_COLS if c in df.columns]
    pn = [c for c in df.columns if c.startswith(PREVIOUS_NIGHT_PREFIXES)]
    if nd:
        df[nd] = _move_by_days(df, nd, +1)
    if pn:
        df[pn] = _move_by_days(df, pn, -1)
    return df


def wake_date_to_closing_day(frame: pd.DataFrame) -> pd.DataFrame:
    """Re-key a per-night source frame from its wake-up date to the behavioral day the
    sleep closes (wake-up date - 1)."""
    if frame is None or frame.empty or DATE_COL not in frame.columns:
        return frame
    f = frame.copy()
    f[DATE_COL] = (pd.to_datetime(f[DATE_COL]) - pd.Timedelta(days=1)).dt.strftime("%Y-%m-%d")
    return f


def _offset_minutes(value) -> float:
    """A WHOOP timezone_offset ('-04:00', '+0530', '-04') in minutes east of UTC, or NaN."""
    if not isinstance(value, str):
        return np.nan
    s = value.strip()
    if len(s) < 3 or s[0] not in "+-":
        return np.nan
    digits = s[1:].replace(":", "")
    if not digits.isdigit() or len(digits) not in (2, 4):
        return np.nan
    minutes = int(digits[:2]) * 60 + (int(digits[2:]) if len(digits) == 4 else 0)
    if minutes > 14 * 60:
        return np.nan
    return float(minutes if s[0] == "+" else -minutes)


def cycle_waking_day(cycles: pd.DataFrame) -> pd.Series:
    """The waking day ('YYYY-MM-DD') whose totals a WHOOP cycle counts, from the cycle's own
    start: the behavioral day (-6 h rule) of the instant WAKING_DAY_FROM_ONSET after the
    opening sleep onset, in the cycle's local time (start_time + timezone_offset; a missing
    or unreadable offset falls back to America/New_York). NaN where start_time is missing.
    See the module docstring for why this replaces "cycle date + 1"."""
    if cycles is None or cycles.empty or "start_time" not in cycles.columns:
        return pd.Series(np.nan, index=getattr(cycles, "index", None), dtype=object)
    start = pd.to_datetime(cycles["start_time"], utc=True, errors="coerce", format="ISO8601")
    if "timezone_offset" in cycles.columns:
        off = cycles["timezone_offset"].map(_offset_minutes).astype(float)
    else:
        off = pd.Series(np.nan, index=cycles.index, dtype=float)
    et_off = start.map(lambda t: t.tz_convert(ET).utcoffset().total_seconds() / 60
                       if pd.notna(t) else np.nan).astype(float)
    off = off.fillna(et_off)
    local = start.dt.tz_localize(None) + pd.to_timedelta(off, unit="m")
    day = (local + WAKING_DAY_FROM_ONSET - BEHAVIORAL_DAY_OFFSET).dt.strftime("%Y-%m-%d")
    return day.where(start.notna())


# ---------------------------------------------------------------------------
# Outcome
# ---------------------------------------------------------------------------

def outcome_col(horizon: int = 1) -> str:
    return f"hrv_target_t{horizon}"


def outcome_series(df: pd.DataFrame, horizon: int = 1) -> pd.Series:
    """HRV of the sleep that closes day D + (horizon - 1), aligned to row D."""
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    moved = _move_by_days(df, [TARGET], -(horizon - 1))[TARGET]
    return pd.to_numeric(moved, errors="coerce")


def add_outcome(df: pd.DataFrame, horizon: int = 1) -> pd.DataFrame:
    df = df.copy()
    df[outcome_col(horizon)] = outcome_series(df, horizon)
    return df


def target_date(feature_date, horizon: int = 1) -> pd.Timestamp:
    """Behavioral date of the sleep a row's horizon-h outcome refers to."""
    return pd.to_datetime(feature_date) + pd.Timedelta(days=horizon - 1)


def feature_date(prediction_dates, horizons) -> pd.Series:
    """Inverse of target_date: the behavioral day whose features predicted a stored
    prediction (prediction_date - (horizon - 1))."""
    h = pd.Series(horizons).astype(int).to_numpy() if not np.isscalar(horizons) else int(horizons)
    return pd.to_datetime(prediction_dates) - pd.to_timedelta(np.asarray(h) - 1, unit="D")


def train_cutoff(test_start: int, horizon: int) -> int:
    """Training rows allowed before predicting row `test_start` at horizon h: a training
    row j has its outcome at row j + h - 1, which must be a sleep that has already happened
    on the evening of day test_start (rows <= test_start - 1). Positional; assumes the
    contiguous daily spine the HRV era has."""
    return max(1, test_start - (horizon - 1))


def naive_baseline_rows(model_df: pd.DataFrame, horizons, min_train: int,
                        outcome_df: pd.DataFrame | None = None) -> list[dict]:
    """Backtest rows for the naive baselines (persistence, 7-day mean, day-of-week) at
    every horizon, for run_evaluation's Accuracy-by-Horizon comparison.

    A prediction made on the evening of feature row i (behavioral day D) at horizon h is
    scored against the sleep that closes day D + h - 1 (target_date), looked up BY DATE
    in `outcome_df` (default: model_df), the same way outcome_series builds the XGBoost
    target. It used to be row i + h - 1 of model_df, which is a different night wherever
    the history has missing days (model_df drops rows without HRV): dot's review
    2026-11-11, finding 3. A target night with no HRV is skipped, as XGBoost skips it.

    The history a baseline may use is the model_df rows before row i (sleeps up to day
    D - 1), unchanged.
    """
    src = model_df if outcome_df is None else outcome_df
    by_date = pd.Series(pd.to_numeric(src[TARGET], errors="coerce").to_numpy(dtype=float),
                        index=pd.to_datetime(src[DATE_COL]))
    by_date = by_date[~by_date.index.duplicated(keep="last")]

    hrv_arr = pd.to_numeric(model_df[TARGET], errors="coerce").to_numpy(dtype=float)
    dates = pd.DatetimeIndex(pd.to_datetime(model_df[DATE_COL]))
    n = len(hrv_arr)
    rows: list[dict] = []
    for h in horizons:
        for i in range(max(min_train, 1), n):
            tdate = target_date(dates[i], h)
            actual = by_date.get(tdate, np.nan)
            if actual is None or np.isnan(actual):
                continue
            actual = float(actual)
            pred_date = tdate.strftime("%Y-%m-%d")
            hrv_hist = hrv_arr[:i]

            def row(model: str, pred: float) -> dict:
                return {
                    "prediction_date": pred_date, "model": model,
                    "predicted_hrv": pred, "actual_hrv": actual,
                    "residual": actual - pred, "horizon_days": h,
                    "model_version": "backtest_initial",
                }

            # Naive persistence: the last known HRV (constant across h).
            naive_pred = float(hrv_hist[-1])
            rows.append(row("baseline_naive", naive_pred))

            # 7-day rolling mean of the last 7 known values (constant across h).
            roll7 = float(np.nanmean(hrv_hist[-7:])) if len(hrv_hist) >= 7 else naive_pred
            rows.append(row("baseline_7d_avg", roll7))

            # Day-of-week mean for the weekday of the TARGET night's behavioral day.
            dow_mask = dates[:i].day_of_week == tdate.day_of_week
            dow_vals = hrv_hist[dow_mask]
            dow_vals = dow_vals[~np.isnan(dow_vals)]
            dow_pred = float(np.mean(dow_vals)) if len(dow_vals) >= 5 else naive_pred
            rows.append(row("baseline_dow", dow_pred))
    return rows


def _as_days(values) -> pd.Series:
    """Dates as midnight datetime64[ns], so two frames built by different libraries join."""
    return pd.to_datetime(pd.Series(np.asarray(values))).dt.normalize().astype("datetime64[ns]")


def holdout_forecast_periods(train_dates, holdout_dates, minimum: int = 30) -> int:
    """Daily steps a forecast must run past the last training date to reach the last
    held-out night. The held-out rows are the last N nights WITH an HRV value, so when a
    day is missing they span more than N calendar days. Equals `minimum` when there is no
    gap (N = minimum)."""
    span = (_as_days(holdout_dates).max() - _as_days(train_dates).max()).days
    return max(int(minimum), int(span))


def pair_holdout_by_date(holdout_df: pd.DataFrame, forecast_df: pd.DataFrame,
                         date_col: str = "ds", actual_col: str = "y",
                         forecast_cols=("yhat", "yhat_lower", "yhat_upper")) -> pd.DataFrame:
    """Held-out actuals next to the forecast made for the SAME date, in date order.

    The Prophet holdout used to compare the k-th forecast day with the k-th held-out row
    (dot's review 2026-11-11, finding 4). The forecast is a daily calendar; the held-out
    rows skip days without HRV, so after the first gap every pair was two different
    nights. A held-out night the forecast does not reach is left out, never matched to
    another date. Identical to the positional pairing when the history has no gap.
    """
    cols = [c for c in forecast_cols if c in forecast_df.columns]
    actual = pd.DataFrame({
        date_col: _as_days(holdout_df[date_col]),
        actual_col: pd.to_numeric(holdout_df[actual_col], errors="coerce").to_numpy(dtype=float),
    })
    forecast = forecast_df[cols].reset_index(drop=True)
    forecast.insert(0, date_col, _as_days(forecast_df[date_col]))
    forecast = forecast.drop_duplicates(subset=date_col, keep="last")
    return (actual.merge(forecast, on=date_col, how="inner")
            .sort_values(date_col, kind="stable").reset_index(drop=True))


# ---------------------------------------------------------------------------
# Which columns can feed what
# ---------------------------------------------------------------------------

# Measured FROM the outcome sleep (after re-keying): mediators for the causal layer,
# unknown when the forecast is made.
SAME_SLEEP_PREFIXES = (
    "whoop_sleep_", "garmin_sleep_", "eight_sleep_", "garmin_hrv_",
    "whoop_deep", "whoop_rem", "whoop_light", "garmin_deep", "garmin_rem",
    "garmin_light", "garmin_awake",
)
SAME_SLEEP_EXACT = frozenset({
    TARGET, "whoop_recovery_score", "whoop_rhr", "whoop_spo2", "whoop_skin_temp",
    "whoop_respiratory_rate", "whoop_disturbances", "whoop_awake_milli",
    "whoop_deep_sleep_milli", "whoop_rem_sleep_milli", "whoop_light_sleep_milli",
    # whoop_sleep extras
    "sleep_cycle_count", "baseline_milli", "need_from_sleep_debt_milli",
    "need_from_recent_strain_milli", "need_from_recent_nap_milli", "total_no_data_time_milli",
    # garmin_sleep extras (re-keyed to the closing day)
    "light_sleep_seconds", "rem_sleep_seconds", "awake_seconds", "unmeasurable_seconds",
    "quality_score", "duration_score", "recovery_score", "rem_score", "light_score",
    "deep_score", "restlessness_score", "avg_sleep_heart_rate", "avg_respiration_rate",
    "avg_spo2", "avg_hrv", "avg_sleep_stress", "sleep_need_seconds", "sleep_debt_seconds",
    "bedtime_hour", "wake_hour", "sleep_midpoint_hour",
    # garmin_hrv extras
    "last_night_avg_ms", "last_night_5min_high_ms", "weekly_avg_ms", "baseline_low_upper_ms",
    "baseline_balanced_low_ms", "baseline_balanced_upper_ms", "baseline_marker_upper_ms",
    "hrv_vs_baseline",
    # eight_sleep extras
    "sleep_quality_score", "sleep_duration_score", "latency_asleep_score",
    "latency_out_score", "wakeup_consistency_score", "sleep_routine_score", "avg_breath_rate",
    # derived from the above
    "hrv_z_28d", "delta_hrv", "delta_rhr", "sleep_debt_ratio", "bed_room_temp_delta",
    "room_temp_x_sleep_eff", "alcohol_x_sleep_duration",
    "whoop_rhr_z28d", "whoop_sleep_duration_milli_z28d", "whoop_recovery_score_z28d",
    # phone use after WHOOP sleep onset (pds.phone_usage_daily): happens during the sleep
    "screen_during_sleep_min",
})

# Anchored to the outcome sleep's onset (or to the WHOOP cycle that starts with it):
# fine to analyse, but not known until the sleep has started.
NEEDS_SLEEP_ONSET = frozenset({
    "meal_last_meal_to_bedtime_min", "caffeine_to_bedtime_min", "caffeine_mg_at_bedtime",
    "delivery_last_meal_to_sleep_min", "last_workout_end_to_sleep_min",
    "screen_last_hour_before_sleep_min",
    "last_workout_whoop_strain", "last_workout_garmin_load", "had_evening_workout",
    "whoop_strain_per_hour_to_bed",
    # travel flags derived from the WHOOP cycle that begins with row D's sleep
    "onyx_is_transition_day", "is_transition_day", "days_since_transition",
    "offset_delta_hours", "is_outbound", "is_return",
})

# Other measurements of the outcome night's HRV / resting HR. Correlating them with the
# outcome is "the same thing measured twice", so they are left out of the driver ranking.
OUTCOME_TWINS = frozenset({
    TARGET, "whoop_recovery_score", "whoop_rhr", "eight_sleep_hrv", "eight_sleep_hr",
    "garmin_hrv_last_night", "garmin_hrv_5min_high", "garmin_hrv_weekly_avg",
    "garmin_hrv_baseline_low", "garmin_hrv_baseline_high", "garmin_hrv_status_ord",
    "last_night_avg_ms", "last_night_5min_high_ms", "weekly_avg_ms", "avg_hrv",
    "hrv_vs_baseline", "hrv_z_28d", "delta_hrv", "delta_rhr",
    "whoop_rhr_z28d", "whoop_recovery_score_z28d", "avg_sleep_heart_rate",
    # Garmin training status' HRV factor: realign_matrix moves it with the other garmin_hrv_*
    # columns (prefix match), so after re-keying it describes the outcome night.
    "garmin_hrv_factor",
})


# Prefix matches that are NOT the outcome sleep: Garmin training-status factors are
# computed on the morning of day D from the night before.
NOT_SAME_SLEEP = frozenset({"garmin_sleep_score_factor", "garmin_sleep_history_factor"})
LAG_SUFFIXES = ("_lag1", "_lag2", "_lag3")


def is_same_sleep(col: str) -> bool:
    """Measured from the outcome sleep. A lag of such a column is an earlier night, so
    it is not."""
    if col in NOT_SAME_SLEEP or col.endswith(LAG_SUFFIXES):
        return False
    return col in SAME_SLEEP_EXACT or col.startswith(SAME_SLEEP_PREFIXES)


def forecast_can_use(col: str) -> bool:
    """True if the column is known on the evening before the sleep being forecast."""
    if col.startswith("hrv_target_t") or col == DATE_COL:
        return False
    return not is_same_sleep(col) and col not in NEEDS_SLEEP_ONSET


# ---------------------------------------------------------------------------
# Serving
# ---------------------------------------------------------------------------

def behavioral_today(now: datetime | None = None) -> date:
    """Behavioral day in progress (ET clock - 6 h): before ~6 AM it is still yesterday."""
    now = now or datetime.now(ET)
    return (now.astimezone(ET) - BEHAVIORAL_DAY_OFFSET).date()


def ensure_row(df: pd.DataFrame, day: date) -> pd.DataFrame:
    """Append an empty spine row for `day` if no source has produced one yet, so the
    forecast always has a row (its lags are filled by the feature builder)."""
    key = day.isoformat()
    if (df[DATE_COL].astype(str) == key).any():
        return df
    return pd.concat([df, pd.DataFrame({DATE_COL: [key]})], ignore_index=True)


def serve_index(df: pd.DataFrame, now: datetime | None = None):
    """Index of the row the live forecast predicts from (behavioral today), or None."""
    key = behavioral_today(now).isoformat()
    hit = df.index[df[DATE_COL].astype(str) == key]
    return hit[-1] if len(hit) else None


# ---------------------------------------------------------------------------
# Runtime guard + canary
# ---------------------------------------------------------------------------

def main_cycle_per_day(cycles: pd.DataFrame) -> pd.DataFrame:
    """Python twin of pds.whoop_main_cycle_per_behavioral_date: longest cycle per
    behavioral day (open cycles last), latest start as tiebreak."""
    c = cycles.dropna(subset=["onyx_behavioral_date"]).copy()
    c["_start"] = pd.to_datetime(c["start_time"], utc=True, errors="coerce", format="ISO8601")
    c["_end"] = pd.to_datetime(c["end_time"], utc=True, errors="coerce", format="ISO8601")
    c["_len"] = (c["_end"] - c["_start"]).dt.total_seconds()
    c = c.sort_values(["onyx_behavioral_date", "_len", "_start"],
                      ascending=[True, False, False], na_position="last")
    return c.drop_duplicates("onyx_behavioral_date", keep="first")


def check_matrix_hrv(matrix: pd.DataFrame, cycles: pd.DataFrame,
                     recovery: pd.DataFrame, tol: float = 0.01) -> list[str]:
    """Every matrix row's HRV must equal the recovery HRV of the WHOOP cycle dated to that
    row. Returns a list of problems (empty = aligned)."""
    problems: list[str] = []
    m = matrix[[DATE_COL, TARGET]].copy()
    m[TARGET] = pd.to_numeric(m[TARGET], errors="coerce")
    m = m.dropna(subset=[TARGET])
    if m.empty:
        return ["matrix has no HRV rows"]
    mc = main_cycle_per_day(cycles)[["cycle_id", "onyx_behavioral_date"]]
    rec = recovery.copy()
    if "score_state" in rec.columns:
        rec = rec[rec["score_state"] == "SCORED"]
    rec = rec[["cycle_id", "hrv_rmssd_milli"]].drop_duplicates("cycle_id")
    exp = mc.merge(rec, on="cycle_id", how="left")
    exp[DATE_COL] = exp["onyx_behavioral_date"].astype(str)
    j = m.merge(exp[[DATE_COL, "hrv_rmssd_milli"]], on=DATE_COL, how="left")
    j["hrv_rmssd_milli"] = pd.to_numeric(j["hrv_rmssd_milli"], errors="coerce")
    bad = j[~(np.abs(j[TARGET] - j["hrv_rmssd_milli"]) <= tol)]
    if len(bad):
        sample = ", ".join(f"{r[DATE_COL]}: row {r[TARGET]:.1f} vs cycle "
                           f"{'none' if pd.isna(r['hrv_rmssd_milli']) else round(r['hrv_rmssd_milli'], 1)}"
                           for _, r in bad.head(5).iterrows())
        problems.append(f"{len(bad)}/{len(j)} matrix rows' HRV != the recovery of the WHOOP "
                        f"cycle dated to that row ({sample})")
    return problems


def _corr(a: pd.Series, b: pd.Series) -> tuple[float, int]:
    x = pd.concat([pd.to_numeric(a, errors="coerce"), pd.to_numeric(b, errors="coerce")],
                  axis=1).dropna()
    if len(x) < 30 or x.iloc[:, 0].nunique() < 2 or x.iloc[:, 1].nunique() < 2:
        return float("nan"), len(x)
    return float(x.iloc[:, 0].corr(x.iloc[:, 1])), len(x)


def check_rekey_directions(realigned: pd.DataFrame) -> list[str]:
    """After realign_matrix, re-keyed columns must match the same row best. If a source's
    dating is ever fixed upstream, these re-keys would double-shift; this catches it.
    Checks with fewer than 30 pairs are skipped."""
    problems: list[str] = []
    df = realigned.sort_values(DATE_COL)
    nxt = _move_by_days(df, list(df.columns.drop(DATE_COL)), -1)   # row D -> row D+1's values
    prv = _move_by_days(df, list(df.columns.drop(DATE_COL)), +1)   # row D -> row D-1's values
    checks = [
        ("whoop_day_strain", "whoop_workout_strain"),
        ("eight_sleep_hrv", TARGET),
        ("garmin_hrv_last_night", TARGET),
        # WHOOP steps (cycle total, re-keyed in pandas) vs Garmin steps (clock day): two
        # devices counting the same day. Skipped when either column is absent.
        ("whoop_steps", "total_steps"),
    ]
    for col, ref in checks:
        if col not in df.columns or ref not in df.columns:
            continue
        same, n = _corr(df[col], df[ref])
        if np.isnan(same):
            continue
        before, _ = _corr(prv[col], df[ref])
        after, _ = _corr(nxt[col], df[ref])
        if not (same > before and same > after):
            problems.append(f"{col} lines up with {ref} on an adjacent row, not the same row "
                            f"(r same={same:.2f}, previous={before:.2f}, next={after:.2f}, n={n})")
    return problems


def alcohol_canary(df: pd.DataFrame, col: str = "journal_have_any_alcoholic_drinks",
                   min_yes: int = 5) -> dict:
    """Known-answer check: drinking should hurt the HRV of the same night more than the
    following night's. Returns {"ok": bool|None, "same": d1, "next": d2, ...}; ok=None when
    there are too few drinking days to judge."""
    if col not in df.columns:
        return {"ok": None, "reason": f"{col} missing"}
    d = df.sort_values(DATE_COL)
    t = pd.to_numeric(d[col], errors="coerce")
    y1 = outcome_series(d, 1)
    y2 = outcome_series(d, 2)

    def diff(y):
        yes, no = y[(t == 1) & y.notna()], y[(t == 0) & y.notna()]
        if len(yes) < min_yes or len(no) < min_yes:
            return float("nan"), len(yes), len(no)
        return float(yes.mean() - no.mean()), len(yes), len(no)

    same, n_yes, n_no = diff(y1)
    nxt, _, _ = diff(y2)
    if np.isnan(same) or np.isnan(nxt):
        return {"ok": None, "same": same, "next": nxt, "n_yes": n_yes, "n_no": n_no,
                "reason": "too few explicitly answered drinking days"}
    return {"ok": bool(same < nxt and same < 0), "same": same, "next": nxt,
            "n_yes": n_yes, "n_no": n_no}
