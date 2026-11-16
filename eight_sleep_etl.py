"""
Personal Data Scientist — Eight Sleep ETL Pipeline
====================================================
Syncs Eight Sleep trend/sleep data to Supabase (Postgres 17).

Usage:
    python eight_sleep_etl.py                    # Sync last 7 days (daily run)
    python eight_sleep_etl.py --backfill 730     # Backfill ~2 years of history
    python eight_sleep_etl.py --backfill 30      # Backfill last 30 days
    python eight_sleep_etl.py --date 2025-06-15  # Sync a specific date
    python eight_sleep_etl.py --selfheal-max 0   # Skip the temp self-heal step
    python eight_sleep_etl.py --selfheal-days 200  # Heal NULL temps up to 200 days back

Requirements:
    pip install httpx supabase python-dotenv
"""

import os
import re
import json
import time
import argparse
import logging
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

from retry_helper import retry_http
from sync_log_helper import log_sync

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EIGHTSLEEP_EMAIL = os.environ["EIGHTSLEEP_EMAIL"]
EIGHTSLEEP_PASSWORD = os.environ["EIGHTSLEEP_PASSWORD"]
# The zone the trends API slices its days in (passed as ?tz=...). Date
# contract (docs/eight-sleep-date-contract.md, checked on live data
# 2026-11-16): a trend `day` is the WAKE-UP date, i.e. the local date in this
# zone of the night's end (presenceEnd / sleepEnd), and it is stored as
# calendar_date unchanged. Nothing corrects it downstream: the table has no
# start_time column, and its trigger (pds.set_onyx_dates_calendar_passthrough)
# copies calendar_date into all three onyx_* dates. That is right because the
# Pod is stationary, so this is the BED's zone, not the wearer's: a night spent
# away leaves no session here, and a night in the bed stays home-dated even
# while user_tz_log still shows a trip. Interval values attach to a trend day
# by session id (never by their own timestamp; a day with several sessions and
# no mainSessionId gets none), and no row is written without a trend day. If
# the Pod moves to a zone with another UTC offset, change this variable (the
# scheduled run sets it in .github/workflows/eight-sleep-etl.yml); until then
# a session reporting such a zone turns the run `partial`
# (GUARD eight_sleep_bed_tz). Supersedes audit re-2026-05-26 P3 (deepseek etl
# F-007) and re-2026-06-07 etl gpt-5/F-002 + deepseek/F-006.
EIGHTSLEEP_TIMEZONE = os.environ.get("EIGHTSLEEP_TIMEZONE", "America/New_York")

