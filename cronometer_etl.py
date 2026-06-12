#!/usr/bin/env python3
"""Cronometer ETL — automated CSV export over Cronometer's own web endpoints.

Replaces the manual "More -> Account -> Export Data" click (Cronometer has no
public API and no scheduled/emailed export — verified June 2026). Logs in with
CRONOMETER_EMAIL / CRONOMETER_PASSWORD, mints a short-lived export token, GETs
the servings + dailySummary CSVs for a rolling window, and feeds them through
`cronometer_import.run_import` — the SAME parser the manual/inbox path uses, so
idempotency (servings delete-by-date, daily upsert), the ~68-nutrient schema,
Gold-timestamp behavioral dating, and the sync_log heartbeats are all reused
unchanged. A rolling re-fetch self-heals edits/deletes made in the app.

UNOFFICIAL — this replays the web app's own flow (the same one gocronometer /
cronometer-mcp use):
    1. GET  /login/                     -> scrape the `anticsrf` hidden input
    2. POST /login (form)               -> sets the `sesnonce` session cookie
    3. POST /cronometer/app  (GWT-RPC)  -> `authenticate` returns the user id
    4. POST /cronometer/app  (GWT-RPC)  -> `generateAuthorizationToken` -> nonce
    5. GET  /export?nonce=..&generate=servings|dailySummary&start=..&end=..

Two things drift when Cronometer ships a new web build: the GWT *permutation*
(x-gwt-permutation header) and the *serialization-policy strong-name* embedded
in the RPC body. `resolve_gwt_values()` re-derives both from the live
nocache/cache.js at runtime, falling back to the values verified live on
2026-06-11, so a redeploy self-heals without a code change. If Cronometer ever
changes the RPC *shape* (method names / type-id signatures below), re-scrape
those from the browser Network tab — or switch to the `cronometer-mcp` PyPI
package, which tracks this upstream.

Session reuse: Cronometer rate-limits logins aggressively, so the cookie jar +
user id + resolved GWT values are persisted to ~/.cronometer_session.json
(mirrored to pds.ci_tokens service='cronometer' via ci_token_helper) and reused
across runs; a fresh login happens only when the saved session can't mint a
token.

Bootstrap / validate (local, ONE time, after putting creds in .env):
    python cronometer_etl.py --auth                  # fresh login + 1-day export, prints OK/FAIL
    python ci_token_helper.py upload cronometer      # persist the session for CI

Run:
    python cronometer_etl.py                         # rolling 30-day export + import (CI default)
    python cronometer_etl.py --days 14
    python cronometer_etl.py --dry-run               # fetch + parse, no DB writes
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import traceback
from datetime import date, datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from supabase import create_client

from cronometer_import import run_import
from sync_log_helper import log_sync, now_epoch

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SESSION_FILE = os.path.expanduser("~/.cronometer_session.json")

BASE = "https://cronometer.com"
GWT_MODULE_BASE = "https://cronometer.com/cronometer/"
GWT_APP_URL = "https://cronometer.com/cronometer/app"
NOCACHE_URL = "https://cronometer.com/cronometer/cronometer.nocache.js"
LOGIN_PAGE_URL = "https://cronometer.com/login/"
LOGIN_POST_URL = "https://cronometer.com/login"
EXPORT_URL = "https://cronometer.com/export"

# GWT magic values verified live 2026-06-11. resolve_gwt_values() prefers the
# runtime-scraped values; these are the fallback if scraping fails.
FALLBACK_PERMUTATION = "9B5E6A6735177A52A4976D0EA39CB4A7"
FALLBACK_POLICY = "08048AF8BA7E897E74754A658DF1BEC5"

# RPC type-id signatures (from gocronometer/cronometer-mcp). These track the
# service interface, not the per-build compile, so they drift far less often
# than the permutation/policy above. Re-scrape from the browser if `authenticate`
# starts returning //EX[...] with valid creds.
RPC_SERVICE = "com.cronometer.shared.rpc.CronometerService"
RPC_AUTHSCOPE = "com.cronometer.shared.user.AuthScope/2065601159"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

import logging
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("cronometer_etl")


# ── GWT value resolution ─────────────────────────────────────────────────────
def resolve_gwt_values(client: httpx.Client) -> tuple[str, str]:
    """Re-derive (permutation, serialization_policy) from the live GWT bootstrap.

    The permutation is the 32-hex strong-name in cronometer.nocache.js; the
    policy is the 32-hex strong-name bound to the 'app' RemoteService in that
    permutation's compiled cache.js. Falls back to the 2026-06-11 constants if
    either scrape comes up empty (so a parser miss degrades, not breaks).
    """
    permutation, policy = FALLBACK_PERMUTATION, FALLBACK_POLICY
    try:
        nocache = client.get(NOCACHE_URL, timeout=30).text
        perms = re.findall(r"[0-9A-F]{32}", nocache)
        if perms:
            permutation = perms[0]
            cache_js = client.get(
                f"{GWT_MODULE_BASE}{permutation}.cache.js", timeout=30
            ).text
            # RemoteServiceProxy init: (this, base, 'app', '<POLICY>', ...)
            m = re.search(r"['\"]app['\"]\s*,\s*['\"]([0-9A-F]{32})['\"]", cache_js)
            if m:
                policy = m.group(1)
        log.info("GWT values resolved: permutation=%s policy=%s", permutation, policy)
    except Exception as e:  # noqa: BLE001
        log.warning("GWT resolution failed (%s); using verified fallbacks", e)
    return permutation, policy


# ── Auth flow ────────────────────────────────────────────────────────────────
def obtain_anticsrf(client: httpx.Client) -> str:
    html = client.get(LOGIN_PAGE_URL, timeout=30).text
    m = re.search(r'name="anticsrf"[^>]*value="([^"]+)"', html) or \
        re.search(r'value="([^"]+)"[^>]*name="anticsrf"', html)
    if not m:
        raise RuntimeError("could not scrape anticsrf token from the login page")
    return m.group(1)


def login(client: httpx.Client, email: str, password: str) -> None:
    anticsrf = obtain_anticsrf(client)
    r = client.post(
        LOGIN_POST_URL,
        data={"anticsrf": anticsrf, "username": email, "password": password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    # Cronometer returns JSON {success, error, redirect}; a non-empty `error`
    # (or a missing sesnonce cookie) means the login failed.
    err = ""
    try:
        err = (r.json() or {}).get("error") or ""
    except Exception:  # noqa: BLE001
        pass
    if err or "sesnonce" not in client.cookies:
        raise RuntimeError(f"Cronometer login failed: {err or 'no sesnonce cookie returned'}")


def _gwt_post(client: httpx.Client, permutation: str, body: str) -> str:
    r = client.post(
        GWT_APP_URL,
        content=body,
        headers={
            "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
            "X-GWT-Module-Base": GWT_MODULE_BASE,
            "X-GWT-Permutation": permutation,
        },
        timeout=30,
    )
    txt = r.text
    if not txt.startswith("//OK"):
        raise RuntimeError(f"GWT-RPC error (permutation may be stale): {txt[:200]}")
    return txt


def gwt_authenticate(client: httpx.Client, permutation: str, policy: str) -> int:
    body = (f"7|0|5|{GWT_MODULE_BASE}|{policy}|{RPC_SERVICE}|authenticate|"
            f"java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|")
    txt = _gwt_post(client, permutation, body)
    m = re.search(r"OK\[(\d+),", txt)
    if not m:
        raise RuntimeError(f"could not parse user id from authenticate response: {txt[:200]}")
    return int(m.group(1))


def gwt_generate_token(client: httpx.Client, permutation: str, policy: str,
                       sesnonce: str, user_id: int) -> str:
    body = (f"7|0|8|{GWT_MODULE_BASE}|{policy}|{RPC_SERVICE}|"
            f"generateAuthorizationToken|java.lang.String/2004016611|I|"
            f"{RPC_AUTHSCOPE}|{sesnonce}|1|2|3|4|4|5|6|6|7|8|{user_id}|3600|7|2|")
    txt = _gwt_post(client, permutation, body)
    # The token is the quoted string returned in the GWT response array.
    m = re.search(r'"([^"]+)"', txt)
    if not m:
        raise RuntimeError(f"could not parse export token: {txt[:200]}")
    return m.group(1)


def export_csv(client: httpx.Client, token: str, generate: str,
               start: str, end: str) -> str:
    r = client.get(
        EXPORT_URL,
        params={"nonce": token, "generate": generate, "start": start, "end": end},
        headers={
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
        },
        timeout=60,
    )
    r.raise_for_status()
    text = r.text
    if not text.strip() or text.lstrip().startswith("<"):
        raise RuntimeError(f"{generate} export returned no CSV (token expired or rejected)")
    return text


# ── Session persistence ──────────────────────────────────────────────────────
def _save_session(client: httpx.Client, user_id: int, permutation: str, policy: str) -> None:
    data = {
        "cookies": {c.name: c.value for c in client.cookies.jar},
        "user_id": user_id,
        "permutation": permutation,
        "policy": policy,
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(SESSION_FILE, "w") as f:
        json.dump(data, f)


def _load_session() -> dict | None:
    if not os.path.exists(SESSION_FILE):
        return None
    try:
        with open(SESSION_FILE) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def get_export_token(client: httpx.Client, email: str, password: str) -> str:
    """Mint an export token, reusing the saved session and only logging in if it's
    expired. Returns the token and leaves a fresh session saved on disk."""
    sess = _load_session()
    permutation, policy = (sess.get("permutation"), sess.get("policy")) if sess else (None, None)
    if not permutation or not policy:
        permutation, policy = resolve_gwt_values(client)

    # Try the saved cookie + user id first (skips the rate-limited login).
    if sess and sess.get("cookies", {}).get("sesnonce") and sess.get("user_id"):
        for name, value in sess["cookies"].items():
            client.cookies.set(name, value, domain="cronometer.com")
        try:
            token = gwt_generate_token(client, permutation, policy,
                                       sess["cookies"]["sesnonce"], sess["user_id"])
            _save_session(client, sess["user_id"], permutation, policy)
            log.info("Reused saved Cronometer session (no login needed)")
            return token
        except Exception as e:  # noqa: BLE001
            log.info("Saved session unusable (%s); logging in fresh", e)
            client.cookies.clear()

    # Fresh login path.
    permutation, policy = resolve_gwt_values(client)
    login(client, email, password)
    sesnonce = client.cookies.get("sesnonce")
    user_id = gwt_authenticate(client, permutation, policy)
    token = gwt_generate_token(client, permutation, policy, sesnonce, user_id)
    _save_session(client, user_id, permutation, policy)
    log.info("Fresh Cronometer login OK (user_id=%s)", user_id)
    return token


# ── Orchestration ────────────────────────────────────────────────────────────
def fetch_and_import(days: int, dry_run: bool, auth_only: bool = False) -> tuple[int, int]:
    email = os.environ.get("CRONOMETER_EMAIL")
    password = os.environ.get("CRONOMETER_PASSWORD")
    if not email or not password:
        raise SystemExit("CRONOMETER_EMAIL / CRONOMETER_PASSWORD must be set in the environment.")

    end = date.today()
    start = end - timedelta(days=1 if auth_only else days)

    with httpx.Client(follow_redirects=True, headers={"User-Agent": UA}) as client:
        token = get_export_token(client, email, password)
        log.info("Exporting %s .. %s", start.isoformat(), end.isoformat())
        servings_csv = export_csv(client, token, "servings", start.isoformat(), end.isoformat())
        daily_csv = export_csv(client, token, "dailySummary", start.isoformat(), end.isoformat())

    if auth_only:
        s_lines = servings_csv.count("\n")
        d_lines = daily_csv.count("\n")
        log.info("AUTH OK — servings CSV %d lines, dailySummary CSV %d lines", s_lines, d_lines)
        return s_lines, d_lines

    with tempfile.TemporaryDirectory() as tmp:
        spath = os.path.join(tmp, "servings.csv")
        dpath = os.path.join(tmp, "dailysummary.csv")
        # Cronometer exports are UTF-8 with a BOM; write utf-8-sig so the existing
        # importer's utf-8-sig read sees the exact same bytes as a manual export.
        with open(spath, "w", encoding="utf-8-sig", newline="") as f:
            f.write(servings_csv.lstrip("﻿"))
        with open(dpath, "w", encoding="utf-8-sig", newline="") as f:
            f.write(daily_csv.lstrip("﻿"))
        return run_import([spath, dpath], dry_run=dry_run)


def main() -> None:
    ap = argparse.ArgumentParser(description="Automated Cronometer export -> Supabase.")
    ap.add_argument("--days", type=int, default=30,
                    help="rolling window to re-export (default 30; servings re-import is "
                         "idempotent per day, so this self-heals app-side edits in-window)")
    ap.add_argument("--dry-run", action="store_true", help="fetch + parse, no DB writes")
    ap.add_argument("--auth", action="store_true",
                    help="bootstrap/validate: fresh login + 1-day export, no import")
    args = ap.parse_args()

    if args.auth:
        fetch_and_import(days=1, dry_run=True, auth_only=True)
        print("Cronometer auth OK — run `python ci_token_helper.py upload cronometer` to persist the session.")
        return

    t0 = now_epoch()
    try:
        scount, dcount = fetch_and_import(args.days, dry_run=args.dry_run)
        log.info("Done — %d servings, %d daily rows.", scount, dcount)
    except BaseException as e:  # noqa: BLE001  (also catches SystemExit from the importer)
        # run_import emits per-data_type success heartbeats on the happy path;
        # a fetch/auth failure happens BEFORE it runs, so surface it on /status
        # ourselves (matches the "heartbeat on every run, success AND failure"
        # convention) and exit non-zero so the Actions run goes red.
        if not args.dry_run:
            try:
                sb = create_client(SUPABASE_URL, SUPABASE_KEY)
                for dt in ("daily", "servings"):
                    log_sync(sb, "cronometer", dt, "error", error=str(e)[:500], started_at=t0)
            except Exception:  # noqa: BLE001
                pass
        log.error("Cronometer ETL failed: %s", e)
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
