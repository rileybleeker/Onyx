"""
GPS-based timezone inference for pds.user_tz_log
================================================
Per ADR-0001 Phase 4 step 4: scan pds.garmin_activities for GPS coordinates,
resolve each (lat, lon) to an IANA timezone, and INSERT new user_tz_log
rows wherever the inferred TZ disagrees with what pds.tz_for_instant
currently returns for that instant.

Closes the "WHOOP-offline travel" detection gap from the ADR's drastic-
TZ-abroad section (gap #1). When Riley travels but WHOOP doesn't capture
a cycle (strap battery dead, etc.), Garmin GPS activities still record
position and let us infer the trip TZ.

Usage:
    python gps_tz_backfill.py              # dry-run: print proposed inserts
    python gps_tz_backfill.py --apply      # actually insert the rows
    python gps_tz_backfill.py --since 2026-04-01 --apply  # bounded window

The script is idempotent — running it twice produces no duplicate rows.
A proposed insert is skipped if pds.tz_for_instant already returns the
inferred TZ for that instant (i.e., a manual or earlier auto entry
already covers it).

Dependencies: pip install timezonefinder supabase python-dotenv
"""

import os
import sys
import argparse
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client
from timezonefinder import TimezoneFinder

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# Single TimezoneFinder instance (lazy-loads ~50MB of polygon data).
tf = TimezoneFinder()

def fetch_gps_activities(since: str | None = None) -> list[dict]:
    """Return Garmin activities with GPS coordinates, sorted by start_time_gmt."""
    q = (supa.schema("pds")
            .from_("garmin_activities")
            .select("activity_id,start_time_gmt,start_latitude,start_longitude")
            .not_.is_("start_latitude", "null")
            .not_.is_("start_longitude", "null")
            .order("start_time_gmt", desc=False))
    if since:
        q = q.gte("start_time_gmt", since)
    rows: list[dict] = []
    offset = 0
    while True:
        page = q.range(offset, offset + 999).execute()
        if not page.data:
            break
        rows.extend(page.data)
        if len(page.data) < 1000:
            break
        offset += 1000
    return rows

def tz_for_instant_via_pg(ts_iso: str) -> str:
    """Query pds.tz_for_instant for the IANA TZ in effect at ts."""
    # Use RPC-style call; the function takes a TIMESTAMPTZ and returns TEXT.
    # supabase-py doesn't have a direct way to call a SQL function, so we
    # bounce it through a one-row query.
    res = (supa.schema("pds").rpc("tz_for_instant", {"ts": ts_iso}).execute())
    if res.data:
        return res.data
    return "America/New_York"

def infer_proposed_inserts(activities: list[dict]) -> list[dict]:
    """For each activity, infer IANA TZ from lat/lon. Yield rows where the
    inferred TZ differs from what user_tz_log currently resolves to.

    Collapses consecutive same-TZ proposals into one row (earliest instant).
    """
    proposals: list[dict] = []
    last_proposed_tz: str | None = None

    for act in activities:
        lat = float(act["start_latitude"])
        lon = float(act["start_longitude"])
        ts_iso = act["start_time_gmt"]
        inferred = tf.timezone_at(lat=lat, lng=lon)
        if not inferred:
            continue
        log_says = tz_for_instant_via_pg(ts_iso)
        if inferred == log_says:
            last_proposed_tz = inferred
            continue
        # Same-offset filter: only propose if the inferred TZ actually
        # produces a different UTC offset than the logged TZ at this
        # instant. Otherwise the IANA name is more specific but the
        # behavioral attribution is identical — pure noise. Common case:
        # Louisville (America/Kentucky/Louisville) and Toronto
        # (America/Toronto) share EDT/EST with NY.
        try:
            ts_aware = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
            off_inf = ts_aware.astimezone(ZoneInfo(inferred)).utcoffset()
            off_log = ts_aware.astimezone(ZoneInfo(log_says)).utcoffset()
            if off_inf == off_log:
                last_proposed_tz = inferred
                continue
        except Exception:
            pass
        # The log says one thing, GPS says another — propose a new entry.
        if inferred == last_proposed_tz:
            # We already proposed this TZ for the immediately-prior activity;
            # skip to avoid duplicates from a string of activities in the
            # same new zone.
            continue
        proposals.append({
            "effective_from": ts_iso,
            "tz": inferred,
            "notes": f"gps-auto: Garmin activity {act['activity_id']} @ ({lat:.4f},{lon:.4f}); log was {log_says}",
        })
        last_proposed_tz = inferred
    return proposals

def apply_proposals(proposals: list[dict]) -> int:
    if not proposals:
        return 0
    # Use insert (not upsert) — PK is effective_from; collision means we
    # already have a manual entry at that instant. Skip those.
    inserted = 0
    for p in proposals:
        try:
            supa.schema("pds").from_("user_tz_log").insert(p).execute()
            inserted += 1
        except Exception as e:
            log.warning(f"  Skipped {p['effective_from']} ({p['tz']}): {e}")
    return inserted

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Actually INSERT the proposed rows (default: dry-run)")
    parser.add_argument("--since", type=str, default=None,
                        help="Only consider activities since this ISO date (default: all history)")
    args = parser.parse_args()

    log.info("Loading GPS activities…")
    activities = fetch_gps_activities(since=args.since)
    log.info(f"  {len(activities)} activities with GPS coordinates")

    log.info("Inferring TZ per activity + comparing against user_tz_log…")
    proposals = infer_proposed_inserts(activities)
    log.info(f"  {len(proposals)} proposed user_tz_log entries")

    if not proposals:
        log.info("Nothing to insert. user_tz_log already covers every GPS-inferred TZ.")
        return 0

    print()
    print("PROPOSED INSERTS:")
    for p in proposals:
        print(f"  {p['effective_from']}  ->  {p['tz']:24s}  ({p['notes']})")
    print()

    if not args.apply:
        log.info("Dry-run complete. Re-run with --apply to insert.")
        return 0

    log.info("Applying inserts…")
    n = apply_proposals(proposals)
    log.info(f"  Inserted {n} of {len(proposals)} proposed rows.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
