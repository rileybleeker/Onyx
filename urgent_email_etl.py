"""
Urgent Email ETL — inbox-triage's Gmail labels → pds.inbox_emails
=================================================================
The personal-agents inbox-triage routine labels every new thread in both of
Riley's Gmail accounts. Two of its labels mean "this needs Riley":

    Agent/Action     needs a reply or a decision from Riley
    Agent/Deadline   a date matters (bill due, RSVP, offer expiring, appointment)

This job copies the METADATA of the messages carrying either label into
pds.inbox_emails so the Today page (/api/urgent-email) can show them. It does
not decide what is urgent (inbox-triage already did); Today adds the reason,
the deadline it can read and the next step.

Read-only on Gmail, same plumbing as flights_email_etl.py: the mailbox is
SELECTed readonly (Gmail's All Mail), every fetch is X-GM-* attributes, FLAGS
or BODY.PEEK, and nothing is ever stored back (no STORE, no COPY, no EXPUNGE,
no label change). Read state is reported, never changed.

What is stored per message: account, Message-ID, Gmail thread + message id,
received time, sender, subject, a <=240-character plain-text snippet (used
only server-side to read a deadline; the API never returns it), unread flag,
the Agent/* labels, whether it is still in the inbox. No bodies, HTML,
attachments or recipients. Rows are never deleted: a message that lost its
label or left the search window is marked labeled=false on the next run.

Every run writes ONE pds.sync_log heartbeat (source 'urgent_email',
data_type 'labels'): success / partial (an account failed or is not
configured, or a message could not be read) / failed (no account worked).
The CI log prints counts only, never a sender or subject (the repo is public).

Usage:
    python urgent_email_etl.py               # last 30 days, every configured account
    python urgent_email_etl.py --days 60
    python urgent_email_etl.py --dry-run     # read Gmail, print counts, no database access

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAP_HOST and the IMAP_EMAIL* /
     IMAP_APP_PASSWORD* pairs shared with flights_email_etl.py.
"""

from __future__ import annotations

import argparse
import email
import imaplib
import logging
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any, Iterable, Optional

# Shared IMAP / HTML plumbing (one implementation for every email ETL).
from flights_email_etl import (
    IMAP_HOST, REQUIRED_ACCOUNTS, _fetch_chunks, account_fingerprint, body_lines, decode_hdr,
    imap_accounts, select_all_mail,
)

log = logging.getLogger("urgent_email_etl")

SOURCE, DATA_TYPE = "urgent_email", "labels"
AGENT_LABELS = ("Agent/Action", "Agent/Deadline")
# Gmail search names nested labels with '-' for '/', case-insensitively
# (verified 2026-11-11: label:agent-action == label:Agent/Action, 5 threads each).
GMAIL_LABEL_QUERY = "{label:agent-action label:agent-deadline}"
DEFAULT_DAYS = 30
MAX_MESSAGES = 300            # per account per run; inbox-triage labels a handful a day
MAX_BODY_BYTES = 2_000_000    # skip the snippet for anything bigger
SNIPPET_MAX = 240
SUBJECT_MAX = 500
TABLE = "inbox_emails"

_UID = re.compile(rb"\bUID (\d+)")
_THRID = re.compile(rb"X-GM-THRID (\d+)")
_MSGID = re.compile(rb"X-GM-MSGID (\d+)")
_SIZE = re.compile(rb"RFC822\.SIZE (\d+)")
_FLAGS = re.compile(rb"FLAGS \(([^)]*)\)")
_LABELS = re.compile(rb'X-GM-LABELS \(((?:[^()"]|"(?:[^"\\]|\\.)*")*)\)')
_LABEL_TOKEN = re.compile(rb'"((?:[^"\\]|\\.)*)"|([^\s"]+)')
# Preheader padding in marketing mail: combining grapheme joiner, zero-width
# characters, soft hyphen, BOM.
_INVISIBLE = re.compile("[͏​‌‍⁠­﻿]")


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/test_urgent_email_etl.py)
# ---------------------------------------------------------------------------

def parse_label_list(raw: bytes) -> list[str]:
    """X-GM-LABELS payload → label names. Handles quoted ("\\\\Inbox", "Agent/Action") and atom (\\Inbox) forms."""
    out: list[str] = []
    for quoted, atom in _LABEL_TOKEN.findall(raw):
        if quoted or not atom:
            text = re.sub(rb"\\(.)", rb"\1", quoted).decode("utf-8", "replace")
        else:
            text = atom.decode("utf-8", "replace")
        if text:
            out.append(text)
    return out


