"""
Onyx — Cronometer Export Folder Watcher
=======================================
Watches ~/Onyx/cronometer_inbox/ for Cronometer CSV/ZIP exports, auto-imports
them into Supabase (pds.cronometer_*), then moves them to ~/Onyx/cronometer_archive/.

Cronometer has no scheduled/emailed export and no official API (verified 2026-05-31),
so this local folder-watcher is the ingestion path (chosen over an IMAP cron). A
GitHub Actions runner can't see this local inbox, so there is no CI cron for
Cronometer — /status derives freshness from MAX(calendar_date) on
pds.cronometer_nutrition_daily plus the sync_log heartbeat this import writes.

Usage:
    python cronometer_watcher.py              # Watch (polls every 10s)
    python cronometer_watcher.py --once       # Process inbox once and exit
    python cronometer_watcher.py --interval 5 # Poll every 5 seconds

Workflow:
    1. Export from cronometer.com: More -> Account -> Account Data -> Export Data,
       pick a date range, export "Servings" and "Daily Nutrition Summary".
    2. Drop servings.csv + dailysummary.csv (or the whole export, or a zip) into
       ~/Onyx/cronometer_inbox/.
    3. This script imports them together (one run, so servings + daily stay in sync)
       and moves each file to cronometer_archive/.

No extra dependencies beyond cronometer_import.py.
"""

import os
import sys
import time
import shutil
import logging
import argparse
import glob
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("cronometer_watcher")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(SCRIPT_DIR, "cronometer_inbox")
ARCHIVE = os.path.join(SCRIPT_DIR, "cronometer_archive")

sys.path.insert(0, SCRIPT_DIR)
from cronometer_import import run_import
from sync_log_helper import log_sync, now_epoch

# Re-audit 2026-06-07 (etl/gemini/F-008): files whose import raises are moved here
# instead of being left in the inbox to be retried (and re-fail) on every poll.
ERROR_DIR = os.path.join(SCRIPT_DIR, "cronometer_error")


def get_supabase():
    """Create a Supabase client for sync_log heartbeats, or None if unconfigured."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client
        return create_client(url, key)
    except Exception as e:  # noqa: BLE001
        log.warning(f"Could not create Supabase client for heartbeat: {e}")
        return None


def ensure_dirs():
    os.makedirs(INBOX, exist_ok=True)
    os.makedirs(ARCHIVE, exist_ok=True)
    os.makedirs(ERROR_DIR, exist_ok=True)


def get_inbox_files() -> list[str]:
    """All Cronometer export files currently in the inbox (CSV + ZIP)."""
    files = glob.glob(os.path.join(INBOX, "*.csv")) + glob.glob(os.path.join(INBOX, "*.zip"))
    return sorted(files)


def _wait_until_stable(path: str):
    """Avoid importing a file mid-copy: wait until its size stops changing."""
    size = -1
    for _ in range(5):
        new_size = os.path.getsize(path)
        if new_size == size and size > 0:
            return
        size = new_size
        time.sleep(1)


def archive_file(path: str):
    basename = os.path.basename(path)
    name, ext = os.path.splitext(basename)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(ARCHIVE, f"{name}_{timestamp}{ext}")
    shutil.move(path, dest)
    log.info(f"Archived -> {os.path.basename(dest)}")


def error_file(path: str):
    """Move a file whose import failed into the error/ subdir so it isn't retried forever."""
    basename = os.path.basename(path)
    name, ext = os.path.splitext(basename)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(ERROR_DIR, f"{name}_{timestamp}{ext}")
    shutil.move(path, dest)
    log.info(f"Moved to error/ -> {os.path.basename(dest)}")


def process_inbox() -> int:
    """Import ALL inbox files in a single run (servings + daily together). Returns files processed."""
    files = get_inbox_files()
    if not files:
        # Re-audit 2026-06-07 (etl/gpt-5/F-007): emit a heartbeat on an empty-inbox
        # poll so /status sees the local watcher is alive on quiet days (most polls
        # have no new export and that's healthy — mirrors the email-cron heartbeats).
        sb = get_supabase()
        if sb is not None:
            log_sync(sb, "cronometer", "watcher", "success", records=0, started_at=now_epoch())
        return 0

    for f in files:
        log.info(f"Found: {os.path.basename(f)}")
        _wait_until_stable(f)

    try:
        scount, dcount = run_import(files)
        log.info(f"Imported {scount} servings, {dcount} daily rows.")
    except SystemExit as e:
        # No recognizable Cronometer CSVs in the batch — move to error/ so they're
        # not re-scanned on every poll. Re-audit 2026-06-07 (etl/gemini/F-008).
        log.error(f"Nothing imported, moving file(s) to error/: {e}")
        for f in files:
            if os.path.exists(f):
                error_file(f)
        return 0
    except Exception as e:  # noqa: BLE001
        # Re-audit 2026-06-07 (etl/gemini/F-008): move failed file(s) to error/
        # instead of leaving them in the inbox to be retried (and re-fail) forever.
        log.error(f"Import failed, moving file(s) to error/: {e}")
        for f in files:
            if os.path.exists(f):
                error_file(f)
        return 0

    for f in files:
        if os.path.exists(f):
            archive_file(f)
    return len(files)


def watch(interval: int = 10):
    ensure_dirs()
    log.info("=" * 60)
    log.info("Cronometer Export Watcher")
    log.info(f"  Inbox:   {INBOX}")
    log.info(f"  Archive: {ARCHIVE}")
    log.info(f"  Polling every {interval}s")
    log.info("=" * 60)
    log.info("Drop Cronometer servings.csv + dailysummary.csv (or a zip) into the inbox.")
    log.info("Press Ctrl+C to stop.\n")
    try:
        while True:
            process_inbox()
            time.sleep(interval)
    except KeyboardInterrupt:
        log.info("\nStopped.")


def main():
    parser = argparse.ArgumentParser(description="Cronometer Export Folder Watcher")
    parser.add_argument("--once", action="store_true", help="Process inbox once and exit")
    parser.add_argument("--interval", type=int, default=10, help="Polling interval seconds (default 10)")
    args = parser.parse_args()

    ensure_dirs()
    if args.once:
        if process_inbox() == 0:
            log.info("No Cronometer files found in inbox.")
    else:
        watch(interval=args.interval)


if __name__ == "__main__":
    main()
