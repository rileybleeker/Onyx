"""
Daily weather -> Supabase ETL

Pulls hourly outdoor weather for the home location from the keyless Open-Meteo
archive API (ECMWF IFS + ERA5 reanalysis; no account, no secret) and upserts one
row per ET clock day into pds.weather_daily: temperature max / min / mean,
apparent temperature, relative humidity, dew point, surface pressure,
precipitation, wind, cloud cover, daylight and sunshine hours, the UV index
maximum, and the temperature of the early-morning night hours. The HRV pipeline
reads the table as the `wx_*` features (hrv_analysis.merge_weather_features).

Usage:
    python weather_etl.py                  # re-sync the last 10 days (an empty table backfills from 2024-01-01 first)
    python weather_etl.py --backfill 400   # re-sync the last 400 days (paged in <=90-day API windows)
    python weather_etl.py --dry-run        # fetch + aggregate, print the rows, write nothing (no .env needed)
    python weather_etl.py --lat 40.72 --lon -73.99   # another location (after the NYC move)

Design notes:
  - Location: the SAME constants and environment overrides as air_quality_etl.py
    (AIR_QUALITY_LAT / AIR_QUALITY_LON, default central Atlanta), imported from
    that module so one change moves both sources. Latitude / longitude are stored
    on every row.
  - The ET clock day is built HERE, not by the API. Open-Meteo applies ONE UTC
    offset to a whole response (checked live 2026-11-13: a July day requested in
    November comes back with the November offset, GMT-5), so its "local day" for
    a date in the other DST season is an hour off and would change with the
    season the request is made in. The ETL therefore asks for UTC hours and
    converts each one to America/New_York itself. A DST day has 23 or 25 hours.
    Means, sums and the wind maximum then equal the API's own daily values
    whenever the API's offset is the right one for that date. temperature_max /
    temperature_min are the extremes of the hourly values; the API's daily
    minimum can read up to ~1 C lower because it uses the model's within-hour
    extremes, which the hourly endpoint does not expose.
  - Hours after "now" are forecasts (the archive returns them for today) and are
    never stored: today's row is partial (n_hours < 24) until the day ends, and
    the HRV pipeline ignores days with fewer than 20 hours.
  - Night columns: night_temp_mean / night_temp_min cover 01:00-08:00 ET of the
    row's clock day (the hours Riley's main sleep normally covers, checked on the
    live WHOOP sleeps). They describe the sleep that started the evening BEFORE, so the HRV
    pipeline places them one row earlier than the daytime columns. The plain
    temperature_min of a clock day usually falls near dawn, inside that same
    earlier sleep, which is why it is stored for display but is not an HRV feature.
  - UV index: the archive returns null for it. It comes from Open-Meteo's
    historical-forecast API (stitched forecast runs, one extra request per window)
    and is best-effort: if that request fails the UV columns are left untouched
    and the run is reported as partial. uv_source records where the value came from.
  - Recent days mix IFS (no delay) and ERA5 (5 days late), so every run re-upserts
    a rolling 10-day window instead of only appending.
  - Heartbeat: one pds.sync_log row per run (source='weather', data_type='daily'),
    written on success, on an empty API answer or a failed UV request (partial)
    and on any failure, including an uncaught exception.
"""

import argparse
import logging
import math
import sys
import time
from datetime import date, datetime, timedelta, timezone

import httpx

from air_quality_etl import DEFAULT_LAT, DEFAULT_LON, ET, resolve_location, windows  # noqa: F401 - one home location for both sources
from retry_helper import retry_http
from sync_log_helper import log_sync as _shared_log_sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("weather_etl")

API_URL = "https://archive-api.open-meteo.com/v1/archive"
UV_API_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
SOURCE = "open-meteo-archive"
UV_SOURCE = "open-meteo-historical-forecast"
TABLE = "weather_daily"

DEFAULT_DAYS = 10                    # recent days are revised when ERA5 replaces IFS (5-day delay)
BOOTSTRAP_START = date(2024, 1, 1)   # an empty table backfills from here (the archive goes back to 1940)
CHUNK_DAYS = 90
UPSERT_BATCH = 500

# Night window: the hourly values at 01:00 ... 08:00 ET of the row's clock day.
NIGHT_HOURS = range(1, 9)
NIGHT_MIN_HOURS = 7                  # 8 on a normal day, 7 / 9 on the two DST days

