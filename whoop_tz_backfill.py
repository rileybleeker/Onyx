"""
WHOOP-cycle-based timezone inference for pds.user_tz_log
========================================================
Companion to gps_tz_backfill.py. Where GPS gives us exact IANA names but
only covers travel days with outdoor activities, WHOOP gives us a numeric
UTC offset on EVERY cycle (Riley always wears the strap) but only provides
the offset — not the IANA name.

This script detects WHOOP cycles whose timezone_offset disagrees with what
pds.tz_for_instant currently returns and inserts new user_tz_log rows,
inferring the most-likely IANA name from Riley's prior manual entries.

Priority (lowest fires first, highest wins on overlap):
  3. WHOOP-cycle-based (this script)  — always available, IANA inferred
  2. GPS-coordinate-based              — only on GPS activity days, IANA exact
  1. Manual entries                    — Riley's authoritative input

Manual entries are NEVER overridden. GPS entries are deferred to (this script
checks if the log already covers the instant within a tolerance). The notes
field tags every auto-insert so they're distinguishable from manual entries.

Usage:
    python whoop_tz_backfill.py              # dry-run: print proposed inserts
    python whoop_tz_backfill.py --apply      # actually insert the rows
    python whoop_tz_backfill.py --since 2026-04-01 --apply  # bounded window

Idempotent — re-running won't duplicate. A proposed insert is skipped when
(a) pds.tz_for_instant already returns the inferred TZ for that instant
(via existing user_tz_log coverage), or (b) the inferred TZ produces the
same UTC offset as whatever's currently logged (no behavioral difference).

Dependencies: pip install supabase python-dotenv
(No new deps — uses zoneinfo from stdlib instead of timezonefinder.)
"""

import os
import sys
import argparse
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# Generic fallback offset -> IANA map (used when history has no matching offset).
# Picked for typical US + Europe travel patterns; covers the obvious cases
# without claiming precision.
GENERIC_OFFSET_IANA = {
    "-09:00": "America/Anchorage",
    "-08:00": "America/Los_Angeles",
    "-07:00": "America/Denver",
    "-06:00": "America/Chicago",
    "-05:00": "America/New_York",
    "-04:00": "America/New_York",     # EDT
    "-03:00": "America/Sao_Paulo",
    "+00:00": "Europe/London",
    "+01:00": "Europe/Paris",
    "+02:00": "Europe/Berlin",
    "+03:00": "Europe/Istanbul",
    "+09:00": "Asia/Tokyo",
    "+10:00": "Australia/Sydney",
}


def parse_offset_str(offset_str: str) -> timedelta:
    """Parse '+02:00' / '-06:00' to a timedelta."""
    sign = 1 if offset_str[0] == "+" else -1
    hh, mm = offset_str[1:].split(":")
    return sign * timedelta(hours=int(hh), minutes=int(mm))


def format_offset(td: timedelta | None) -> str | None:
    """Format a timedelta as +HH:MM / -HH:MM."""
    if td is None:
        return None
    total_min = int(td.total_seconds()) // 60
    sign = "+" if total_min >= 0 else "-"
    abs_min = abs(total_min)
    return f"{sign}{abs_min // 60:02d}:{abs_min % 60:02d}"


def build_history_iana_map() -> dict[str, str]:
    """Derive offset -> most-common IANA from manual user_tz_log entries.

    Manual entries are those whose `notes` field does NOT start with
    'whoop-auto:' or 'gps-auto:'. This prevents bootstrap bias (we don't
    want the script's own inferences to influence future inferences).
    """
    rows = supa.schema("pds").from_("user_tz_log").select("effective_from,tz,notes").execute().data
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        notes = (r.get("notes") or "").lower().strip()
        if notes.startswith("whoop-auto:") or notes.startswith("gps-auto:"):
            continue
        tz_name = r["tz"]
        try:
            ts = datetime.fromisoformat(r["effective_from"].replace("Z", "+00:00"))
            offset_str = format_offset(ts.astimezone(ZoneInfo(tz_name)).utcoffset())
            if offset_str:
                counts[offset_str][tz_name] += 1
        except Exception as e:
            log.warning(f"  history-map: skipped {r['effective_from']} ({tz_name}): {e}")
    return {off: max(c.items(), key=lambda x: x[1])[0] for off, c in counts.items()}


def infer_iana(offset_str: str, history_map: dict[str, str]) -> tuple[str | None, str]:
    """Return (iana, provenance_string) for the inferred zone.

    Returns (None, reason) when no IANA can be confidently inferred so the
    caller skips rather than proposing a bogus placeholder. Previously this
    fell back to 'Etc/UTC' on unknown offsets — but Etc/UTC's offset is
    +00:00, which never matches the WHOOP offset that triggered the proposal,
    so on every subsequent cycle for the same trip the script would propose
    Etc/UTC again and again without converging (gemini tz/F-003).
    """
    if offset_str in history_map:
        return history_map[offset_str], f"history-inferred from past {offset_str} trips"
    if offset_str in GENERIC_OFFSET_IANA:
        return GENERIC_OFFSET_IANA[offset_str], f"generic default for {offset_str}"
    return None, (
        f"no inference available for {offset_str}; manual user_tz_log entry "
        "required — skipping proposal to avoid Etc/UTC oscillation"
    )


