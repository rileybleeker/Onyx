"""
Personal Data Scientist — WHOOP Journal Email Automation
========================================================
Monitors email (IMAP) for WHOOP data export notifications, downloads
the ZIP, extracts journal_entries.csv, and imports to Supabase.

Usage:
    python whoop_journal_email.py              # Poll every 5 minutes
    python whoop_journal_email.py --once       # Check once and exit
    python whoop_journal_email.py --interval 120  # Custom interval (seconds)
    python whoop_journal_email.py --dry-run    # Parse + download but don't write to DB

Setup:
    1. Enable 2FA on your email account
    2. Generate an App Password (Gmail: myaccount.google.com/apppasswords)
    3. Add to .env: IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD
    4. Tap "Data Export" in WHOOP app
    5. Run this script — or let GitHub Actions pick it up automatically

Runs in GitHub Actions every 4 hours (see .github/workflows/whoop-journal-email.yml).
"""

import os
import sys
import re
import time
import imaplib
import email
import zipfile
import tempfile
import argparse
import logging
from datetime import datetime, date
from email.header import decode_header
from html.parser import HTMLParser

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

from sync_log_helper import log_sync as _shared_log_sync

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
IMAP_EMAIL = os.environ.get("IMAP_EMAIL", "")
IMAP_APP_PASSWORD = os.environ.get("IMAP_APP_PASSWORD", "")

WHOOP_EMAIL_SUBJECT = "Your WHOOP Export is Ready"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("whoop_journal_email")

# Import the journal importer
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from whoop_journal_import import import_journal


# ---------------------------------------------------------------------------
# HTML link extraction (stdlib only — no BeautifulSoup needed)
# ---------------------------------------------------------------------------
class LinkExtractor(HTMLParser):
    """Extract href values and link text from <a> tags."""

    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []  # (href, link_text)
        self._current_href: str | None = None
        self._current_text: str = ""

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value:
                    self._current_href = value
                    self._current_text = ""

    def handle_data(self, data):
        if self._current_href is not None:
            self._current_text += data

    def handle_endtag(self, tag):
        if tag == "a" and self._current_href:
            self.links.append((self._current_href, self._current_text.strip()))
            self._current_href = None
            self._current_text = ""


def extract_links_from_html(html: str) -> list[tuple[str, str]]:
    parser = LinkExtractor()
    parser.feed(html)
    return parser.links


# ---------------------------------------------------------------------------
# Sync log (identical pattern to other ETLs)
# ---------------------------------------------------------------------------
def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, started_at: float = None):
    """Sync_log heartbeat. Delegates to sync_log_helper so both sync_start and
    sync_end are populated consistently with the rest of the ETLs."""
    _shared_log_sync(
        sb, source=source, data_type=data_type, status=status,
        records=records, started_at=started_at, error=error,
        date_range_start=date_start, date_range_end=date_end,
    )


# ---------------------------------------------------------------------------
# IMAP helpers
# ---------------------------------------------------------------------------
def connect_imap() -> imaplib.IMAP4_SSL:
    """Connect and authenticate to the IMAP server."""
    if not IMAP_EMAIL or not IMAP_APP_PASSWORD:
        raise RuntimeError(
            "Missing IMAP credentials. Set IMAP_EMAIL and IMAP_APP_PASSWORD in .env"
        )
    log.info(f"Connecting to {IMAP_HOST} as {IMAP_EMAIL}...")
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    imap.login(IMAP_EMAIL, IMAP_APP_PASSWORD)
    return imap