# hourly API variable -> may it be negative?
HOURLY_VARS = {
    "temperature_2m": True,
    "apparent_temperature": True,
    "relative_humidity_2m": False,
    "dew_point_2m": True,
    "surface_pressure": False,
    "precipitation": False,
    "wind_speed_10m": False,
    "cloud_cover": False,
    "sunshine_duration": False,
}


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/test_weather.py - no network, no database)
# ---------------------------------------------------------------------------

def _num(v, allow_negative: bool = False):
    """A usable finite number, else None (the API sends null for missing hours)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if not math.isfinite(v) or (v < 0 and not allow_negative):
        return None
    return float(v)


def _utc_hour(stamp) -> datetime | None:
    """A UTC hour string from the API ("2026-11-09T14:00") as an aware UTC datetime."""
    try:
        return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _et_local(utc_stamp: datetime) -> datetime:
    """ET wall-clock time of a UTC hour, naive. Each hour belongs to the ET clock day and
    hour of its own timestamp (00:00 ... 23:00), which is how Open-Meteo builds its daily
    means, sums and wind maximum (checked live against its daily values, 2026-11-13)."""
    return utc_stamp.astimezone(ET).replace(tzinfo=None)


def _mean(xs, digits=2):
    return round(sum(xs) / len(xs), digits) if xs else None


def api_range(start: date, end: date, now_utc: datetime) -> tuple[date, date]:
    """UTC dates to request so every hour of the ET days [start, end] is covered.

    ET is behind UTC, so the last ET day runs into the next UTC date. The archive
    rejects dates after today (UTC), and hours after now are dropped anyway.
    """
    return start, min(end + timedelta(days=1), now_utc.date())


def aggregate_daily(payload: dict, now_et: datetime, lat: float, lon: float) -> list[dict]:
    """Hourly UTC payload -> one row per ET clock day with at least one temperature value.

    `payload["hourly"]` carries parallel lists: time (UTC, "2026-11-09T14:00") and one
    list per HOURLY_VARS name. `payload["daily"]` may carry time + daylight_duration
    (seconds per date). `now_et` must be timezone-aware; hours after it are forecasts
    and are dropped. A day
    with no temperature value produces no row, so an API gap can never overwrite a good
    day with nulls.
    """
    hourly = payload.get("hourly") if isinstance(payload, dict) else None
    if not isinstance(hourly, dict) or "time" not in hourly or "temperature_2m" not in hourly:
        raise ValueError("Open-Meteo answer has no hourly time/temperature_2m arrays")
    times = hourly["time"]
    series = {}
    for name in HOURLY_VARS:
        values = hourly.get(name)
        if values is None:
            values = [None] * len(times)
        if len(values) != len(times):
            raise ValueError(f"Open-Meteo hourly arrays differ in length (time {len(times)}, {name} {len(values)})")
        series[name] = values

    daily = payload.get("daily") if isinstance(payload.get("daily"), dict) else {}
    daylight = {}
    for day, secs in zip(daily.get("time") or [], daily.get("daylight_duration") or []):
        value = _num(secs)
        if value is not None:
            daylight[str(day)[:10]] = value

    cutoff = now_et.astimezone(timezone.utc)
    by_day: dict[str, dict[str, list[float]]] = {}
    for i, stamp in enumerate(times):
        utc = _utc_hour(stamp)
        if utc is None or utc > cutoff:
            continue
        local = _et_local(utc)
        bucket = by_day.setdefault(local.date().isoformat(), {name: [] for name in (*HOURLY_VARS, "night")})
        for name, negative_ok in HOURLY_VARS.items():
            value = _num(series[name][i], negative_ok)
            if value is not None:
                bucket[name].append(value)
        temp = _num(series["temperature_2m"][i], True)
        if temp is not None and local.hour in NIGHT_HOURS:
            bucket["night"].append(temp)

    rows = []
    for day in sorted(by_day):
        b = by_day[day]
        temps = b["temperature_2m"]
        if not temps:
            continue
        # The night counts only once its last hourly value (08:00 ET) is in the past.
        night_end = datetime.fromisoformat(day).replace(hour=NIGHT_HOURS[-1], tzinfo=ET)
        night_ok = len(b["night"]) >= NIGHT_MIN_HOURS and night_end <= cutoff
        sun = b["sunshine_duration"]
        rows.append({
            "calendar_date": day,
            "temperature_max": round(max(temps), 2),
            "temperature_min": round(min(temps), 2),
            "temperature_mean": _mean(temps),
            "apparent_temp_mean": _mean(b["apparent_temperature"]),
            "apparent_temp_max": round(max(b["apparent_temperature"]), 2) if b["apparent_temperature"] else None,
            "humidity_mean": _mean(b["relative_humidity_2m"]),
            "dew_point_mean": _mean(b["dew_point_2m"]),
            "pressure_mean": _mean(b["surface_pressure"]),
            "precipitation_sum": round(sum(b["precipitation"]), 2) if b["precipitation"] else None,
            "wind_speed_max": round(max(b["wind_speed_10m"]), 2) if b["wind_speed_10m"] else None,
            "cloud_cover_mean": _mean(b["cloud_cover"]),
            "daylight_hours": round(daylight[day] / 3600, 2) if day in daylight else None,
            "sunshine_hours": round(sum(sun) / 3600, 2) if sun else None,
            "night_temp_mean": _mean(b["night"]) if night_ok else None,
            "night_temp_min": round(min(b["night"]), 2) if night_ok else None,
            "night_hours": len(b["night"]),
            "n_hours": len(temps),
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "source": SOURCE,
        })
    return rows


def uv_daily_max(payload: dict, now_et: datetime) -> dict[str, float]:
    """Hourly UTC uv_index payload -> {ET clock day: highest value among the hours up to now}."""
    hourly = payload.get("hourly") if isinstance(payload, dict) else None
    if not isinstance(hourly, dict) or "time" not in hourly or "uv_index" not in hourly:
        raise ValueError("Open-Meteo answer has no hourly time/uv_index arrays")
    times, uv = hourly["time"], hourly["uv_index"]
    if len(times) != len(uv):
        raise ValueError(f"Open-Meteo hourly arrays differ in length ({len(times)}/{len(uv)})")
    cutoff = now_et.astimezone(timezone.utc)
    out: dict[str, float] = {}
    for stamp, value in zip(times, uv):
        utc, v = _utc_hour(stamp), _num(value)
        if utc is None or v is None or utc > cutoff:
            continue
        day = _et_local(utc).date().isoformat()
        out[day] = max(out.get(day, 0.0), v)
    return {day: round(v, 2) for day, v in out.items()}


def with_uv(rows: list[dict], uv: dict[str, float] | None) -> list[dict]:
    """Add the UV columns to every row, or to none.

    uv=None means the UV request failed: the keys are left out entirely, so the
    upsert does not touch values an earlier run stored. Every row of a batch must
    carry the same keys, hence all-or-nothing.
    """
    if uv is None:
        return rows
    return [{**r, "uv_index_max": uv.get(r["calendar_date"]),
             "uv_source": UV_SOURCE if r["calendar_date"] in uv else None} for r in rows]


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def get_supabase():
    """Service-role client. Imports are lazy so the pure helpers (and the tests) need no extras."""
    import os
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def _get_json(client: httpx.Client, url: str, params: dict) -> dict:
    try:
        return retry_http(lambda: client.get(url, params=params), max_attempts=4, log=log).json()
    except httpx.HTTPStatusError as exc:
        reason = ""
        try:
            reason = exc.response.json().get("reason", "")
        except Exception:  # noqa: BLE001 - body is not JSON
            reason = exc.response.text[:200]
        raise RuntimeError(f"Open-Meteo HTTP {exc.response.status_code}: {reason}") from exc


def fetch_hourly(client: httpx.Client, lat: float, lon: float, start: date, end: date) -> dict:
    """Hourly weather + daily daylight for the UTC dates [start, end]."""
    return _get_json(client, API_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(HOURLY_VARS),
        "daily": "daylight_duration",
        "timezone": "GMT",
        "start_date": start.isoformat(), "end_date": end.isoformat(),
    })


def fetch_uv(client: httpx.Client, lat: float, lon: float, start: date, end: date) -> dict:
    """Hourly UV index for the UTC dates [start, end] (historical-forecast API)."""
    return _get_json(client, UV_API_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": "uv_index",
        "timezone": "GMT",
        "start_date": start.isoformat(), "end_date": end.isoformat(),
    })


def log_sync(sb, status: str, records: int, started_at: float, error: str | None = None,
             date_range: tuple[date, date] | None = None) -> None:
    _shared_log_sync(
        sb, source="weather", data_type="daily", status=status, records=records,
        started_at=started_at, error=error,
        date_range_start=date_range[0] if date_range else None,
        date_range_end=date_range[1] if date_range else None,
    )


def _missing_table(exc: Exception) -> bool:
    msg = str(exc)
    return TABLE in msg and any(s in msg for s in ("PGRST205", "does not exist", "schema cache", "42P01"))


def run_etl(days: int | None, lat: float, lon: float, dry_run: bool = False, sb=None) -> int:
    """Fetch, aggregate and upsert. Returns the number of day rows written.

    days=None is the routine run: the last DEFAULT_DAYS days, or everything since
    BOOTSTRAP_START when the table is still empty. An explicit N always means exactly N days back.
    """
    started = time.time()
    now_et = datetime.now(ET)
    now_utc = now_et.astimezone(timezone.utc)
    today = now_et.date()
    written = 0
    first_day = last_day = None
    uv_problem = None
    try:
        if not dry_run:
            sb = sb or get_supabase()
        start = today - timedelta(days=days if days is not None else DEFAULT_DAYS)
        if not dry_run and days is None:
            # An empty table (first run, or right after the schema is applied) backfills itself.
            probe = sb.schema("pds").table(TABLE).select("calendar_date").limit(1).execute()
            if not probe.data:
                start = BOOTSTRAP_START
                log.info(f"  Table is empty: bootstrapping from {start}")
        log.info(f"Weather {start} -> {today} at ({lat}, {lon})")

        with httpx.Client(timeout=60.0) as client:
            for w_start, w_end in windows(start, today, CHUNK_DAYS):
                a_start, a_end = api_range(w_start, w_end, now_utc)
                rows = aggregate_daily(fetch_hourly(client, lat, lon, a_start, a_end), now_et, lat, lon)
                # The extra UTC date only completes the last ET day; its own partial row is not this window's.
                rows = [r for r in rows if w_start.isoformat() <= r["calendar_date"] <= w_end.isoformat()]
                if not rows:
                    log.info(f"  {w_start} -> {w_end}: no temperature values")
                    continue
                try:
                    uv = uv_daily_max(fetch_uv(client, lat, lon, a_start, a_end), now_et)
                except Exception as exc:  # noqa: BLE001 - UV is optional, the weather rows still land
                    uv = None
                    uv_problem = f"{type(exc).__name__}: {exc}"
                    log.warning(f"  {w_start} -> {w_end}: UV index unavailable ({uv_problem})")
                rows = with_uv(rows, uv)
                if dry_run:
                    for r in rows[-3:]:
                        log.info(f"  [dry-run] {r}")
                else:
                    stamp = datetime.now(timezone.utc).isoformat()
                    for i in range(0, len(rows), UPSERT_BATCH):
                        batch = [{**r, "synced_at": stamp} for r in rows[i:i + UPSERT_BATCH]]
                        sb.schema("pds").table(TABLE).upsert(batch, on_conflict="calendar_date").execute()
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
                     error="Open-Meteo returned no temperature values for the window (outage, or a bad location)",
                     date_range=rng)
            log.warning("No temperature values returned")
        elif uv_problem:
            log_sync(sb, "partial", written, started, date_range=rng,
                     error=f"Weather rows written, but the UV index request failed (UV columns left as they were): {uv_problem}"[:500])
            log.warning(f"Done with a UV gap: {written} day row(s) upserted")
        else:
            log_sync(sb, "success", written, started, date_range=rng)
            log.info(f"Done: {written} day row(s) upserted")
        return written
    except Exception as exc:  # noqa: BLE001 - heartbeat, then fail the Actions run
        if dry_run or sb is None:
            raise
        msg = f"{type(exc).__name__}: {exc}"
        if _missing_table(exc):
            msg = f"pds.weather_daily is missing - apply sql/weather_schema.sql. {msg}"
        if written:
            msg += f" (after {written} day row(s))"
        log.error(msg)
        log_sync(sb, "failed", written, started, error=msg[:500])
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Daily weather ETL - Open-Meteo -> pds.weather_daily")
    ap.add_argument("--backfill", type=int, help=f"re-sync the last N days (default {DEFAULT_DAYS})")
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
