"""
Uber rides: import the rider trip history from Uber's own privacy download.

How to get the file (a few minutes of Riley's time; no automation of Uber's site):
  myprivacy.uber.com -> Download your data -> Rider (or all) -> Submit. Uber emails a link; the
  ZIP holds Rider/trips_data.csv. Pass the ZIP, the folder or the CSV to this script.

Why a file import and not a harvester: Uber's Agent Terms (US General Terms s.10, 2026-11-04) let
Uber suspend an account that an unidentified automated agent reads. This script never touches
Uber's site. Pickup / drop-off addresses in the file are never read or stored.

    python uber_rides_import.py <zip|dir|csv>            # dry run: counts only, writes nothing
    python uber_rides_import.py <zip|dir|csv> --apply    # upsert into pds.uber_rides + heartbeat

Output is counts only. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for --apply.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import re
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

# Header names vary a little between export vintages: match on a normalised header.
ALIASES = {
    "requested_at": ("request time", "requested at", "request date", "request timestamp"),
    "started_at": ("begin trip time", "trip start time", "start time", "begintrip time"),
    "ended_at": ("dropoff time", "drop off time", "trip end time", "end time"),
    "product": ("product type", "product", "service type"),
    "city": ("city",),
    "status": ("trip or order status", "status", "trip status"),
    "distance": ("distance (miles)", "distance miles", "distance (mi)", "distance"),
    "fare": ("fare amount", "fare", "total fare"),
    "currency": ("fare currency", "currency"),
}
MAX_ROWS = 200_000


def _norm(h: str) -> str:
    return re.sub(r"\s+", " ", h.strip().lower().lstrip("﻿"))


def parse_time(raw: str) -> Optional[datetime]:
    """Uber writes '2024-01-05 18:22:10 +0000 UTC' (older files: ISO 8601, or no zone = UTC)."""
    s = (raw or "").strip()
    if not s or s.lower() in ("n/a", "null", "none", "-"):
        return None
    s = re.sub(r"\s+UTC$", "", s)
    s = s.replace("Z", "+00:00")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?$", s)
    if m:
        s = f"{m.group(1)}T{m.group(2)}{m.group(3)}:{m.group(4) or '00'}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_number(raw: str) -> Optional[float]:
    s = re.sub(r"[^\d.\-]", "", (raw or "").replace(",", ""))
    if s in ("", "-", "."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def status_of(raw: str) -> str:
    s = (raw or "").strip().lower()
    if s == "completed":
        return "completed"
    if "cancel" in s:
        return "canceled"
    return "other"


def ride_key(requested: datetime, started: Optional[datetime], ended: Optional[datetime],
             fare: Optional[float]) -> str:
    parts = [requested.isoformat(), started.isoformat() if started else "",
             ended.isoformat() if ended else "", f"{fare:.2f}" if fare is not None else ""]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


def rows_from_csv(text: str) -> tuple[list[dict], int]:
    """Returns (rows, skipped). Address columns are never read."""
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header:
        return [], 0
    index = {_norm(h): i for i, h in enumerate(header)}

    def col(name: str) -> Optional[int]:
        for alias in ALIASES[name]:
            if alias in index:
                return index[alias]
        return None

    cols = {k: col(k) for k in ALIASES}
    if cols["requested_at"] is None and cols["started_at"] is None:
        raise ValueError("no request / start time column found: is this Rider/trips_data.csv?")

    def get(row: list[str], key: str) -> str:
        i = cols[key]
        return row[i] if i is not None and i < len(row) else ""

    out: dict[str, dict] = {}
    skipped = 0
    for n, row in enumerate(reader):
        if n >= MAX_ROWS:
            break
        started = parse_time(get(row, "started_at"))
        requested = parse_time(get(row, "requested_at")) or started
        if requested is None:
            skipped += 1
            continue
        ended = parse_time(get(row, "ended_at"))
        fare = parse_number(get(row, "fare"))
        key = ride_key(requested, started, ended, fare)
        out[key] = {
            "ride_key": key,
            "requested_at": requested.isoformat(),
            "started_at": started.isoformat() if started else None,
            "ended_at": ended.isoformat() if ended else None,
            "product": get(row, "product").strip() or None,
            "city": get(row, "city").strip() or None,
            "status": status_of(get(row, "status")),
            "distance_miles": parse_number(get(row, "distance")),
            "fare_amount": fare,
            "fare_currency": get(row, "currency").strip().upper()[:3] or None,
        }
    return list(out.values()), skipped


def find_csv_texts(path: Path) -> Iterable[str]:
    """Yield the text of every trips CSV under a zip, folder or file."""
    def want(name: str) -> bool:
        low = name.lower().replace("\\", "/")
        return low.endswith("trips_data.csv") or (low.endswith(".csv") and "trip" in low.rsplit("/", 1)[-1])

    if path.is_file() and path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if want(info.filename) and info.file_size < 200 * 1024 * 1024:
                    yield z.read(info).decode("utf-8-sig", errors="replace")
    elif path.is_dir():
        for p in sorted(path.rglob("*.csv")):
            if want(str(p)):
                yield p.read_text(encoding="utf-8-sig", errors="replace")
    elif path.is_file():
        yield path.read_text(encoding="utf-8-sig", errors="replace")


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", type=Path)
    ap.add_argument("--apply", action="store_true", help="write to Supabase (default: dry run)")
    args = ap.parse_args(argv)
    started_at = time.time()

    rows: dict[str, dict] = {}
    skipped = 0
    for text in find_csv_texts(args.path):
        r, s = rows_from_csv(text)
        skipped += s
        rows.update({x["ride_key"]: x for x in r})
    if not rows:
        print("No rides found in that path.")
        return 1

    by_status: dict[str, int] = {}
    for r in rows.values():
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    times = sorted(r["requested_at"] for r in rows.values())
    print(f"rides: {len(rows)} ({', '.join(f'{k} {v}' for k, v in sorted(by_status.items()))}); "
          f"skipped rows without a time: {skipped}; range {times[0][:10]} to {times[-1][:10]}")
    if not args.apply:
        print("Dry run: nothing written. Re-run with --apply.")
        return 0

    import os
    from dotenv import load_dotenv
    from supabase import create_client
    from sync_log_helper import log_sync
    load_dotenv()
    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    try:
        items = list(rows.values())
        for i in range(0, len(items), 500):
            supa.schema("pds").from_("uber_rides").upsert(items[i:i + 500], on_conflict="ride_key").execute()
        log_sync(supa, "uber_rides", "import", "success", records=len(items), started_at=started_at,
                 date_range_start=datetime.fromisoformat(times[0]).date(),
                 date_range_end=datetime.fromisoformat(times[-1]).date())
        print(f"Upserted {len(items)} rides.")
        return 0
    except Exception as exc:  # heartbeat on failure too; the type name only, never the text
        log_sync(supa, "uber_rides", "import", "failed", started_at=started_at, error=type(exc).__name__)
        print(f"Import failed: {type(exc).__name__}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
