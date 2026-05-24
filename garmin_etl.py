"""
Personal Data Scientist — Garmin ETL Pipeline
==============================================
Syncs Garmin Connect data to Supabase (Postgres 17).

Usage:
    python garmin_etl.py                  # Sync last 7 days (daily run)
    python garmin_etl.py --backfill 730   # Backfill ~2 years of history
    python garmin_etl.py --backfill 30    # Backfill last 30 days
    python garmin_etl.py --date 2025-06-15  # Sync a specific date

Requirements:
    pip install garminconnect supabase python-dotenv
"""

import os
import sys
import json
import time
import argparse
import logging
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv
from garminconnect import Garmin
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GARMIN_EMAIL = os.environ["GARMIN_EMAIL"]
GARMIN_PASSWORD = os.environ["GARMIN_PASSWORD"]

TOKEN_DIR = os.path.expanduser("~/.garminconnect")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("garmin_etl")

# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

def get_garmin_client() -> Garmin:
    """Authenticate with Garmin Connect, reusing saved tokens when possible.

    Retries fresh login up to 3 times with exponential backoff to handle
    Garmin's 429 rate limiting on the SSO endpoint.
    """
    client = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD)
    try:
        client.login(TOKEN_DIR)
        log.info("Garmin: logged in with saved tokens")
        return client
    except Exception:
        log.info("Garmin: saved tokens expired, performing fresh login...")

    for attempt in range(1, 4):
        try:
            client.login()
            if hasattr(client, 'garth'):
                client.garth.dump(TOKEN_DIR)
            log.info("Garmin: fresh login successful, tokens saved")
            return client
        except Exception as e:
            if attempt == 3:
                raise
            wait = 60 * attempt
            log.warning("Garmin: login attempt %d failed (%s), retrying in %ds...", attempt, e, wait)
            time.sleep(wait)


def get_supabase_client() -> Client:
    """Create Supabase client with service role key."""
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def date_to_ts(d: date) -> str:
    """Convert a date to a midnight UTC timestamp string."""
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).isoformat()


