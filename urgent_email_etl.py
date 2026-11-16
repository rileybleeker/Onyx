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
attachments or recipients. Rows are never deleted.

Two scopes, kept apart on purpose
---------------------------------
1. REFRESH (bounded). Messages labeled within the --days window, newest
   MAX_MESSAGES of them, get their metadata and snippet (re)read and upserted.
   A field this run could not read (a failed FETCH chunk, a missing header, a
   body that was too big or failed to parse, a missing X-GM-LABELS item) is
   left out of the upsert, so the stored value stays: an unreadable message
   never erases what an earlier run read.
2. RECONCILE (authoritative, all ages). A stored row is set labeled=false
   only when this run PROVED its message no longer carries an Agent/* label:
   both label searches (X-GM-LABELS, no date limit) answered OK in a mailbox
   verified to be Gmail's All Mail, and every UID they returned was mapped to
   its X-GM-MSGID. The row's gmail_message_id is then absent from that
   complete membership. Anything less (INBOX fallback, a NO/BAD/malformed
   search, a failed or incomplete FETCH, more than MAX_MEMBERSHIP labeled
   messages, a SEARCH answer with no untagged SEARCH payload, a mailbox whose
   LIST flags lack an exact \\All, a row without a Gmail message id) makes the account's
   reconciliation UNKNOWN: nothing is cleared, the rows are counted as kept,
   and the heartbeat is 'partial'. A message that really lost its label is
   cleared by the first run that reconciles completely.

Identity stays (account, message_id). A refreshed message is first matched to
the stored row with the same Gmail message id and updated under THAT key, so a
header that lost (or regained) its Message-ID never forks a second row. Only
Gmail's global id may stand in for a missing Message-ID ('gmail:<id>'); a
folder-local UID never does, and a message with neither is skipped (kept).

Every run writes ONE pds.sync_log heartbeat (source 'urgent_email',
data_type 'labels'): success / partial (an account failed or is not
configured, a message could not be read, the window hit its cap, or the
reconciliation was not complete) / failed (no account worked). Logs and the
heartbeat carry counts and codes only (email_log_safety.py), never a sender,
subject, address or exception text (the repo is public).

Usage:
    python urgent_email_etl.py               # last 30 days, every configured account
    python urgent_email_etl.py --days 60
    python urgent_email_etl.py --dry-run     # read Gmail, print counts, no database access
                                             # (would-clear counts are reported as unknown)

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAP_HOST and the IMAP_EMAIL* /
     IMAP_APP_PASSWORD* pairs shared with flights_email_etl.py.
"""

from __future__ import annotations

import argparse
import email
import email.message
import imaplib
import logging
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

from email_log_safety import HeartbeatGate, bounded_days, is_missing_table, log_failure, quiet_dependency_loggers
# Shared IMAP / HTML plumbing (one implementation for every email ETL).
from flights_email_etl import (
    IMAP_HOST, REQUIRED_ACCOUNTS, account_fingerprint, body_lines, decode_hdr,
    imap_accounts, select_all_mail_verified,
)

log = logging.getLogger("urgent_email_etl")
quiet_dependency_loggers()
HEARTBEAT = HeartbeatGate()   # opened by main() only for a write-mode run

SOURCE, DATA_TYPE = "urgent_email", "labels"
AGENT_LABELS = ("Agent/Action", "Agent/Deadline")
# Gmail search names nested labels with '-' for '/', case-insensitively
# (verified 2026-11-11: label:agent-action == label:Agent/Action, 5 threads each).
GMAIL_LABEL_QUERY = "{label:agent-action label:agent-deadline}"
DEFAULT_DAYS = 30
MAX_MESSAGES = 300            # refresh cap per account per run; inbox-triage labels a handful a day
MAX_MEMBERSHIP = 20_000       # all-age labeled messages the reconciliation will map; more = unknown
MAX_BODY_BYTES = 2_000_000    # skip the snippet for anything bigger (the stored one stays)
SNIPPET_MAX = 240
SUBJECT_MAX = 500
TABLE = "inbox_emails"
STORE_SCHEMA_HINT = "apply sql/inbox_emails_schema.sql"

_UID = re.compile(rb"\bUID (\d+)")
_THRID = re.compile(rb"X-GM-THRID (\d+)")
_MSGID = re.compile(rb"X-GM-MSGID (\d+)")
_SIZE = re.compile(rb"RFC822\.SIZE (\d+)")
_FLAGS = re.compile(rb"(?<![-\w])FLAGS \(([^)]*)\)")
_LABELS = re.compile(rb'X-GM-LABELS \(((?:[^()"]|"(?:[^"\\]|\\.)*")*)\)')
_LABEL_TOKEN = re.compile(rb'"((?:[^"\\]|\\.)*)"|([^\s"]+)')
# Preheader padding in marketing mail: combining grapheme joiner, zero-width
# characters, soft hyphen, BOM.
_INVISIBLE = re.compile("[͏​‌‍⁠­﻿]")

# Reconciliation outcome codes (counts-only diagnostics).
RECONCILE_COMPLETE = "complete"
MAILBOX_NOT_ALL_MAIL = "mailbox_not_all_mail"
MEMBERSHIP_SEARCH_FAILED = "membership_search_failed"
MEMBERSHIP_SEARCH_MALFORMED = "membership_search_malformed"
MEMBERSHIP_OVER_CAP = "membership_over_cap"
MEMBERSHIP_FETCH_FAILED = "membership_fetch_failed"
MEMBERSHIP_FETCH_INCOMPLETE = "membership_fetch_incomplete"
MEMBERSHIP_ERROR = "membership_error"
NO_DATABASE = "no_database_read"


class SearchMalformed(RuntimeError):
    """A SEARCH answered OK but its payload is not a UID list."""


def et_today() -> date:
    """Riley's calendar day. A UTC date.today() on the runner is already tomorrow in the ET evening."""
    return datetime.now(ZoneInfo("America/New_York")).date()


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
    """One FETCH response (X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE UID) → dict, or None.

    A response without a well-formed X-GM-LABELS item has UNKNOWN labels (agent_labels and
    in_inbox are None), never "no labels": a missing or malformed item must not read as a
    label removal. Missing FLAGS likewise leave unread as None.
    """
    uid = _UID.search(meta)
    if not uid:
        return None
    labels_m = _LABELS.search(meta)
    labels = parse_label_list(labels_m.group(1)) if labels_m else None
    flags_m = _FLAGS.search(meta)
    flags = flags_m.group(1).decode("ascii", "replace").split() if flags_m else None
    thr, msg, size = _THRID.search(meta), _MSGID.search(meta), _SIZE.search(meta)
    wanted = {name.lower(): name for name in AGENT_LABELS}
    return {
        "uid": uid.group(1),
        "thread_id": thr.group(1).decode() if thr else None,
        "gmail_message_id": msg.group(1).decode() if msg else None,
        "size": int(size.group(1)) if size else None,
        "labels_known": labels is not None,
        "agent_labels": (sorted({wanted[l.lower()] for l in labels if l.lower() in wanted})
                         if labels is not None else None),
        "in_inbox": (any(l.lower() in ("\\inbox", "inbox") for l in labels) if labels is not None else None),
        "unread": ("\\Seen" not in flags) if flags is not None else None,
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


def build_row(account: str, attrs: Optional[dict], header: Optional[email.message.Message],
              snippet: Optional[str], seen_at: str, snippet_known: bool = True) -> Optional[dict]:
    """Row for pds.inbox_emails, or None when the labels are unknown/absent or there is no usable date or sender.

    Only fields this run actually read are included. A key left out of the upsert keeps its
    stored value, so an empty Subject, a missing display name, an unknown snippet (body not read)
    or missing Gmail ids never erase what an earlier run stored. A new row gets the column defaults.
    """
    if not attrs or not attrs.get("agent_labels") or header is None:
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
        # Only Gmail's global message id may stand in for a missing Message-ID, and store_account
        # first re-keys to any EXISTING row with that id. A mailbox UID is folder-local and can be
        # reused: it is never an identity. Neither id -> no row (the stored one is kept).
        gm = attrs.get("gmail_message_id") or ""
        if not gm.isdigit():
            return None
        mid = f"gmail:{gm}"
    row: dict[str, Any] = {
        "account": account.strip().lower()[:320],
        "message_id": mid[:500],
        "received_at": received.astimezone(timezone.utc).isoformat(),
        "from_address": address[:320],                 # length caps match sql/inbox_emails_schema.sql
        "agent_labels": attrs["agent_labels"],
        "labeled": True,
        "last_seen_at": seen_at,
        "synced_at": seen_at,
    }
    name = name.strip()[:200]
    if name:
        row["from_name"] = name
    subject = decode_hdr(header.get("Subject"))[:SUBJECT_MAX]
    if subject:
        row["subject"] = subject
    if snippet_known:
        row["snippet"] = snippet
    if attrs.get("unread") is not None:
        row["is_unread"] = bool(attrs["unread"])
    if attrs.get("in_inbox") is not None:
        row["in_inbox"] = bool(attrs["in_inbox"])
    if attrs.get("thread_id"):
        row["gmail_thread_id"] = attrs["thread_id"]
    if attrs.get("gmail_message_id"):
        row["gmail_message_id"] = attrs["gmail_message_id"]
    return row


def row_gmail_id(row: dict) -> Optional[str]:
    """The Gmail message id a stored row reconciles by: its gmail_message_id column only.

    A 'gmail:<n>' Message-ID is NOT parsed: older versions could put a folder-local UID there."""
    gm = (row.get("gmail_message_id") or "").strip()
    return gm if gm.isdigit() else None


def resolve_identities(rows: list[dict], existing: dict[str, list[str]]) -> tuple[list[dict], int]:
    """Re-key refreshed rows to the PROVEN stored identity of the same Gmail message. Pure.

    existing: gmail_message_id -> message_ids already stored for this account with that id.
    One stored row  -> the refresh updates it under its stored message_id (a header that lost or
                       gained its Message-ID never forks a second row).
    Several rows    -> ambiguous: the refresh is skipped and every stored row kept as it is.
    None            -> the row keeps the key build_row gave it.
    Returns (rows to upsert, ambiguous count). Nothing is merged or deleted."""
    out: dict[str, dict] = {}
    ambiguous = 0
    for row in rows:
        gm = row.get("gmail_message_id")
        known = sorted(set(existing.get(gm, []))) if gm else []
        if len(known) > 1:
            ambiguous += 1
            continue
        if known:
            row = dict(row, message_id=known[0])
        out[row["message_id"]] = row
    return list(out.values()), ambiguous


def classify_rows(labeled_rows: list[dict], seen_this_run: set[str], membership: Optional[set[str]]) -> dict:
    """Split stored labeled rows by what this run proved. Pure; never guesses.

    seen      refreshed by this run (still labeled)
    retained  in the complete membership (still labeled, outside the window / cap, or unreadable)
    clear     proven unlabeled: absent from a COMPLETE membership
    unknown   membership unknown for this account: kept
    unidentified  no Gmail message id to reconcile by: kept
    """
    out: dict[str, list[str]] = {"seen": [], "retained": [], "clear": [], "unknown": [], "unidentified": []}
    for r in labeled_rows:
        mid = r.get("message_id")
        if not mid:
            continue
        if mid in seen_this_run:
            out["seen"].append(mid)
        elif membership is None:
            out["unknown"].append(mid)
        else:
            gm = row_gmail_id(r)
            if gm is None:
                out["unidentified"].append(mid)
            elif gm in membership:
                out["retained"].append(mid)
            else:
                out["clear"].append(mid)
    return out


# ---------------------------------------------------------------------------
# IMAP (read-only)
# ---------------------------------------------------------------------------

def _uid_list(data: Any) -> list[bytes]:
    """UID SEARCH payload → UIDs. Raises SearchMalformed for anything that is not an explicit answer.

    An empty result is the untagged '* SEARCH' line, which imaplib returns as [b'']. A missing
    payload (None, [], [None]) means the server sent no SEARCH response at all: that is UNKNOWN,
    never an authoritative empty result (an empty membership would clear every stored row)."""
    if not isinstance(data, (list, tuple)) or not data:
        raise SearchMalformed("search payload")
    uids: list[bytes] = []
    for part in data:
        if not isinstance(part, bytes):
            raise SearchMalformed("search payload")
        for tok in part.split():
            if not tok.isdigit():
                raise SearchMalformed("search payload")
            uids.append(tok)
    return uids


def search_labeled(imap: imaplib.IMAP4_SSL, since: date) -> tuple[list[bytes], str]:
    """UIDs (ascending) of messages carrying Agent/Action or Agent/Deadline received since `since`."""
    try:
        status, data = imap.uid("SEARCH", None, "X-GM-RAW", f'"{GMAIL_LABEL_QUERY} after:{since:%Y/%m/%d}"')
        if status == "OK":
            return sorted(set(_uid_list(data)), key=int), "X-GM-RAW"
    except imaplib.IMAP4.abort:
        raise
    except imaplib.IMAP4.error:
        log.info("window_search: X-GM-RAW unavailable; using X-GM-LABELS")
    uids: set[bytes] = set()
    for label in AGENT_LABELS:
        status, data = imap.uid("SEARCH", None, "X-GM-LABELS", f'"{label}"', "SINCE", since.strftime("%d-%b-%Y"))
        if status != "OK":
            raise RuntimeError("label search failed")
        uids.update(_uid_list(data))
    return sorted(uids, key=int), "X-GM-LABELS"


def _fetch_meta(d: Any) -> Optional[bytes]:
    if isinstance(d, tuple):
        return b"".join(x for x in d if isinstance(x, bytes))
    return d if isinstance(d, bytes) else None


def fetch_attrs(imap: imaplib.IMAP4_SSL, uids: list[bytes], chunk: int = 100) -> tuple[dict[bytes, dict], int]:
    """X-GM-* attributes per UID, and the number of FETCH chunks that failed (their UIDs are simply absent)."""
    out: dict[bytes, dict] = {}
    failed = 0
    wanted = set(uids)
    for i in range(0, len(uids), chunk):
        try:
            status, data = imap.uid("FETCH", b",".join(uids[i:i + chunk]),
                                    "(X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE)")
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error:
            failed += 1
            continue
        if status != "OK":
            failed += 1
            continue
        for d in data or []:
            meta = _fetch_meta(d)
            if not meta:
                continue
            attrs = parse_attrs(meta)
            if not attrs or attrs["uid"] not in wanted:
                continue
            prev = out.get(attrs["uid"])
            # An unsolicited FETCH (FLAGS only) must not replace a response that carried labels.
            if prev is not None and prev["labels_known"] and not attrs["labels_known"]:
                continue
            out[attrs["uid"]] = attrs
    return out, failed


def fetch_literals(imap: imaplib.IMAP4_SSL, uids: list[bytes], item: str, chunk: int) -> tuple[dict[bytes, bytes], int]:
    """BODY.PEEK[...] literal per UID, and the number of FETCH chunks that failed."""
    out: dict[bytes, bytes] = {}
    failed = 0
    wanted = set(uids)
    for i in range(0, len(uids), chunk):
        try:
            status, data = imap.uid("FETCH", b",".join(uids[i:i + chunk]), item)
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error:
            failed += 1
            continue
        if status != "OK":
            failed += 1
            continue
        for d in data or []:
            if isinstance(d, tuple) and len(d) == 2 and isinstance(d[0], bytes) and isinstance(d[1], bytes):
                m = _UID.search(d[0])
                if m and m.group(1) in wanted:
                    out[m.group(1)] = d[1]
    return out, failed


def label_membership(imap: imaplib.IMAP4_SSL, all_mail: bool, chunk: int = 500) -> tuple[Optional[set[str]], str, int]:
    """Gmail message ids of EVERY message (any age) carrying an Agent/* label, or None when not provably complete.

    Read-only: two UID SEARCH X-GM-LABELS (no date limit) and FETCH (X-GM-MSGID), in a mailbox
    verified to be All Mail. Returns (membership or None, outcome code, labeled message count).
    """
    if not all_mail:
        return None, MAILBOX_NOT_ALL_MAIL, 0
    try:
        uids: set[bytes] = set()
        for label in AGENT_LABELS:
            try:
                status, data = imap.uid("SEARCH", None, "X-GM-LABELS", f'"{label}"')
            except imaplib.IMAP4.abort:
                raise
            except imaplib.IMAP4.error:
                return None, MEMBERSHIP_SEARCH_FAILED, 0
            if status != "OK":
                return None, MEMBERSHIP_SEARCH_FAILED, 0
            try:
                uids.update(_uid_list(data))
            except SearchMalformed:
                return None, MEMBERSHIP_SEARCH_MALFORMED, 0
        if len(uids) > MAX_MEMBERSHIP:
            return None, MEMBERSHIP_OVER_CAP, len(uids)
        ordered = sorted(uids, key=int)
        by_uid: dict[bytes, str] = {}
        for i in range(0, len(ordered), chunk):
            try:
                status, data = imap.uid("FETCH", b",".join(ordered[i:i + chunk]), "(X-GM-MSGID)")
            except imaplib.IMAP4.abort:
                raise
            except imaplib.IMAP4.error:
                return None, MEMBERSHIP_FETCH_FAILED, len(uids)
            if status != "OK":
                return None, MEMBERSHIP_FETCH_FAILED, len(uids)
            for d in data or []:
                meta = _fetch_meta(d)
                if not meta:
                    continue
                u, g = _UID.search(meta), _MSGID.search(meta)
                if u and g and u.group(1) in uids:
                    by_uid[u.group(1)] = g.group(1).decode()
        if set(by_uid) != uids:
            return None, MEMBERSHIP_FETCH_INCOMPLETE, len(uids)
        return set(by_uid.values()), RECONCILE_COMPLETE, len(uids)
    except Exception as e:  # connection lost mid-way: unknown, and the refresh already read stays usable
        log_failure(log, MEMBERSHIP_ERROR, e)
        return None, MEMBERSHIP_ERROR, 0


def new_stats() -> dict:
    return {"mailbox": None, "search": None, "window_candidates": 0, "dropped_by_cap": 0, "messages": 0,
            "attr_failed_chunks": 0, "header_failed_chunks": 0, "body_failed_chunks": 0,
            "attrs_missing": 0, "labels_unknown": 0, "headers_missing": 0, "headers_unusable": 0, "identity_missing": 0,
            "bodies_missing": 0, "body_oversize": 0, "snippet_errors": 0,
            "unlabeled": 0, "skipped": 0, "rows": 0, "action": 0, "deadline": 0,
            "membership": None, "membership_size": 0}


def process_account(account: str, password: str, since: date, seen_at: str) -> tuple[list[dict], dict, Optional[set[str]]]:
    """Read one mailbox. Returns (rows to upsert, counts-only stats, all-age label membership or None)."""
    stats = new_stats()
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        imap.login(account, password)
        _box, all_mail = select_all_mail_verified(imap)   # SELECT ... readonly; True only for an exact \All flag
        stats["mailbox"] = "all_mail" if all_mail else "inbox_fallback"
        found, how = search_labeled(imap, since)
        stats["search"] = how
        stats["window_candidates"] = len(found)
        stats["dropped_by_cap"] = max(0, len(found) - MAX_MESSAGES)
        uids = found[-MAX_MESSAGES:]
        stats["messages"] = len(uids)
        rows_by_mid: dict[str, dict] = {}
        if uids:
            attrs, stats["attr_failed_chunks"] = fetch_attrs(imap, uids)
            raw_headers, stats["header_failed_chunks"] = fetch_literals(
                imap, uids, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)])", chunk=100)
            headers: dict[bytes, email.message.Message] = {}
            for uid, raw in raw_headers.items():
                try:
                    headers[uid] = email.message_from_bytes(raw)
                except Exception:
                    stats["headers_unusable"] += 1
            labeled = [u for u in uids if (attrs.get(u) or {}).get("agent_labels")]
            small = []
            for u in labeled:
                size = attrs[u].get("size")
                if size is not None and size > MAX_BODY_BYTES:
                    stats["body_oversize"] += 1
                else:
                    small.append(u)
            raw_bodies, stats["body_failed_chunks"] = fetch_literals(imap, small, "(BODY.PEEK[])", chunk=10)
            snippets: dict[bytes, Optional[str]] = {}
            for uid in small:
                raw = raw_bodies.get(uid)
                if raw is None:
                    stats["bodies_missing"] += 1
                    continue
                try:
                    snippets[uid] = clean_snippet(body_lines(email.message_from_bytes(raw)))
                except Exception:
                    stats["snippet_errors"] += 1
            for uid in uids:
                a = attrs.get(uid)
                if a is None:
                    stats["attrs_missing"] += 1          # FETCH chunk failed or the UID was not answered
                    continue
                if a["agent_labels"] is None:
                    stats["labels_unknown"] += 1         # no / malformed X-GM-LABELS: never "unlabeled"
                    continue
                if not a["agent_labels"]:
                    stats["unlabeled"] += 1              # another message of a labeled thread: not an error
                    continue
                h = headers.get(uid)
                if h is None:
                    stats["headers_missing"] += 1
                    continue
                if not (a.get("gmail_message_id") or "").isdigit():
                    # Even a present RFC Message-ID can be a new key for an old gmail:<id> row.
                    # Without the global Gmail id we cannot prove identity continuity; keep the
                    # stored row until a complete attribute response lets us resolve its key.
                    stats["identity_missing"] += 1
                    continue
                try:
                    row = build_row(account, a, h, snippets.get(uid), seen_at, snippet_known=uid in snippets)
                except Exception:
                    row = None
                if row is None:
                    stats["headers_unusable"] += 1
                    continue
                rows_by_mid[row["message_id"]] = row     # one row per Message-ID (the upsert key)
        rows = list(rows_by_mid.values())
        for row in rows:
            stats["action"] += "Agent/Action" in row["agent_labels"]
            stats["deadline"] += "Agent/Deadline" in row["agent_labels"]
        stats["rows"] = len(rows)
        stats["skipped"] = (stats["attrs_missing"] + stats["labels_unknown"] + stats["headers_missing"]
                            + stats["headers_unusable"] + stats["identity_missing"])
        membership, stats["membership"], stats["membership_size"] = label_membership(imap, all_mail)
        return rows, stats, membership
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def _table(supa: Any):
    return supa.schema("pds").table(TABLE)


def upsert_rows(supa: Any, rows: list[dict]) -> int:
    """Upsert in batches of identical key sets (PostgREST bulk upserts need uniform keys)."""
    groups: dict[tuple[str, ...], list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(sorted(r)), []).append(r)
    n = 0
    for keys in sorted(groups):
        batch = groups[keys]
        for i in range(0, len(batch), 200):
            _table(supa).upsert(batch[i:i + 200], on_conflict="account,message_id").execute()
            n += len(batch[i:i + 200])
    return n


def labeled_rows(supa: Any, account: str) -> list[dict]:
    """This account's rows still marked labeled (read-only, paged)."""
    out: list[dict] = []
    start = 0
    while True:
        page = (_table(supa).select("message_id,gmail_message_id").eq("account", account).eq("labeled", True)
                .order("message_id").range(start, start + 999).execute().data or [])
        out.extend(page)
        if len(page) < 1000:
            return out
        start += 1000


def stored_identities(supa: Any, account: str, gmail_ids: Iterable[str]) -> dict[str, list[str]]:
    """gmail_message_id -> stored message_ids for this account (read-only; any labeled state)."""
    ids = sorted({g for g in gmail_ids if g and g.isdigit()})
    out: dict[str, list[str]] = {}
    for i in range(0, len(ids), 100):
        start = 0
        while True:
            data = (_table(supa).select("message_id,gmail_message_id").eq("account", account)
                    .in_("gmail_message_id", ids[i:i + 100]).order("message_id")
                    .range(start, start + 999).execute().data or [])
            for r in data:
                if r.get("gmail_message_id") and r.get("message_id"):
                    out.setdefault(r["gmail_message_id"], []).append(r["message_id"])
            if len(data) < 1000:
                break
            start += 1000
    return out


def store_account(supa: Any, account: str, rows: list[dict], seen_at: str,
                  membership: Optional[set[str]] = None, dry_run: bool = False) -> dict:
    """Upsert what this run read, then clear ONLY rows proven unlabeled by a complete membership.

    Rows are first re-keyed to the stored identity of the same Gmail message (resolve_identities).
    membership None = reconciliation unknown: nothing is cleared. dry_run: reads only, writes nothing,
    and returns the would-clear counts. Returns counts only.
    """
    acct = account.strip().lower()
    result = {"refreshed": 0, "upserted": 0, "identity_ambiguous": 0, "labeled_rows": 0, "seen": 0,
              "retained": 0, "cleared": 0, "would_clear": 0, "unknown": 0, "unidentified": 0}
    rows, result["identity_ambiguous"] = resolve_identities(
        rows, stored_identities(supa, acct, (r.get("gmail_message_id") for r in rows)))
    result["refreshed"] = len(rows)
    if not dry_run:
        result["upserted"] = upsert_rows(supa, rows)
    stored = labeled_rows(supa, acct)
    result["labeled_rows"] = len(stored)
    split = classify_rows(stored, {r["message_id"] for r in rows}, membership)
    for key in ("seen", "retained", "unknown", "unidentified"):
        result[key] = len(split[key])
    if dry_run:
        result["would_clear"] = len(split["clear"])
        return result
    for mid in split["clear"]:
        # One exact row per update. lt(last_seen_at) keeps a row refreshed by this run labeled.
        (_table(supa).update({"labeled": False, "synced_at": seen_at})
            .eq("account", acct).eq("message_id", mid).eq("labeled", True).lt("last_seen_at", seen_at).execute())
        result["cleared"] += 1
    return result


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def _account_notes(fp: str, stats: dict, rec: dict, dry_run: bool) -> list[str]:
    """Counts-only heartbeat notes for one account. Any note makes the run 'partial'."""
    notes: list[str] = []
    if stats["mailbox"] != "all_mail":
        notes.append(f"account {fp}: mailbox={stats['mailbox']}")
    if stats["dropped_by_cap"]:
        notes.append(f"account {fp}: {stats['dropped_by_cap']} labeled message(s) beyond the refresh cap "
                     f"{MAX_MESSAGES} not refreshed (kept)")
    unreadable = stats["skipped"]
    chunks = stats["attr_failed_chunks"] + stats["header_failed_chunks"]
    if unreadable or chunks:
        notes.append(f"account {fp}: {unreadable} message(s) unreadable (attrs {stats['attrs_missing']}, labels "
                     f"{stats['labels_unknown']}, headers {stats['headers_missing'] + stats['headers_unusable']}, "
                     f"identity {stats['identity_missing']}), {chunks} fetch chunk(s) failed (kept)")
    if rec.get("identity_ambiguous"):
        notes.append(f"account {fp}: {rec['identity_ambiguous']} message(s) match several stored rows; "
                     f"not refreshed (kept)")
    snippet_gap = stats["bodies_missing"] + stats["snippet_errors"]
    if snippet_gap or stats["body_failed_chunks"]:
        notes.append(f"account {fp}: {snippet_gap} snippet(s) not refreshed, {stats['body_failed_chunks']} "
                     f"body chunk(s) failed (stored snippets kept)")
    if stats["membership"] != RECONCILE_COMPLETE:
        kept = rec.get("unknown")
        notes.append(f"account {fp}: reconcile=unknown({stats['membership']}); "
                     f"{'unknown number of' if kept is None else kept} labeled row(s) kept")
    if rec.get("unidentified"):
        notes.append(f"account {fp}: {rec['unidentified']} labeled row(s) without a Gmail id kept")
    if dry_run and rec.get("would_clear") is None:
        notes.append(f"account {fp}: would-clear count unknown ({NO_DATABASE})")
    return notes


def run_detailed(supa: Any, accounts: list[tuple[str, str]], days: int, dry_run: bool = False) -> dict:
    """One run. Returns counts-only diagnostics: status, records, error note, window and per-account counts."""
    seen_at = datetime.now(timezone.utc).isoformat()
    since = et_today() - timedelta(days=days)
    report: dict[str, Any] = {"status": "failed", "records": 0, "error": None, "window_days": days,
                              "refresh_cap": MAX_MESSAGES, "dry_run": dry_run, "accounts": []}
    if not accounts:
        report["error"] = "no IMAP accounts configured"
        return report
    failures: list[str] = []
    notes: list[str] = []
    total = 0
    for account, password in accounts:
        fp = account_fingerprint(account)
        entry: dict[str, Any] = {"fp": fp}
        report["accounts"].append(entry)
        try:
            rows, stats, membership = process_account(account, password, since, seen_at)
        except Exception as e:
            code = log_failure(log, "account_read_failed", e, fp=fp, level=logging.ERROR,
                               extra={SearchMalformed: "search_malformed"})
            failures.append(f"account {fp}: {code}")
            entry["failed"] = code
            continue
        entry["stats"] = {k: v for k, v in stats.items()}
        try:
            if supa is None:            # dry run without a database: nothing is read or written
                rec = {"refreshed": len(rows), "upserted": 0, "identity_ambiguous": None, "labeled_rows": None,
                       "seen": None, "retained": None, "cleared": 0, "would_clear": None, "unknown": None,
                       "unidentified": None}
            else:
                rec = store_account(supa, account, rows, seen_at, membership, dry_run=dry_run)
        except Exception as e:
            code = log_failure(log, "account_store_failed", e, fp=fp, level=logging.ERROR)
            hint = f" ({STORE_SCHEMA_HINT})" if is_missing_table(e) else ""
            failures.append(f"account {fp}: {code}{hint}")
            entry["failed"] = code
            continue
        entry["reconcile"] = rec
        total += rec["refreshed"]
        cleared_label = "would_clear" if dry_run else "cleared"
        log.info(f"[fp={fp}] mailbox={stats['mailbox']} search={stats['search']} window={days}d "
                 f"candidates={stats['window_candidates']} cap={MAX_MESSAGES} over_cap={stats['dropped_by_cap']} "
                 f"rows={rec['refreshed']} action={stats['action']} deadline={stats['deadline']} "
                 f"unreadable={stats['skipped']} snippet_gaps={stats['bodies_missing'] + stats['snippet_errors']} "
                 f"reconcile={stats['membership']} labeled_rows={rec['labeled_rows']} "
                 f"{cleared_label}={rec[cleared_label]} retained={rec['retained']} unknown={rec['unknown']} "
                 f"unidentified={rec['unidentified']}")
        notes.extend(_account_notes(fp, stats, rec, dry_run))
    report["records"] = total
    if len(failures) == len(accounts):
        report["error"] = "; ".join(failures)
        return report
    configured = {a.strip().lower() for a, _ in accounts}
    missing = [a for a in REQUIRED_ACCOUNTS if a not in configured]
    if missing:
        notes.append(f"{len(missing)} Gmail account(s) not configured (add IMAP_EMAIL_n/IMAP_APP_PASSWORD_n secrets)")
    report["status"] = "partial" if failures or notes else "success"
    report["error"] = "; ".join(failures + notes) or None
    return report


def run(supa: Any, accounts: list[tuple[str, str]], days: int, dry_run: bool = False) -> tuple[str, int, Optional[str]]:
    """Returns (heartbeat status, records, error note)."""
    r = run_detailed(supa, accounts, days, dry_run=dry_run)
    return r["status"], r["records"], r["error"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=bounded_days, default=DEFAULT_DAYS, help="refresh window (default 30)")
    ap.add_argument("--dry-run", action="store_true", help="read Gmail and print counts; no database access")
    args = ap.parse_args()
    if not args.dry_run:
        HEARTBEAT.open()          # write mode, arguments valid: a crash from here on writes a heartbeat
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
             date_range_start=et_today() - timedelta(days=args.days), date_range_end=et_today())
    return 0 if status != "failed" else 1


def fatal(e: BaseException) -> None:
    """Root crash handler: a code on the log; a 'failed' heartbeat ONLY when HEARTBEAT was opened by a
    write-mode run. A --dry-run (or a crash before the mode is known) creates no client and writes nothing."""
    code = log_failure(log, "fatal", e, level=logging.ERROR)
    if not HEARTBEAT.allowed:
        return
    try:
        import os
        from supabase import create_client
        from sync_log_helper import log_sync
        supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
        log_sync(supa, SOURCE, DATA_TYPE, "failed", records=0, error=code)
    except Exception:
        pass


def cli() -> int:
    """Entry point: main() with the crash handler (heartbeat on crash, per the Onyx ETL convention)."""
    HEARTBEAT.close()
    try:
        return main()
    except SystemExit:
        raise
    except Exception as e:
        fatal(e)
        return 1
    finally:
        HEARTBEAT.close()


if __name__ == "__main__":
    sys.exit(cli())