AUTH_URL = "https://auth-api.8slp.net/v1/tokens"
CLIENT_API_URL = "https://client-api.8slp.net/v1"
APP_API_URL = "https://app-api.8slp.net"
CLIENT_ID = os.environ.get("EIGHTSLEEP_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("EIGHTSLEEP_CLIENT_SECRET", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("eight_sleep_etl")

# HTTP client loggers. httpx logs every request at INFO with its full URL, and
# the temp self-heal's URLs carry the provider's user and session ids
# (/users/{id}/intervals/{session id}) and the healed row's date (the
# PostgREST filter calendar_date=eq.<date>). The Actions log is public.
HTTP_LOGGERS = ("httpx", "httpcore", "hpack", "h2")


@contextmanager
def quiet_http_logs(level: int = logging.ERROR):
    """Raise the HTTP client loggers to `level` while the block (or a function
    decorated with @quiet_http_logs()) runs, then put their levels back.

    A failed request still reaches the caller as an exception, which it counts
    or logs by type, so nothing is lost but the request lines.
    """
    loggers = [logging.getLogger(n) for n in HTTP_LOGGERS]
    saved = [lg.level for lg in loggers]
    for lg in loggers:
        lg.setLevel(max(lg.level, level))
    try:
        yield
    finally:
        for lg, lvl in zip(loggers, saved):
            lg.setLevel(lvl)


# A database error code worth keeping: a PostgREST code (PGRST205), a Postgres
# SQLSTATE (42P01) or the HTTP status postgrest-py puts in `code` when the
# response body is not JSON (502). Anything else is dropped.
_SAFE_ERROR_CODE = re.compile(r"^(?:PGRST\d{3}|[0-9A-Z]{5}|\d{3})$")


def _safe_error(exc: BaseException) -> str:
    """An exception as text safe for the public Actions log and the heartbeat.

    The type name, plus the HTTP status of a provider error or the code of a
    database error when it has one. Never str(exc): a provider error quotes
    its request URL (user and session ids), and a database error can carry
    the response body (postgrest-py puts a non-JSON body in `details`, and
    its message is part of str()).
    """
    name = type(exc).__name__
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{name} {exc.response.status_code}"
    code = getattr(exc, "code", None)
    if isinstance(code, str) and _SAFE_ERROR_CODE.match(code):
        return f"{name} {code}"
    return name


# ---------------------------------------------------------------------------
# Eight Sleep API Client (OAuth2)
# ---------------------------------------------------------------------------

class EightSleepClient:
    """Minimal Eight Sleep API client using OAuth2 password grant."""

    def __init__(self, email: str, password: str, tz: str):
        self.email = email
        self.password = password
        self.timezone = tz
        self.token: str | None = None
        self.user_id: str | None = None
        self.http = httpx.Client(timeout=30)

    def authenticate(self):
        """Obtain bearer token via OAuth2 password grant."""
        # Re-audit 2026-06-07 (etl/gpt-5/F-003): the auth/token POST is left
        # un-retried deliberately. retry_http would re-issue the password grant
        # on a 5xx, and a 4xx (bad creds / locked account) must surface
        # immediately rather than be masked behind retry latency; the data-fetch
        # GET calls below carry the retry/backoff that the finding is about.
        resp = self.http.post(AUTH_URL, json={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "password",
            "username": self.email,
            "password": self.password,
        })
        resp.raise_for_status()
        data = resp.json()
        self.token = data["access_token"]
        self.user_id = data["userId"]
        log.info(f"Eight Sleep: authenticated (user_id={self.user_id})")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def get_me(self) -> dict:
        """Get current user profile to discover device & bed sides."""
        # Re-audit 2026-06-07 (etl/gpt-5/F-003): wrap the data-fetch GET in
        # retry_http (5xx / 429 / network retried, up to 3 attempts). retry_http
        # calls .raise_for_status() itself, so the explicit call is dropped.
        resp = retry_http(
            lambda: self.http.get(
                f"{CLIENT_API_URL}/users/me", headers=self._headers()
            ),
            max_attempts=3, log=log,
        )
        return resp.json()

    def get_device(self, device_id: str) -> dict:
        """Get device info."""
        # Re-audit 2026-06-07 (etl/gpt-5/F-003): wrap in retry_http.
        resp = retry_http(
            lambda: self.http.get(
                f"{CLIENT_API_URL}/devices/{device_id}",
                headers=self._headers(),
            ),
            max_attempts=3, log=log,
        )
        return resp.json()

    def get_trends(self, user_id: str, start: str, end: str) -> list[dict]:
        """Fetch trend data for a date range. Returns list of day dicts."""
        # Re-audit 2026-06-07 (etl/gpt-5/F-003): wrap in retry_http.
        resp = retry_http(
            lambda: self.http.get(
                f"{CLIENT_API_URL}/users/{user_id}/trends",
                headers=self._headers(),
                params={
                    "tz": self.timezone,
                    "from": start,
                    "to": end,
                    "include-main": "false",
                    "include-all-sessions": "true",
                    "model-version": "v2",
                },
            ),
            max_attempts=3, log=log,
        )
        return resp.json().get("days", [])

    def get_intervals(self, user_id: str) -> list[dict]:
        """Fetch all available interval/session data."""
        # Re-audit 2026-06-07 (etl/gpt-5/F-003): wrap in retry_http.
        resp = retry_http(
            lambda: self.http.get(
                f"{CLIENT_API_URL}/users/{user_id}/intervals",
                headers=self._headers(),
            ),
            max_attempts=3, log=log,
        )
        return resp.json().get("intervals", [])

    def get_interval(self, user_id: str, session_id: str) -> dict | None:
        """Fetch ONE interval (with timeseries) by session ID; None on 404.

        Unlike the /intervals collection (capped at the 10 most recent
        sessions), this per-ID endpoint serves sessions of any age.

        Used only by the temp self-heal and eight_sleep_temp_backfill.py, whose
        log is the public Actions log: a retried network error is logged by
        type only (quote_errors=False), because its text is not ours and can
        quote the request (user and session ids). The final error still
        propagates and the heal counts it by type and code (_safe_error).
        """
        try:
            resp = retry_http(
                lambda: self.http.get(
                    f"{CLIENT_API_URL}/users/{user_id}/intervals/{session_id}",
                    headers=self._headers(),
                ),
                max_attempts=3, log=log, quote_errors=False,
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise
        return resp.json()

    def close(self):
        self.http.close()


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dicts."""
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            return default
    return current


def avg_timeseries(timeseries: list | None) -> float | None:
    """Compute average from a list of [timestamp, value] pairs."""
    if not timeseries:
        return None
    total = sum(entry[1] for entry in timeseries)
    return round(total / len(timeseries), 2)


def median_timeseries(timeseries: list | None) -> float | None:
    """Compute median from a list of [timestamp, value] pairs."""
    if not timeseries:
        return None
    values = sorted(entry[1] for entry in timeseries)
    mid = len(values) // 2
    if len(values) % 2:
        return round(values[mid], 2)
    return round((values[mid - 1] + values[mid]) / 2, 2)


def sum_timeseries(timeseries: list | None) -> int | None:
    """Compute sum from a list of [timestamp, value] pairs."""
    if not timeseries:
        return None
    return int(sum(entry[1] for entry in timeseries))


def upsert_to_supabase(sb: Client, table: str, rows: list[dict],
                        conflict_columns: str):
    if not rows:
        return 0
    # return=representation is spelled out (not left to the client default) so
    # the row count below, which feeds sync_log.records_synced, can never
    # silently become 0 if a client version flips its default to minimal.
    result = (
        sb.schema("pds")
        .table(table)
        .upsert(rows, on_conflict=conflict_columns, returning="representation")
        .execute()
    )
    return len(result.data) if result.data else 0


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def parse_trend_day(day: dict, bed_side: str) -> dict | None:
    """Parse a trend day dict into a database row.

    The v2 trends API includes scores AND biometric averages in
    sleepQualityScore / sleepRoutineScore / sleepFitnessScore.
    """
    day_str = day.get("day")
    if not day_str:
        return None

    if day.get("processing"):
        return None

    # Eight Sleep's day-level payload is internally inconsistent on multi-session
    # days (main sleep + nap): top-level `sleepDuration` reports only the main
    # session, but top-level `deepDuration` / `lightDuration` / `remDuration` sum
    # across all sessions. Computing `awake = presenceDuration - sleepDuration`
    # therefore understated awake on nap days, while stage totals overstated
    # time-in-bed. Sum the per-session `stageSummary` fields instead — those are
    # internally consistent per session, and summing gives correct day totals.
    sessions = day.get("sessions") or []
    main_session_id = day.get("mainSessionId")
    stage_sums = {"sleepDuration": 0, "awakeDuration": 0, "lightDuration": 0,
                  "deepDuration": 0, "remDuration": 0}
    main_session_sums = {"sleepDuration": None, "awakeDuration": None,
                          "lightDuration": None, "deepDuration": None,
                          "remDuration": None}
    have_session_summaries = False
    for s in sessions:
        summary = s.get("stageSummary") or {}
        if not summary:
            continue
        have_session_summaries = True
        for k in stage_sums:
            v = summary.get(k)
            if v is not None:
                stage_sums[k] += v
        # Capture the main session separately for cross-device comparisons.
        # WHOOP filters is_nap=false (main-only), so for Bland-Altman / HRV
        # joins we need the symmetric Eight Sleep main-only value.
        if main_session_id and s.get("id") == main_session_id:
            for k in main_session_sums:
                main_session_sums[k] = summary.get(k)

    if have_session_summaries:
        sleep_duration = stage_sums["sleepDuration"]
        awake_seconds  = stage_sums["awakeDuration"]
        light_seconds  = stage_sums["lightDuration"]
        deep_seconds   = stage_sums["deepDuration"]
        rem_seconds    = stage_sums["remDuration"]
    else:
        # Fallback for older payloads without per-session stageSummary blocks.
        presence_duration = day.get("presenceDuration")
        sleep_duration = day.get("sleepDuration")
        awake_seconds = None
        if presence_duration is not None and sleep_duration is not None:
            awake_seconds = presence_duration - sleep_duration
        light_seconds = day.get("lightDuration")
        deep_seconds  = day.get("deepDuration")
        rem_seconds   = day.get("remDuration")

    # Sleep-onset latency: in-bed (presenceStart) → first sleep (sleepStart).
    # The v2 trends payload exposes a latencyAsleepSeconds.score (0-100) but
    # not the raw seconds, so we derive it from the timestamps.
    latency_asleep_seconds = None
    presence_start = day.get("presenceStart")
    sleep_start = day.get("sleepStart")
    if presence_start and sleep_start:
        try:
            ps = datetime.fromisoformat(presence_start.replace("Z", "+00:00"))
            ss = datetime.fromisoformat(sleep_start.replace("Z", "+00:00"))
            diff = int((ss - ps).total_seconds())
            if diff >= 0:
                latency_asleep_seconds = diff
        except (ValueError, TypeError):
            pass

    quality = day.get("sleepQualityScore", {}) or {}
    routine = day.get("sleepRoutineScore", {}) or {}
    fitness = day.get("sleepFitnessScore", {}) or {}

    return {
        "calendar_date": day_str,
        "bed_side": bed_side,
        # Scores
        "sleep_score": day.get("score"),
        "sleep_fitness_score": fitness.get("total"),
        "sleep_quality_score": quality.get("total"),
        "sleep_duration_score": safe_get(quality, "sleepDurationSeconds", "score"),
        "latency_asleep_score": safe_get(routine, "latencyAsleepSeconds", "score"),
        "latency_out_score": safe_get(routine, "latencyOutSeconds", "score"),
        "wakeup_consistency_score": safe_get(routine, "wakeupConsistency", "score"),
        "sleep_routine_score": routine.get("total"),
        # Biometrics (v2 trends include these in sleepQualityScore)
        "avg_heart_rate": safe_get(quality, "heartRate", "current"),
        "avg_hrv": safe_get(quality, "hrv", "current"),
        "avg_breath_rate": safe_get(quality, "respiratoryRate", "current"),
        # Environment — left null here so the upsert falls through to
        # parse_interval()'s median of per-minute readings. The trends
        # payload's sleepQualityScore block doesn't expose tempBedC/tempRoomC
        # (only HR/HRV/respiratoryRate get the .current/.average treatment),
        # so we always compute the per-night value from the interval timeseries.
        "median_bed_temp": None,
        "median_room_temp": None,
        # Sleep stages (seconds) — summed across all sessions per stageSummary
        # so multi-session days (main + nap) are internally consistent.
        "time_slept_seconds": sleep_duration,
        "awake_seconds": awake_seconds,
        "light_sleep_seconds": light_seconds,
        "deep_sleep_seconds": deep_seconds,
        "rem_sleep_seconds": rem_seconds,
        # Main-session-only stages (seconds) — isolated for cross-device
        # comparisons against WHOOP, which filters is_nap=false. Use these
        # (not the totals above) for Bland-Altman / HRV pipeline joins so the
        # comparison is apples-to-apples.
        "time_slept_main_session_seconds":  main_session_sums["sleepDuration"],
        "awake_main_session_seconds":       main_session_sums["awakeDuration"],
        "light_sleep_main_session_seconds": main_session_sums["lightDuration"],
        "deep_sleep_main_session_seconds":  main_session_sums["deepDuration"],
        "rem_sleep_main_session_seconds":   main_session_sums["remDuration"],
        # Other
        "toss_and_turns": day.get("tnt"),
        "latency_asleep_seconds": latency_asleep_seconds,
        # Snoring (Pod's microphone-based detection; cleanest signal is
        # duration — percent / event fields are sparse and inconsistent)
        "snore_duration_seconds": day.get("snoreDuration"),
        "heavy_snore_duration_seconds": day.get("heavySnoreDuration"),
        "session_date": day_str,
    }


def _parse_instant(value) -> datetime | None:
    """An Eight Sleep ISO instant ('...Z' or with an offset) as an aware datetime."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else None


def bed_tz_check(day: dict, tz: str) -> dict:
    """Compare the zone each session of a trend day reports with `tz`.

    Counts {"mismatch", "unknown"}: a mismatch is a session whose `timezone`
    has a different UTC offset than `tz` at the session's end (so the provider
    may be slicing days in the wrong zone: the Pod moved); a session without a
    readable zone or instant is unknown and is never treated as a match or a
    mismatch. Same-offset zones are not a mismatch (no date can differ).
    Whether the field is the Pod's own setting or an echo of ?tz= is not
    known; with every request in one zone the data cannot tell them apart.
    """
    out = {"mismatch": 0, "unknown": 0}
    try:
        ours = ZoneInfo(tz)
    except Exception:  # noqa: BLE001 — an unusable configured zone cannot be compared
        out["unknown"] = len(day.get("sessions") or [])
        return out
    for s in day.get("sessions") or []:
        if not isinstance(s, dict):
            out["unknown"] += 1
            continue
        instant = _parse_instant(s.get("presenceEnd")) or _parse_instant(s.get("ts"))
        name = s.get("timezone")
        try:
            theirs = ZoneInfo(name) if isinstance(name, str) and name else None
        except Exception:  # noqa: BLE001 — unknown zone name
            theirs = None
        if theirs is None or instant is None:
            out["unknown"] += 1
        elif instant.astimezone(theirs).utcoffset() != instant.astimezone(ours).utcoffset():
            out["mismatch"] += 1
    return out


def parse_interval(interval: dict, bed_side: str) -> dict | None:
    """Parse one /intervals session (bed / room temps, fallback biometrics).

    Returns its `session_id` instead of a date: the caller attaches it to the
    trend day whose mainSessionId names it. Dating an interval by its own
    `ts` (the session START) put every session that began before local
    midnight on the previous trend day, because a trend `day` is the wake-up
    date (docs/eight-sleep-date-contract.md). None without an id.
    """
    session_id = interval.get("id")
    if not session_id:
        return None
    ts = interval.get("timeseries", {}) or {}

    stages = interval.get("stages", [])
    stage_totals = {}
    for stage in (stages or []):
        stage_name = stage.get("stage")
        dur = stage.get("duration", 0)
        if stage_name and stage_name != "out":
            stage_totals[stage_name] = stage_totals.get(stage_name, 0) + dur

    return {
        "session_id": str(session_id),
        "bed_side": bed_side,
        "avg_heart_rate": avg_timeseries(ts.get("heartRate")),
        "avg_breath_rate": avg_timeseries(ts.get("respiratoryRate")),
        # Temps stored as MEDIAN of per-minute readings, not mean — robust to
        # the warm-up transient (bed cold when first in) and cool-off at wake.
        "median_bed_temp": median_timeseries(ts.get("tempBedC")),
        "median_room_temp": median_timeseries(ts.get("tempRoomC")),
        "toss_and_turns": sum_timeseries(ts.get("tnt")),
        "light_sleep_seconds": stage_totals.get("light"),
        "deep_sleep_seconds": stage_totals.get("deep"),
        "rem_sleep_seconds": stage_totals.get("rem"),
        "awake_seconds": stage_totals.get("awake"),
    }


def _prefer_trend(trend: dict, interval: dict, key: str):
    """Prefer trend[key], fall back to interval[key], treating 0 / 0.0 / False
    as valid trend values (not falsy holes).

    The naive `trend.get(key) or interval.get(key)` pattern silently overwrites
    legitimate zeros from the trends payload (e.g. awake_seconds=0 on a perfect
    sleep, deep_sleep_seconds=0 on a degraded reading, toss_and_turns=0) with
    whatever the interval API returned for the same key — which may be stale,
    absent, or computed differently.
    """
    v = trend.get(key)
    return v if v is not None else interval.get(key)


def _split_rows_by_temp(rows: list[dict]) -> list[list[dict]]:
    """Split upsert rows so a row with no temps never overwrites stored ones.

    A date whose session is no longer among the 10 the /intervals collection
    returns has both temps None here. Upserting that None would erase a temp
    stored (or self-healed) earlier, e.g. on a wide --days catch-up. Those
    rows are sent in their own batch without the two temp columns, so the
    stored values stay. (One request needs the same keys on every row, hence
    two batches.)
    """
    with_temp = [r for r in rows
                 if any(r.get(c) is not None for c in TEMP_COLUMNS)]
    without_temp = [{k: v for k, v in r.items() if k not in TEMP_COLUMNS}
                    for r in rows
                    if all(r.get(c) is None for c in TEMP_COLUMNS)]
    return [b for b in (with_temp, without_temp) if b]


def _strip_timeseries(data: dict) -> dict:
    """Return a copy with bulky timeseries arrays removed."""
    stripped = {}
    for k, v in data.items():
        if k == "timeseries":
            continue
        elif k == "sessions" and isinstance(v, list):
            sessions = []
            for s in v:
                if isinstance(s, dict):
                    sessions.append({sk: sv for sk, sv in s.items()
                                     if sk != "timeseries"})
            stripped[k] = sessions
        else:
            stripped[k] = v
    return stripped


# ---------------------------------------------------------------------------
# Sync logic
# ---------------------------------------------------------------------------

def _new_sync_stats() -> dict:
    return {"records": 0, "trend_chunks": 0, "trend_chunks_failed": 0,
            "intervals_matched": 0, "intervals_unmatched": 0,
            "intervals_without_id": 0, "interval_pairing_failed": 0,
            "bed_tz_mismatch": 0, "bed_tz_unknown": 0}


def sync_user(client: EightSleepClient, sb: Client, user_id: str,
              bed_side: str, start_date: date, end_date: date) -> dict:
    """Sync trend + interval data for one user/bed side.

    Every row is a trend `day` from the provider (calendar_date = that day,
    the wake-up date); interval values join it by the day's mainSessionId.
    An interval with no trend day this run (a night still processing, a
    failed trends chunk) writes nothing: a row built from an interval alone
    would carry NULL scores and raw_json and erase the stored ones. The next
    run (7-day window) or the temp self-heal picks it up by session id.
    Returns counters; `records` is the number of rows upserted.
    """
    stats = _new_sync_stats()

    # 1. Fetch intervals (the 10 most recent sessions)
    log.info(f"  [{bed_side}] Fetching intervals...")
    try:
        intervals = client.get_intervals(user_id)
        log.info(f"  [{bed_side}] Got {len(intervals)} total intervals")
    except Exception as e:
        log.warning(f"  [{bed_side}] Intervals fetch failed: {e}")
        intervals = []

    interval_by_id: dict[str, dict] = {}
    # The start of EVERY item, with or without an id: the pairing check below
    # must also see sessions whose id is missing or renamed, or a payload
    # change that drops the id would look like a quiet window.
    session_starts: list[datetime] = []
    for interval in intervals:
        if not isinstance(interval, dict):
            stats["intervals_without_id"] += 1
            continue
        start = _parse_instant(interval.get("ts"))
        if start is not None:
            session_starts.append(start)
        parsed = parse_interval(interval, bed_side)
        if parsed:
            interval_by_id[parsed["session_id"]] = parsed
        else:
            stats["intervals_without_id"] += 1

    # 2. Fetch trends in 30-day chunks (v2 API includes biometrics)
    log.info(f"  [{bed_side}] Fetching trends...")
    chunk_size = 30
    trend_by_date: dict[str, dict] = {}
    raw_by_date: dict[str, dict] = {}

    current = start_date
    while current <= end_date:
        chunk_end = min(current + timedelta(days=chunk_size - 1), end_date)
        start_str = current.isoformat()
        end_str = chunk_end.isoformat()
        stats["trend_chunks"] += 1

        try:
            days = client.get_trends(user_id, start_str, end_str)
            for day in days:
                parsed = parse_trend_day(day, bed_side)
                if parsed:
                    trend_by_date[parsed["calendar_date"]] = parsed
                    raw_by_date[parsed["calendar_date"]] = day
        except Exception as e:
            stats["trend_chunks_failed"] += 1
            log.error(f"  [{bed_side}] Trends {start_str} → {end_str}: {e}")

        current = chunk_end + timedelta(days=1)
        time.sleep(0.5)

    # 3. Merge: one row per trend day; the interval is the day's main session
    used_sessions: set[str] = set()
    rows = []
    for d in sorted(trend_by_date):
        trend = trend_by_date[d]
        raw = raw_by_date.get(d)
        tz_check = bed_tz_check(raw or {}, EIGHTSLEEP_TIMEZONE)
        stats["bed_tz_mismatch"] += tz_check["mismatch"]
        stats["bed_tz_unknown"] += tz_check["unknown"]
        session_id = _session_id_from_raw(raw)
        interval = interval_by_id.get(session_id, {}) if session_id else {}
        if interval:
            used_sessions.add(session_id)

        row = {
            "calendar_date": d,
            "bed_side": bed_side,
            # Scores (trends only)
            "sleep_score": trend.get("sleep_score"),
            "sleep_fitness_score": trend.get("sleep_fitness_score"),
            "sleep_quality_score": trend.get("sleep_quality_score"),
            "sleep_duration_score": trend.get("sleep_duration_score"),
            "latency_asleep_score": trend.get("latency_asleep_score"),
            "latency_out_score": trend.get("latency_out_score"),
            "wakeup_consistency_score": trend.get("wakeup_consistency_score"),
            "sleep_routine_score": trend.get("sleep_routine_score"),
            # Biometrics — prefer trend (v2), fall back to interval
            "avg_heart_rate": _prefer_trend(trend, interval, "avg_heart_rate"),
            "avg_hrv": trend.get("avg_hrv"),
            "avg_breath_rate": _prefer_trend(trend, interval, "avg_breath_rate"),
            # Environment
            "median_bed_temp": _prefer_trend(trend, interval, "median_bed_temp"),
            "median_room_temp": _prefer_trend(trend, interval, "median_room_temp"),
            # Sleep stages — prefer trend, fall back to interval
            "time_slept_seconds": trend.get("time_slept_seconds"),
            "awake_seconds": _prefer_trend(trend, interval, "awake_seconds"),
            "light_sleep_seconds": _prefer_trend(trend, interval, "light_sleep_seconds"),
            "deep_sleep_seconds": _prefer_trend(trend, interval, "deep_sleep_seconds"),
            "rem_sleep_seconds": _prefer_trend(trend, interval, "rem_sleep_seconds"),
            # Main-session-only stages (trends only). These were computed in
            # parse_trend_day but dropped here until 2026-11-07, leaving the
            # columns NULL from 2026-05-24 and the Eight Sleep side of
            # /bland-altman empty.
            "time_slept_main_session_seconds": trend.get("time_slept_main_session_seconds"),
            "awake_main_session_seconds": trend.get("awake_main_session_seconds"),
            "light_sleep_main_session_seconds": trend.get("light_sleep_main_session_seconds"),
            "deep_sleep_main_session_seconds": trend.get("deep_sleep_main_session_seconds"),
            "rem_sleep_main_session_seconds": trend.get("rem_sleep_main_session_seconds"),
            # Other
            "toss_and_turns": _prefer_trend(trend, interval, "toss_and_turns"),
            "latency_asleep_seconds": trend.get("latency_asleep_seconds"),
            # Snoring (trends-only — intervals API doesn't expose these)
            "snore_duration_seconds": trend.get("snore_duration_seconds"),
            "heavy_snore_duration_seconds": trend.get("heavy_snore_duration_seconds"),
            "session_date": d,
            "raw_json": _strip_timeseries(raw) if raw else None,
        }
        rows.append(row)

    stats["intervals_matched"] = len(used_sessions)
    stats["intervals_unmatched"] = len(set(interval_by_id) - used_sessions)
    if stats["intervals_unmatched"]:
        # Most are the main sessions of nights outside the window and naps;
        # nothing is lost, they are only not written by date.
        log.info(f"  [{bed_side}] {stats['intervals_unmatched']} interval(s) are not "
                 "the main session of a trend day in this window (not written)")
    if stats["intervals_without_id"]:
        log.warning(f"  [{bed_side}] {stats['intervals_without_id']} interval(s) carry "
                    "no session id and cannot be paired with a trend day")
    # Pairing by id assumes /intervals items carry the same id as the trend
    # day's mainSessionId. If that ever stops holding, nothing pairs and the
    # sync silently stops writing temps; flag it when it can be told apart
    # from a quiet window: sessions started inside the window (or the evening
    # before it), counted over every item whether it had an id or not, trend
    # days with a known main session, and not one match. The session start
    # only places a session in or out of the window, it never dates a row.
    lo = start_date - timedelta(days=1)
    try:
        zone = ZoneInfo(EIGHTSLEEP_TIMEZONE)
        in_window = sum(1 for t in session_starts
                        if lo <= t.astimezone(zone).date() <= end_date)
    except Exception:  # noqa: BLE001 — an unusable zone: cannot tell, do not flag
        in_window = 0
    days_with_main = sum(1 for d in trend_by_date if _session_id_from_raw(raw_by_date.get(d)))
    if not used_sessions and in_window and days_with_main:
        stats["interval_pairing_failed"] = 1
        log.warning(f"  [{bed_side}] none of {in_window} interval(s) in the window "
                    f"paired with {days_with_main} trend day(s) by session id")

    if rows:
        count = 0
        for batch in _split_rows_by_temp(rows):
            count += upsert_to_supabase(
                sb, "eight_sleep_trends", batch, "calendar_date,bed_side"
            )
        log.info(f"  [{bed_side}] Upserted {count} records "
                 f"({start_date} → {end_date})")
        stats["records"] = count
        return stats

    log.info(f"  [{bed_side}] No data found")
    return stats


# ---------------------------------------------------------------------------
# Temp self-heal
# ---------------------------------------------------------------------------
# The /intervals collection only returns the 10 most recent sessions, so a
# pause of 10+ days (or a wide --days catch-up, which upserts NULL temps for
# dates the collection no longer covers) leaves median_bed_temp /
# median_room_temp NULL. The per-ID endpoint serves any session, and the
# trends rows already store mainSessionId, so each gap can be recovered.
# eight_sleep_temp_backfill.py runs this same function with no look-back bound.

SELFHEAL_MAX_ROWS = 20        # per-ID API calls per run, both sides combined
SELFHEAL_LOOKBACK_DAYS = 60   # only rows newer than this are scanned
SELFHEAL_SCAN_LIMIT = 500     # rows read from Postgres per run
SELFHEAL_DELAY_S = 0.3        # politeness delay between per-ID calls
TEMP_COLUMNS = ("median_bed_temp", "median_room_temp")


def _today() -> date:
    """Today in the Eight Sleep time zone (the trends API is sliced by it).

    A naive date.today() is the UTC date on the Actions runner, which is
    already tomorrow during the ET evening.
    """
    return datetime.now(ZoneInfo(EIGHTSLEEP_TIMEZONE)).date()


def _new_heal_stats() -> dict:
    return {"candidates": 0, "attempted": 0, "lookups": 0, "healed": 0,
            "no_temp": 0, "not_found": 0, "failed": 0, "skipped": 0,
            "over_cap": 0, "scan_error": None}


def _session_id_from_raw(raw) -> str | None:
    """The main session id of a trends payload (or of a stored raw_json).

    mainSessionId when present; else the day's one session, when sessionIds
    (a list) and the ids in sessions[] name exactly one distinct session. A
    day with several sessions and no mainSessionId has no known main session
    (the list order is not documented, so the first one may be a nap): None,
    never the first id, so nothing is paired with it and stored temps stay as
    they are. A sessionIds that is not a list counts as no ids. raw_json is a
    dict on current rows and a JSON string on older ones.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None
    if not isinstance(raw, dict):
        return None
    main_id = raw.get("mainSessionId")
    if main_id:
        return str(main_id)
    listed = raw.get("sessionIds")
    ids = {str(i) for i in listed if i} if isinstance(listed, list) else set()
    sessions = raw.get("sessions")
    if isinstance(sessions, list):
        ids |= {str(s["id"]) for s in sessions if isinstance(s, dict) and s.get("id")}
    return ids.pop() if len(ids) == 1 else None


# Decorated, so every caller (the ETL, the backfill script) gets the quiet
# HTTP loggers for the whole heal, lookups and UPDATEs alike.
@quiet_http_logs()
def self_heal_temps(client, sb: Client, users: dict[str, str], today: date,
                    max_rows: int = SELFHEAL_MAX_ROWS,
                    lookback_days: int | None = SELFHEAL_LOOKBACK_DAYS,
                    delay_s: float = SELFHEAL_DELAY_S,
                    dry_run: bool = False,
                    scan_limit: int = SELFHEAL_SCAN_LIMIT) -> dict:
    """Fill NULL median_bed_temp / median_room_temp from /intervals/{id}.

    Bounded: at most `max_rows` per-ID API calls per run. Rows with no usable
    session id or bed side cost nothing, and a session shared by both bed
    sides (one sleeper on a two-sided pod) is fetched once. When more
    sessions need a lookup than the cap allows, the starting point rotates
    with the date, so rows that can never be healed (a session without temp
    readings) cannot keep older, healable rows waiting forever.
    `lookback_days=None` scans every date (the one-off backfill).
    Idempotent and non-destructive: only columns that are NULL are written,
    and the UPDATE itself re-checks `IS NULL` so a concurrent writer is never
    overwritten. `dry_run=True` does the lookups but writes nothing.
    Today is excluded (the session may still be processing). One failing row
    never stops the others; it stays NULL and is retried next run.
    Nothing per row is logged (no date, value or provider id: the Actions log
    is public); the caller logs the counters. That covers the HTTP clients
    too: httpx's per-request INFO lines, whose URLs carry the user and session
    ids and the healed row's date, are turned down while it runs
    (quiet_http_logs), and an error is reported by type and code only
    (_safe_error), never its text; so is a network error retried inside a
    lookup (get_interval logs its retries by type). Returns counters;
    `scan_error` is set if the candidate query failed.
    """
    stats = _new_heal_stats()
    if max_rows <= 0:
        return stats
    try:
        q = (sb.schema("pds").from_("eight_sleep_trends")
             .select("calendar_date,bed_side,raw_json,"
                     "median_bed_temp,median_room_temp"))
        if lookback_days is not None:
            q = q.gte("calendar_date",
                      (today - timedelta(days=lookback_days)).isoformat())
        rows = (
            q.lt("calendar_date", today.isoformat())
            .or_("median_bed_temp.is.null,median_room_temp.is.null")
            .order("calendar_date", desc=True)
            .limit(scan_limit)
            .execute()
        ).data or []
    except Exception as e:  # noqa: BLE001 — heal must never fail the ETL
        # Type and code only (_safe_error): scan_error goes to the public log
        # and into both heartbeats, and the error text can carry the response
        # body or the request URL.
        stats["scan_error"] = f"candidate query failed ({_safe_error(e)})"
        log.warning(f"Self-heal: {stats['scan_error']}")
        return stats

    stats["candidates"] = len(rows)
    work: list[tuple[dict, tuple[str, str]]] = []
    for row in rows:
        user_id = users.get(row.get("bed_side"))
        session_id = _session_id_from_raw(row.get("raw_json"))
        if not user_id or not session_id:
            stats["skipped"] += 1
            continue
        work.append((row, (user_id, session_id)))

    # One API call per distinct (user, session), newest first, capped.
    keys = list(dict.fromkeys(key for _, key in work))
    if len(keys) > max_rows:
        start = (today.toordinal() * max_rows) % len(keys)
        keys = (keys[start:] + keys[:start])[:max_rows]
    chosen = set(keys)
    fetched: dict[tuple[str, str], object] = {}

    for row, key in work:
        if key not in chosen:
            stats["over_cap"] += 1
            continue
        cal, side = row.get("calendar_date"), row.get("bed_side")
        stats["attempted"] += 1
        try:
            if key not in fetched:
                stats["lookups"] += 1
                try:
                    fetched[key] = client.get_interval(*key)
                except Exception as e:  # noqa: BLE001 — remembered, not retried for the other side
                    fetched[key] = e
                time.sleep(delay_s)
            interval = fetched[key]
            if isinstance(interval, Exception):
                raise interval
            if interval is None:
                stats["not_found"] += 1
                continue
            ts = interval.get("timeseries") or {}
            found = {
                "median_bed_temp": median_timeseries(ts.get("tempBedC")),
                "median_room_temp": median_timeseries(ts.get("tempRoomC")),
            }
            # Never overwrite: only columns NULL on the row AND present in the interval.
            payload = {c: found[c] for c in TEMP_COLUMNS
                       if found[c] is not None and row.get(c) is None}
            if not payload:
                stats["no_temp"] += 1
                continue
            if not dry_run:
                q = (sb.schema("pds").from_("eight_sleep_trends").update(payload)
                     .eq("calendar_date", cal).eq("bed_side", side))
                for col in payload:
                    q = q.is_(col, "null")
                q.execute()
            stats["healed"] += 1
        except Exception as e:  # noqa: BLE001 — row stays NULL, retried next run
            stats["failed"] += 1
            # Type and status / code only: the Actions log is public, and the
            # message of a provider error can carry the user and session ids
            # in its URL.
            log.warning(f"  Self-heal: a lookup failed ({_safe_error(e)})")
    return stats


def _selfheal_summary(stats: dict, max_rows: int) -> str:
    return (f"healed {stats['healed']} of {stats['attempted']} rows tried "
            f"({stats['lookups']} lookups, cap {max_rows}; "
            f"{stats['candidates']} candidate rows); "
            f"failed={stats['failed']} no_temp={stats['no_temp']} "
            f"not_found={stats['not_found']} skipped={stats['skipped']} "
            f"over_cap={stats['over_cap']}"
            + (f"; {stats['scan_error']}" if stats["scan_error"] else ""))


def trends_problems(errors: int, sync_totals: dict,
                    heal_problem: str | None) -> list[str]:
    """What turns the `eight_sleep|trends` heartbeat partial, GUARD first.

    A bed-zone mismatch breaks the date contract (the provider may be slicing
    days in the wrong zone), so it leads the message with the GUARD prefix the
    devops agent reports to Riley instead of re-running. Counts only: never a
    zone name or a value (the Actions log is public).
    """
    problems: list[str] = []
    if sync_totals.get("bed_tz_mismatch"):
        problems.append(
            f"GUARD eight_sleep_bed_tz: {sync_totals['bed_tz_mismatch']} session(s) "
            "report a time zone whose UTC offset differs from EIGHTSLEEP_TIMEZONE, so "
            "their trend days may be dated in the wrong zone; if the Pod moved, set "
            "EIGHTSLEEP_TIMEZONE in .github/workflows/eight-sleep-etl.yml (a protected "
            "path, so Riley changes it; docs/eight-sleep-date-contract.md, case G)")
    if errors:
        problems.append(f"{errors} error(s)")
    if sync_totals.get("trend_chunks_failed"):
        problems.append(
            f"trends fetch failed for {sync_totals['trend_chunks_failed']} of "
            f"{sync_totals.get('trend_chunks', 0)} chunk(s); those days were not "
            "written and are retried next run")
    if sync_totals.get("intervals_without_id"):
        problems.append(
            f"{sync_totals['intervals_without_id']} /intervals item(s) carry no session "
            "id, so their temps cannot be paired with a trend day; check the /intervals "
            "payload shape (the self-heal still fills NULL temps of past days by per-ID "
            "lookup)")
    if sync_totals.get("interval_pairing_failed"):
        problems.append(
            f"no interval paired with a trend day by session id on "
            f"{sync_totals['interval_pairing_failed']} bed side(s) although sessions "
            "fall in the window, so the sync wrote no temps; check that /intervals "
            "ids still equal the trend mainSessionId (the self-heal still fills "
            "NULL temps of past days by per-ID lookup)")
    if heal_problem:
        problems.append(heal_problem)
    return problems


# ---------------------------------------------------------------------------
# Discover bed sides
# ---------------------------------------------------------------------------

def discover_users(client: EightSleepClient) -> dict[str, str]:
    """Return {bed_side: user_id} for all users on the device."""
    me = client.get_me()
    user_obj = me.get("user", me)
    current_device = user_obj.get("currentDevice", {})
    device_id = current_device.get("id")

    if not device_id:
        # Fallback: just use the authenticated user
        side = current_device.get("side", "left")
        log.info(f"Single user detected on '{side}' side")
        return {side: client.user_id}

    device = client.get_device(device_id)
    result = device.get("result", device)

    users = {}
    left_id = result.get("leftUserId")
    right_id = result.get("rightUserId")

    if left_id:
        users["left"] = left_id
    if right_id:
        users["right"] = right_id

    if not users:
        side = current_device.get("side", "left")
        users[side] = client.user_id

    log.info(f"Discovered bed sides: {list(users.keys())}")
    return users


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Eight Sleep ETL — Supabase")
    parser.add_argument("--backfill", type=int, default=None,
                        help="Number of days to backfill (e.g., 730 for ~2 years)")
    parser.add_argument("--days", type=int, default=7,
                        help="Number of recent days to sync (default: 7)")
    parser.add_argument("--date", type=str, default=None,
                        help="Sync a specific date (YYYY-MM-DD)")
    parser.add_argument("--side", type=str, default=None,
                        choices=["left", "right"],
                        help="Sync only one bed side (default: both)")
    parser.add_argument("--selfheal-max", type=int, default=SELFHEAL_MAX_ROWS,
                        help="Max per-ID interval lookups the post-sync temp "
                             f"self-heal may make (default: {SELFHEAL_MAX_ROWS}; "
                             "0 disables)")
    parser.add_argument("--selfheal-days", type=int,
                        default=SELFHEAL_LOOKBACK_DAYS,
                        help="How many days back the temp self-heal looks for "
                             f"NULL temps (default: {SELFHEAL_LOOKBACK_DAYS}; "
                             "raise once to recover an older gap)")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — Eight Sleep ETL")
    log.info("=" * 60)
    # Surface the configured TZ so a wrong env var on a travel day is
    # visible in the run log. Audit re-2026-05-26 P3 (deepseek etl F-007).
    log.info(f"Eight Sleep TZ (EIGHTSLEEP_TIMEZONE): {EIGHTSLEEP_TIMEZONE}")

    # Connect
    client = EightSleepClient(EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD,
                               EIGHTSLEEP_TIMEZONE)
    client.authenticate()
    sb = get_supabase_client()

    # Discover bed sides
    all_users = discover_users(client)
    if args.side:
        if args.side not in all_users:
            log.error(f"Side '{args.side}' not found. Available: {list(all_users.keys())}")
            return
        users = {args.side: all_users[args.side]}
    else:
        users = all_users

    # Determine date range
    today = _today()
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
    total_records = 0
    errors = 0
    sync_totals = _new_sync_stats()

    for side, user_id in users.items():
        try:
            side_stats = sync_user(client, sb, user_id, side, start, end)
            for k in sync_totals:
                sync_totals[k] += side_stats.get(k, 0)
            total_records += side_stats["records"]
        except Exception as e:
            errors += 1
            log.error(f"[{side}] Sync failed: {e}", exc_info=True)
    if sync_totals["bed_tz_unknown"]:
        log.info(f"{sync_totals['bed_tz_unknown']} session(s) report no readable "
                 "zone or end time (bed zone unknown, not counted as a move)")

    # Self-heal NULL temps the normal sync could not fill (before the matview
    # refresh so healed values reach daily_health_matrix this run). It never
    # fails the ETL: a problem here turns the heartbeats `partial`, with the
    # counts, and the rows stay NULL for the next run.
    heal = _new_heal_stats()
    heal_problem = None
    if args.selfheal_max > 0:
        heal_t0 = time.time()
        try:
            heal = self_heal_temps(client, sb, users, today,
                                   max_rows=args.selfheal_max,
                                   lookback_days=args.selfheal_days)
        except Exception as e:  # noqa: BLE001 — never fail the ETL on the heal step
            # Type and code only, no traceback: this text reaches the public
            # log and both heartbeats (the heal's URLs carry provider ids).
            heal["scan_error"] = f"self-heal crashed ({_safe_error(e)})"
            log.warning(f"Temp {heal['scan_error']}")
        summary = _selfheal_summary(heal, args.selfheal_max)
        log.info(f"Temp self-heal: {summary}" if heal["candidates"] or heal["scan_error"]
                 else "Temp self-heal: nothing to heal")
        if heal["failed"] or heal["scan_error"]:
            heal_problem = f"temp self-heal: {summary}"[:500]
        # Written on every run (0 = nothing to heal), so a missing row means
        # the step did not run, not that there was nothing to do.
        log_sync(sb, "eight_sleep", "temp_selfheal",
                 "partial" if heal_problem else "success",
                 records=heal["healed"], started_at=heal_t0,
                 date_range_start=today - timedelta(days=args.selfheal_days),
                 date_range_end=today,
                 error=heal_problem)

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.schema("pds").rpc("refresh_materialized_views", {}).execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    # The /status Eight Sleep card reads this row only, so a heal problem is
    # reported here too (the sync itself still counts its records).
    problems = trends_problems(errors, sync_totals, heal_problem)
    log_sync(sb, "eight_sleep", "trends", "partial" if problems else "success",
             records=total_records, started_at=t0,
             date_range_start=start, date_range_end=end,
             error="; ".join(problems) or None)

    log.info("=" * 60)
    log.info(f"Done! {total_records} total records | {heal['healed']} temps healed "
             f"| {errors} errors | {duration:.1f}s")
    log.info("=" * 60)

    client.close()


if __name__ == "__main__":
    # Re-audit 2026-06-07 (etl/deepseek/F-001): top-level failure heartbeat so an
    # uncaught exception surfaces on /status instead of silently going stale.
    import time as _time
    _t_main_start = _time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — top-level safety net
        try:
            _sb_for_log = get_supabase_client()
            log_sync(_sb_for_log, "eight_sleep", "trends", "failed",
                     records=0, error=f"Uncaught exception: {exc}",
                     started_at=_t_main_start)
        except Exception as log_exc:  # noqa: BLE001
            log.error(f"Could not write failure sync_log row: {log_exc}")
        raise
