#!/usr/bin/env python3
"""
Onyx HRV Backfill Detection
============================
Scans health-data tables for historical rows (calendar date older than the
rolling "recent" window) that have been written or updated since the last
hrv_analysis.py run. Emits a GitHub Actions output flag so the companion
workflow can conditionally trigger a full analysis retrain.

Runs hourly via .github/workflows/hrv-retrain-on-backfill.yml.
"""

import logging
import os
import sys
from datetime import date, timedelta

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hrv_backfill_check")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

# Calendar dates older than (today - HISTORICAL_DAYS) are considered
# "historical" — writes to recent days are expected from the hourly ETL
# and should not count as backfill.
HISTORICAL_DAYS = 2

TABLES_TO_CHECK = [
    # (table, date_col, sync_col)
    ("whoop_journal", "cycle_date", "synced_at"),
    ("habit_journal", "cycle_date", "synced_at"),
    ("myfitnesspal_nutrition", "calendar_date", "synced_at"),
    ("garmin_daily_summary", "calendar_date", "synced_at"),
    ("eight_sleep_trends", "calendar_date", "synced_at"),
    ("whoop_cycles", "start_time", "updated_at"),
]


def get_last_analysis_time() -> str | None:
    resp = (
        supa.schema("pds")
        .from_("hrv_analysis_results")
        .select("computed_at")
        .order("computed_at", desc=True)
        .limit(1)
        .execute()
    )
    if not resp.data:
        return None
    return resp.data[0]["computed_at"]


def has_backfilled_rows(table: str, date_col: str, sync_col: str,
                        last_analysis: str, historical_cutoff: str) -> bool:
    try:
        resp = (
            supa.schema("pds")
            .from_(table)
            .select(date_col)
            .gt(sync_col, last_analysis)
            .lt(date_col, historical_cutoff)
            .limit(1)
            .execute()
        )
        return bool(resp.data)
    except Exception as e:
        log.warning(f"  {table}: check failed ({e}) — treating as no backfill")
        return False


def set_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if out_path:
        with open(out_path, "a") as f:
            f.write(f"{key}={value}\n")
    log.info(f"output: {key}={value}")


def main() -> int:
    last_analysis = get_last_analysis_time()
    if last_analysis is None:
        log.info("No prior hrv_analysis_results found — signaling initial run.")
        set_output("backfill_detected", "true")
        return 0

    historical_cutoff = (date.today() - timedelta(days=HISTORICAL_DAYS)).isoformat()
    log.info(f"Last analysis: {last_analysis}")
    log.info(f"Historical cutoff: date < {historical_cutoff}")

    detected = False
    for table, date_col, sync_col in TABLES_TO_CHECK:
        if has_backfilled_rows(table, date_col, sync_col, last_analysis, historical_cutoff):
            log.info(f"  {table}: backfilled rows present")
            detected = True
        else:
            log.info(f"  {table}: no backfill")

    set_output("backfill_detected", "true" if detected else "false")
    if detected:
        log.info("Backfill detected — signaling retrain.")
    else:
        log.info("No backfill detected — skipping retrain.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
