"""
CI Token Helper — Download/upload OAuth tokens from/to Supabase.

Used by GitHub Actions to persist rotating tokens (Garmin, WHOOP)
across ephemeral CI runs.

Usage:
    python ci_token_helper.py download garmin
    python ci_token_helper.py download whoop
    python ci_token_helper.py upload garmin
    python ci_token_helper.py upload whoop
    python ci_token_helper.py download tanita
    python ci_token_helper.py upload tanita
    python ci_token_helper.py download cronometer
    python ci_token_helper.py upload cronometer
"""

import os
import sys
import json
import hashlib
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

GARMIN_TOKEN_DIR = os.path.expanduser("~/.garminconnect")
WHOOP_TOKEN_FILE = os.path.expanduser("~/.whoop_tokens.json")
SPOTIFY_TOKEN_FILE = os.path.expanduser("~/.spotify_tokens.json")
TANITA_TOKEN_FILE = os.path.expanduser("~/.tanita_tokens.json")
CRONOMETER_SESSION_FILE = os.path.expanduser("~/.cronometer_session.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ci_token_helper")


def get_supabase():
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_garmin():
    """Download Garmin tokens from Supabase and write to ~/.garminconnect/."""
    import garth

    sb = get_supabase()
    row = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "garmin")
        .single()
        .execute()
    )

    if not row.data:
        log.error("No Garmin tokens found in ci_tokens table")
        sys.exit(1)

    token_data = row.data["token_data"]

    os.makedirs(GARMIN_TOKEN_DIR, exist_ok=True)
    client = garth.Client()
    client.loads(token_data)
    client.dump(GARMIN_TOKEN_DIR)

    log.info(f"Garmin tokens written to {GARMIN_TOKEN_DIR}")


def download_whoop():
    """Download WHOOP tokens from Supabase and write to ~/.whoop_tokens.json."""
    sb = get_supabase()
    row = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "whoop")
        .single()
        .execute()
    )

    if not row.data:
        log.error("No WHOOP tokens found in ci_tokens table")
        sys.exit(1)

    token_data = row.data["token_data"]

    with open(WHOOP_TOKEN_FILE, "w") as f:
        f.write(token_data)

    log.info(f"WHOOP tokens written to {WHOOP_TOKEN_FILE}")


def download_spotify():
    """Download Spotify tokens from Supabase and write to ~/.spotify_tokens.json."""
    sb = get_supabase()
    row = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "spotify")
        .single()
        .execute()
    )

    if not row.data:
        log.error("No Spotify tokens found in ci_tokens table")
        sys.exit(1)

    token_data = row.data["token_data"]

    with open(SPOTIFY_TOKEN_FILE, "w") as f:
        f.write(token_data)
    # Remember what was downloaded, so upload_spotify can tell "the ETL refreshed the
    # token" from "the ETL never got that far" (see there).
    with open(_spotify_baseline_file(), "w") as f:
        f.write(_file_sha256(SPOTIFY_TOKEN_FILE))

    log.info(f"Spotify tokens written to {SPOTIFY_TOKEN_FILE}")


def download_tanita():
    """Download Tanita Health Planet tokens from Supabase and write to ~/.tanita_tokens.json."""
    sb = get_supabase()
    row = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "tanita")
        .single()
        .execute()
    )

    if not row.data:
        log.error("No Tanita tokens found in ci_tokens table")
        sys.exit(1)

    token_data = row.data["token_data"]

    with open(TANITA_TOKEN_FILE, "w") as f:
        f.write(token_data)

    log.info(f"Tanita tokens written to {TANITA_TOKEN_FILE}")