def fetch_cycles(since: str | None = None) -> list[dict]:
    """Return WHOOP cycles, sorted by start_time."""
    q = (supa.schema("pds").from_("whoop_cycles")
            .select("cycle_id,start_time,end_time,timezone_offset")
            .not_.is_("timezone_offset", "null")
            .order("start_time", desc=False))
    if since:
        q = q.gte("start_time", since)
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
    res = supa.schema("pds").rpc("tz_for_instant", {"ts": ts_iso}).execute()
    return res.data or "America/New_York"


def infer_proposed_inserts(cycles: list[dict], history_map: dict[str, str]) -> list[dict]:
    """For each cycle, propose a user_tz_log row only if:
      (a) the WHOOP offset doesn't match the offset of what tz_for_instant
          currently returns at this instant, AND
      (b) we haven't already proposed the same IANA for the immediately
          prior cycle (deduplication).
    """
    proposals: list[dict] = []
    last_proposed_tz: str | None = None

    for c in cycles:
        ts_iso = c["start_time"]
        end_iso = c.get("end_time")
        whoop_offset_str = c["timezone_offset"]
        log_tz = tz_for_instant_via_pg(ts_iso)
        try:
            ts_aware = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
            log_offset_at_start = format_offset(ts_aware.astimezone(ZoneInfo(log_tz)).utcoffset())
            log_offset_at_end = None
            if end_iso:
                end_aware = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
                # Use the same log_tz lookup at end_time so DST shifts mid-cycle
                # are visible. (tz_for_instant returns the IANA, ZoneInfo
                # handles DST per-instant.)
                end_log_tz = tz_for_instant_via_pg(end_iso)
                log_offset_at_end = format_offset(end_aware.astimezone(ZoneInfo(end_log_tz)).utcoffset())
        except Exception as e:
            log.warning(f"  cycle {c['cycle_id']}: log-offset compute failed: {e}")
            continue

        # DST-artifact filter: WHOOP picks one offset per cycle. On NY's DST
        # transition night, the cycle physically spans the 2 AM shift. The
        # log's offset at start may differ from the log's offset at end by
        # exactly 1h. If WHOOP's offset matches EITHER, it's not a real
        # trip — it's a DST artifact. Skip.
        if whoop_offset_str == log_offset_at_start or whoop_offset_str == log_offset_at_end:
            last_proposed_tz = log_tz
            continue

        # WHOOP says one thing, log says another — propose a new entry.
        inferred_iana, provenance = infer_iana(whoop_offset_str, history_map)
        if inferred_iana is None:
            # No confident inference (unknown offset, no manual history).
            # Skip rather than oscillating on Etc/UTC. Log once per cycle so
            # the user can spot trips needing a manual user_tz_log row.
            log.warning(
                f"  cycle {c['cycle_id']} offset {whoop_offset_str}: {provenance}"
            )
            continue
        if inferred_iana == last_proposed_tz:
            # Same IANA we just proposed for the prior cycle — skip dup.
            continue
        proposals.append({
            "effective_from": ts_iso,
            "tz": inferred_iana,
            "notes": (f"whoop-auto: cycle {c['cycle_id']} offset {whoop_offset_str}; "
                      f"{provenance}; log was {log_tz} ({log_offset_at_start})"),
        })
        last_proposed_tz = inferred_iana
    return proposals


def apply_proposals(proposals: list[dict]) -> int:
    if not proposals:
        return 0
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
                        help="Only consider cycles since this ISO date (default: all history)")
    args = parser.parse_args()

    log.info("Building offset -> IANA map from MANUAL user_tz_log entries…")
    history_map = build_history_iana_map()
    if history_map:
        for off, tz in sorted(history_map.items()):
            log.info(f"  {off:7s} -> {tz}")
    else:
        log.info("  (no manual entries yet — will use generic defaults)")

    log.info(f"Loading WHOOP cycles{f' since {args.since}' if args.since else ''}…")
    cycles = fetch_cycles(since=args.since)
    log.info(f"  {len(cycles)} cycles with timezone_offset")

    log.info("Comparing WHOOP-reported offset vs user_tz_log resolution…")
    proposals = infer_proposed_inserts(cycles, history_map)
    log.info(f"  {len(proposals)} proposed user_tz_log entries")

    if not proposals:
        log.info("Nothing to insert. user_tz_log already covers every WHOOP cycle's offset.")
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
