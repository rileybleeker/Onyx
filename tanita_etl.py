"""
Tanita Health Planet → Supabase ETL

Pulls innerscan body-composition measurements (tag 6021 = weight kg,
tag 6022 = body fat %) from the Health Planet API (healthplanet.jp) and:
  1. upserts one row per measurement instant into pds.tanita_measurements
     (the ADR-0001 date quad is trigger-populated from measured_at)
  2. rolls up the earliest measurement per ET day into pds.weight_log
     (source='tanita'; manual /nutrition rows are never overwritten)

Usage:
    python tanita_etl.py --auth        # One-time OAuth bootstrap (local only)
    python tanita_etl.py --inspect     # Print newest raw measurement (TZ verification)
    python tanita_etl.py               # Sync last 14 days
    python tanita_etl.py --backfill N  # Backfill N days

API notes (https://www.healthplanet.jp/apis/api.html — Japanese):
  - Authorize: GET /oauth/auth?client_id&redirect_uri&scope=innerscan&
    response_type=code. With the "client application" registration type the
    redirect_uri is Health Planet's own success.html — the browser lands on
    success.html?code=XXXX and the user copy-pastes the code (10-minute TTL),
    same manual bootstrap shape as the Spotify flow but without a local
    callback server.
  - Token: POST /oauth/token, form params client_id/client_secret/
    redirect_uri/code/grant_type. access_token expires_in=2592000 (30 days).
    The refresh_token grant is UNDOCUMENTED but works; rotation behavior is
    unconfirmed upstream, so both returned tokens are persisted on every
    refresh, and we only refresh within 7 days of expiry (don't exercise an
    undocumented grant more than needed).
  - Data: GET /status/innerscan.json?access_token&date=1&from&to&tag.
    from/to are yyyyMMddHHmmss; spans >3 months are SILENTLY truncated (the
    API corrects `to` to from+3 months — no error), so backfills page in
    <=80-day windows. Rate limit: 60 requests/hour.
  - Response data[] carries ONE item per tag; items sharing (date, model)
    are one physical weigh-in. `date` is yyyyMMddHHmm (minute precision),
    timezone-naive. Tags 6023-6029 (muscle mass, BMR, ...) were retired from
    the public API on 2020-06-29 — only 6021/6022 come back.
  - date=1 windows filter on MEASUREMENT time, so a weigh-in that syncs to
    the cloud >14 days after it was taken (phone app offline that long)
    falls outside the default window — run `--backfill N` to recover it.
    date=0 (registration time) would catch late syncs but also swaps the
    RETURNED timestamp to registration time, corrupting measured_at — not
    worth it for a scale that syncs whenever the app opens.
"""

import os
import sys
import json
import time
import argparse
import logging
import urllib.parse
import webbrowser
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

from retry_helper import retry_http
from sync_log_helper import log_sync as _shared_log_sync

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

TANITA_CLIENT_ID = os.environ.get("TANITA_CLIENT_ID", "")
TANITA_CLIENT_SECRET = os.environ.get("TANITA_CLIENT_SECRET", "")

HP_BASE = "https://www.healthplanet.jp"
HP_AUTH_URL = f"{HP_BASE}/oauth/auth"
HP_TOKEN_URL = f"{HP_BASE}/oauth/token"
HP_INNERSCAN_URL = f"{HP_BASE}/status/innerscan.json"
# "Client application" registration type → Health Planet's own success page;
# the auth code is copy-pasted from the success.html?code=... address bar.
HP_REDIRECT_URI = "https://www.healthplanet.jp/success.html"
HP_SCOPE = "innerscan"

TAG_WEIGHT = "6021"
TAG_BODY_FAT = "6022"

TANITA_TOKEN_FILE = os.path.expanduser("~/.tanita_tokens.json")

DEFAULT_DAYS = 14
WINDOW_DAYS = 80          # defensive margin under the silent 3-month cap
REFRESH_AHEAD_SECONDS = 7 * 86400

ET = ZoneInfo("America/New_York")

