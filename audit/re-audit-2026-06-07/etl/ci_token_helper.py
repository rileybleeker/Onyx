"""
CI Token Helper — Download/upload OAuth tokens from/to Supabase.

Used by GitHub Actions to persist rotating tokens (Garmin, WHOOP)
across ephemeral CI runs.

Usage:
    python ci_token_helper.py download garmin
    python ci_token_helper.py download whoop
    python ci_token_helper.py upload garmin
    python ci_token_helper.py upload whoop
"""

import os
import sys
import json
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

    log.info(f"Spotify tokens written to {SPOTIFY_TOKEN_FILE}")


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


def upload_spotify():
    """Read Spotify tokens from ~/.spotify_tokens.json and upload to Supabase."""
    if not os.path.exists(SPOTIFY_TOKEN_FILE):
        log.error(f"Spotify token file not found: {SPOTIFY_TOKEN_FILE}")
        sys.exit(1)

    with open(SPOTIFY_TOKEN_FILE, "r") as f:
        token_data = f.read()

    sb = get_supabase()
    sb.schema("pds").table("ci_tokens").upsert({
        "service": "spotify",
        "token_data": token_data,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    log.info("Spotify tokens uploaded to Supabase")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

COMMANDS = {
    ("download", "garmin"): download_garmin,
    ("download", "whoop"): download_whoop,
    ("download", "spotify"): download_spotify,
    ("upload", "garmin"): upload_garmin,
    ("upload", "whoop"): upload_whoop,
    ("upload", "spotify"): upload_spotify,
}


def main():
    if len(sys.argv) != 3 or (sys.argv[1], sys.argv[2]) not in COMMANDS:
        print("Usage: python ci_token_helper.py <download|upload> <garmin|whoop|spotify>")
        sys.exit(1)

    action, service = sys.argv[1], sys.argv[2]
    COMMANDS[(action, service)]()


if __name__ == "__main__":
    main()
