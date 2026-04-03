"""
Personal Data Scientist — MyFitnessPal ETL Pipeline
=====================================================
Syncs daily nutrition data from MyFitnessPal to Supabase (Postgres 17).

Uses the `python-myfitnesspal` library (session-cookie login with username/password).
No token persistence needed — authenticates fresh each run.

Usage:
    python myfitnesspal_etl.py                 # Sync last 7 days (daily run)
    python myfitnesspal_etl.py --backfill 365  # Backfill ~1 year
    python myfitnesspal_etl.py --date 2026-04-01

Requirements:
    pip install myfitnesspal supabase python-dotenv
"""

import os
import json
import time
import argparse
import logging
from datetime import date, timedelta

import myfitnesspal
from dotenv import load_dotenv
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MFP_USERNAME = os.environ["MFP_USERNAME"]
MFP_PASSWORD = os.environ["MFP_PASSWORD"]

CUPS_TO_ML = 236.588  # 1 US cup in mL

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("myfitnesspal_etl")


# ---------------------------------------------------------------------------
# Supabase helpers (identical pattern to eight_sleep_etl.py)
# ---------------------------------------------------------------------------

def get_supabase_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, duration: float = None):
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
                        conflict_columns: str) -> int:
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

def parse_meal(meal) -> dict | None:
    """Convert a myfitnesspal Meal object to a flat macro dict.

    MFP uses 'carbohydrates' as the key — mapped to 'carbs_g' here.
    Returns None if the meal has no logged entries.
    """
    totals = getattr(meal, "totals", {}) or {}
    if not totals or totals.get("calories", 0) == 0:
        return None
    return {
        "calories": totals.get("calories"),
        "protein_g": totals.get("protein"),
        "carbs_g": totals.get("carbohydrates"),
        "fat_g": totals.get("fat"),
        "fiber_g": totals.get("fiber"),
        "sugar_g": totals.get("sugar"),
        "sodium_mg": totals.get("sodium"),
    }


def fetch_day(client: myfitnesspal.Client, target_date: date) -> dict | None:
    """Fetch one day of nutrition data from MFP.

    Returns None if the user logged nothing that day (no entry created).
    Converts water from cups to mL.
    """
    try:
        day = client.get_date(target_date.year, target_date.month, target_date.day)
    except Exception as e:
        log.warning(f"  {target_date}: fetch failed — {e}")
        return None

    totals = getattr(day, "totals", {}) or {}

    # Skip days with no logged data at all
    if not totals or totals.get("calories", 0) == 0:
        log.debug(f"  {target_date}: no data logged, skipping")
        return None

    # Per-meal breakdown
    meals_data = {}
    for meal in getattr(day, "meals", []) or []:
        meal_name = getattr(meal, "name", "").lower()
        parsed = parse_meal(meal)
        if parsed is not None:
            meals_data[meal_name] = parsed

    # Water: MFP reports in cups; convert to mL
    water_cups = getattr(day, "water", None)
    water_ml = round(water_cups * CUPS_TO_ML, 1) if water_cups else None

    # Exercise calories burned (sum across all exercise entries)
    exercise_kcal = None
    for exercise_group in getattr(day, "exercises", []) or []:
        for exercise in getattr(exercise_group, "exercises", []) or []:
            burned = getattr(exercise, "calories_burned", None)
            if burned:
                exercise_kcal = (exercise_kcal or 0) + burned

    return {
        "calendar_date": target_date.isoformat(),
        "calories": totals.get("calories"),
        "protein_g": totals.get("protein"),
        "carbs_g": totals.get("carbohydrates"),
        "fat_g": totals.get("fat"),
        "fiber_g": totals.get("fiber"),
        "sugar_g": totals.get("sugar"),
        "sodium_mg": totals.get("sodium"),
        "water_ml": water_ml,
        "exercise_kcal": exercise_kcal,
        "meals_json": json.dumps(meals_data) if meals_data else None,
        "raw_json": json.dumps({
            "totals": totals,
            "meals": meals_data,
            "water_cups": water_cups,
            "exercise_kcal": exercise_kcal,
        }),
    }


def sync_range(mfp: myfitnesspal.Client, sb: Client,
               start_date: date, end_date: date) -> int:
    """Fetch every date in [start_date, end_date], upsert to Supabase.

    Returns count of rows upserted.
    """
    rows = []
    current = start_date
    total_days = (end_date - start_date).days + 1

    while current <= end_date:
        log.info(f"  Fetching {current}...")
        row = fetch_day(mfp, current)
        if row:
            rows.append(row)
        current += timedelta(days=1)
        if current <= end_date:
            time.sleep(0.5)  # be respectful of MFP's servers

    if not rows:
        log.info(f"  No logged data found in range ({total_days} days checked)")
        return 0

    log.info(f"  Upserting {len(rows)} rows to Supabase...")
    count = upsert_to_supabase(sb, "myfitnesspal_nutrition", rows, "calendar_date")
    return count


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="MyFitnessPal ETL — Supabase")
    parser.add_argument("--backfill", type=int, default=None,
                        help="Number of days to backfill (e.g., 365)")
    parser.add_argument("--days", type=int, default=7,
                        help="Number of recent days to sync (default: 7)")
    parser.add_argument("--date", type=str, default=None,
                        help="Sync a specific date (YYYY-MM-DD)")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — MyFitnessPal ETL")
    log.info("=" * 60)

    # Connect
    log.info("Authenticating with MyFitnessPal...")
    try:
        mfp = myfitnesspal.Client(MFP_USERNAME, password=MFP_PASSWORD)
    except Exception as e:
        log.error(f"MFP authentication failed: {e}")
        raise

    sb = get_supabase_client()

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
    errors = 0

    try:
        total_records = sync_range(mfp, sb, start, end)
    except Exception as e:
        errors += 1
        total_records = 0
        log.error(f"Sync failed: {e}", exc_info=True)

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.rpc("refresh_materialized_views", {}).execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    log_sync(sb, "myfitnesspal", "nutrition",
             "success" if errors == 0 else "partial",
             records=total_records, date_start=start, date_end=end,
             duration=duration,
             error=f"{errors} error(s)" if errors else None)

    log.info("=" * 60)
    log.info(f"Done! {total_records} records | {errors} errors | {duration:.1f}s")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
