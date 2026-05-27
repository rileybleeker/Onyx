"""
Personal Data Scientist — WHOOP Journal Folder Watcher
======================================================
Watches ~/Onyx/journal_inbox/ for new CSV files, auto-imports them
into Supabase, then moves them to ~/Onyx/journal_archive/.

Usage:
    python whoop_journal_watcher.py              # Watch (polls every 10s)
    python whoop_journal_watcher.py --once       # Process inbox once and exit
    python whoop_journal_watcher.py --interval 5 # Poll every 5 seconds

Workflow:
    1. Export WHOOP data (app → Data Export → email → download ZIP)
    2. Extract journal_entries.csv into ~/Onyx/journal_inbox/
    3. This script auto-imports it and moves it to journal_archive/

No extra dependencies — uses only stdlib + whoop_journal_import.py.
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
log = logging.getLogger("whoop_journal_watcher")

# Resolve paths relative to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(SCRIPT_DIR, "journal_inbox")
ARCHIVE = os.path.join(SCRIPT_DIR, "journal_archive")

# Import the journal importer
sys.path.insert(0, SCRIPT_DIR)
from whoop_journal_import import import_journal

def ensure_dirs():
    """Create inbox/archive folders if they don't exist."""
    os.makedirs(INBOX, exist_ok=True)
    os.makedirs(ARCHIVE, exist_ok=True)

def get_csv_files() -> list[str]:
    """Find all CSV files in the inbox folder."""
    return sorted(glob.glob(os.path.join(INBOX, "*.csv")))

def archive_file(csv_path: str):
    """Move a processed CSV to the archive folder with a timestamp."""
    basename = os.path.basename(csv_path)
    name, ext = os.path.splitext(basename)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_name = f"{name}_{timestamp}{ext}"
    dest = os.path.join(ARCHIVE, archive_name)
    shutil.move(csv_path, dest)
    log.info(f"Archived → {archive_name}")

def process_inbox() -> int:
    """Process all CSV files in the inbox. Returns count of files processed."""
    csv_files = get_csv_files()
    if not csv_files:
        return 0

    processed = 0
    for csv_path in csv_files:
        basename = os.path.basename(csv_path)
        log.info(f"Found: {basename}")

        # Wait briefly to make sure the file is fully written (copy in progress)
        size = -1
        for _ in range(5):
            new_size = os.path.getsize(csv_path)
            if new_size == size and size > 0:
                break
            size = new_size
            time.sleep(1)

        try:
            count = import_journal(csv_path)
            log.info(f"Imported {count} entries from {basename}")
            archive_file(csv_path)
            processed += 1
        except Exception as e:
            log.error(f"Failed to import {basename}: {e}")

    return processed

def watch(interval: int = 10):
    """Poll the inbox folder at a regular interval."""
    ensure_dirs()
    log.info("=" * 60)
    log.info("WHOOP Journal Watcher")
    log.info(f"  Inbox:   {INBOX}")
    log.info(f"  Archive: {ARCHIVE}")
    log.info(f"  Polling every {interval}s")
    log.info("=" * 60)
    log.info("Drop a WHOOP journal CSV into the inbox folder to import it.")
    log.info("Press Ctrl+C to stop.\n")

    try:
        while True:
            process_inbox()
            time.sleep(interval)
    except KeyboardInterrupt:
        log.info("\nStopped.")

def main():
    parser = argparse.ArgumentParser(description="WHOOP Journal Folder Watcher")
    parser.add_argument("--once", action="store_true",
                        help="Process inbox once and exit (no watching)")
    parser.add_argument("--interval", type=int, default=10,
                        help="Polling interval in seconds (default: 10)")
    args = parser.parse_args()

    ensure_dirs()

    if args.once:
        count = process_inbox()
        if count == 0:
            log.info("No CSV files found in inbox.")
    else:
        watch(interval=args.interval)

if __name__ == "__main__":
    main()
