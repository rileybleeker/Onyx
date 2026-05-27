"""
Personal Data Scientist — MyFitnessPal Email Automation
========================================================
Monitors email (IMAP) for MyFitnessPal data export emails, downloads
the CSV (or ZIP containing the CSV), and imports to Supabase.

Usage:
    python myfitnesspal_email.py              # Poll every 5 minutes
    python myfitnesspal_email.py --once       # Check once and exit
    python myfitnesspal_email.py --interval 120  # Custom interval (seconds)
    python myfitnesspal_email.py --dry-run    # Parse + download but don't write to DB

Setup:
    1. Open MyFitnessPal app → More → Settings → Export Data → Nutrition
    2. MFP emails you a CSV (or ZIP) at the address on your MFP account
    3. Forward that email to your Onyx inbox (rileybleekeronyx@gmail.com), OR
       configure MFP to use the same email address
    4. Run this script — or let GitHub Actions pick it up automatically

Runs in GitHub Actions every 4 hours (see .github/workflows/mfp-email.yml).
Uses the same IMAP credentials as the WHOOP journal email automation.
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
from email.utils import parsedate_to_datetime
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

# Matches MFP export email subjects
MFP_SUBJECT_KEYWORDS = ("myfitnesspal", "my fitness pal")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("myfitnesspal_email")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from myfitnesspal_import import import_nutrition


# ---------------------------------------------------------------------------
# HTML link extraction (same as whoop_journal_email.py)
# ---------------------------------------------------------------------------
class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[str, str]] = []
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
# Sync log
# ---------------------------------------------------------------------------
def log_sync(sb: Client, source: str, data_type: str, status: str,
             records: int = 0, date_start: date = None, date_end: date = None,
             error: str = None, started_at: float = None):
    """Sync_log heartbeat. Delegates to sync_log_helper so sync_start AND sync_end
    are both populated consistently across every ETL. Callers pass started_at
    (capture time.time() at the start of the per-email processing block, or at
    main() entry for noop heartbeats)."""
    _shared_log_sync(
        sb, source=source, data_type=data_type, status=status,
        records=records, started_at=started_at, error=error,
        date_range_start=date_start, date_range_end=date_end,
    )


# ---------------------------------------------------------------------------
# IMAP helpers
# ---------------------------------------------------------------------------
def connect_imap() -> imaplib.IMAP4_SSL:
    if not IMAP_EMAIL or not IMAP_APP_PASSWORD:
        raise RuntimeError(
            "Missing IMAP credentials. Set IMAP_EMAIL and IMAP_APP_PASSWORD in .env"
        )
    log.info(f"Connecting to {IMAP_HOST} as {IMAP_EMAIL}...")
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    imap.login(IMAP_EMAIL, IMAP_APP_PASSWORD)
    return imap


def decode_subject(msg: email.message.Message) -> str:
    raw = msg.get("Subject", "")
    parts = decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def find_mfp_emails(imap: imaplib.IMAP4_SSL) -> list[tuple[bytes, email.message.Message]]:
    """Search for unread MFP export emails.

    Two-stage search to survive subject-line locale / branding changes:
      1. FROM filter (`myfitnesspal.com`) catches every unread message from
         the official sender regardless of subject. Domain is more stable
         than localized subject text.
      2. Client-side keyword filter (`MFP_SUBJECT_KEYWORDS`) keeps the
         match-set tight — non-export emails (newsletters, support replies)
         from myfitnesspal.com are excluded.

    Falls back to the legacy SUBJECT search if the FROM search returns
    nothing (some IMAP servers / forwarding setups lose / mask the From
    header). If both return nothing but the sender DOES have unseen
    messages with a different subject, log a warning so a subject-format
    change can be diagnosed before days of missed imports accumulate.
    """
    imap.select("INBOX")

    # Stage 1: by FROM (resilient to subject changes)
    status, data = imap.uid("SEARCH", None, '(UNSEEN FROM "myfitnesspal.com")')
    by_from_uids: list[bytes] = []
    if status == "OK" and data and data[0]:
        by_from_uids = data[0].split()

    # Stage 2 (fallback): by SUBJECT — covers forwarded-from-personal-inbox
    # cases where the From header doesn't carry the original sender.
    status, data = imap.uid("SEARCH", None, '(UNSEEN SUBJECT "MyFitnessPal")')
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
        subject = decode_subject(msg).lower()
        if any(kw in subject for kw in MFP_SUBJECT_KEYWORDS):
            results.append((uid, msg))
        elif uid in by_from_uids:
            # Came from myfitnesspal.com but subject didn't keyword-match —
            # could be the "your weekly newsletter" type, or a rebrand.
            other_from_subjects.append(subject[:80])

    log.info(f"Found {len(results)} unread MFP export email(s)")
    if not results and other_from_subjects:
        log.warning(
            f"No MFP export emails matched our subject keywords, but "
            f"{len(other_from_subjects)} unseen email(s) came from myfitnesspal.com "
            f"with these subjects: {other_from_subjects[:5]}. Did MFP change "
            f"their export-email subject? Update MFP_SUBJECT_KEYWORDS."
        )
    return results


# ---------------------------------------------------------------------------
# Email processing
# ---------------------------------------------------------------------------
def extract_csv_from_attachment(msg: email.message.Message,
                                dest_dir: str) -> str | None:
    """Check email attachments for a CSV or ZIP containing a CSV."""
    for part in msg.walk():
        content_disposition = part.get("Content-Disposition", "")
        if "attachment" not in content_disposition:
            continue

        filename = part.get_filename() or ""
        payload = part.get_payload(decode=True)
        if not payload:
            continue

        if filename.lower().endswith(".csv"):
            csv_path = os.path.join(dest_dir, filename)
            with open(csv_path, "wb") as f:
                f.write(payload)
            log.info(f"Extracted CSV attachment: {filename}")
            return csv_path

        if filename.lower().endswith(".zip"):
            zip_path = os.path.join(dest_dir, filename)
            with open(zip_path, "wb") as f:
                f.write(payload)
            return extract_csv_from_zip(zip_path, dest_dir)

    return None


def extract_csv_from_zip(zip_path: str, dest_dir: str) -> str | None:
    """Extract nutrition CSV from a ZIP file."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        log.info(f"ZIP contents: {names}")

        # Look for a nutrition CSV (MFP typically names it "Nutrition Summary.csv"
        # or "nutrition.csv")
        csv_file = None
        for name in names:
            base = os.path.basename(name).lower()
            if base.endswith(".csv") and any(kw in base for kw in
                                              ("nutrition", "food", "diary")):
                csv_file = name
                break
        # Fallback: take the first CSV
        if not csv_file:
            for name in names:
                if name.lower().endswith(".csv"):
                    csv_file = name
                    break

        if not csv_file:
            log.warning(f"No CSV found in ZIP. Contents: {names}")
            return None

        zf.extract(csv_file, dest_dir)
        csv_path = os.path.join(dest_dir, csv_file)
        log.info(f"Extracted {csv_file} from ZIP")
        return csv_path