def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dicts."""
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            return default
    return current


def to_int(val):
    """Convert a value to int if not None (handles floats like 180.0 for integer columns)."""
    return int(val) if val is not None else None


def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, duration: float = None):
    """Write a sync log entry to pds.sync_log.

    Both `sync_start` and `sync_end` are populated explicitly. Postgres has a
    default for `sync_start` so it would fill in even if omitted, but `sync_end`
    has no default — leaving it NULL broke /status freshness queries (audit
    finding 3.A).
    """
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=duration) if duration is not None else end
    try:
        sb.schema("pds").table("sync_log").insert({
            "source": source,
            "data_type": data_type,
            "status": status,
            "records_synced": records,
            "date_range_start": date_start.isoformat() if date_start else None,
            "date_range_end": date_end.isoformat() if date_end else None,
            "error_message": error,
            "duration_seconds": duration,
            "sync_start": start.isoformat(),
            "sync_end": end.isoformat(),
        }).execute()
    except Exception as e:
        log.warning(f"Failed to write sync log: {e}")


def upsert_to_supabase(sb: Client, table: str, rows: list[dict],
                        conflict_columns: str):
    """Upsert rows to a Supabase table in the pds schema."""
    if not rows:
        return 0
    # Supabase client upsert with on_conflict
    result = (
        sb.schema("pds")
        .table(table)
        .upsert(rows, on_conflict=conflict_columns)
        .execute()
    )
    return len(result.data) if result.data else 0


# ---------------------------------------------------------------------------
# Sync: Daily Summary
# ---------------------------------------------------------------------------

def sync_daily_summary(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of daily summary stats."""
    ds = target_date.isoformat()
    # Skip future dates: Garmin's API returns a stub row for today+1 onwards with
    # all metric columns NULL. Storing those breaks "latest data date" queries
    # in /status and seeds garbage forward-edges into the daily_health_matrix view
    # (audit finding 1.F).
    #
    # Self-review fix: previously used `date.today()` which on the GHA runner is
    # UTC-local. For a user in ET (UTC-4/-5), UTC may have already rolled into
    # tomorrow while the user's local "today" is yesterday — making the guard
    # accept a real-world-future row. Compare against ET-local date instead.
    try:
        from zoneinfo import ZoneInfo
        local_today = datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:
        local_today = date.today()
    if target_date > local_today:
        log.debug(f"  daily_summary {ds}: future date (local {local_today}), skipping")
        return 0
    try:
        stats = garmin.get_stats(ds)
    except Exception as e:
        log.debug(f"  daily_summary {ds}: no data ({e})")
        return 0

    if not stats:
        return 0

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "total_steps": stats.get("totalSteps"),
        "daily_step_goal": stats.get("dailyStepGoal"),
        "total_distance_meters": stats.get("totalDistanceMeters"),
        "floors_ascended": stats.get("floorsAscended"),
        "floors_descended": stats.get("floorsDescended"),
        "total_kilocalories": stats.get("totalKilocalories"),
        "active_kilocalories": stats.get("activeKilocalories"),
        "bmr_kilocalories": stats.get("bmrKilocalories"),
        "resting_heart_rate": stats.get("restingHeartRate"),
        "min_heart_rate": stats.get("minHeartRate"),
        "max_heart_rate": stats.get("maxHeartRate"),
        "last_seven_days_avg_rhr": stats.get("lastSevenDaysAvgRestingHeartRate"),
        "avg_stress_level": stats.get("averageStressLevel"),
        "max_stress_level": stats.get("maxStressLevel"),
        "stress_duration_minutes": stats.get("stressDuration"),
        "rest_stress_duration_min": stats.get("restStressDuration"),
        "low_stress_duration_min": stats.get("lowStressDuration"),
        "medium_stress_duration_min": stats.get("mediumStressDuration"),
        "high_stress_duration_min": stats.get("highStressDuration"),
        "stress_qualifier": stats.get("stressQualifier"),
        "body_battery_charged": stats.get("bodyBatteryChargedValue"),
        "body_battery_drained": stats.get("bodyBatteryDrainedValue"),
        "body_battery_highest": stats.get("bodyBatteryHighestValue"),
        "body_battery_lowest": stats.get("bodyBatteryLowestValue"),
        "body_battery_most_recent": stats.get("bodyBatteryMostRecentValue"),
        "avg_spo2": stats.get("averageSpo2"),
        "lowest_spo2": stats.get("lowestSpo2"),
        "avg_waking_respiration": stats.get("avgWakingRespirationValue"),
        "highest_respiration": stats.get("highestRespirationValue"),
        "lowest_respiration": stats.get("lowestRespirationValue"),
        "moderate_intensity_minutes": stats.get("moderateIntensityMinutes"),
        "vigorous_intensity_minutes": stats.get("vigorousIntensityMinutes"),
        "intensity_minutes_goal": stats.get("intensityMinutesGoal"),
        "highly_active_seconds": stats.get("highlyActiveSeconds"),
        "active_seconds": stats.get("activeSeconds"),
        "sedentary_seconds": stats.get("sedentarySeconds"),
        "sleeping_seconds": stats.get("sleepingSeconds"),
        "abnormal_hr_count": stats.get("abnormalHeartRateAlertsCount"),
        "raw_json": json.dumps(stats),
    }

    return upsert_to_supabase(sb, "garmin_daily_summary", [row], "calendar_date,ts")


# ---------------------------------------------------------------------------
# Sync: Sleep
# ---------------------------------------------------------------------------

