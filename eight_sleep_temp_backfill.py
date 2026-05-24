"""One-off backfill: recover historical median_bed_temp and median_room_temp
for every pds.eight_sleep_trends row currently storing NULL temps.

Why this works: Eight Sleep's /intervals collection endpoint only returns the
10 most-recent sessions, but the per-ID endpoint /users/{uid}/intervals/{sid}
returns the full interval with timeseries for ANY session ID, including ones
months old. The trends payload (which we've been storing since the ETL began)
includes mainSessionId + sessionIds for every historical day — so we have a
lookup key for every session that ever existed.

For each multi-session day, we use mainSessionId (the main sleep session,
excluding naps), matching the existing parse_interval convention.

Usage:
    python eight_sleep_temp_backfill.py            # dry-run, no DB writes
    python eight_sleep_temp_backfill.py --apply    # actually write to Supabase
"""

import os
import sys
import time
import json
import logging
from dotenv import load_dotenv
from supabase import create_client
from eight_sleep_etl import EightSleepClient, CLIENT_API_URL, median_timeseries, discover_users

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APPLY = "--apply" in sys.argv


def get_interval_by_id(client: EightSleepClient, user_id: str, session_id: str) -> dict | None:
    """Fetch a single interval by session ID. Returns None on 404/error."""
    try:
        resp = client.http.get(
            f"{CLIENT_API_URL}/users/{user_id}/intervals/{session_id}",
            headers=client._headers(),
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        log.warning(f"  /intervals/{session_id} failed: {e}")
        return None


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    client = EightSleepClient(
        email=os.environ["EIGHTSLEEP_EMAIL"],
        password=os.environ["EIGHTSLEEP_PASSWORD"],
        tz="America/New_York",
    )
    client.authenticate()
    user_map = discover_users(client)  # {bed_side: user_id}
    log.info(f"Discovered bed sides: {sorted(user_map.keys())}")

    # Pull every row missing temp, with its raw_json
    log.info("Querying trends rows missing temp...")
    resp = sb.schema("pds").from_("eight_sleep_trends") \
        .select("calendar_date,bed_side,raw_json") \
        .is_("median_bed_temp", "null") \
        .order("calendar_date", desc=False) \
        .execute()
    rows = resp.data or []
    log.info(f"Found {len(rows)} rows needing backfill")

    updated = 0
    skipped_no_session = 0
    skipped_no_temp = 0
    failed = 0

    for i, row in enumerate(rows, 1):
        cal = row["calendar_date"]
        side = row["bed_side"]
        raw = row.get("raw_json")
        if not raw:
            skipped_no_session += 1
            continue

        # raw_json is stored as a JSON string (double-encoded). Parse it.
        if isinstance(raw, str):
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                log.warning(f"  [{cal}/{side}] raw_json not parseable")
                failed += 1
                continue
        else:
            payload = raw

        main_id = payload.get("mainSessionId")
        session_ids = payload.get("sessionIds") or []
        target_id = main_id if main_id else (session_ids[0] if session_ids else None)
        if not target_id:
            skipped_no_session += 1
            continue

        user_id = user_map.get(side)
        if not user_id:
            log.warning(f"  [{cal}/{side}] no user_id for this side")
            failed += 1
            continue

        interval = get_interval_by_id(client, user_id, str(target_id))
        if not interval:
            failed += 1
            continue

        ts = interval.get("timeseries") or {}
        bed_temp = median_timeseries(ts.get("tempBedC"))
        room_temp = median_timeseries(ts.get("tempRoomC"))

        if bed_temp is None and room_temp is None:
            skipped_no_temp += 1
            continue

        if APPLY:
            sb.schema("pds").from_("eight_sleep_trends").update({
                "median_bed_temp": bed_temp,
                "median_room_temp": room_temp,
            }).eq("calendar_date", cal).eq("bed_side", side).execute()

        updated += 1
        if i % 10 == 0 or i == len(rows):
            log.info(f"  [{i}/{len(rows)}] {cal}/{side}: bed={bed_temp} room={room_temp}")

        # Polite delay so we don't hammer Eight Sleep's API
        time.sleep(0.3)

    log.info("=" * 60)
    log.info(f"{'APPLIED' if APPLY else 'DRY RUN'}: updated={updated}, "
             f"skipped_no_session={skipped_no_session}, "
             f"skipped_no_temp={skipped_no_temp}, failed={failed}")
    if not APPLY:
        log.info("Re-run with --apply to write these to the database.")

    client.close()


if __name__ == "__main__":
    main()
