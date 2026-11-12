"""
Air quality (PM2.5) -> Supabase ETL

Pulls hourly PM2.5 (ug/m3) and US AQI for the Atlanta area from the keyless
Open-Meteo Air Quality API (CAMS model analysis; no account, no secret) and
upserts one row per ET clock day into pds.air_quality_daily (daily mean + max,
hour count). The HRV pipeline reads that table as the `aqi_*` features
(hrv_analysis.merge_air_quality_features) and the causal layer treats `aqi_pm25`
as a median-split exposure.

Usage:
    python air_quality_etl.py                  # re-sync the last 7 days (an empty table backfills from 2024-01-01 first)
    python air_quality_etl.py --backfill 400   # re-sync the last 400 days (paged in <=90-day API windows)
    python air_quality_etl.py --dry-run        # fetch + aggregate, print the rows, write nothing (no .env needed)
    python air_quality_etl.py --lat 40.72 --lon -73.99   # another location (after the NYC move)

Design notes:
  - Location is fixed to central Atlanta (33.75, -84.39) and overridable with
    AIR_QUALITY_LAT / AIR_QUALITY_LON or --lat/--lon. Reading the latest Garmin
    activity GPS was deliberately skipped: a run in Madrid would silently move
    the whole daily series, and the model data is regional (~0.4 degree grid)
    anyway. Latitude/longitude are stored on every row, so a changed location
    stays auditable.
  - Open-Meteo returns the hours of the requested days in the requested
    timezone (America/New_York here), so grouping by the date part of each
    timestamp gives the ET clock day directly. Hours after "now" are forecast
    values and are never stored: today's row is partial (n_hours < 24) until the
    day ends, and the HRV pipeline ignores days with fewer than 20 hours.
  - Recent hours are revised as CAMS analyses arrive, so every run re-upserts a
    rolling window (7 days) instead of only appending.
  - Global history starts 2022-07-29; earlier hours come back null and are skipped.
  - Heartbeat: one pds.sync_log row per run (source='air_quality',
    data_type='daily'), written on success, on an empty API answer (partial)
    and on any failure, including an uncaught exception.
"""

import argparse
import logging
import math
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

from retry_helper import retry_http
from sync_log_helper import log_sync as _shared_log_sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("air_quality_etl")

API_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
ET_NAME = "America/New_York"
ET = ZoneInfo(ET_NAME)
SOURCE = "open-meteo-cams"

DEFAULT_LAT = 33.75   # central Atlanta (the API grid is ~11 km, so no finer location is useful)
DEFAULT_LON = -84.39
DEFAULT_DAYS = 7
BOOTSTRAP_START = date(2024, 1, 1)   # an empty table backfills from here (global data exists from 2022-07-29)
CHUNK_DAYS = 90                      # keep each API call to ~2,200 hourly values
UPSERT_BATCH = 500


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/test_air_quality.py - no network, no database)
# ---------------------------------------------------------------------------