def sync_sleep(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of sleep data."""
    ds = target_date.isoformat()
    try:
        sleep = garmin.get_sleep_data(ds)
    except Exception as e:
        log.debug(f"  sleep {ds}: no data ({e})")
        return 0

    if not sleep or not sleep.get("dailySleepDTO"):
        return 0

    dto = sleep["dailySleepDTO"]
    sleep_id = dto.get("id", 0)
    # Skip placeholder rows where Garmin returned a DTO but no real sleep id.
    # The PK includes sleep_id, but Postgres treats NULLs as distinct in unique
    # constraints, so empty placeholders previously duplicated ~24×/day per
    # missing date (audit finding 5.A / 4.C).
    if not sleep_id:
        log.debug(f"  sleep {ds}: no sleep_id, skipping placeholder")
        return 0

    # Parse timestamps. Garmin returns *both* sleepStartTimestampGMT (true UTC epoch ms)
    # and sleepStartTimestampLocal (local-clock epoch ms — wall-clock value re-encoded as
    # if it were UTC). We must use the GMT field; the Local field decoded with tz=UTC
    # silently shifts every stored timestamp by Riley's TZ offset (~4-5h).
    sleep_start_gmt = dto.get("sleepStartTimestampGMT")
    sleep_end_gmt = dto.get("sleepEndTimestampGMT")
    if sleep_start_gmt is None or sleep_end_gmt is None:
        # Loud warning rather than silent fallback. The whole reason for this
        # fix is the Local field encodes local-as-UTC; a silent fallback would
        # silently re-introduce the bug audit finding 4.A described.
        log.warning(
            f"  sleep {ds}: Garmin response missing sleepStart/EndTimestampGMT "
            f"— falling back to *Local with TZ offset bug. Inspect dailySleepDTO keys."
        )
    sleep_start = sleep_start_gmt or dto.get("sleepStartTimestampLocal")
    sleep_end = sleep_end_gmt or dto.get("sleepEndTimestampLocal")

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "sleep_id": sleep_id,
        "sleep_start": datetime.fromtimestamp(sleep_start / 1000, tz=timezone.utc).isoformat() if sleep_start else None,
        "sleep_end": datetime.fromtimestamp(sleep_end / 1000, tz=timezone.utc).isoformat() if sleep_end else None,
        "sleep_duration_seconds": dto.get("sleepTimeSeconds"),
        "unmeasurable_seconds": dto.get("unmeasurableSleepSeconds"),
        "deep_sleep_seconds": dto.get("deepSleepSeconds"),
        "light_sleep_seconds": dto.get("lightSleepSeconds"),
        "rem_sleep_seconds": dto.get("remSleepSeconds"),
        "awake_seconds": dto.get("awakeSleepSeconds"),
        # sleepScores lives inside dailySleepDTO (dto), NOT at the top of the
        # response. Previous code read from `sleep` and got NULL on every row.
        "overall_sleep_score": safe_get(dto, "sleepScores", "overall", "value"),
        "quality_score": safe_get(dto, "sleepScores", "quality", "qualifierKey"),
        "duration_score": safe_get(dto, "sleepScores", "duration", "value"),
        "recovery_score": safe_get(dto, "sleepScores", "recovery", "value"),
        "rem_score": safe_get(dto, "sleepScores", "rem", "value"),
        "light_score": safe_get(dto, "sleepScores", "light", "value"),
        "deep_score": safe_get(dto, "sleepScores", "deep", "value"),
        "restlessness_score": safe_get(dto, "sleepScores", "restlessness", "value"),
        "avg_sleep_heart_rate": dto.get("averageHeartRate"),
        "avg_respiration_rate": dto.get("averageRespirationValue"),
        "avg_spo2": dto.get("averageSpO2Value"),
        "lowest_spo2": dto.get("lowestSpO2Value"),
        "avg_hrv": dto.get("hrvAverage"),
        "hrv_status": dto.get("hrvStatus"),
        "avg_sleep_stress": dto.get("averageStressLevel"),
        "sleep_need_seconds": dto.get("sleepNeedSeconds"),
        "sleep_debt_seconds": dto.get("sleepDebtSeconds"),
        "is_nap": False,
        "auto_detected": dto.get("autoSleepStartTimestampGMT") is not None,
        "sleep_result_type": dto.get("sleepResultType"),
        "raw_json": json.dumps(sleep),
    }

    return upsert_to_supabase(sb, "garmin_sleep", [row], "calendar_date,sleep_id,ts")


# ---------------------------------------------------------------------------
# Sync: Heart Rate
# ---------------------------------------------------------------------------

def sync_heart_rate(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of heart rate data."""
    ds = target_date.isoformat()
    try:
        hr = garmin.get_heart_rates(ds)
    except Exception as e:
        log.debug(f"  heart_rate {ds}: no data ({e})")
        return 0

    if not hr:
        return 0

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "resting_heart_rate": hr.get("restingHeartRate"),
        "min_heart_rate": hr.get("minHeartRate"),
        "max_heart_rate": hr.get("maxHeartRate"),
        "last_seven_days_avg_rhr": hr.get("lastSevenDaysAvgRestingHeartRate"),
        "raw_hr_values": json.dumps(hr.get("heartRateValues")),
    }

    return upsert_to_supabase(sb, "garmin_heart_rate", [row], "calendar_date,ts")