def download_cronometer():
    """Download the Cronometer session (cookie jar + user id + GWT values) and
    write to ~/.cronometer_session.json. Missing is non-fatal: cronometer_etl.py
    falls back to a fresh login when no session file exists."""
    sb = get_supabase()
    row = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "cronometer")
        .execute()
    )

    if not row.data:
        log.warning("No Cronometer session in ci_tokens — ETL will log in fresh")
        return

    with open(CRONOMETER_SESSION_FILE, "w") as f:
        f.write(row.data[0]["token_data"])

    log.info(f"Cronometer session written to {CRONOMETER_SESSION_FILE}")


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def upload_garmin():
    """Read Garmin tokens from ~/.garminconnect/ and upload to Supabase."""
    import garth

    if not os.path.exists(GARMIN_TOKEN_DIR):
        log.error(f"Garmin token directory not found: {GARMIN_TOKEN_DIR}")
        sys.exit(1)

    client = garth.Client()
    client.load(GARMIN_TOKEN_DIR)
    token_data = client.dumps()

    sb = get_supabase()
    sb.schema("pds").table("ci_tokens").upsert({
        "service": "garmin",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info("Garmin tokens uploaded to Supabase")


def upload_whoop():
    """Read WHOOP tokens from ~/.whoop_tokens.json and upload to Supabase."""
    if not os.path.exists(WHOOP_TOKEN_FILE):
        log.error(f"WHOOP token file not found: {WHOOP_TOKEN_FILE}")
        sys.exit(1)

    with open(WHOOP_TOKEN_FILE, "r") as f:
        token_data = f.read()

    sb = get_supabase()
    sb.schema("pds").table("ci_tokens").upsert({
        "service": "whoop",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info("WHOOP tokens uploaded to Supabase")


def _spotify_baseline_file() -> str:
    return SPOTIFY_TOKEN_FILE + ".downloaded.sha256"


def _file_sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _spotify_blob(text):
    """The token blob as a dict, or None when the text is not a usable Spotify token blob."""
    if not isinstance(text, str):
        return None
    try:
        blob = json.loads(text)
    except ValueError:
        return None
    if not isinstance(blob, dict) or not isinstance(blob.get("refresh_token"), str) or not blob["refresh_token"]:
        return None
    return blob


def _epoch(value):
    """A positive epoch-seconds number, else 0 (missing, null, text and booleans all count as unknown)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return value if value > 0 else 0


def spotify_upload_decision(local_text, stored_text):
    """Newer-wins: may the local token file replace the row stored in pds.ci_tokens?

    Returns (action, reason) with action one of:
      "upload"  - write the local blob
      "skip"    - leave the stored row alone (not an error; exit 0)
      "invalid" - the local file is not a Spotify token blob; never store it (exit 1)

    The baseline check in upload_spotify covers a run that never refreshed. This covers
    the rest: a run that DID refresh the token it downloaded while a new sign-in was
    stored meanwhile (the /status Reconnect, the workflow's auth_code input, or the site
    writing back its own refresh). Without it that run would put the old sign-in's
    refresh token back over the new one.
      1. no stored row, or an unreadable one -> upload.
      2. local == stored                    -> skip: nothing to write.
      3. otherwise compare (authorized_at, obtained_at): a later sign-in always wins;
         within one sign-in the later refresh wins. Upload only when the local blob is
         strictly newer. A blob without authorized_at counts as the oldest sign-in.
    Mirrors isNewerBlob in frontend/src/lib/spotify-reconnect.ts.
    """
    local = _spotify_blob(local_text)
    if local is None:
        return "invalid", "the local token file is not a Spotify token blob"

    stored = _spotify_blob(stored_text)
    if stored is None:
        return "upload", "no usable token is stored yet"
    if stored == local:
        return "skip", "the stored token is already this one"

    local_key = (_epoch(local.get("authorized_at")), _epoch(local.get("obtained_at")))
    stored_key = (_epoch(stored.get("authorized_at")), _epoch(stored.get("obtained_at")))
    if local_key > stored_key:
        return "upload", "the local token is newer than the stored one"
    if local_key[0] < stored_key[0]:
        return "skip", "the stored token comes from a newer sign-in"
    return "skip", "the stored token was refreshed more recently"


def upload_spotify():
    """Read Spotify tokens from ~/.spotify_tokens.json and upload to Supabase.

    The workflow runs this with `if: always()`, so it must be safe after a failed ETL:
      * a file that is empty, not JSON or has no refresh token is never uploaded (exit 1);
      * a file identical to what `download spotify` wrote is not uploaded (exit 0). The
        ETL rewrites the file on every successful refresh, so "identical" means it never
        refreshed: uploading would only put the same, possibly dead, token back, over
        whatever was stored in the meantime (a fresh sign-in, or a token the frontend
        rotated). Until 2026-11-13 a failing run re-uploaded the dead token every hour.
      * a file that is not newer than the stored row is not uploaded (exit 0): see
        spotify_upload_decision. The stored row is read first; if that read fails the
        command fails without writing, rather than risk replacing a newer token.
    A refreshed file is uploaded even when the ETL failed later in the run, so a rotated
    refresh token is not lost. With no download baseline (local use after --auth) only
    the newer-wins rule applies.
    """
    if not os.path.exists(SPOTIFY_TOKEN_FILE):
        log.error(f"Spotify token file not found: {SPOTIFY_TOKEN_FILE}")
        sys.exit(1)

    with open(SPOTIFY_TOKEN_FILE, "r") as f:
        token_data = f.read()

    try:
        parsed = json.loads(token_data)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict) or not parsed.get("refresh_token"):
        log.error("Spotify token file is empty or has no refresh token; not uploading")
        sys.exit(1)

    baseline = _spotify_baseline_file()
    if os.path.exists(baseline):
        with open(baseline, "r") as f:
            downloaded_sha = f.read().strip()
        if downloaded_sha == _file_sha256(SPOTIFY_TOKEN_FILE):
            log.info("Spotify token file unchanged since download (no successful refresh); not uploading")
            return

    sb = get_supabase()
    # `service` is the table's key, so this is one row at most. (No .single(): it raises
    # when the row is missing, and "no row yet" must upload.)
    found = (
        sb.schema("pds")
        .table("ci_tokens")
        .select("token_data")
        .eq("service", "spotify")
        .execute()
    ).data
    if isinstance(found, list):
        found = found[0] if found else None
    stored = found.get("token_data") if isinstance(found, dict) else None

    action, reason = spotify_upload_decision(token_data, stored)
    if action == "invalid":
        log.error(f"Spotify tokens NOT uploaded: {reason}")
        sys.exit(1)
    if action == "skip":
        log.info(f"Spotify tokens not uploaded: {reason}")
        return

    sb.schema("pds").table("ci_tokens").upsert({
        "service": "spotify",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info(f"Spotify tokens uploaded to Supabase ({reason})")


def upload_tanita():
    """Read Tanita tokens from ~/.tanita_tokens.json and upload to Supabase."""
    if not os.path.exists(TANITA_TOKEN_FILE):
        log.error(f"Tanita token file not found: {TANITA_TOKEN_FILE}")
        sys.exit(1)

    with open(TANITA_TOKEN_FILE, "r") as f:
        token_data = f.read()

    sb = get_supabase()
    sb.schema("pds").table("ci_tokens").upsert({
        "service": "tanita",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info("Tanita tokens uploaded to Supabase")


def upload_cronometer():
    """Read the Cronometer session from ~/.cronometer_session.json and upload to
    Supabase. The ETL refreshes this file every run (rotating sesnonce / GWT
    values), so CI re-uploads it after each run with `if: always()`."""
    if not os.path.exists(CRONOMETER_SESSION_FILE):
        log.error(f"Cronometer session file not found: {CRONOMETER_SESSION_FILE}")
        sys.exit(1)

    with open(CRONOMETER_SESSION_FILE, "r") as f:
        token_data = f.read()

    sb = get_supabase()
    sb.schema("pds").table("ci_tokens").upsert({
        "service": "cronometer",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info("Cronometer session uploaded to Supabase")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

COMMANDS = {
    ("download", "garmin"): download_garmin,
    ("download", "whoop"): download_whoop,
    ("download", "spotify"): download_spotify,
    ("download", "tanita"): download_tanita,
    ("download", "cronometer"): download_cronometer,
    ("upload", "garmin"): upload_garmin,
    ("upload", "whoop"): upload_whoop,
    ("upload", "spotify"): upload_spotify,
    ("upload", "tanita"): upload_tanita,
    ("upload", "cronometer"): upload_cronometer,
}


def main():
    if len(sys.argv) != 3 or (sys.argv[1], sys.argv[2]) not in COMMANDS:
        print("Usage: python ci_token_helper.py <download|upload> <garmin|whoop|spotify|tanita|cronometer>")
        sys.exit(1)

    action, service = sys.argv[1], sys.argv[2]
    COMMANDS[(action, service)]()


if __name__ == "__main__":
    main()