# ---------------------------------------------------------------------------
# Timestamp semantics — VERIFIED EMPIRICALLY 2026-06-09. The API returns
# `date` as a TZ-naive yyyyMMddHHmm string and the spec is silent on
# timezone (every reference client is Japan-based, where JST == device-local
# — indistinguishable upstream). Verification: Riley weighed in at ~11:26 PM
# ET and the API returned raw `202606092326` — i.e. measured (date=1)
# timestamps carry the DEVICE-LOCAL wall clock, not JST (which would have
# read 202606101226). The scale lives at home in ET, so parse as
# America/New_York. Re-verify with `--inspect` if the scale ever moves
# time zones or the phone app's locale handling changes.
# ---------------------------------------------------------------------------
TANITA_TZ = ZoneInfo("America/New_York")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("tanita_etl")


def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def log_sync(sb: Client, status: str, records: int, started_at: float, error: str | None = None):
    _shared_log_sync(sb, source="tanita", data_type="weight",
                     status=status, records=records, started_at=started_at, error=error)


# ---------------------------------------------------------------------------
# Token handling
# ---------------------------------------------------------------------------

class TanitaAuthError(Exception):
    """Raised when Health Planet refuses the stored refresh token (expired/revoked).

    Distinct from transient HTTP errors so the ETL can write an actionable
    sync_log entry and exit 0 (no retry) instead of looping the cron on a
    permanently-broken token.
    """


REAUTH_INSTRUCTIONS = (
    "Health Planet refresh token rejected. Re-run `python tanita_etl.py --auth` "
    "locally then `python ci_token_helper.py upload tanita`."
)


def load_tokens() -> dict:
    # Raises (instead of sys.exit) so run_etl's pre-flight catch still writes
    # the failed heartbeat — SystemExit would escape both heartbeat nets and
    # leave /status silently stale on this path.
    if not os.path.exists(TANITA_TOKEN_FILE):
        raise TanitaAuthError(
            f"No Tanita tokens at {TANITA_TOKEN_FILE}. "
            "Run `python tanita_etl.py --auth` locally, then "
            "`python ci_token_helper.py upload tanita`."
        )
    with open(TANITA_TOKEN_FILE, "r") as f:
        return json.load(f)


def save_tokens(tokens: dict):
    with open(TANITA_TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2)
    log.info(f"Tanita tokens saved to {TANITA_TOKEN_FILE}")