def decode_subject(msg: email.message.Message) -> str:
    """Decode a possibly-encoded email subject."""
    raw = msg.get("Subject", "")
    parts = decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def find_whoop_emails(imap: imaplib.IMAP4_SSL) -> list[tuple[bytes, email.message.Message]]:
    """Search for unread WHOOP export emails. Returns list of (uid, message).

    Two-stage search (parallels myfitnesspal_email.find_mfp_emails) to
    survive subject-line locale / branding changes:
      1. FROM filter (`whoop.com`) — stable across subject rewrites.
      2. Legacy SUBJECT filter as fallback for forwarded-from-personal-inbox
         setups where the From header gets masked.
    Diagnostic warning emitted when WHOOP-domain unseen messages exist but
    none subject-match — surfaces a rebrand before days of missed imports.
    """
    imap.select("INBOX")

    # Stage 1: by FROM
    status, data = imap.uid("SEARCH", None, '(UNSEEN FROM "whoop.com")')
    by_from_uids: list[bytes] = []
    if status == "OK" and data and data[0]:
        by_from_uids = data[0].split()

    # Stage 2 (fallback): by SUBJECT
    status, data = imap.uid("SEARCH", None, '(UNSEEN SUBJECT "WHOOP Export")')
    by_subject_uids: list[bytes] = []
    if status == "OK" and data and data[0]:
        by_subject_uids = data[0].split()

    # Merge UID sets (preserve order, dedupe)
    seen: set[bytes] = set()
    uids: list[bytes] = []
    for u in by_from_uids + by_subject_uids:
        if u not in seen:
            seen.add(u)
            uids.append(u)

    results: list[tuple[bytes, email.message.Message]] = []
    other_from_subjects: list[str] = []
    for uid in uids:
        status, msg_data = imap.uid("FETCH", uid, "(RFC822)")
        if status != "OK" or not msg_data[0]:
            continue
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        subject = decode_subject(msg)
        s_lower = subject.lower()
        if "whoop" in s_lower and "export" in s_lower:
            results.append((uid, msg))
        elif uid in by_from_uids:
            other_from_subjects.append(subject[:80])

    log.info(f"Found {len(results)} unread WHOOP export email(s)")
    if not results and other_from_subjects:
        log.warning(
            f"No WHOOP export emails matched our subject keywords, but "
            f"{len(other_from_subjects)} unseen email(s) came from whoop.com "
            f"with these subjects: {other_from_subjects[:5]}. Did WHOOP "
            f"change the export-email subject? Update find_whoop_emails."
        )
    return results


# ---------------------------------------------------------------------------
# Email processing
# ---------------------------------------------------------------------------
def extract_download_url(msg: email.message.Message) -> str | None:
    """Extract the data export download URL from the email body."""
    # Try HTML parts first, then plain text
    html_body = None
    plain_body = None

    for part in msg.walk():
        content_type = part.get_content_type()
        if content_type == "text/html" and not html_body:
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                html_body = payload.decode(charset, errors="replace")
        elif content_type == "text/plain" and not plain_body:
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                plain_body = payload.decode(charset, errors="replace")

    # Extract links from HTML (returns list of (href, link_text) tuples)
    if html_body:
        links = extract_links_from_html(html_body)
        # Primary: match on link text (e.g. "DOWNLOAD YOUR DATA")
        for href, text in links:
            if "download" in text.lower():
                log.info(f"Found download URL via link text \"{text}\": {href[:80]}...")
                return href
        # Secondary: match on URL keywords
        for href, text in links:
            if any(kw in href.lower() for kw in ("export", "download", ".zip")):
                log.info(f"Found download URL via href keyword: {href[:80]}...")
                return href

    # Fallback: extract URLs from plain text
    if plain_body:
        urls = re.findall(r'https?://\S+', plain_body)
        for url in urls:
            url = url.rstrip(">.),;\"'")
            if any(kw in url.lower() for kw in ("export", "download", ".zip")):
                log.info(f"Found download URL from plain text: {url[:80]}...")
                return url

    return None