# ---------------------------------------------------------------------------
# Sync: HRV
# ---------------------------------------------------------------------------

def sync_hrv(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of HRV data."""
    ds = target_date.isoformat()
    try:
        hrv = garmin.get_hrv_data(ds)
    except Exception as e:
        log.debug(f"  hrv {ds}: no data ({e})")
        return 0

    if not hrv or not hrv.get("hrvSummary"):
        return 0

    summary = hrv["hrvSummary"]

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "weekly_avg_ms": summary.get("weeklyAvg"),
        "last_night_avg_ms": summary.get("lastNightAvg"),
        "last_night_5min_high_ms": summary.get("lastNight5MinHigh"),
        "baseline_low_upper_ms": summary.get("baselineLowUpper"),
        "baseline_balanced_low_ms": summary.get("baselineBalancedLow"),
        "baseline_balanced_upper_ms": summary.get("baselineBalancedUpper"),
        "baseline_marker_upper_ms": summary.get("baselineMarkerUpper"),
        "hrv_status": summary.get("status"),
        "start_timestamp": summary.get("startTimestampGMT"),
        "end_timestamp": summary.get("endTimestampGMT"),
        "create_timestamp": summary.get("createTimeStamp"),
        "raw_hrv_readings": json.dumps(hrv.get("hrvReadings")),
    }

    return upsert_to_supabase(sb, "garmin_hrv", [row], "calendar_date,ts")


# ---------------------------------------------------------------------------
# Sync: Stress
# ---------------------------------------------------------------------------

def sync_stress(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of stress data."""
    ds = target_date.isoformat()
    try:
        stress = garmin.get_stress_data(ds)
    except Exception as e:
        log.debug(f"  stress {ds}: no data ({e})")
        return 0

    if not stress:
        return 0

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "overall_stress_level": stress.get("overallStressLevel"),
        "rest_stress_duration_sec": stress.get("restStressDuration"),
        "low_stress_duration_sec": stress.get("lowStressDuration"),
        "medium_stress_duration_sec": stress.get("mediumStressDuration"),
        "high_stress_duration_sec": stress.get("highStressDuration"),
        "stress_qualifier": stress.get("stressQualifier"),
        "raw_stress_values": json.dumps(stress.get("stressValuesArray")),
    }

    return upsert_to_supabase(sb, "garmin_stress", [row], "calendar_date,ts")


# ---------------------------------------------------------------------------
# Sync: Training Status
# ---------------------------------------------------------------------------

def sync_training_status(garmin: Garmin, sb: Client, target_date: date) -> int:
    """Sync one day of training readiness/status data."""
    ds = target_date.isoformat()
    try:
        tr = garmin.get_training_readiness(ds)
    except Exception as e:
        log.debug(f"  training_status {ds}: no data ({e})")
        return 0

    if not tr:
        return 0

    # API may return a list; take the first element
    if isinstance(tr, list):
        if len(tr) == 0:
            return 0
        tr = tr[0]

    row = {
        "ts": date_to_ts(target_date),
        "calendar_date": ds,
        "training_readiness_score": tr.get("score"),
        "training_readiness_level": tr.get("level"),
        "sleep_score_factor": safe_get(tr, "sleepScoreFactor", "score"),
        "recovery_time_factor": safe_get(tr, "recoveryTimeFactor", "score"),
        "hrv_factor": safe_get(tr, "hrvFactor", "score"),
        "sleep_history_factor": safe_get(tr, "sleepHistoryFactor", "score"),
        "stress_history_factor": safe_get(tr, "stressHistoryFactor", "score"),
        "training_load_factor": safe_get(tr, "acuteTrainingLoadFactor", "score"),
        "raw_json": json.dumps(tr),
    }

    return upsert_to_supabase(sb, "garmin_training_status", [row], "calendar_date,ts")


