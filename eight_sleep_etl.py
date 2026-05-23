"""
Personal Data Scientist — Eight Sleep ETL Pipeline
====================================================
Syncs Eight Sleep trend/sleep data to Supabase (Postgres 17).

Usage:
    python eight_sleep_etl.py                    # Sync last 7 days (daily run)
    python eight_sleep_etl.py --backfill 730     # Backfill ~2 years of history
    python eight_sleep_etl.py --backfill 30      # Backfill last 30 days
    python eight_sleep_etl.py --date 2025-06-15  # Sync a specific date

Requirements:
    pip install httpx supabase python-dotenv
"""

import os
import json
import time
import argparse
import logging
from datetime import date, datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EIGHTSLEEP_EMAIL = os.environ["EIGHTSLEEP_EMAIL"]
EIGHTSLEEP_PASSWORD = os.environ["EIGHTSLEEP_PASSWORD"]
EIGHTSLEEP_TIMEZONE = os.environ.get("EIGHTSLEEP_TIMEZONE", "America/New_York")

AUTH_URL = "https://auth-api.8slp.net/v1/tokens"
CLIENT_API_URL = "https://client-api.8slp.net/v1"
APP_API_URL = "https://app-api.8slp.net"
CLIENT_ID = os.environ.get("EIGHTSLEEP_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("EIGHTSLEEP_CLIENT_SECRET", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("eight_sleep_etl")


# ---------------------------------------------------------------------------
# Eight Sleep API Client (OAuth2)
# ---------------------------------------------------------------------------

class EightSleepClient:
    """Minimal Eight Sleep API client using OAuth2 password grant."""

    def __init__(self, email: str, password: str, tz: str):
        self.email = email
        self.password = password
        self.timezone = tz
        self.token: str | None = None
        self.user_id: str | None = None
        self.http = httpx.Client(timeout=30)

    def authenticate(self):
        """Obtain bearer token via OAuth2 password grant."""
        resp = self.http.post(AUTH_URL, json={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "password",
            "username": self.email,
            "password": self.password,
        })
        resp.raise_for_status()
        data = resp.json()
        self.token = data["access_token"]
        self.user_id = data["userId"]
        log.info(f"Eight Sleep: authenticated (user_id={self.user_id})")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def get_me(self) -> dict:
        """Get current user profile to discover device & bed sides."""
        resp = self.http.get(
            f"{CLIENT_API_URL}/users/me", headers=self._headers()
        )
        resp.raise_for_status()
        return resp.json()

    def get_device(self, device_id: str) -> dict:
        """Get device info."""
        resp = self.http.get(
            f"{CLIENT_API_URL}/devices/{device_id}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    def get_trends(self, user_id: str, start: str, end: str) -> list[dict]:
        """Fetch trend data for a date range. Returns list of day dicts."""
        resp = self.http.get(
            f"{CLIENT_API_URL}/users/{user_id}/trends",
            headers=self._headers(),
            params={
                "tz": self.timezone,
                "from": start,
                "to": end,
                "include-main": "false",
                "include-all-sessions": "true",
                "model-version": "v2",
            },
        )
        resp.raise_for_status()
        return resp.json().get("days", [])

    def get_intervals(self, user_id: str) -> list[dict]:
        """Fetch all available interval/session data."""
        resp = self.http.get(
            f"{CLIENT_API_URL}/users/{user_id}/intervals",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json().get("intervals", [])

    def close(self):
        self.http.close()


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dicts."""
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            return default
    return current


def avg_timeseries(timeseries: list | None) -> float | None:
    """Compute average from a list of [timestamp, value] pairs."""
    if not timeseries:
        return None
    total = sum(entry[1] for entry in timeseries)
    return round(total / len(timeseries), 2)


def sum_timeseries(timeseries: list | None) -> int | None:
    """Compute sum from a list of [timestamp, value] pairs."""
    if not timeseries:
        return None
    return int(sum(entry[1] for entry in timeseries))


def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, duration: float = None):
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
    if not rows:
        return 0
    result = (
        sb.schema("pds")
        .table(table)
        .upsert(rows, on_conflict=conflict_columns)
        .execute()
    )
    return len(result.data) if result.data else 0


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def parse_trend_day(day: dict, bed_side: str) -> dict | None:
    """Parse a trend day dict into a database row.

    The v2 trends API includes scores AND biometric averages in
    sleepQualityScore / sleepRoutineScore / sleepFitnessScore.
    """
    day_str = day.get("day")
    if not day_str:
        return None

    if day.get("processing"):
        return None

    # Eight Sleep's day-level payload is internally inconsistent on multi-session
    # days (main sleep + nap): top-level `sleepDuration` reports only the main
    # session, but top-level `deepDuration` / `lightDuration` / `remDuration` sum
    # across all sessions. Computing `awake = presenceDuration - sleepDuration`
    # therefore understated awake on nap days, while stage totals overstated
    # time-in-bed. Sum the per-session `stageSummary` fields instead — those are
    # internally consistent per session, and summing gives correct day totals.
    sessions = day.get("sessions") or []
    main_session_id = day.get("mainSessionId")
    stage_sums = {"sleepDuration": 0, "awakeDuration": 0, "lightDuration": 0,
                  "deepDuration": 0, "remDuration": 0}
    main_session_sums = {"sleepDuration": None, "awakeDuration": None,
                          "lightDuration": None, "deepDuration": None,
                          "remDuration": None}
    have_session_summaries = False
    for s in sessions:
        summary = s.get("stageSummary") or {}
        if not summary:
            continue
        have_session_summaries = True
        for k in stage_sums:
            v = summary.get(k)
            if v is not None:
                stage_sums[k] += v
        # Capture the main session separately for cross-device comparisons.
        # WHOOP filters is_nap=false (main-only), so for Bland-Altman / HRV
        # joins we need the symmetric Eight Sleep main-only value.
        if main_session_id and s.get("id") == main_session_id:
            for k in main_session_sums:
                main_session_sums[k] = summary.get(k)

    if have_session_summaries:
        sleep_duration = stage_sums["sleepDuration"]
        awake_seconds  = stage_sums["awakeDuration"]
        light_seconds  = stage_sums["lightDuration"]
        deep_seconds   = stage_sums["deepDuration"]
        rem_seconds    = stage_sums["remDuration"]
    else:
        # Fallback for older payloads without per-session stageSummary blocks.
        presence_duration = day.get("presenceDuration")
        sleep_duration = day.get("sleepDuration")
        awake_seconds = None
        if presence_duration is not None and sleep_duration is not None:
            awake_seconds = presence_duration - sleep_duration
        light_seconds = day.get("lightDuration")
        deep_seconds  = day.get("deepDuration")
        rem_seconds   = day.get("remDuration")

    # Sleep-onset latency: in-bed (presenceStart) → first sleep (sleepStart).
    # The v2 trends payload exposes a latencyAsleepSeconds.score (0-100) but
    # not the raw seconds, so we derive it from the timestamps.
    latency_asleep_seconds = None
    presence_start = day.get("presenceStart")
    sleep_start = day.get("sleepStart")
    if presence_start and sleep_start:
        try:
            ps = datetime.fromisoformat(presence_start.replace("Z", "+00:00"))
            ss = datetime.fromisoformat(sleep_start.replace("Z", "+00:00"))
            diff = int((ss - ps).total_seconds())
            if diff >= 0:
                latency_asleep_seconds = diff
        except (ValueError, TypeError):
            pass

    quality = day.get("sleepQualityScore", {}) or {}
    routine = day.get("sleepRoutineScore", {}) or {}
    fitness = day.get("sleepFitnessScore", {}) or {}

    return {
        "calendar_date": day_str,
        "bed_side": bed_side,
        # Scores
        "sleep_score": day.get("score"),
        "sleep_fitness_score": fitness.get("total"),
        "sleep_quality_score": quality.get("total"),
        "sleep_duration_score": safe_get(quality, "sleepDurationSeconds", "score"),
        "latency_asleep_score": safe_get(routine, "latencyAsleepSeconds", "score"),
        "latency_out_score": safe_get(routine, "latencyOutSeconds", "score"),
        "wakeup_consistency_score": safe_get(routine, "wakeupConsistency", "score"),
        "sleep_routine_score": routine.get("total"),
        # Biometrics (v2 trends include these in sleepQualityScore)
        "avg_heart_rate": safe_get(quality, "heartRate", "average"),
        "avg_hrv": safe_get(quality, "hrv", "current"),
        "avg_breath_rate": safe_get(quality, "respiratoryRate", "current"),
        "avg_resp_rate": safe_get(quality, "respiratoryRate", "average"),
        # Environment
        "avg_bed_temp": safe_get(quality, "tempBedC", "average"),
        "avg_room_temp": safe_get(quality, "tempRoomC", "average"),
        # Sleep stages (seconds) — summed across all sessions per stageSummary
        # so multi-session days (main + nap) are internally consistent.
        "time_slept_seconds": sleep_duration,
        "awake_seconds": awake_seconds,
        "light_sleep_seconds": light_seconds,
        "deep_sleep_seconds": deep_seconds,
        "rem_sleep_seconds": rem_seconds,
        # Main-session-only stages (seconds) — isolated for cross-device
        # comparisons against WHOOP, which filters is_nap=false. Use these
        # (not the totals above) for Bland-Altman / HRV pipeline joins so the
        # comparison is apples-to-apples.
        "time_slept_main_session_seconds":  main_session_sums["sleepDuration"],
        "awake_main_session_seconds":       main_session_sums["awakeDuration"],
        "light_sleep_main_session_seconds": main_session_sums["lightDuration"],
        "deep_sleep_main_session_seconds":  main_session_sums["deepDuration"],
        "rem_sleep_main_session_seconds":   main_session_sums["remDuration"],
        # Other
        "toss_and_turns": day.get("tnt"),
        "latency_asleep_seconds": latency_asleep_seconds,
        # Snoring (Pod's microphone-based detection; cleanest signal is
        # duration — percent / event fields are sparse and inconsistent)
        "snore_duration_seconds": day.get("snoreDuration"),
        "heavy_snore_duration_seconds": day.get("heavySnoreDuration"),
        "session_date": day_str,
    }


def parse_interval(interval: dict, bed_side: str) -> dict | None:
    """Parse an interval dict for biometric data (fallback for older data)."""
    ts_str = interval.get("ts")
    if not ts_str:
        return None

    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        try:
            dt = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, TypeError):
            return None

    calendar_date = dt.date().isoformat()
    ts = interval.get("timeseries", {}) or {}

    stages = interval.get("stages", [])
    stage_totals = {}
    for stage in (stages or []):
        stage_name = stage.get("stage")
        dur = stage.get("duration", 0)
        if stage_name and stage_name != "out":
            stage_totals[stage_name] = stage_totals.get(stage_name, 0) + dur

    return {
        "calendar_date": calendar_date,
        "bed_side": bed_side,
        "avg_heart_rate": avg_timeseries(ts.get("heartRate")),
        "avg_breath_rate": avg_timeseries(ts.get("respiratoryRate")),
        "avg_resp_rate": avg_timeseries(ts.get("respiratoryRate")),
        "avg_bed_temp": avg_timeseries(ts.get("tempBedC")),
        "avg_room_temp": avg_timeseries(ts.get("tempRoomC")),
        "toss_and_turns": sum_timeseries(ts.get("tnt")),
        "light_sleep_seconds": stage_totals.get("light"),
        "deep_sleep_seconds": stage_totals.get("deep"),
        "rem_sleep_seconds": stage_totals.get("rem"),
        "awake_seconds": stage_totals.get("awake"),
    }


def _strip_timeseries(data: dict) -> dict:
    """Return a copy with bulky timeseries arrays removed."""
    stripped = {}
    for k, v in data.items():
        if k == "timeseries":
            continue
        elif k == "sessions" and isinstance(v, list):
            sessions = []
            for s in v:
                if isinstance(s, dict):
                    sessions.append({sk: sv for sk, sv in s.items()
                                     if sk != "timeseries"})
            stripped[k] = sessions
        else:
            stripped[k] = v
    return stripped


# ---------------------------------------------------------------------------
# Sync logic
# ---------------------------------------------------------------------------

def sync_user(client: EightSleepClient, sb: Client, user_id: str,
              bed_side: str, start_date: date, end_date: date) -> int:
    """Sync trend + interval data for one user/bed side."""

    # 1. Fetch intervals (all available)
    log.info(f"  [{bed_side}] Fetching intervals...")
    try:
        intervals = client.get_intervals(user_id)
        log.info(f"  [{bed_side}] Got {len(intervals)} total intervals")
    except Exception as e:
        log.warning(f"  [{bed_side}] Intervals fetch failed: {e}")
        intervals = []

    interval_by_date: dict[str, dict] = {}
    for interval in intervals:
        parsed = parse_interval(interval, bed_side)
        if parsed:
            interval_by_date[parsed["calendar_date"]] = parsed

    # 2. Fetch trends in 30-day chunks (v2 API includes biometrics)
    log.info(f"  [{bed_side}] Fetching trends...")
    chunk_size = 30
    trend_by_date: dict[str, dict] = {}
    raw_by_date: dict[str, dict] = {}

    current = start_date
    while current <= end_date:
        chunk_end = min(current + timedelta(days=chunk_size - 1), end_date)
        start_str = current.isoformat()
        end_str = chunk_end.isoformat()

        try:
            days = client.get_trends(user_id, start_str, end_str)
            for day in days:
                parsed = parse_trend_day(day, bed_side)
                if parsed:
                    trend_by_date[parsed["calendar_date"]] = parsed
                    raw_by_date[parsed["calendar_date"]] = day
        except Exception as e:
            log.error(f"  [{bed_side}] Trends {start_str} → {end_str}: {e}")

        current = chunk_end + timedelta(days=1)
        time.sleep(0.5)

    # 3. Merge: trend data is primary, interval fills gaps
    all_dates = set(trend_by_date.keys()) | set(
        d for d in interval_by_date.keys()
        if start_date.isoformat() <= d <= end_date.isoformat()
    )

    rows = []
    for d in sorted(all_dates):
        trend = trend_by_date.get(d, {})
        interval = interval_by_date.get(d, {})
        raw = raw_by_date.get(d)

        row = {
            "calendar_date": d,
            "bed_side": bed_side,
            # Scores (trends only)
            "sleep_score": trend.get("sleep_score"),
            "sleep_fitness_score": trend.get("sleep_fitness_score"),
            "sleep_quality_score": trend.get("sleep_quality_score"),
            "sleep_duration_score": trend.get("sleep_duration_score"),
            "latency_asleep_score": trend.get("latency_asleep_score"),
            "latency_out_score": trend.get("latency_out_score"),
            "wakeup_consistency_score": trend.get("wakeup_consistency_score"),
            "sleep_routine_score": trend.get("sleep_routine_score"),
            # Biometrics — prefer trend (v2), fall back to interval
            "avg_heart_rate": trend.get("avg_heart_rate") or interval.get("avg_heart_rate"),
            "avg_hrv": trend.get("avg_hrv"),
            "avg_breath_rate": trend.get("avg_breath_rate") or interval.get("avg_breath_rate"),
            "avg_resp_rate": trend.get("avg_resp_rate") or interval.get("avg_resp_rate"),
            # Environment
            "avg_bed_temp": trend.get("avg_bed_temp") or interval.get("avg_bed_temp"),
            "avg_room_temp": trend.get("avg_room_temp") or interval.get("avg_room_temp"),
            # Sleep stages — prefer trend, fall back to interval
            "time_slept_seconds": trend.get("time_slept_seconds"),
            "awake_seconds": trend.get("awake_seconds") or interval.get("awake_seconds"),
            "light_sleep_seconds": trend.get("light_sleep_seconds") or interval.get("light_sleep_seconds"),
            "deep_sleep_seconds": trend.get("deep_sleep_seconds") or interval.get("deep_sleep_seconds"),
            "rem_sleep_seconds": trend.get("rem_sleep_seconds") or interval.get("rem_sleep_seconds"),
            # Other
            "toss_and_turns": trend.get("toss_and_turns") or interval.get("toss_and_turns"),
            "latency_asleep_seconds": trend.get("latency_asleep_seconds"),
            # Snoring (trends-only — intervals API doesn't expose these)
            "snore_duration_seconds": trend.get("snore_duration_seconds"),
            "heavy_snore_duration_seconds": trend.get("heavy_snore_duration_seconds"),
            "session_date": d,
            "raw_json": json.dumps(_strip_timeseries(raw)) if raw else None,
        }
        rows.append(row)

    if rows:
        count = upsert_to_supabase(
            sb, "eight_sleep_trends", rows, "calendar_date,bed_side"
        )
        log.info(f"  [{bed_side}] Upserted {count} records "
                 f"({start_date} → {end_date})")
        return count

    log.info(f"  [{bed_side}] No data found")
    return 0


# ---------------------------------------------------------------------------
# Discover bed sides
# ---------------------------------------------------------------------------

def discover_users(client: EightSleepClient) -> dict[str, str]:
    """Return {bed_side: user_id} for all users on the device."""
    me = client.get_me()
    user_obj = me.get("user", me)
    current_device = user_obj.get("currentDevice", {})
    device_id = current_device.get("id")

    if not device_id:
        # Fallback: just use the authenticated user
        side = current_device.get("side", "left")
        log.info(f"Single user detected on '{side}' side")
        return {side: client.user_id}

    device = client.get_device(device_id)
    result = device.get("result", device)

    users = {}
    left_id = result.get("leftUserId")
    right_id = result.get("rightUserId")

    if left_id:
        users["left"] = left_id
    if right_id:
        users["right"] = right_id

    if not users:
        side = current_device.get("side", "left")
        users[side] = client.user_id

    log.info(f"Discovered bed sides: {list(users.keys())}")
    return users


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Eight Sleep ETL — Supabase")
    parser.add_argument("--backfill", type=int, default=None,
                        help="Number of days to backfill (e.g., 730 for ~2 years)")
    parser.add_argument("--days", type=int, default=7,
                        help="Number of recent days to sync (default: 7)")
    parser.add_argument("--date", type=str, default=None,
                        help="Sync a specific date (YYYY-MM-DD)")
    parser.add_argument("--side", type=str, default=None,
                        choices=["left", "right"],
                        help="Sync only one bed side (default: both)")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — Eight Sleep ETL")
    log.info("=" * 60)

    # Connect
    client = EightSleepClient(EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD,
                               EIGHTSLEEP_TIMEZONE)
    client.authenticate()
    sb = get_supabase_client()

    # Discover bed sides
    all_users = discover_users(client)
    if args.side:
        if args.side not in all_users:
            log.error(f"Side '{args.side}' not found. Available: {list(all_users.keys())}")
            return
        users = {args.side: all_users[args.side]}
    else:
        users = all_users

    # Determine date range
    today = date.today()
    if args.date:
        start = date.fromisoformat(args.date)
        end = start
        log.info(f"Syncing single date: {args.date}")
    elif args.backfill:
        start = today - timedelta(days=args.backfill)
        end = today
        log.info(f"Backfilling {args.backfill} days: {start} — {end}")
    else:
        start = today - timedelta(days=args.days)
        end = today
        log.info(f"Syncing last {args.days} days: {start} — {end}")

    # Sync
    t0 = time.time()
    total_records = 0
    errors = 0

    for side, user_id in users.items():
        try:
            count = sync_user(client, sb, user_id, side, start, end)
            total_records += count
        except Exception as e:
            errors += 1
            log.error(f"[{side}] Sync failed: {e}", exc_info=True)

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.rpc("refresh_materialized_views", {}).execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    log_sync(sb, "eight_sleep", "trends", "success" if errors == 0 else "partial",
             records=total_records, date_start=start, date_end=end,
             duration=duration,
             error=f"{errors} error(s)" if errors else None)

    log.info("=" * 60)
    log.info(f"Done! {total_records} total records | {errors} errors | {duration:.1f}s")
    log.info("=" * 60)

    client.close()


if __name__ == "__main__":
    main()
