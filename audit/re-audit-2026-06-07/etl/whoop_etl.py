"""
Personal Data Scientist — WHOOP ETL Pipeline
=============================================
Syncs WHOOP data to Supabase (Postgres 17) via OAuth2 API v2.

First run:
    python whoop_etl.py --auth          # Opens browser for OAuth2 login
    python whoop_etl.py                 # Sync last 30 days
    python whoop_etl.py --backfill 730  # Backfill ~2 years

Requirements:
    pip install requests supabase python-dotenv
"""

import os
import sys
import json
import time
import argparse
import logging
import webbrowser
import secrets
import hashlib
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
WHOOP_CLIENT_ID = os.environ["WHOOP_CLIENT_ID"]
WHOOP_CLIENT_SECRET = os.environ["WHOOP_CLIENT_SECRET"]
WHOOP_REDIRECT_URI = os.environ.get("WHOOP_REDIRECT_URI", "http://localhost:8080/callback")

WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
WHOOP_API_BASE = "https://api.prod.whoop.com/developer"

TOKEN_FILE = os.path.expanduser("~/.whoop_tokens.json")

SCOPES = "read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout offline"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("whoop_etl")

# ---------------------------------------------------------------------------
# OAuth2 Flow
# ---------------------------------------------------------------------------

class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Handles the OAuth2 redirect callback."""
    auth_code = None
    state = None

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        OAuthCallbackHandler.auth_code = params.get("code", [None])[0]
        OAuthCallbackHandler.state = params.get("state", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html><body><h2>WHOOP authorization successful!</h2>"
                         b"<p>You can close this tab and return to the terminal.</p></body></html>")

    def log_message(self, format, *args):
        pass  # Suppress HTTP server logs


def do_oauth_flow() -> dict:
    """Run the OAuth2 authorization code flow. Opens browser, waits for callback."""
    state = secrets.token_urlsafe(16)

    auth_params = {
        "response_type": "code",
        "client_id": WHOOP_CLIENT_ID,
        "redirect_uri": WHOOP_REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
    }
    auth_url = f"{WHOOP_AUTH_URL}?{urlencode(auth_params)}"

    log.info("Opening browser for WHOOP authorization...")
    log.info(f"If browser doesn't open, visit:\n{auth_url}")
    webbrowser.open(auth_url)

    # Parse redirect URI to get port
    parsed_redirect = urlparse(WHOOP_REDIRECT_URI)
    port = parsed_redirect.port or 8080

    server = HTTPServer(("localhost", port), OAuthCallbackHandler)
    log.info(f"Waiting for OAuth callback on localhost:{port}...")
    server.handle_request()
    server.server_close()

    if not OAuthCallbackHandler.auth_code:
        raise RuntimeError("No authorization code received")

    if OAuthCallbackHandler.state != state:
        raise RuntimeError("OAuth state mismatch — possible CSRF attack")

    # Exchange code for tokens
    token_data = {
        "grant_type": "authorization_code",
        "code": OAuthCallbackHandler.auth_code,
        "redirect_uri": WHOOP_REDIRECT_URI,
        "client_id": WHOOP_CLIENT_ID,
        "client_secret": WHOOP_CLIENT_SECRET,
    }
    resp = requests.post(WHOOP_TOKEN_URL, data=token_data)
    resp.raise_for_status()
    tokens = resp.json()
    tokens["obtained_at"] = datetime.now(timezone.utc).isoformat()

    save_tokens(tokens)
    log.info("OAuth tokens obtained and saved!")
    return tokens


def save_tokens(tokens: dict):
    """Save tokens to disk."""
    with open(TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2)


def load_tokens() -> dict:
    """Load tokens from disk."""
    if not os.path.exists(TOKEN_FILE):
        raise RuntimeError(
            f"No WHOOP tokens found at {TOKEN_FILE}. Run: python whoop_etl.py --auth"
        )
    with open(TOKEN_FILE, "r") as f:
        return json.load(f)


def refresh_access_token(tokens: dict) -> dict:
    """Refresh the access token using the refresh token."""
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("No refresh token available. Run: python whoop_etl.py --auth")

    token_data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": WHOOP_CLIENT_ID,
        "client_secret": WHOOP_CLIENT_SECRET,
    }
    resp = requests.post(WHOOP_TOKEN_URL, data=token_data)
    resp.raise_for_status()
    new_tokens = resp.json()
    new_tokens["obtained_at"] = datetime.now(timezone.utc).isoformat()

    save_tokens(new_tokens)
    log.info("Access token refreshed")
    return new_tokens


# ---------------------------------------------------------------------------
# API Client
# ---------------------------------------------------------------------------

class WhoopClient:
    """Simple WHOOP API v2 client with auto-refresh."""

    def __init__(self):
        self.tokens = load_tokens()
        self.session = requests.Session()
        self._set_auth_header()

    def _set_auth_header(self):
        self.session.headers["Authorization"] = f"Bearer {self.tokens['access_token']}"

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = f"{WHOOP_API_BASE}{path}"
        resp = self.session.request(method, url, **kwargs)

        # Auto-refresh on 401
        if resp.status_code == 401:
            log.info("Access token expired, refreshing...")
            self.tokens = refresh_access_token(self.tokens)
            self._set_auth_header()
            resp = self.session.request(method, url, **kwargs)

        # Rate limit handling
        if resp.status_code == 429:
            remaining = resp.headers.get("X-RateLimit-Remaining", "0")
            reset = int(resp.headers.get("X-RateLimit-Reset", "60"))
            log.warning(f"Rate limited. Waiting {reset}s...")
            time.sleep(reset)
            resp = self.session.request(method, url, **kwargs)

        resp.raise_for_status()
        return resp

    def get(self, path: str, **kwargs) -> dict:
        return self._request("GET", path, **kwargs).json()

    def get_paginated(self, path: str, start: str = None, end: str = None) -> list:
        """Fetch all pages from a paginated endpoint.

        WHOOP v2 contract (verified against developer.whoop.com/api):
          - Request param: nextToken (camelCase)
          - Response field: next_token (snake_case)

        Loop guard: if the API ever returns the same token twice in a row
        (indicating a regression or server-side bug), we'd otherwise spin
        forever. Track seen tokens and break with a warning instead.
        """
        all_records = []
        params = {}
        if start:
            params["start"] = start
        if end:
            params["end"] = end

        seen_tokens: set[str] = set()
        page_count = 0
        last_token: str | None = None
        while True:
            data = self.get(path, params=params)
            records = data.get("records", [])
            all_records.extend(records)
            page_count += 1

            next_token = data.get("next_token")
            if not next_token:
                break
            if next_token in seen_tokens:
                log.warning(
                    f"{path}: pagination token repeated ({next_token!r}); "
                    f"breaking after {page_count} pages to avoid infinite loop."
                )
                break
            seen_tokens.add(next_token)
            last_token = next_token
            params["nextToken"] = next_token
            time.sleep(0.3)  # Be gentle with rate limits

        log.info(
            f"{path}: fetched {len(all_records)} records across {page_count} page(s)"
            + (f" (final token={last_token})" if last_token else "")
        )
        return all_records

    def get_profile(self) -> dict:
        return self.get("/v1/user/profile/basic")

    def get_body_measurement(self) -> dict:
        return self.get("/v1/user/measurement/body")

    def get_cycles(self, start: str, end: str) -> list:
        return self.get_paginated("/v1/cycle", start=start, end=end)

    def get_recovery(self, start: str, end: str) -> list:
        return self.get_paginated("/v2/recovery", start=start, end=end)

    def get_sleep(self, start: str, end: str) -> list:
        return self.get_paginated("/v2/activity/sleep", start=start, end=end)

    def get_workouts(self, start: str, end: str) -> list:
        return self.get_paginated("/v2/activity/workout", start=start, end=end)


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def get_supabase_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def upsert_to_supabase(sb: Client, table: str, rows: list[dict],
                        conflict_columns: str) -> int:
    if not rows:
        return 0
    result = (
        sb.schema("pds")
        .table(table)
        .upsert(rows, on_conflict=conflict_columns)
        .execute()
    )
    return len(result.data) if result.data else 0


def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start=None, date_end=None,
             error: str = None, duration: float = None):
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=duration) if duration is not None else end
    try:
        sb.schema("pds").table("sync_log").insert({
            "source": source,
            "data_type": data_type,
            "status": status,
            "records_synced": records,
            "date_range_start": date_start.isoformat() if date_start else None,
            "date_range_end": date_end.isoformat() if date_end else None,
            "error_message": error,
            "duration_seconds": duration,
            "sync_start": start.isoformat(),
            "sync_end": end.isoformat(),
        }).execute()
    except Exception as e:
        log.warning(f"Failed to write sync log: {e}")


def safe_get(data: dict, *keys, default=None):
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key, default)
        else:
            return default
    return current


# ---------------------------------------------------------------------------
# Sync functions
# ---------------------------------------------------------------------------

def sync_cycles(whoop: WhoopClient, sb: Client, start: str, end: str) -> int:
    """Sync WHOOP cycles."""
    cycles = whoop.get_cycles(start, end)
    if not cycles:
        return 0

    rows = []
    for c in cycles:
        score = c.get("score") or {}
        rows.append({
            "cycle_id": c["id"],
            "user_id": c.get("user_id"),
            "created_at": c.get("created_at"),
            "updated_at": c.get("updated_at"),
            "start_time": c["start"],
            "end_time": c.get("end"),
            "timezone_offset": c.get("timezone_offset"),
            "score_state": c.get("score_state"),
            "strain": score.get("strain"),
            "kilojoule": score.get("kilojoule"),
            "average_heart_rate": score.get("average_heart_rate"),
            "max_heart_rate": score.get("max_heart_rate"),
            "raw_json": c,
        })

    return upsert_to_supabase(sb, "whoop_cycles", rows, "cycle_id")


def sync_recovery(whoop: WhoopClient, sb: Client, start: str, end: str) -> int:
    """Sync WHOOP recovery data."""
    recoveries = whoop.get_recovery(start, end)
    if not recoveries:
        return 0

    rows = []
    for r in recoveries:
        score = r.get("score") or {}
        rows.append({
            "cycle_id": r["cycle_id"],
            "sleep_id": r.get("sleep_id"),
            "user_id": r.get("user_id"),
            "created_at": r.get("created_at"),
            "updated_at": r.get("updated_at"),
            "score_state": r.get("score_state"),
            "recovery_score": score.get("recovery_score"),
            "resting_heart_rate": score.get("resting_heart_rate"),
            "hrv_rmssd_milli": score.get("hrv_rmssd_milli"),
            "spo2_percentage": score.get("spo2_percentage"),
            "skin_temp_celsius": score.get("skin_temp_celsius"),
            "user_calibrating": score.get("user_calibrating"),
            "raw_json": r,
        })

    return upsert_to_supabase(sb, "whoop_recovery", rows, "cycle_id")


def sync_sleep(whoop: WhoopClient, sb: Client, start: str, end: str) -> int:
    """Sync WHOOP sleep data."""
    sleeps = whoop.get_sleep(start, end)
    if not sleeps:
        return 0

    rows = []
    for s in sleeps:
        score = s.get("score") or {}
        stage = score.get("stage_summary") or {}
        need = score.get("sleep_needed") or {}

        rows.append({
            "sleep_id": s["id"],
            "cycle_id": s.get("cycle_id"),
            "user_id": s.get("user_id"),
            "created_at": s.get("created_at"),
            "updated_at": s.get("updated_at"),
            "start_time": s["start"],
            "end_time": s.get("end"),
            "timezone_offset": s.get("timezone_offset"),
            "is_nap": s.get("nap", False),
            "score_state": s.get("score_state"),
            # Stage summary
            "total_in_bed_time_milli": stage.get("total_in_bed_time_milli"),
            "total_awake_time_milli": stage.get("total_awake_time_milli"),
            "total_no_data_time_milli": stage.get("total_no_data_time_milli"),
            "total_light_sleep_time_milli": stage.get("total_light_sleep_time_milli"),
            "total_slow_wave_sleep_time_milli": stage.get("total_slow_wave_sleep_time_milli"),
            "total_rem_sleep_time_milli": stage.get("total_rem_sleep_time_milli"),
            "sleep_cycle_count": stage.get("sleep_cycle_count"),
            "disturbance_count": stage.get("disturbance_count"),
            # Sleep need
            "baseline_milli": need.get("baseline_milli"),
            "need_from_sleep_debt_milli": need.get("need_from_sleep_debt_milli"),
            "need_from_recent_strain_milli": need.get("need_from_recent_strain_milli"),
            "need_from_recent_nap_milli": need.get("need_from_recent_nap_milli"),
            # Performance
            "respiratory_rate": score.get("respiratory_rate"),
            "sleep_performance_percentage": score.get("sleep_performance_percentage"),
            "sleep_consistency_percentage": score.get("sleep_consistency_percentage"),
            "sleep_efficiency_percentage": score.get("sleep_efficiency_percentage"),
            "raw_json": s,
        })

    return upsert_to_supabase(sb, "whoop_sleep", rows, "sleep_id")


def sync_workouts(whoop: WhoopClient, sb: Client, start: str, end: str) -> int:
    """Sync WHOOP workout data."""
    workouts = whoop.get_workouts(start, end)
    if not workouts:
        return 0

    rows = []
    for w in workouts:
        score = w.get("score") or {}
        zones = score.get("zone_duration") or {}

        rows.append({
            "workout_id": w["id"],
            "user_id": w.get("user_id"),
            "created_at": w.get("created_at"),
            "updated_at": w.get("updated_at"),
            "start_time": w["start"],
            "end_time": w.get("end"),
            "timezone_offset": w.get("timezone_offset"),
            "sport_id": w.get("sport_id"),
            "sport_name": w.get("sport_name"),
            "score_state": w.get("score_state"),
            "strain": score.get("strain"),
            "average_heart_rate": score.get("average_heart_rate"),
            "max_heart_rate": score.get("max_heart_rate"),
            "kilojoule": score.get("kilojoule"),
            "percent_recorded": score.get("percent_recorded"),
            "distance_meter": score.get("distance_meter"),
            "altitude_gain_meter": score.get("altitude_gain_meter"),
            "altitude_change_meter": score.get("altitude_change_meter"),
            "zone_zero_milli": zones.get("zone_zero_milli"),
            "zone_one_milli": zones.get("zone_one_milli"),
            "zone_two_milli": zones.get("zone_two_milli"),
            "zone_three_milli": zones.get("zone_three_milli"),
            "zone_four_milli": zones.get("zone_four_milli"),
            "zone_five_milli": zones.get("zone_five_milli"),
            "raw_json": w,
        })

    return upsert_to_supabase(sb, "whoop_workouts", rows, "workout_id")


def sync_body_measurement(whoop: WhoopClient, sb: Client) -> int:
    """Sync WHOOP body measurement (singleton — snapshot over time)."""
    try:
        bm = whoop.get_body_measurement()
    except Exception as e:
        log.debug(f"  body_measurement: no data ({e})")
        return 0

    if not bm:
        return 0

    row = {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "height_meter": bm.get("height_meter"),
        "weight_kilogram": bm.get("weight_kilogram"),
        "max_heart_rate": bm.get("max_heart_rate"),
        "raw_json": bm,
    }

    return upsert_to_supabase(sb, "whoop_body_measurements", [row], "measured_at")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="WHOOP ETL — Supabase")
    parser.add_argument("--auth", action="store_true",
                        help="Run OAuth2 authorization flow")
    parser.add_argument("--backfill", type=int, default=None,
                        help="Number of days to backfill (e.g., 730 for ~2 years)")
    parser.add_argument("--days", type=int, default=30,
                        help="Number of recent days to sync (default: 30)")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — WHOOP ETL")
    log.info("=" * 60)

    # OAuth flow
    if args.auth:
        do_oauth_flow()
        log.info("Authorization complete! You can now run syncs.")
        return

    # Connect
    whoop = WhoopClient()
    sb = get_supabase_client()

    # Determine date range
    now = datetime.now(timezone.utc)
    if args.backfill:
        days = args.backfill
    else:
        days = args.days

    start_dt = now - timedelta(days=days)
    start_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_iso = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    log.info(f"Syncing {days} days: {start_dt.date()} — {now.date()}")

    # Profile check
    profile_started = time.time()
    try:
        profile = whoop.get_profile()
        log.info(f"Authenticated as: {profile.get('first_name')} {profile.get('last_name')}")
    except Exception as e:
        # Audit fix: previously returned without writing a sync_log row, so
        # /status saw silence on every run with a broken token / WHOOP outage.
        # Per CLAUDE.md: every ETL run emits a heartbeat, success AND failure.
        msg = f"WHOOP profile check failed: {e}"
        log.error(msg)
        log_sync(
            sb, "whoop", "full_sync", "failed",
            records=0, error=msg,
            duration=time.time() - profile_started,
        )
        return

    # Sync all data types
    t0 = time.time()
    total_records = 0
    errors = 0

    sync_tasks = [
        ("cycles", lambda: sync_cycles(whoop, sb, start_iso, end_iso)),
        ("recovery", lambda: sync_recovery(whoop, sb, start_iso, end_iso)),
        ("sleep", lambda: sync_sleep(whoop, sb, start_iso, end_iso)),
        ("workouts", lambda: sync_workouts(whoop, sb, start_iso, end_iso)),
        ("body_measurement", lambda: sync_body_measurement(whoop, sb)),
    ]

    for name, sync_fn in sync_tasks:
        try:
            count = sync_fn()
            total_records += count
            log.info(f"  {name}: {count} records synced")
            time.sleep(0.5)  # Brief pause between endpoints
        except Exception as e:
            errors += 1
            log.error(f"  {name}: ERROR - {e}")

    # Refresh materialized views
    log.info("Refreshing materialized views...")
    try:
        sb.schema("pds").rpc("refresh_materialized_views").execute()
        log.info("  Materialized views refreshed")
    except Exception as e:
        log.warning(f"  Materialized view refresh failed: {e}")

    duration = time.time() - t0

    log_sync(sb, "whoop", "full_sync", "success" if errors == 0 else "partial",
             records=total_records, date_start=start_dt.date(), date_end=now.date(),
             duration=duration,
             error=f"{errors} endpoint(s) failed" if errors else None)

    log.info("=" * 60)
    log.info(f"Done! {total_records} total records | {errors} errors | {duration:.1f}s")
    log.info("=" * 60)

    # ADR-0001 Phase 4 step 4 (extended): auto-extend user_tz_log from any
    # WHOOP cycle whose timezone_offset disagrees with the log. Catches the
    # case where Riley travels but doesn't do a GPS-tracked activity
    # (rest trip, watch off, etc.) — WHOOP is always-worn so this is the
    # most reliable trip-detector we have. IANA is history-inferred since
    # WHOOP gives offset not IANA; manual entries always win and are never
    # overridden. Silently skips if anything goes wrong (ETL still succeeds).
    try:
        import subprocess
        since_iso = start_dt.date().isoformat()
        log.info(f"Running whoop_tz_backfill --since {since_iso} --apply…")
        subprocess.run(
            [sys.executable, "whoop_tz_backfill.py", "--since", since_iso, "--apply"],
            check=False, timeout=120,
        )
    except Exception as e:
        log.warning(f"  whoop_tz_backfill skipped: {e}")


if __name__ == "__main__":
    # Belt-and-suspenders top-level heartbeat: any uncaught exception inside
    # main() (e.g. token refresh failure before the per-endpoint try/except
    # blocks, or import/config errors) gets a sync_log row so /status sees
    # the failure rather than silently going stale. Skipped for --auth, which
    # is interactive bootstrap, not a scheduled run.
    _is_auth_run = "--auth" in sys.argv
    _t_main_start = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — top-level safety net
        if not _is_auth_run:
            try:
                _sb_for_log = get_supabase_client()
                log_sync(
                    _sb_for_log, "whoop", "full_sync", "failed",
                    records=0, error=f"Uncaught exception: {exc}",
                    duration=time.time() - _t_main_start,
                )
            except Exception as log_exc:  # noqa: BLE001
                log.error(f"Could not write failure sync_log row: {log_exc}")
        raise