# ---------------------------------------------------------------------------
# Sync: Workout Definitions (target paces from Workout Builder)
# ---------------------------------------------------------------------------

def _maybe_capture_segment(step: dict, iterations: int, out: list) -> None:
    """If step is a pace-targeted interval, append a segment dict to out."""
    step_key = safe_get(step, "stepType", "stepTypeKey")
    target_key = safe_get(step, "targetType", "workoutTargetTypeKey")
    if step_key != "interval" or not target_key or "pace" not in target_key:
        return
    cond_key = safe_get(step, "endCondition", "conditionTypeKey")
    cond_val = step.get("endConditionValue")
    out.append({
        "step_order":      step.get("stepOrder"),
        "step_id":         step.get("stepId"),
        "target_low_mps":  step.get("targetValueOne"),
        "target_high_mps": step.get("targetValueTwo"),
        "distance_meters": cond_val if cond_key == "distance" else None,
        "duration_seconds": cond_val if cond_key == "time"     else None,
        "iterations":      iterations,
    })


def parse_interval_targets(workout: dict) -> dict:
    """Extract every pace-targeted interval step from a workout definition.

    Walks the full segment tree (no first-match break) so workouts with
    multiple distinct pace targets — e.g. "1km TL + 12x400 VO2 + 1km TL" —
    capture each segment with its target band and iteration count.

    Returns:
      segment_targets: full list of pace-targeted interval steps, in plan order,
                       with parent-RepeatGroup iterations preserved per step.
      interval_target_pace_low_mps / _high_mps / _distance_meters /
      interval_count: backward-compat fields, populated from the FIRST segment.
    """
    segments: list[dict] = []
    for seg in workout.get("workoutSegments", []):
        for step in seg.get("workoutSteps", []):
            stype = step.get("type")
            if stype == "RepeatGroupDTO":
                iters = step.get("numberOfIterations") or 1
                for sub in step.get("workoutSteps", []):
                    _maybe_capture_segment(sub, iters, segments)
            elif stype == "ExecutableStepDTO":
                _maybe_capture_segment(step, 1, segments)

    result: dict = {
        "segment_targets": segments,
        "interval_target_pace_low_mps": None,
        "interval_target_pace_high_mps": None,
        "interval_distance_meters": None,
        "interval_count": None,
    }
    if segments:
        first = segments[0]
        result["interval_target_pace_low_mps"]  = first["target_low_mps"]
        result["interval_target_pace_high_mps"] = first["target_high_mps"]
        result["interval_distance_meters"]      = first.get("distance_meters")
        result["interval_count"]                = first.get("iterations") or 1
    return result


def sync_workout_definitions(garmin: Garmin, sb: Client, activity_workout_ids: list[str]) -> int:
    """Sync workout definitions for activities that have workoutIds."""
    if not activity_workout_ids:
        return 0

    # Deduplicate
    unique_ids = list(set(activity_workout_ids))
    total = 0

    for wid in unique_ids:
        try:
            workout = garmin.get_workout_by_id(int(wid))
        except Exception:
            log.debug(f"  workout {wid}: not found (likely deleted)")
            continue

        targets = parse_interval_targets(workout)
        row = {
            "workout_id": int(wid),
            "workout_name": workout.get("workoutName"),
            "sport_type": safe_get(workout, "sportType", "sportTypeKey"),
            "description": workout.get("description"),
            "interval_target_pace_low_mps": targets["interval_target_pace_low_mps"],
            "interval_target_pace_high_mps": targets["interval_target_pace_high_mps"],
            "interval_distance_meters": targets["interval_distance_meters"],
            "interval_count": targets["interval_count"],
            "segment_targets": json.dumps(targets["segment_targets"]) if targets["segment_targets"] else None,
            "raw_json": json.dumps(workout, default=str),
        }

        count = upsert_to_supabase(sb, "garmin_workouts", [row], "workout_id")
        total += count
        time.sleep(0.5)  # Rate limit

    log.info(f"  Workouts: {total} synced out of {len(unique_ids)} unique IDs")
    return total