def refresh_access_token(tokens: dict) -> dict:
    resp = httpx.post(
        HP_TOKEN_URL,
        data={
            "client_id": TANITA_CLIENT_ID,
            "client_secret": TANITA_CLIENT_SECRET,
            "redirect_uri": HP_REDIRECT_URI,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=30,
    )
    if resp.status_code in (400, 401):
        raise TanitaAuthError(f"{REAUTH_INSTRUCTIONS} (HTTP {resp.status_code}: {resp.text})")
    resp.raise_for_status()
    new = resp.json()
    if "error" in new:
        # Health Planet error shapes are undocumented; the token endpoint can
        # return 200 with an error key.
        raise TanitaAuthError(f"{REAUTH_INSTRUCTIONS} (token endpoint error: {new})")
    tokens["access_token"] = new["access_token"]
    tokens["expires_in"] = new.get("expires_in", 2592000)
    tokens["obtained_at"] = int(time.time())
    # Rotation behavior unconfirmed upstream — persist whatever comes back.
    if new.get("refresh_token"):
        tokens["refresh_token"] = new["refresh_token"]
        log.info("Refresh token rotated; saving new value.")
    save_tokens(tokens)
    return tokens


def ensure_fresh_tokens(tokens: dict) -> dict:
    """Refresh only within REFRESH_AHEAD_SECONDS of expiry.

    Access tokens last 30 days; with a daily cron this refreshes roughly
    monthly rather than every run — the refresh grant is undocumented, so we
    exercise it as little as possible.
    """
    expires_at = tokens.get("obtained_at", 0) + tokens.get("expires_in", 0)
    if expires_at - time.time() < REFRESH_AHEAD_SECONDS:
        log.info("Access token within 7 days of expiry; refreshing.")
        return refresh_access_token(tokens)
    return tokens


def run_auth_flow():
    """Print consent URL → user logs in + approves → paste code → exchange."""
    if not TANITA_CLIENT_ID or not TANITA_CLIENT_SECRET:
        log.error("TANITA_CLIENT_ID and TANITA_CLIENT_SECRET must be set in .env")
        sys.exit(1)

    params = {
        "client_id": TANITA_CLIENT_ID,
        "redirect_uri": HP_REDIRECT_URI,
        "scope": HP_SCOPE,
        "response_type": "code",
    }
    auth_url = f"{HP_AUTH_URL}?{urllib.parse.urlencode(params)}"

    print("\n1. Open this URL (log in to Health Planet if prompted, then allow access):")
    print(f"\n   {auth_url}\n")
    print("2. The browser lands on success.html — copy the `code` value from the")
    print("   address bar (https://www.healthplanet.jp/success.html?code=XXXX).")
    print("   The code expires in 10 minutes.\n")
    webbrowser.open(auth_url)

    code = input("Paste code: ").strip()
    if not code:
        log.error("Empty code; aborting.")
        sys.exit(1)

    log.info("Exchanging authorization code for tokens...")
    resp = httpx.post(
        HP_TOKEN_URL,
        data={
            "client_id": TANITA_CLIENT_ID,
            "client_secret": TANITA_CLIENT_SECRET,
            "redirect_uri": HP_REDIRECT_URI,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    resp.raise_for_status()
    tokens = resp.json()
    if "error" in tokens:
        log.error(f"Token exchange failed: {tokens}")
        sys.exit(1)
    tokens["obtained_at"] = int(time.time())
    save_tokens(tokens)
    log.info("OAuth bootstrap complete. Run `python ci_token_helper.py upload tanita` next.")


# ---------------------------------------------------------------------------
# Health Planet client
# ---------------------------------------------------------------------------

class TanitaClient:
    def __init__(self, tokens: dict):
        self.tokens = tokens
        self.http = httpx.Client(timeout=30)

    def _request(self, params: dict) -> httpx.Response:
        # Exactly ONE network request per attempt; retry_http wraps the whole
        # callable and calls .raise_for_status() itself — so do() must not.
        # access_token rides as a query param (no Bearer-header support).
        refreshed = {"done": False}

        def do() -> httpx.Response:
            resp = self.http.get(
                HP_INNERSCAN_URL,
                params={**params, "access_token": self.tokens["access_token"]},
            )
            if resp.status_code == 401 and not refreshed["done"]:
                log.info("Access token rejected; refreshing.")
                self.tokens = refresh_access_token(self.tokens)
                refreshed["done"] = True
                resp = self.http.get(
                    HP_INNERSCAN_URL,
                    params={**params, "access_token": self.tokens["access_token"]},
                )
            return resp

        return retry_http(do, max_attempts=3, log=log)

    def innerscan(self, from_dt: datetime, to_dt: datetime) -> list[dict]:
        """Fetch measured (date=1) weight + body-fat items for a local-time window."""
        params = {
            "date": "1",  # 1 = measurement date (0 = registration date)
            "from": from_dt.strftime("%Y%m%d%H%M%S"),
            "to": to_dt.strftime("%Y%m%d%H%M%S"),
            "tag": f"{TAG_WEIGHT},{TAG_BODY_FAT}",
        }
        resp = self._request(params)
        payload = resp.json()
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(f"innerscan returned error: {payload}")
        return payload.get("data") or []


def iter_windows(start: datetime, end: datetime):
    """Yield <=WINDOW_DAYS (from, to) pairs — spans over the API's 3-month cap
    are silently truncated server-side, so we page defensively."""
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=WINDOW_DAYS), end)
        yield cur, nxt
        cur = nxt


# ---------------------------------------------------------------------------
# Transform + load
# ---------------------------------------------------------------------------

def parse_measurements(items: list[dict]) -> list[dict]:
    """Group per-tag API items into one row per (date, model) weigh-in."""
    grouped: dict[tuple[str, str], list[dict]] = {}
    for it in items:
        raw_date = it.get("date")
        if not raw_date:
            continue
        grouped.setdefault((raw_date, it.get("model") or ""), []).append(it)

    rows = []
    for (raw_date, model), group in sorted(grouped.items()):
        try:
            local_dt = datetime.strptime(raw_date, "%Y%m%d%H%M").replace(tzinfo=TANITA_TZ)
        except ValueError:
            log.warning(f"Unparseable measurement date {raw_date!r}; skipping")
            continue
        # Uniform key set across all rows (explicit None for absent tags) —
        # PostgREST bulk upserts reject heterogeneous object keys.
        row: dict = {
            "measured_at": local_dt.isoformat(),
            "weight_kg": None,
            "body_fat_pct": None,
            "model": model or None,
            "raw_json": {"date": raw_date, "model": model, "items": group},
            "synced_at": datetime.now(timezone.utc).isoformat(),
        }
        for it in group:
            try:
                val = float(it["keydata"])
            except (KeyError, TypeError, ValueError):
                log.warning(f"Unparseable keydata in {it!r}; skipping item")
                continue
            if it.get("tag") == TAG_WEIGHT:
                row["weight_kg"] = val
            elif it.get("tag") == TAG_BODY_FAT:
                row["body_fat_pct"] = val
        if row["weight_kg"] is not None or row["body_fat_pct"] is not None:
            rows.append(row)

    # PK is measured_at alone, so two devices reporting the same minute would
    # collide inside one upsert batch (Postgres: "cannot affect row a second
    # time"). Single-scale household makes this near-impossible, but degrade
    # gracefully: keep the row that has a weight, else the first seen.
    by_instant: dict[str, dict] = {}
    for row in rows:
        cur = by_instant.get(row["measured_at"])
        if cur is None or (cur.get("weight_kg") is None and row.get("weight_kg") is not None):
            by_instant[row["measured_at"]] = row
    if len(by_instant) < len(rows):
        log.warning(f"Collapsed {len(rows) - len(by_instant)} same-minute multi-device row(s)")
    return list(by_instant.values())


def upsert_measurements(sb: Client, rows: list[dict]) -> int:
    if not rows:
        return 0
    sb.schema("pds").table("tanita_measurements").upsert(
        rows, on_conflict="measured_at"
    ).execute()
    return len(rows)


def rollup_weight_log(sb: Client, rows: list[dict]) -> int:
    """Earliest measurement per ET day → pds.weight_log (morning weigh-in wins).

    Tanita only owns rows it wrote: any existing row with source != 'tanita'
    (the manual /nutrition quick-log) takes precedence and is left untouched.
    """
    by_day: dict[str, dict] = {}
    for r in rows:
        if r.get("weight_kg") is None:
            continue
        inst = datetime.fromisoformat(r["measured_at"])
        et_day = inst.astimezone(ET).date().isoformat()
        cur = by_day.get(et_day)
        if cur is None or inst < datetime.fromisoformat(cur["measured_at"]):
            by_day[et_day] = r

    if not by_day:
        return 0

    dates = sorted(by_day.keys())
    manual_dates: set[str] = set()
    CHUNK = 100
    for i in range(0, len(dates), CHUNK):
        existing = (
            sb.schema("pds")
            .table("weight_log")
            .select("log_date,source")
            .in_("log_date", dates[i:i + CHUNK])
            .execute()
        )
        manual_dates.update(
            row["log_date"] for row in (existing.data or []) if row["source"] != "tanita"
        )

    out_rows = [
        {
            "log_date": d,
            "weight_kg": r["weight_kg"],
            "source": "tanita",
            "logged_at": r["measured_at"],
        }
        for d, r in sorted(by_day.items())
        if d not in manual_dates
    ]
    if not out_rows:
        return 0
    sb.schema("pds").table("weight_log").upsert(out_rows, on_conflict="log_date").execute()
    if manual_dates:
        log.info(f"Skipped {len(manual_dates)} manual weight_log day(s): {sorted(manual_dates)}")
    return len(out_rows)


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------

def run_inspect():
    """Print the newest raw measurement under both TZ readings — Riley confirms
    which matches the actual weigh-in time before the attribution is final."""
    try:
        tokens = ensure_fresh_tokens(load_tokens())
    except TanitaAuthError as e:
        log.error(str(e))
        sys.exit(1)
    client = TanitaClient(tokens)
    now_local = datetime.now(TANITA_TZ)
    items = client.innerscan(now_local - timedelta(days=WINDOW_DAYS), now_local)
    if not items:
        print(f"No measurements in the last {WINDOW_DAYS} days.")
        return
    latest = max(items, key=lambda it: it.get("date") or "")
    raw = latest["date"]
    naive = datetime.strptime(raw, "%Y%m%d%H%M")
    as_jst_in_et = naive.replace(tzinfo=ZoneInfo("Asia/Tokyo")).astimezone(ET)
    print("\nNewest measurement (date=1, measured):")
    print(f"  raw date string    : {raw}  (tag {latest.get('tag')}, keydata {latest.get('keydata')})")
    print(f"  if device-local ET : weigh-in at {naive:%a %Y-%m-%d %I:%M %p} ET")
    print(f"  if JST             : weigh-in at {as_jst_in_et:%a %Y-%m-%d %I:%M %p} ET")
    print("\nWhich matches when you actually stepped on the scale?")
    print("Set TANITA_TZ in tanita_etl.py accordingly before running the ETL.")


def run_etl(days: int = DEFAULT_DAYS):
    started = time.time()
    sb = get_supabase()

    try:
        tokens = ensure_fresh_tokens(load_tokens())
    except TanitaAuthError as e:
        log.error(str(e))
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(0)
    client = TanitaClient(tokens)

    try:
        now_local = datetime.now(TANITA_TZ)
        windows = list(iter_windows(now_local - timedelta(days=days), now_local))
        items: list[dict] = []
        for i, (w_from, w_to) in enumerate(windows):
            items.extend(client.innerscan(w_from, w_to))
            if i < len(windows) - 1:
                # The cap is 60 req/h. Normal runs are 1 request; even a
                # 10-year backfill is ~46 windows, so 1.1s spacing is plain
                # politeness. Past ~55 windows (a >12-year backfill) drop to
                # one request per 61s so the run can't blow the cap mid-way.
                time.sleep(61.0 if len(windows) > 55 else 1.1)

        rows = parse_measurements(items)
        n_meas = upsert_measurements(sb, rows)
        n_days = rollup_weight_log(sb, rows)

        log_sync(sb, status="success", records=n_meas, started_at=started)
        log.info(
            f"Tanita ETL complete: {n_meas} measurement(s) upserted, "
            f"{n_days} weight_log day(s) rolled up ({days}d window, {len(windows)} request(s))."
        )
    except TanitaAuthError as e:
        # Refresh token died mid-run (rare: reactive 401 refresh inside _request).
        log.error(str(e))
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(0)
    except Exception as e:
        log.exception("Tanita ETL failed")
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Tanita Health Planet ETL Pipeline")
    parser.add_argument("--auth", action="store_true", help="One-time OAuth bootstrap (run locally)")
    parser.add_argument("--inspect", action="store_true",
                        help="Print newest raw measurement under both TZ readings (verification)")
    parser.add_argument("--backfill", type=int, help="Backfill N days (paged in <=80-day API windows)")
    args = parser.parse_args()

    if args.auth:
        run_auth_flow()
        return

    if args.inspect:
        run_inspect()
        return

    run_etl(days=args.backfill if args.backfill else DEFAULT_DAYS)


if __name__ == "__main__":
    # Top-level failure heartbeat so an uncaught exception surfaces on /status
    # instead of silently going stale (same safety net as spotify_etl.py).
    _t_main_start = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — top-level safety net
        try:
            log_sync(get_supabase(), "failed", 0, _t_main_start,
                     error=f"Uncaught exception: {exc}")
        except Exception as log_exc:  # noqa: BLE001
            log.error(f"Could not write failure sync_log row: {log_exc}")
        raise
