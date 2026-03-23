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
    pip install pyeight supabase python-dotenv
"""

import os
import sys
import json
import time
import asyncio
import argparse
import logging
from datetime import date, datetime, timedelta

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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("eight_sleep_etl")

# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

async def get_eight_sleep_client():
    """Authenticate with Eight Sleep via OAuth2."""
    from pyeight.eight import EightSleep

    eight = EightSleep(
        EIGHTSLEEP_EMAIL,
        EIGHTSLEEP_PASSWORD,
        EIGHTSLEEP_TIMEZONE,
    )
    await eight.start()
    await eight.update_device_data()
    await eight.update_user_data()
    log.info("Eight Sleep: connected and authenticated")
    return eight


def get_supabase_client() -> Client:
    """Create Supabase client with service role key."""
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


def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, duration: float = None):
    """Write a sync log entry to pds.sync_log."""
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
        }).execute()
    except Exception as e:
        log.warning(f"Failed to write sync log: {e}")


def upsert_to_supabase(sb: Client, table: str, rows: list[dict],
                        conflict_columns: str):
    """Upsert rows to a Supabase table in the pds schema."""
    if not rows:
        return 0
    result = (
        sb.schema("pds")
        .table(table)
        .upsert(rows, on_conflict=conflict_columns)
        .execute()
    )
    return len(result.data) if result.data else 0


def parse_trend_day(day: dict, bed_side: str) -> dict | None:
    """Parse a single trend day dict into a database row."""
    day_str = day.get("day")
    if not day_str:
        return None

    # Skip sessions still being processed
    if day.get("processing"):
        return None

    # Sleep stage durations (seconds)
    presence_duration = day.get("presenceDuration")
    sleep_duration = day.get("sleepDuration")
    awake_seconds = None
    if presence_duration is not None and sleep_duration is not None:
        awake_seconds = presence_duration - sleep_duration

    # Scores
    quality = day.get("sleepQualityScore", {}) or {}
    routine = day.get("sleepRoutineScore", {}) or {}
    fitness = day.get("sleepFitnessScore", {}) or {}

    row = {
        "calendar_date": day_str,
        "bed_side": bed_side,

        # Sleep scores
        "sleep_score": day.get("score"),
        "sleep_fitness_score": fitness.get("total"),
        "sleep_quality_score": quality.get("total"),
        "sleep_duration_score": safe_get(quality, "sleepDurationSeconds", "score"),
        "latency_asleep_score": safe_get(routine, "latencyAsleepSeconds", "score"),
        "latency_out_score": safe_get(routine, "latencyOutSeconds", "score"),
        "wakeup_consistency_score": safe_get(routine, "wakeupConsistency", "score"),
        "sleep_routine_score": routine.get("total"),

        # Biometrics
        "avg_heart_rate": safe_get(quality, "heartRate", "average"),
        "avg_hrv": safe_get(quality, "hrv", "current"),
        "avg_breath_rate": safe_get(quality, "respiratoryRate", "current"),
        "avg_resp_rate": safe_get(quality, "respiratoryRate", "average"),

        # Environment
        "avg_bed_temp": safe_get(quality, "tempBedC", "average"),
        "avg_room_temp": safe_get(quality, "tempRoomC", "average"),

        # Sleep stages (seconds)
        "time_slept_seconds": sleep_duration,
        "awake_seconds": awake_seconds,
        "light_sleep_seconds": day.get("lightDuration"),
        "deep_sleep_seconds": day.get("deepDuration"),
        "rem_sleep_seconds": day.get("remDuration"),

        # Other
        "toss_and_turns": day.get("tnt"),
        "session_date": day_str,

        # Raw JSON (exclude bulky timeseries to save space)
        "raw_json": json.dumps(_strip_timeseries(day)),
    }

    return row


def _strip_timeseries(day: dict) -> dict:
    """Return a copy of the trend day dict without bulky timeseries arrays."""
    stripped = {}
    for k, v in day.items():
        if k == "sessions":
            # Keep session metadata but drop timeseries
            sessions = []
            if isinstance(v, list):
                for s in v:
                    if isinstance(s, dict):
                        session_copy = {sk: sv for sk, sv in s.items()
                                        if sk != "timeseries"}
                        sessions.append(session_copy)
            stripped[k] = sessions
        else:
            stripped[k] = v
    return stripped


# ---------------------------------------------------------------------------
# Sync logic
# ---------------------------------------------------------------------------

async def sync_trends(eight, sb: Client, start_date: date, end_date: date,
                      bed_sides: list[str]) -> int:
    """Fetch trend data and upsert to Supabase.

    Fetches in 30-day chunks to avoid potential API limits.
    """
    total = 0
    chunk_size = 30

    for side_key in bed_sides:
        user = eight.users.get(side_key)
        if not user:
            log.warning(f"  No user found for bed side '{side_key}', skipping")
            continue

        log.info(f"Syncing trends for '{side_key}' side...")

        current = start_date
        while current <= end_date:
            chunk_end = min(current + timedelta(days=chunk_size - 1), end_date)
            start_str = current.isoformat()
            end_str = chunk_end.isoformat()

            try:
                await user.update_trend_data(start_str, end_str)
                trends = user.trends or []

                rows = []
                for day in trends:
                    row = parse_trend_day(day, side_key)
                    if row:
                        rows.append(row)

                if rows:
                    count = upsert_to_supabase(
                        sb, "eight_sleep_trends", rows,
                        "calendar_date,bed_side"
                    )
                    total += count
                    log.info(f"  {side_key} {start_str} → {end_str}: "
                             f"{count} records")
                else:
                    log.debug(f"  {side_key} {start_str} → {end_str}: no data")

            except Exception as e:
                log.error(f"  {side_key} {start_str} → {end_str}: ERROR - {e}")

            current = chunk_end + timedelta(days=1)
            # Rate limit between chunks
            await asyncio.sleep(1)

    return total


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def async_main():
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
    eight = await get_eight_sleep_client()
    sb = get_supabase_client()

    # Determine bed sides
    if args.side:
        bed_sides = [args.side]
    else:
        bed_sides = [k for k in eight.users.keys()]
        log.info(f"Detected bed sides: {bed_sides}")

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

    try:
        total_records = await sync_trends(eight, sb, start, end, bed_sides)
    except Exception as e:
        errors += 1
        log.error(f"Sync failed: {e}")

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.rpc("refresh_materialized_views", {}).execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    # Log sync summary
    log_sync(sb, "eight_sleep", "trends", "success" if errors == 0 else "partial",
             records=total_records, date_start=start, date_end=end,
             duration=duration,
             error=f"{errors} error(s)" if errors else None)

    log.info("=" * 60)
    log.info(f"Done! {total_records} total records | {errors} errors | {duration:.1f}s")
    log.info("=" * 60)

    # Clean up
    await eight.stop()


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