# ---------------------------------------------------------------------------
# Sync: Activities + Laps
# ---------------------------------------------------------------------------

def sync_activities(garmin: Garmin, sb: Client, start_date: date, end_date: date) -> tuple[int, list[str]]:
    """Sync all activities in a date range, including laps.
    Returns (record_count, list_of_workout_ids)."""
    try:
        activities = garmin.get_activities_by_date(
            start_date.isoformat(), end_date.isoformat()
        )
    except Exception as e:
        log.warning(f"  activities {start_date} to {end_date}: error ({e})")
        return 0, []

    if not activities:
        return 0, []

    total = 0
    workout_ids = []

    for act in activities:
        activity_id = act.get("activityId")
        start_ts = act.get("startTimeGMT") or act.get("startTimeLocal")

        # Collect workout IDs for later sync
        wid = act.get("workoutId")
        if wid:
            workout_ids.append(str(wid))

        row = {
            "ts": start_ts,
            "activity_id": activity_id,
            "activity_type": safe_get(act, "activityType", "typeKey"),
            "activity_type_id": safe_get(act, "activityType", "typeId"),
            "activity_name": act.get("activityName"),
            "sport_type": safe_get(act, "activityType", "parentTypeId"),
            "start_time_local": act.get("startTimeLocal"),
            "start_time_gmt": act.get("startTimeGMT"),
            "duration_seconds": act.get("duration"),
            "elapsed_duration_seconds": act.get("elapsedDuration"),
            "moving_duration_seconds": act.get("movingDuration"),
            "distance_meters": act.get("distance"),
            "avg_speed_mps": act.get("averageSpeed"),
            "max_speed_mps": act.get("maxSpeed"),
            "avg_heart_rate": to_int(act.get("averageHR")),
            "max_heart_rate": to_int(act.get("maxHR")),
            "avg_running_cadence": to_int(act.get("averageRunningCadenceInStepsPerMinute")),
            "max_running_cadence": to_int(act.get("maxRunningCadenceInStepsPerMinute")),
            "elevation_gain_meters": to_int(act.get("elevationGain")),
            "elevation_loss_meters": to_int(act.get("elevationLoss")),
            "min_elevation_meters": to_int(act.get("minElevation")),
            "max_elevation_meters": to_int(act.get("maxElevation")),
            "calories": to_int(act.get("calories")),
            "aerobic_training_effect": act.get("aerobicTrainingEffect"),
            "anaerobic_training_effect": act.get("anaerobicTrainingEffect"),
            "training_effect_label": act.get("trainingEffectLabel"),
            "training_load": act.get("activityTrainingLoad"),
            "vo2_max": act.get("vO2MaxValue"),
            "avg_temperature_c": act.get("averageTemperature"),
            "max_temperature_c": act.get("maxTemperature"),
            "min_temperature_c": act.get("minTemperature"),
            "start_latitude": act.get("startLatitude"),
            "start_longitude": act.get("startLongitude"),
            "manual_activity": act.get("manual", False),
            "has_splits": act.get("hasSplits", False),
            "has_polyline": act.get("hasPolyline", False),
            "raw_json": json.dumps(act),
        }

        count = upsert_to_supabase(sb, "garmin_activities", [row], "activity_id,ts")
        total += count

        # Sync laps for this activity
        if act.get("hasSplits"):
            _sync_laps_for_activity(garmin, sb, activity_id, start_ts)

    return total, workout_ids


