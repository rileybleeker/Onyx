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