def extract_download_url(msg: email.message.Message) -> str | None:
    """Extract download URL from email body."""
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

    if html_body:
        links = extract_links_from_html(html_body)
        for href, text in links:
            if "download" in text.lower():
                log.info(f"Found download URL via link text \"{text}\": {href[:80]}...")
                return href
        for href, text in links:
            if any(kw in href.lower() for kw in ("export", "download", ".csv", ".zip")):
                log.info(f"Found download URL via href keyword: {href[:80]}...")
                return href

    if plain_body:
        urls = re.findall(r'https?://\S+', plain_body)
        for url in urls:
            url = url.rstrip(">.),;\"'")
            if any(kw in url.lower() for kw in ("export", "download", ".csv", ".zip")):
                log.info(f"Found download URL from plain text: {url[:80]}...")
                return url

    return None


def download_csv(url: str, dest_dir: str) -> str | None:
    """Download CSV or ZIP from url, return path to CSV."""
    log.info("Downloading MFP export...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    log.info(f"Downloaded {len(resp.content) / 1024:.0f} KB")

    # Detect format from Content-Type or URL
    content_type = resp.headers.get("Content-Type", "")
    if ".zip" in url.lower() or "zip" in content_type:
        zip_path = os.path.join(dest_dir, "mfp_export.zip")
        with open(zip_path, "wb") as f:
            f.write(resp.content)
        return extract_csv_from_zip(zip_path, dest_dir)
    else:
        csv_path = os.path.join(dest_dir, "mfp_nutrition.csv")
        with open(csv_path, "wb") as f:
            f.write(resp.content)
        return csv_path


def process_email(imap: imaplib.IMAP4_SSL, uid: bytes,
                  msg: email.message.Message, sb: Client,
                  dry_run: bool = False) -> bool:
    """Process a single MFP export email end-to-end."""
    subject = decode_subject(msg)
    email_date = msg.get("Date", "unknown")
    log.info(f"Processing: \"{subject}\" ({email_date})")

    # Parse the email's Date header so the importer can refuse to overwrite a
    # newer row with stale data from an older export (deepseek etl/F-005).
    # Falls back to now() if unparseable — same as old behaviour.
    email_received_at: datetime | None = None
    raw_date = msg.get("Date")
    if raw_date:
        try:
            email_received_at = parsedate_to_datetime(raw_date)
        except (TypeError, ValueError):
            email_received_at = None

    t0 = time.time()

    with tempfile.TemporaryDirectory() as tmpdir:
        # Step 1: Try attachment first, then download link
        csv_path = extract_csv_from_attachment(msg, tmpdir)

        if not csv_path:
            url = extract_download_url(msg)
            if not url:
                log.warning("No CSV attachment or download URL found — marking as read")
                imap.uid("STORE", uid, "+FLAGS", "\\Seen")
                log_sync(sb, "myfitnesspal", "nutrition", "error",
                         error="No CSV attachment or download URL found in email",
                         started_at=t0)
                return False
            try:
                csv_path = download_csv(url, tmpdir)
            except requests.RequestException as e:
                log.error(f"Download failed: {e} — will retry next cycle")
                log_sync(sb, "myfitnesspal", "nutrition", "error",
                         error=f"Download failed: {e}", started_at=t0)
                return False

        if not csv_path:
            imap.uid("STORE", uid, "+FLAGS", "\\Seen")
            log_sync(sb, "myfitnesspal", "nutrition", "error",
                     error="Could not extract nutrition CSV from email",
                     started_at=t0)
            return False

        # Step 2: Import nutrition data
        try:
            count = import_nutrition(
                csv_path, dry_run=dry_run,
                export_received_at=email_received_at,
            )
        except Exception as e:
            log.error(f"Import failed: {e} — will retry next cycle")
            log_sync(sb, "myfitnesspal", "nutrition", "error",
                     error=f"Import failed: {e}", started_at=t0)
            return False

    # Step 3: Mark as read and log success
    duration = time.time() - t0
    imap.uid("STORE", uid, "+FLAGS", "\\Seen")
    action = "parsed (dry run)" if dry_run else "imported"
    log.info(f"Successfully {action} {count} nutrition days in {duration:.1f}s")
    log_sync(sb, "myfitnesspal", "nutrition", "success",
             records=count, started_at=t0)
    return True


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def check_email(dry_run: bool = False) -> int:
    """Connect to IMAP, find MFP export emails, process each one."""
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    imap = None
    t_start = time.time()
    try:
        imap = connect_imap()
        emails = find_mfp_emails(imap)
        if not emails:
            # Audit P1 fix: emit a heartbeat even when no email was found.
            # "No new export" is the healthy state for a manual-export flow,
            # so /status would otherwise see staleness grow without any sync
            # event confirming the cron is alive.
            log.info("No new MFP export emails")
            log_sync(sb, "myfitnesspal", "nutrition", "success",
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
    parser = argparse.ArgumentParser(description="MyFitnessPal Email → Supabase")
    parser.add_argument("--once", action="store_true",
                        help="Check once and exit (no polling)")
    parser.add_argument("--interval", type=int, default=300,
                        help="Polling interval in seconds (default: 300)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and download but don't write to database")
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("Personal Data Scientist — MyFitnessPal Email Automation")
    log.info("=" * 60)

    if args.once:
        count = check_email(dry_run=args.dry_run)
        log.info(f"Processed {count} export email(s)" if count else "Nothing to process")
        return

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