def _sync_laps_for_activity(garmin: Garmin, sb: Client, activity_id, start_ts) -> int:
    """Fetch and upsert laps for a single activity."""
    try:
        splits = garmin.get_activity_splits(activity_id)
        if splits and splits.get("lapDTOs"):
            lap_rows = []
            for i, lap in enumerate(splits["lapDTOs"]):
                lap_start = lap.get("startTimeGMT", start_ts)
                lap_rows.append({
                    "ts": lap_start,
                    "activity_id": activity_id,
                    "lap_index": i,
                    "start_time_gmt": lap_start,
                    "duration_seconds": lap.get("duration"),
                    "elapsed_duration_seconds": lap.get("elapsedDuration"),
                    "moving_duration_seconds": lap.get("movingDuration"),
                    "distance_meters": lap.get("distance"),
                    "avg_speed_mps": lap.get("averageSpeed"),
                    "max_speed_mps": lap.get("maxSpeed"),
                    "avg_heart_rate": to_int(lap.get("averageHR")),
                    "max_heart_rate": to_int(lap.get("maxHR")),
                    "avg_running_cadence": to_int(lap.get("averageRunCadence")),
                    "max_running_cadence": to_int(lap.get("maxRunCadence")),
                    "elevation_gain_meters": lap.get("elevationGain"),
                    "elevation_loss_meters": lap.get("elevationLoss"),
                    "start_elevation_meters": lap.get("startElevation"),
                    "end_elevation_meters": lap.get("endElevation"),
                    "calories": lap.get("calories"),
                    "start_latitude": lap.get("startLatitude"),
                    "start_longitude": lap.get("startLongitude"),
                    "end_latitude": lap.get("endLatitude"),
                    "end_longitude": lap.get("endLongitude"),
                    "lap_trigger": lap.get("lapTrigger"),
                    "intensity": lap.get("intensity"),
                    "raw_json": json.dumps(lap),
                })
            upsert_to_supabase(sb, "garmin_activity_laps", lap_rows,
                               "activity_id,lap_index,ts")
        time.sleep(0.5)
    except Exception as e:
        log.debug(f"  laps for activity {activity_id}: error ({e})")
    return 0


def backfill_laps(garmin: Garmin, sb: Client) -> int:
    """Backfill laps for all activities that have splits but no laps in DB."""
    # Get all activity IDs with splits
    result = (
        sb.schema("pds")
        .table("garmin_activities")
        .select("activity_id,start_time_gmt")
        .eq("has_splits", True)
        .order("start_time_local", desc=False)
        .execute()
    )
    all_activities = result.data or []

    # Get activity IDs that already have laps
    try:
        existing_result = (
            sb.schema("pds")
            .table("garmin_activity_laps")
            .select("activity_id")
            .execute()
        )
        existing_ids = set(r["activity_id"] for r in (existing_result.data or []))
    except Exception:
        existing_ids = set()

    missing = [a for a in all_activities if a["activity_id"] not in existing_ids]
    log.info(f"Backfilling laps: {len(missing)} activities missing laps out of {len(all_activities)} total")

    count = 0
    for i, act in enumerate(missing):
        _sync_laps_for_activity(garmin, sb, act["activity_id"], act["start_time_gmt"])
        count += 1
        if (i + 1) % 50 == 0:
            log.info(f"  Laps backfill progress: {i+1}/{len(missing)}")

    log.info(f"  Laps backfill complete: {count} activities processed")
    return count


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def sync_date(garmin: Garmin, sb: Client, target_date: date) -> dict:
    """Sync all data types for a single date. Returns counts per type."""
    syncs = {
        "daily_summary": sync_daily_summary,
        "sleep": sync_sleep,
        "heart_rate": sync_heart_rate,
        "hrv": sync_hrv,
        "stress": sync_stress,
        "training_status": sync_training_status,
    }
    counts = {}
    for name, func in syncs.items():
        try:
            counts[name] = func(garmin, sb, target_date)
        except Exception as e:
            log.warning(f"  {name} {target_date}: {e}")
            counts[name] = 0
    return counts