def parse_attrs(meta: bytes) -> Optional[dict]:
    """One FETCH response (X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE UID) → dict, or None."""
    uid = _UID.search(meta)
    if not uid:
        return None
    labels_m = _LABELS.search(meta)
    labels = parse_label_list(labels_m.group(1)) if labels_m else []
    flags_m = _FLAGS.search(meta)
    flags = flags_m.group(1).decode("ascii", "replace").split() if flags_m else []
    thr, msg, size = _THRID.search(meta), _MSGID.search(meta), _SIZE.search(meta)
    wanted = {name.lower(): name for name in AGENT_LABELS}
    return {
        "uid": uid.group(1),
        "thread_id": thr.group(1).decode() if thr else None,
        "gmail_message_id": msg.group(1).decode() if msg else None,
        "size": int(size.group(1)) if size else None,
        "agent_labels": sorted({wanted[l.lower()] for l in labels if l.lower() in wanted}),
        "in_inbox": any(l.lower() in ("\\inbox", "inbox") for l in labels),
        "unread": "\\Seen" not in flags,
    }


def clean_snippet(lines: Iterable[str], limit: int = SNIPPET_MAX) -> Optional[str]:
    text = _INVISIBLE.sub("", " ".join(lines))
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def bare_message_id(raw: str | None) -> str:
    return (raw or "").strip().strip("<>").strip()


def build_row(account: str, attrs: dict, header: email.message.Message, snippet: Optional[str], seen_at: str) -> Optional[dict]:
    """Row for pds.inbox_emails, or None when the message has no usable date or sender."""
    if not attrs.get("agent_labels"):
        return None
    try:
        received = parsedate_to_datetime(header.get("Date"))
        if received.tzinfo is None:
            received = received.replace(tzinfo=timezone.utc)
    except Exception:
        return None
    name, address = parseaddr(decode_hdr(header.get("From")))
    address = address.strip().lower()
    if not address:
        return None
    mid = bare_message_id(header.get("Message-ID"))
    if not mid:
        mid = f"gmail:{attrs.get('gmail_message_id') or attrs['uid'].decode()}"
    subject = decode_hdr(header.get("Subject"))
    return {
        "account": account.strip().lower(),
        "message_id": mid[:500],
        "received_at": received.astimezone(timezone.utc).isoformat(),
        "from_name": (name.strip() or None),
        "from_address": address,
        "subject": subject[:SUBJECT_MAX],
        "snippet": snippet,
        "is_unread": bool(attrs.get("unread")),
        "gmail_thread_id": attrs.get("thread_id"),
        "gmail_message_id": attrs.get("gmail_message_id"),
        "agent_labels": attrs["agent_labels"],
        "in_inbox": bool(attrs.get("in_inbox")),
        "labeled": True,
        "last_seen_at": seen_at,
        "synced_at": seen_at,
    }


# ---------------------------------------------------------------------------
# IMAP (read-only)
# ---------------------------------------------------------------------------

def search_labeled(imap: imaplib.IMAP4_SSL, since: date) -> tuple[list[bytes], str]:
    """UIDs of messages carrying Agent/Action or Agent/Deadline received since `since`."""
    try:
        status, data = imap.uid("SEARCH", None, "X-GM-RAW", f'"{GMAIL_LABEL_QUERY} after:{since:%Y/%m/%d}"')
        if status == "OK":
            return (data[0].split() if data and data[0] else []), "X-GM-RAW"
    except imaplib.IMAP4.error as e:
        log.info(f"X-GM-RAW search unavailable ({e}); using X-GM-LABELS")
    uids: set[bytes] = set()
    for label in AGENT_LABELS:
        status, data = imap.uid("SEARCH", None, "X-GM-LABELS", f'"{label}"', "SINCE", since.strftime("%d-%b-%Y"))
        if status != "OK":
            raise RuntimeError(f"label search failed ({status})")
        uids.update(data[0].split() if data and data[0] else [])
    return sorted(uids, key=int), "X-GM-LABELS"


def fetch_attrs(imap: imaplib.IMAP4_SSL, uids: list[bytes], chunk: int = 100) -> dict[bytes, dict]:
    out: dict[bytes, dict] = {}
    for i in range(0, len(uids), chunk):
        status, data = imap.uid("FETCH", b",".join(uids[i:i + chunk]), "(X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE)")
        if status != "OK":
            continue
        for d in data or []:
            meta = b"".join(x for x in d if isinstance(x, bytes)) if isinstance(d, tuple) else d
            if not isinstance(meta, bytes):
                continue
            attrs = parse_attrs(meta)
            if attrs:
                out[attrs["uid"]] = attrs
    return out