def download_and_extract(url: str, dest_dir: str) -> str | None:
    """Download the ZIP from url and extract journal_entries.csv to dest_dir."""
    log.info("Downloading export ZIP...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()

    zip_path = os.path.join(dest_dir, "whoop_export.zip")
    with open(zip_path, "wb") as f:
        f.write(resp.content)

    log.info(f"Downloaded {len(resp.content) / 1024:.0f} KB")

    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        log.info(f"ZIP contents: {names}")

        # Find journal_entries.csv (may be in a subdirectory)
        journal_file = None
        for name in names:
            if os.path.basename(name).lower() == "journal_entries.csv":
                journal_file = name
                break

        if not journal_file:
            log.warning(f"journal_entries.csv not found in ZIP. Contents: {names}")
            return None

        zf.extract(journal_file, dest_dir)
        csv_path = os.path.join(dest_dir, journal_file)
        log.info(f"Extracted {journal_file}")
        return csv_path


def process_email(imap: imaplib.IMAP4_SSL, uid: bytes,
                  msg: email.message.Message, sb: Client,
                  dry_run: bool = False) -> bool:
    """Process a single WHOOP export email end-to-end."""
    subject = decode_subject(msg)
    email_date = msg.get("Date", "unknown")
    log.info(f"Processing: \"{subject}\" ({email_date})")

    t0 = time.time()

    # Step 1: Extract download URL
    url = extract_download_url(msg)
    if not url:
        log.warning("No download URL found in email — marking as read to avoid reprocessing")
        imap.uid("STORE", uid, "+FLAGS", "\\Seen")
        log_sync(sb, "whoop", "journal_email", "error",
                 error="No download URL found in email", started_at=t0)
        return False

    # Step 2: Download ZIP and extract CSV
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            csv_path = download_and_extract(url, tmpdir)
        except requests.RequestException as e:
            log.error(f"Download failed: {e} — will retry next cycle")
            log_sync(sb, "whoop", "journal_email", "error",
                     error=f"Download failed: {e}", started_at=t0)
            return False
        except zipfile.BadZipFile as e:
            log.error(f"Corrupt ZIP: {e} — marking as read")
            imap.uid("STORE", uid, "+FLAGS", "\\Seen")
            log_sync(sb, "whoop", "journal_email", "error",
                     error=f"Corrupt ZIP: {e}", started_at=t0)
            return False

        if not csv_path:
            imap.uid("STORE", uid, "+FLAGS", "\\Seen")
            log_sync(sb, "whoop", "journal_email", "error",
                     error="journal_entries.csv not found in ZIP", started_at=t0)
            return False

        # Step 3: Import journal entries
        try:
            count = import_journal(csv_path, dry_run=dry_run)
        except Exception as e:
            log.error(f"Import failed: {e} — will retry next cycle")
            log_sync(sb, "whoop", "journal_email", "error",
                     error=f"Import failed: {e}", started_at=t0)
            return False

    # Step 4: Mark as read and log success
    duration = time.time() - t0
    imap.uid("STORE", uid, "+FLAGS", "\\Seen")
    action = "parsed (dry run)" if dry_run else "imported"
    log.info(f"Successfully {action} {count} journal entries in {duration:.1f}s")
    log_sync(sb, "whoop", "journal_email", "success",
             records=count, started_at=t0)
    return True


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def check_email(dry_run: bool = False) -> int:
    """Connect to IMAP, find WHOOP export emails, process each one."""
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    imap = None
    t_start = time.time()
    try:
        imap = connect_imap()
        emails = find_whoop_emails(imap)
        if not emails:
            # Audit P1 fix: heartbeat on no-op runs so /status sees the cron
            # is alive even on quiet days (manual-export flow — most days
            # have no new email and that's healthy).
            log.info("No new WHOOP export emails")
            log_sync(sb, "whoop", "journal_email", "success",
                     records=0, started_at=t_start)
            return 0

        processed = 0
        for uid, msg in emails:
            if process_email(imap, uid, msg, sb, dry_run=dry_run):
                processed += 1
        return processed

    except imaplib.IMAP4.error as e:
        log.error(f"IMAP error: {e}")
        return 0
    finally:
        if imap:
            try:
                imap.logout()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="WHOOP Journal Email → Supabase")
    parser.add_argument("--once", action="store_true",
                        help="Check once and exit (no polling)")
    parser.add_argument("--interval", type=int, default=300,
                        help="Polling interval in seconds (default: 300)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and download but don't write to database")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — WHOOP Journal Email Automation")
    log.info("=" * 60)

    if args.once:
        count = check_email(dry_run=args.dry_run)
        if count:
            log.info(f"Processed {count} export email(s)")
        else:
            log.info("Nothing to process")
        return

    # Polling mode
    log.info(f"  IMAP host: {IMAP_HOST}")
    log.info(f"  Account:   {IMAP_EMAIL}")
    log.info(f"  Polling every {args.interval}s")
    log.info("Press Ctrl+C to stop.\n")

    try:
        while True:
            check_email(dry_run=args.dry_run)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("\nStopped.")


if __name__ == "__main__":
    main()