def main():
    parser = argparse.ArgumentParser(description="Garmin ETL — Supabase")
    parser.add_argument("--backfill", type=int, default=None,
                        help="Number of days to backfill (e.g., 730 for ~2 years)")
    parser.add_argument("--days", type=int, default=7,
                        help="Number of recent days to sync (default: 7)")
    parser.add_argument("--date", type=str, default=None,
                        help="Sync a specific date (YYYY-MM-DD)")
    parser.add_argument("--backfill-laps", action="store_true",
                        help="Backfill laps for all activities missing lap data")
    parser.add_argument("--sync-workouts", action="store_true",
                        help="Sync workout definitions for all activities with workout IDs")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — Garmin ETL")
    log.info("=" * 60)

    # Connect
    garmin = get_garmin_client()
    sb = get_supabase_client()

    # Handle standalone backfill-laps mode
    if args.backfill_laps:
        t0 = time.time()
        count = backfill_laps(garmin, sb)
        duration = time.time() - t0
        log.info(f"Lap backfill done: {count} activities | {duration:.1f}s")
        return

    # Handle standalone sync-workouts mode
    if args.sync_workouts:
        t0 = time.time()
        # Get all unique workout IDs from activities
        result = sb.schema("pds").from_("garmin_activities").select(
            "raw_json"
        ).neq("raw_json", "null").execute()
        workout_ids = []
        for row in (result.data or []):
            try:
                raw = json.loads(row["raw_json"]) if isinstance(row["raw_json"], str) else row["raw_json"]
                wid = raw.get("workoutId")
                if wid:
                    workout_ids.append(str(wid))
            except Exception:
                continue
        count = sync_workout_definitions(garmin, sb, workout_ids)
        duration = time.time() - t0
        log.info(f"Workout sync done: {count} definitions | {duration:.1f}s")
        return

    # Determine date range
    today = date.today()
    if args.date:
        dates = [date.fromisoformat(args.date)]
        log.info(f"Syncing single date: {args.date}")
    elif args.backfill:
        start = today - timedelta(days=args.backfill)
        dates = [start + timedelta(days=i) for i in range(args.backfill + 1)]
        log.info(f"Backfilling {len(dates)} days: {start} — {today}")
    else:
        start = today - timedelta(days=args.days)
        dates = [start + timedelta(days=i) for i in range(args.days + 1)]
        log.info(f"Syncing last {args.days} days: {start} — {today}")

    # Sync daily data types date by date
    t0 = time.time()
    total_records = 0
    errors = 0

    for i, d in enumerate(dates):
        try:
            counts = sync_date(garmin, sb, d)
            day_total = sum(counts.values())
            total_records += day_total
            if day_total > 0:
                log.info(f"  [{i+1}/{len(dates)}] {d}: {day_total} records synced")
            else:
                log.debug(f"  [{i+1}/{len(dates)}] {d}: no data")

            # Rate limit: 1 second between days to be gentle on Garmin API
            if i < len(dates) - 1:
                time.sleep(1)

        except Exception as e:
            errors += 1
            log.error(f"  [{i+1}/{len(dates)}] {d}: ERROR - {e}")
            time.sleep(2)  # Back off on errors

    # Sync activities separately (date range query is more efficient)
    log.info("Syncing activities...")
    act_start = dates[0]
    act_end = dates[-1]
    workout_ids = []
    try:
        act_count, workout_ids = sync_activities(garmin, sb, act_start, act_end)
        total_records += act_count
        log.info(f"  Activities: {act_count} synced ({act_start} — {act_end})")
    except Exception as e:
        errors += 1
        log.error(f"  Activities: ERROR - {e}")

    # Sync workout definitions for any activities with workout IDs
    if workout_ids:
        log.info("Syncing workout definitions...")
        try:
            sync_workout_definitions(garmin, sb, workout_ids)
        except Exception as e:
            log.warning(f"  Workout sync failed: {e}")

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.schema("pds").rpc("refresh_materialized_views").execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    # Log sync summary
    log_sync(sb, "garmin", "full_sync", "success" if errors == 0 else "partial",
             records=total_records, date_start=dates[0], date_end=dates[-1],
             duration=duration,
             error=f"{errors} date(s) failed" if errors else None)

    # Persist any refreshed tokens to disk (needed for CI token upload)
    # garth attribute removed in newer garminconnect versions; login(TOKEN_DIR) handles persistence
    if hasattr(garmin, 'garth'):
        garmin.garth.dump(TOKEN_DIR)

    log.info("=" * 60)
    log.info(f"Done! {total_records} total records | {errors} errors | {duration:.1f}s")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