def process_account(account: str, password: str, since: date, seen_at: str) -> tuple[list[dict], dict]:
    stats = {"messages": 0, "rows": 0, "skipped": 0, "unlabeled": 0, "snippet_errors": 0, "action": 0, "deadline": 0}
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        imap.login(account, password)
        box = select_all_mail(imap)           # SELECT ... readonly
        uids, how = search_labeled(imap, since)
        uids = uids[-MAX_MESSAGES:]
        stats["messages"] = len(uids)
        log.info(f"[fp={account_fingerprint(account)}] {len(uids)} labeled message(s) since {since} in {box} via {how}")
        if not uids:
            return [], stats
        attrs = fetch_attrs(imap, uids)
        headers: dict[bytes, email.message.Message] = {}
        for uid, raw in _fetch_chunks(imap, uids, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)])", chunk=100):
            headers[uid] = email.message_from_bytes(raw)
        small = [u for u in uids if (attrs.get(u) or {}).get("size") is None or attrs[u]["size"] <= MAX_BODY_BYTES]
        snippets: dict[bytes, Optional[str]] = {}
        for uid, raw in _fetch_chunks(imap, small, "(BODY.PEEK[])", chunk=10):
            try:
                snippets[uid] = clean_snippet(body_lines(email.message_from_bytes(raw)))
            except Exception:
                stats["snippet_errors"] += 1
        rows = []
        for uid in uids:
            a, h = attrs.get(uid), headers.get(uid)
            if a is not None and not a["agent_labels"]:
                stats["unlabeled"] += 1      # another message of a labeled thread: not an error
                continue
            row = build_row(account, a, h, snippets.get(uid), seen_at) if a and h is not None else None
            if row is None:
                stats["skipped"] += 1
                continue
            rows.append(row)
            stats["action"] += "Agent/Action" in row["agent_labels"]
            stats["deadline"] += "Agent/Deadline" in row["agent_labels"]
        stats["rows"] = len(rows)
        return rows, stats
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def store_account(supa: Any, account: str, rows: list[dict], seen_at: str) -> None:
    """Upsert what this run saw, then mark this account's rows it did NOT see as no longer labeled."""
    table = lambda: supa.schema("pds").table(TABLE)  # noqa: E731
    for i in range(0, len(rows), 200):
        table().upsert(rows[i:i + 200], on_conflict="account,message_id").execute()
    (table().update({"labeled": False, "synced_at": seen_at})
        .eq("account", account.strip().lower()).eq("labeled", True).lt("last_seen_at", seen_at).execute())


def run(supa: Any, accounts: list[tuple[str, str]], days: int, dry_run: bool = False) -> tuple[str, int, Optional[str]]:
    """Returns (heartbeat status, records, error note)."""
    seen_at = datetime.now(timezone.utc).isoformat()
    since = date.today() - timedelta(days=days)
    failures: list[str] = []
    notes: list[str] = []
    total = 0
    for account, password in accounts:
        fp = account_fingerprint(account)
        try:
            rows, stats = process_account(account, password, since, seen_at)
            if not dry_run:
                store_account(supa, account, rows, seen_at)
            total += len(rows)
            log.info(f"[fp={fp}] stored {len(rows)} (action {stats['action']}, deadline {stats['deadline']}, "
                     f"skipped {stats['skipped']}, snippet errors {stats['snippet_errors']})")
            if stats["skipped"] or stats["snippet_errors"]:
                notes.append(f"account {fp}: {stats['skipped']} message(s) unreadable, {stats['snippet_errors']} snippet error(s)")
        except Exception as e:
            log.error(f"[fp={fp}] account failed: {type(e).__name__}")
            failures.append(f"account {fp}: {type(e).__name__}: {str(e)[:120]}")
    if not accounts:
        return "failed", 0, "no IMAP accounts configured"
    if len(failures) == len(accounts):
        return "failed", 0, "; ".join(failures)
    status = "partial" if failures or notes else "success"
    configured = {a.strip().lower() for a, _ in accounts}
    missing = [a for a in REQUIRED_ACCOUNTS if a not in configured]
    if missing:
        status = "partial"
        notes.append(f"{len(missing)} Gmail account(s) not configured (add IMAP_EMAIL_n/IMAP_APP_PASSWORD_n secrets)")
    return status, total, ("; ".join(failures + notes) or None)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS, help="look-back window (default 30)")
    ap.add_argument("--dry-run", action="store_true", help="read Gmail and print counts; no database access")
    args = ap.parse_args()
    started = time.time()
    accounts = imap_accounts()
    if args.dry_run:
        status, total, error = run(None, accounts, args.days, dry_run=True)
        log.info(f"dry run: {status}, {total} labeled message(s); {error or 'no notes'}")
        return 0
    import os
    from supabase import create_client
    from sync_log_helper import log_sync
    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    status, total, error = run(supa, accounts, args.days)
    log.info(f"Done: {status}, {total} labeled message(s)")
    log_sync(supa, SOURCE, DATA_TYPE, status, records=total, started_at=started, error=error,
             date_range_start=date.today() - timedelta(days=args.days), date_range_end=date.today())
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # heartbeat on crash, per the Onyx ETL convention
        log.exception("fatal")
        try:
            import os
            from supabase import create_client
            from sync_log_helper import log_sync
            supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
            log_sync(supa, SOURCE, DATA_TYPE, "failed", records=0, error=f"{type(e).__name__}: {str(e)[:300]}")
        except Exception:
            pass
        sys.exit(1)