def _num(v):
    """A usable non-negative finite number, else None (the API sends null for missing hours)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if not math.isfinite(v) or v < 0:
        return None
    return float(v)


def windows(start: date, end: date, chunk_days: int = CHUNK_DAYS) -> list[tuple[date, date]]:
    """Split [start, end] into consecutive inclusive windows of at most chunk_days days."""
    out: list[tuple[date, date]] = []
    cur = start
    while cur <= end:
        stop = min(end, cur + timedelta(days=chunk_days - 1))
        out.append((cur, stop))
        cur = stop + timedelta(days=1)
    return out


def aggregate_daily(payload: dict, now_et: datetime, lat: float, lon: float) -> list[dict]:
    """Hourly API payload -> one row per ET clock day with at least one PM2.5 value.

    `payload["hourly"]` carries parallel lists time / pm2_5 / us_aqi, with times as
    naive local strings in the requested timezone ("2026-11-09T14:00"). Hours later
    than `now_et` are forecasts and are dropped. A day with no PM2.5 value produces
    no row (so an API gap can never overwrite a good day with nulls).
    """
    hourly = payload.get("hourly") if isinstance(payload, dict) else None
    if not isinstance(hourly, dict) or "time" not in hourly or "pm2_5" not in hourly:
        raise ValueError("Open-Meteo answer has no hourly time/pm2_5 arrays")
    times, pm = hourly["time"], hourly["pm2_5"]
    aqi = hourly.get("us_aqi") or [None] * len(times)
    if not (len(times) == len(pm) == len(aqi)):
        raise ValueError(f"Open-Meteo hourly arrays differ in length ({len(times)}/{len(pm)}/{len(aqi)})")

    cutoff = now_et.replace(tzinfo=None)
    by_day: dict[str, dict[str, list[float]]] = {}
    for t, p, a in zip(times, pm, aqi):
        try:
            local = datetime.fromisoformat(t)
        except (TypeError, ValueError):
            continue
        if local > cutoff:
            continue
        bucket = by_day.setdefault(local.date().isoformat(), {"pm": [], "aqi": []})
        pv, av = _num(p), _num(a)
        if pv is not None:
            bucket["pm"].append(pv)
        if av is not None:
            bucket["aqi"].append(av)

    rows = []
    for day in sorted(by_day):
        pms, aqis = by_day[day]["pm"], by_day[day]["aqi"]
        if not pms:
            continue
        rows.append({
            "calendar_date": day,
            "pm25_mean": round(sum(pms) / len(pms), 2),
            "pm25_max": round(max(pms), 2),
            "us_aqi_mean": round(sum(aqis) / len(aqis), 1) if aqis else None,
            "us_aqi_max": round(max(aqis), 1) if aqis else None,
            "n_hours": len(pms),
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "source": SOURCE,
        })
    return rows


def resolve_location(lat_arg: float | None, lon_arg: float | None) -> tuple[float, float]:
    """CLI flag > AIR_QUALITY_LAT / AIR_QUALITY_LON > Atlanta. Rejects out-of-range values."""
    lat = lat_arg if lat_arg is not None else float(os.environ.get("AIR_QUALITY_LAT") or DEFAULT_LAT)
    lon = lon_arg if lon_arg is not None else float(os.environ.get("AIR_QUALITY_LON") or DEFAULT_LON)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"location out of range: lat={lat}, lon={lon}")
    return lat, lon


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def get_supabase():
    """Service-role client. Imports are lazy so the pure helpers (and the tests) need no extras."""
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def fetch_hourly(client: httpx.Client, lat: float, lon: float, start: date, end: date) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "pm2_5,us_aqi",
        "timezone": ET_NAME,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
    }
    try:
        return retry_http(lambda: client.get(API_URL, params=params), max_attempts=4, log=log).json()
    except httpx.HTTPStatusError as exc:
        reason = ""
        try:
            reason = exc.response.json().get("reason", "")
        except Exception:  # noqa: BLE001 - body is not JSON
            reason = exc.response.text[:200]
        raise RuntimeError(f"Open-Meteo HTTP {exc.response.status_code}: {reason}") from exc


def log_sync(sb, status: str, records: int, started_at: float, error: str | None = None,
             date_range: tuple[date, date] | None = None) -> None:
    _shared_log_sync(
        sb, source="air_quality", data_type="daily", status=status, records=records,
        started_at=started_at, error=error,
        date_range_start=date_range[0] if date_range else None,
        date_range_end=date_range[1] if date_range else None,
    )


def _missing_table(exc: Exception) -> bool:
    msg = str(exc)
    return "air_quality_daily" in msg and any(s in msg for s in ("PGRST205", "does not exist", "schema cache", "42P01"))


def run_etl(days: int | None, lat: float, lon: float, dry_run: bool = False, sb=None) -> int:
    """Fetch, aggregate and upsert. Returns the number of day rows written.

    days=None is the routine run: the last DEFAULT_DAYS days, or everything since
    BOOTSTRAP_START when the table is still empty. An explicit N always means exactly N days back.
    """
    started = time.time()
    now_et = datetime.now(ET)
    today = now_et.date()
    written = 0
    first_day = last_day = None
    try:
        if not dry_run:
            sb = sb or get_supabase()
        start = today - timedelta(days=days if days is not None else DEFAULT_DAYS)
        if not dry_run and days is None:
            # An empty table (first run, or right after the schema is applied) backfills itself.
            probe = sb.schema("pds").table("air_quality_daily").select("calendar_date").limit(1).execute()
            if not probe.data:
                start = BOOTSTRAP_START
                log.info(f"  Table is empty: bootstrapping from {start}")
        log.info(f"Air quality {start} -> {today} at ({lat}, {lon})")

        with httpx.Client(timeout=60.0) as client:
            for w_start, w_end in windows(start, today):
                rows = aggregate_daily(fetch_hourly(client, lat, lon, w_start, w_end), now_et, lat, lon)
                if not rows:
                    log.info(f"  {w_start} -> {w_end}: no PM2.5 values")
                    continue
                if dry_run:
                    for r in rows[-3:]:
                        log.info(f"  [dry-run] {r}")
                else:
                    stamp = datetime.now(timezone.utc).isoformat()
                    for i in range(0, len(rows), UPSERT_BATCH):
                        batch = [{**r, "synced_at": stamp} for r in rows[i:i + UPSERT_BATCH]]
                        sb.schema("pds").table("air_quality_daily").upsert(batch, on_conflict="calendar_date").execute()
                written += len(rows)
                first_day = first_day or date.fromisoformat(rows[0]["calendar_date"])
                last_day = date.fromisoformat(rows[-1]["calendar_date"])
                log.info(f"  {w_start} -> {w_end}: {len(rows)} day(s)")
                time.sleep(0.2)

        if dry_run:
            log.info(f"Dry run: {written} day row(s) would be written")
            return written
        rng = (first_day, last_day) if first_day and last_day else None
        if written == 0:
            log_sync(sb, "partial", 0, started,
                     error="Open-Meteo returned no PM2.5 values for the window (outage, or a location outside CAMS coverage)",
                     date_range=rng)
            log.warning("No PM2.5 values returned")
        else:
            log_sync(sb, "success", written, started, date_range=rng)
            log.info(f"Done: {written} day row(s) upserted")
        return written
    except Exception as exc:  # noqa: BLE001 - heartbeat, then fail the Actions run
        if dry_run or sb is None:
            raise
        msg = f"{type(exc).__name__}: {exc}"
        if _missing_table(exc):
            msg = f"pds.air_quality_daily is missing - apply sql/air_quality_schema.sql. {msg}"
        if written:
            msg += f" (after {written} day row(s))"
        log.error(msg)
        log_sync(sb, "failed", written, started, error=msg[:500])
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Air quality (PM2.5) ETL - Open-Meteo -> pds.air_quality_daily")
    ap.add_argument("--backfill", type=int, help="re-sync the last N days (default 7)")
    ap.add_argument("--lat", type=float, help="latitude (default AIR_QUALITY_LAT or Atlanta)")
    ap.add_argument("--lon", type=float, help="longitude (default AIR_QUALITY_LON or Atlanta)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    args = ap.parse_args()
    if args.backfill is not None and args.backfill < 1:
        ap.error("--backfill must be at least 1")
    lat, lon = resolve_location(args.lat, args.lon)
    run_etl(args.backfill, lat, lon, dry_run=args.dry_run)


if __name__ == "__main__":
    # Top-level failure heartbeat so an uncaught exception (bad env value, no Supabase
    # credentials) still surfaces on /status instead of silently going stale.
    _t0 = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - top-level safety net
        if "--dry-run" not in sys.argv:
            try:
                log_sync(get_supabase(), "failed", 0, _t0, error=f"Uncaught exception: {exc}"[:500])
            except Exception as log_exc:  # noqa: BLE001
                log.error(f"Could not write failure sync_log row: {log_exc}")
        raise
