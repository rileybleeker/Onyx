"""
SimpleFIN Bridge -> pds.finance_accounts / finance_transactions / finance_balance_snapshots.

Why: the Rocket Money browser harvester depended on a web sign-in that expires within hours, so it broke every
day. SimpleFIN Bridge (https://beta-bridge.simplefin.org, $15/yr) is a read-only bank-data service with an API:
one long-lived Access URL, read from GitHub Actions like every other ETL. No browser, no PC, no sign-in to keep
alive. Riley connects the banks on SimpleFIN's own site; Onyx only ever holds the read-only Access URL.

Coverage (checked 2026-11-14): Amex, Wells Fargo, Citi, Discover, Fidelity daily; Apple Card monthly
("Updated Monthly" on SimpleFIN); Apple Cash not offered.

What a run does (one GET /accounts per run; SimpleFIN asks for <= 24 a day, the cron runs 4):
  1. Matches each SimpleFIN account to a ledger account (stored simplefin_id, else institution + last four digits,
     else the account name) or creates one. An account that might be an existing one but cannot be matched
     uniquely is skipped and reported, never guessed: a wrong match would mix two accounts' rows.
  2. Transactions (posted only; pending are not requested) -> rows with the ledger's sign (expense-positive).
     Investment accounts are balances-only, as they were under Rocket Money (trades and dividends are not spending).
  3. Cutover from the Rocket Money history, per account: a row transacted more than OVERLAP_DAYS before the last
     Rocket Money row and posted by that date is dropped (that history already has it; a row posted after it may not
     be there, since Rocket Money skipped pending rows). Any other row is dropped only on identity evidence
     (PIPE-04; the two feeds share no transaction id): same account, amount and currency, and either the same date
     and description text (store numbers included) that names a merchant ('exact') or a date within OVERLAP_DAYS and
     the same merchant name ('merchant': one side's distinctive words all on the other side, including the word that
     names the business, at the smallest date gap of both rows); payee names whose distinctive words contradict,
     store numbers that contradict ('DEMO DELI 0042' and 'DEMO DELI 0099') or two different kinds of business ('DEMO
     CAFE' and 'DEMO HOTEL') are never a match (a shared STORE or COFFEE is no evidence). A group of candidate pairs
     is a match only when it is one to one, or when it has as many SimpleFIN rows as Rocket Money rows and its rows
     cannot be told apart on either side; a group of unequal size is never guessed (key order is not identity
     evidence). The smallest date gap is found over every contender, held and ambiguous rows included, so a row
     whose nearest candidate is held is never paired with a farther one. Every SimpleFIN row of the response takes
     part, so a Rocket Money row whose twin is before the window is taken by that twin, and a Rocket Money row an
     earlier run matched stays taken (pds.finance_cutover_matches; the ledger is read from before the earliest date
     in the answer, and every Rocket Money row the record names is read by key, so the record is replayed whatever
     the date window, and a named row gone from the ledger leaves its claimant kept for review); the candidates of a
     row recorded as ambiguous stay held while that row is missing from a later answer, and a recorded claim or hold
     the run no longer makes is recorded again as 'unconfirmed' (kept for review), never left behind. An equal
     amount alone never drops a row: a row with competing candidates ('ambiguous') or with a same-amount Rocket
     Money row nearby but no merchant evidence ('unconfirmed') is KEPT and counted for review, on every run until a
     heartbeat carrying it is written (review_state 'pending' -> 'reported'). Every match and every row kept for
     review is recorded (also the decisions on rows dropped before the window, which hold or take a Rocket Money
     row) in pds.finance_cutover_matches (keys only; the run's whole set in one statement, so it is never on record
     in part) BEFORE the ledger is written: when that record cannot be read (other than not applied yet), cannot be
     written, or is missing while there are decisions to record, the run fails before writing anything, so a row is
     never left out on a match that is not on record. Rows already stored by an earlier SimpleFIN run are always
     rewritten in place.
  4. Category (SimpleFIN sends none; /financials needs one to keep card payments and transfers out of spending):
     a payment/transfer pair (same amount, opposite sign, two of Riley's accounts, within PAIR_DAYS, one side worded
     like a payment or transfer) -> "Credit Card Payment" or "Internal Transfers"; else the category Rocket Money
     gave the same description (or merchant name) in the history; else payment/transfer wording; else none.
  5. One balance snapshot per account (captured_at = SimpleFIN's balance-date). Asset / liability comes from the
     account's Rocket Money history; a new account stays unclassified (never guessed from its name).
  6. Heartbeats simplefin|transactions and simplefin|balances on every run: failed (exit 1) when SimpleFIN cannot
     be read, partial when it reports a connection problem or an account was skipped.

Output is COUNTS ONLY (the repo and its Actions logs are public): never names, descriptions, amounts or ids.
--dry-run (local) prints a per-account table for checking the matching before the first real run.

Heartbeat text is an ALLOWLIST (NOTE_CODES): a fixed code, fixed wording and a count, nothing else. SimpleFIN's own
error messages, institution and account names and ids never reach sync_log or the log; its errlist codes (gen. /
con. / act.) map to our codes, and anything unknown or malformed is sf_unclassified. /status re-renders these
heartbeats from the codes alone (lib/finance-status.ts, SIMPLEFIN_NOTES), so an older row with free text shows a
generic note.

Secrets: the Access URL comes from SIMPLEFIN_ACCESS_URL or ~/.simplefin_access_url; it is never printed, and every
error text is built from fixed wording. Supabase: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, else
~/.onyx_supabase_secret (local).

Usage:
  python simplefin_etl.py --claim [--set-github-secret]   # one time: setup token file -> Access URL
  python simplefin_etl.py --dry-run [--days 90]            # read everything, write nothing, show the matching
  python simplefin_etl.py [--days N]                       # routine run (default 45 days, max 90)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import unquote, urlsplit, urlunsplit

SOURCE = "simplefin"
ALLOWED_HOSTS = {"beta-bridge.simplefin.org", "bridge.simplefin.org"}
HOME = Path(os.path.expanduser("~"))
ACCESS_FILE = HOME / ".simplefin_access_url"
SETUP_FILE = HOME / ".simplefin_setup_token"
SUPABASE_SECRET_FILE = HOME / ".onyx_supabase_secret"
DEFAULT_SUPABASE_URL = "https://fewweioupmsnbccqtxdl.supabase.co"
GITHUB_REPO = "rileybleeker/Onyx"

DEFAULT_DAYS = 45      # SimpleFIN: "Requested date range exceeds recommended range of 45 days" beyond this
MAX_DAYS = 90          # SimpleFIN: "limited to 90 days at a time"
OVERLAP_DAYS = 3       # cutover: how far a SimpleFIN date may sit from the Rocket Money date of the same row
PAIR_DAYS = 5          # a card payment / transfer posts on both accounts within this many days
LEARN_YEARS = 3        # category history read from the Rocket Money rows
CHUNK = 500
PAGE = 1000

NON_SPENDING = {"Internal Transfers", "Credit Card Payment", "Savings Transfer"}
SKIP_LEARNED = {"", "uncategorized"}

# Payment / transfer wording. Card side: "AUTOPAY PAYMENT - THANK YOU". Bank side: "AMEX EPAYMENT ACH PMT",
# "APPLECARD GSBANK PAYMENT", "CITI CARD ONLINE PAYMENT", "ONLINE TRANSFER TO ...". Person-to-person apps are
# never internal transfers.
PAYMENT_WORDS = re.compile(r"\b(PAYMENT|PMT|EPAY|E PAYMENT|AUTOPAY|AUTO PAY|THANK YOU|TRANSFER|XFER)\b")
TRANSFER_WORDS = re.compile(r"\b(ONLINE TRANSFER|RECURRING TRANSFER|TRANSFER TO|TRANSFER FROM)\b")
CARD_ISSUER_WORDS = re.compile(
    r"\b(AMEX|AMERICAN EXPRESS|APPLECARD|APPLE CARD|GSBANK|GOLDMAN|CITI|CITIBANK|DISCOVER|CHASE|CAPITAL ONE|BARCLAY|CARD)\b"
)
P2P_WORDS = re.compile(r"\b(ZELLE|VENMO|CASH APP|CASHAPP|PAYPAL)\b")

INVESTMENT_WORDS = re.compile(r"\b(401 ?K|IRA|ROTH|BROKERAGE|RETIREMENT|INVESTMENT|HSA|HEALTH SAVINGS|PENSION|INDIVIDUAL)\b", re.I)
CARD_WORDS = re.compile(r"\b(CARD|CREDIT|VISA|MASTERCARD|PLATINUM|GOLD|SAPPHIRE)\b", re.I)
CASH_WORDS = re.compile(r"\b(CHECKING|SAVINGS|WAY2SAVE|DEPOSIT|MONEY MARKET)\b", re.I)


# ---------------------------------------------------------------------------------------------------------------
# Heartbeat notes: the only text a run writes to sync_log or prints about a problem
# ---------------------------------------------------------------------------------------------------------------
# sync_log is read by /status (a cacheable endpoint) and by the support agents, so a note carries only a code from
# this list, its fixed wording and a count: never SimpleFIN's own message text, an institution or account name, an
# id, an amount or the Access URL. SimpleFIN's own site marks the connection that needs attention, and --dry-run
# (local) flags the account. lib/finance-status.ts (SIMPLEFIN_NOTES) lists the same codes with the same wording and
# renders these heartbeats from the codes alone (a frontend test reads this block: one entry per line, in double
# quotes, no escapes).
NOTE_CODES: dict[str, str] = {
    "sf_not_connected": "SimpleFIN is not connected: set the SIMPLEFIN_ACCESS_URL secret (simplefin_etl.py --claim --set-github-secret)",
    "sf_access_url_invalid": "the SimpleFIN Access URL is not a valid SimpleFIN address: claim a new one (simplefin_etl.py --claim --set-github-secret)",
    "sf_access_refused": "SimpleFIN refused the Access URL (revoked, disabled for too many requests, or wrong): create a new setup token at beta-bridge.simplefin.org and run simplefin_etl.py --claim --set-github-secret",
    "sf_payment_required": "SimpleFIN says payment is required: renew the SimpleFIN Bridge subscription",
    "sf_unreachable": "SimpleFIN could not be reached; the next run retries",
    "sf_http_error": "SimpleFIN returned an unexpected HTTP status; the next run retries (the Actions log has the number)",
    "sf_bad_answer": "SimpleFIN's answer was not the expected JSON (the format may have changed)",
    "window_too_long": "the requested window is longer than SimpleFIN's 90-day limit",
    "etl_error": "the SimpleFIN ETL failed unexpectedly (the Actions log names the error type)",
    "db_write_failed": "the SimpleFIN ETL could not write to Supabase; the next run retries",
    "db_read_failed": "the SimpleFIN ETL could not read its cutover record from Supabase; nothing was written, the next run retries",
    "sf_reauth": "SimpleFIN: a bank connection needs signing in again: reconnect it on SimpleFIN's site",
    "sf_connection_error": "SimpleFIN: a bank connection reported an error: check it on SimpleFIN's site",
    "sf_account_failed": "SimpleFIN could not read an account this run; it retries",
    "sf_account_incomplete": "SimpleFIN says an account's transaction list is incomplete this run; it retries",
    "sf_account_error": "SimpleFIN reported an account error: check the connections on SimpleFIN's site",
    "sf_server_auth": "SimpleFIN reported an authentication problem with the Access URL: if it repeats, claim a new one",
    "sf_api_error": "SimpleFIN says the request was malformed (a bug in simplefin_etl.py)",
    "sf_general_error": "SimpleFIN reported a general problem: check SimpleFIN's site",
    "sf_unclassified": "SimpleFIN reported a problem it did not classify: check the connections on SimpleFIN's site",
    "account_no_id": "SimpleFIN sent an account without an id; it was skipped",
    "account_unmatched": "an account was not imported: it could not be matched uniquely to a ledger account (run simplefin_etl.py --dry-run locally)",
    "account_type_unset": "a new account is balances-only until its finance_accounts.account_type is set",
    "cutover_review": "rows near the Rocket Money cutover were kept though a same-amount Rocket Money row is near: check for duplicates (simplefin_etl.py --dry-run locally)",
    "cutover_provenance_unsaved": "the cutover match record table is missing or out of date (apply sql/finance_cutover_matches.sql); nothing was written, the next run retries",
}
NOTE_LIMIT = 300      # past this the later codes keep only their token (format_notes); lib/finance-status.ts agrees
NOTE_MAX_COUNT = 9999

# SimpleFIN protocol v2 errlist codes ("prefix.subcode"; an unknown subcode is treated as the bare prefix).
ERRLIST_CODES = {
    ("con", "auth"): "sf_reauth",
    ("con", ""): "sf_connection_error",
    ("act", "failed"): "sf_account_failed",
    ("act", "missingdata"): "sf_account_incomplete",
    ("act", ""): "sf_account_error",
    ("gen", "auth"): "sf_server_auth",
    ("gen", "api"): "sf_api_error",
    ("gen", ""): "sf_general_error",
}


def note_token(code: str, n: int) -> str:
    return f"[{code} x{n}]" if n > 1 else f"[{code}]"


def format_notes(counts) -> Optional[str]:
    """{code: count} -> 'wording [code]; wording [code x2]' in NOTE_CODES order; codes not in NOTE_CODES are left
    out. Once the wording passes NOTE_LIMIT the later codes keep only their token ('...; also [code x2] [code]'),
    so no code is lost and the length is bounded by the allowlist. The first code always has its wording."""
    items = [(c, min(int(counts.get(c) or 0), NOTE_MAX_COUNT)) for c in NOTE_CODES]
    items = [(c, n) for c, n in items if n > 0]
    if not items:
        return None
    out: list[str] = []
    for i, (c, n) in enumerate(items):
        seg = f"{NOTE_CODES[c]} {note_token(c, n)}"
        if out and len("; ".join(out + [seg])) > NOTE_LIMIT:
            return "; ".join(out) + "; also " + " ".join(note_token(rc, rn) for rc, rn in items[i:])
        out.append(seg)
    return "; ".join(out)


class SimpleFinError(Exception):
    """An error whose text is fixed wording, safe for logs (never a URL, credential or row). `code` is what a
    heartbeat gets (a NOTE_CODES key); `detail` is an HTTP status or an exception type name, for the log only."""

    def __init__(self, code: str, message: Optional[str] = None, detail: Optional[str] = None):
        self.code = code
        self.detail = detail
        super().__init__(message or NOTE_CODES.get(code) or "the SimpleFIN ETL failed")


# ---------------------------------------------------------------------------------------------------------------
# Access URL + claim
# ---------------------------------------------------------------------------------------------------------------
def split_access_url(access_url: str) -> tuple[str, tuple[str, str]]:
    """Access URL -> (base URL without credentials, (user, password)). Refuses anything not on SimpleFIN's host."""
    try:
        parts = urlsplit((access_url or "").strip())
    except ValueError:
        raise SimpleFinError("sf_access_url_invalid", "the SimpleFIN Access URL could not be read") from None
    if parts.scheme != "https" or (parts.hostname or "").lower() not in ALLOWED_HOSTS:
        raise SimpleFinError("sf_access_url_invalid", "the SimpleFIN Access URL is not an https URL on SimpleFIN's host")
    if not parts.username or parts.password is None:
        raise SimpleFinError("sf_access_url_invalid", "the SimpleFIN Access URL has no credentials in it")
    host = parts.hostname + (f":{parts.port}" if parts.port else "")
    base = urlunsplit(("https", host, parts.path.rstrip("/"), "", ""))
    return base, (unquote(parts.username), unquote(parts.password))


def decode_setup_token(token: str) -> str:
    """Setup token (base64 of the claim URL) -> claim URL, checked to be https on SimpleFIN's host."""
    raw = re.sub(r"\s+", "", token or "")
    if not raw:
        raise SimpleFinError("claim_failed", "the setup token file is empty")
    try:
        url = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=False).decode("utf-8").strip()
    except Exception:
        raise SimpleFinError("claim_failed", "the setup token is not base64") from None
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in ALLOWED_HOSTS:
        raise SimpleFinError("claim_failed", "the setup token does not point at SimpleFIN's claim URL")
    return url


def claim_access_url(token: str, http) -> str:
    """POSTs once to the claim URL (a setup token works only once) and returns the Access URL."""
    claim_url = decode_setup_token(token)
    try:
        res = http.post(claim_url, headers={"Content-Length": "0"}, timeout=30)
    except Exception:
        raise SimpleFinError("claim_failed", "the claim request could not be sent") from None
    if res.status_code == 403:
        raise SimpleFinError("claim_failed", "SimpleFIN refused the setup token (already used or wrong); create a new one")
    if res.status_code != 200:
        raise SimpleFinError("claim_failed", f"the claim request returned HTTP {int(res.status_code)}")
    access_url = (res.text or "").strip()
    split_access_url(access_url)  # validates host + credentials
    return access_url


def load_access_url() -> str:
    env = (os.environ.get("SIMPLEFIN_ACCESS_URL") or "").strip()
    if env:
        return env
    try:
        text = ACCESS_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    if not text:
        raise SimpleFinError("sf_not_connected", "no SimpleFIN Access URL: set SIMPLEFIN_ACCESS_URL (GitHub secret) or run --claim")
    return text


# ---------------------------------------------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------------------------------------------
def epoch(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def fetch_accounts(access_url: str, start: date, end_exclusive: date, http) -> dict:
    """GET /accounts?version=2 over [start, end_exclusive). Raises SimpleFinError with fixed wording."""
    if (end_exclusive - start).days > MAX_DAYS:
        raise SimpleFinError("window_too_long")
    base, auth = split_access_url(access_url)
    params = {"version": "2", "start-date": str(epoch(start)), "end-date": str(epoch(end_exclusive))}
    try:
        res = http.get(f"{base}/accounts", params=params, auth=auth, timeout=90, follow_redirects=True)
    except Exception:
        raise SimpleFinError("sf_unreachable") from None
    if res.status_code == 403:
        raise SimpleFinError("sf_access_refused")
    if res.status_code == 402:
        raise SimpleFinError("sf_payment_required")
    if res.status_code != 200:
        raise SimpleFinError("sf_http_error", detail=f"HTTP {res.status_code if isinstance(res.status_code, int) else 0}")
    try:
        body = res.json()
    except Exception:
        raise SimpleFinError("sf_bad_answer", "SimpleFIN's answer was not JSON") from None
    if not isinstance(body, dict) or not isinstance(body.get("accounts"), list):
        raise SimpleFinError("sf_bad_answer", "SimpleFIN's answer had no accounts list (the format may have changed)")
    return body


# ---------------------------------------------------------------------------------------------------------------
# Pure normalization
# ---------------------------------------------------------------------------------------------------------------
def to_cents(value: Any) -> Optional[int]:
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite():
        return None
    return int((d * 100).to_integral_value(rounding="ROUND_HALF_UP"))


def utc_date(ts: Any) -> Optional[date]:
    """SimpleFIN timestamps are Unix seconds; bank dates arrive as midnight or noon UTC, so the UTC date is the date."""
    try:
        n = int(ts)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n, tz=timezone.utc).date()


def response_dates(accounts: Iterable["SfAccount"]) -> list[date]:
    """Every transacted and posted date in SimpleFIN's answer (build_plan reads the ledger from before the earliest).
    A timestamp too large for a date is left out here (normalize_transactions judges the row itself)."""
    out: list[date] = []
    for a in accounts:
        for t in a.transactions:
            for ts in (t.get("transacted_at"), t.get("posted")):
                try:
                    d = utc_date(ts)
                except (OverflowError, OSError, ValueError):
                    d = None
                if d:
                    out.append(d)
    return out


def clean(s: Any, limit: int = 300) -> Optional[str]:
    if not isinstance(s, str):
        return None
    t = re.sub(r"\s+", " ", s).strip()
    return t[:limit] or None


def norm_text(s: Optional[str]) -> str:
    """Upper-case letters only, single spaces: store numbers, dates and card digits drop out."""
    t = re.sub(r"[^A-Z]+", " ", (s or "").upper())
    return " ".join(w for w in t.split() if len(w) > 1)


def canonical_institution(*names: Optional[str]) -> str:
    """Institution names from either feed -> one key ("Citibank Online" and "Citi" -> citi; "Citizens" is not Citi)."""
    text = " ".join(n for n in names if n).lower()
    spaced = " " + re.sub(r"[^a-z0-9]+", " ", text).strip() + " "
    compact = spaced.replace(" ", "")
    for key, pattern in (
        ("amex", r" american express | amex | americanexpress "),
        ("wellsfargo", r" wells fargo | wellsfargo "),
        ("citi", r" citi | citibank | citicards "),
        ("discover", r" discover "),
        ("fidelity", r" fidelity "),
        ("apple", r" apple | goldman sachs | gsbank "),
        ("chase", r" chase "),
        ("capitalone", r" capital one | capitalone "),
    ):
        if re.search(pattern, spaced):  # each alternative carries its own spaces: whole words only
            return key
    return compact


def last_four(name: Optional[str]) -> Optional[str]:
    m = re.search(r"(\d{4})\D*$", name or "")
    return m.group(1) if m else None


def compact_name(name: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\.\.\.\d+|\(\d+\)|\d{4}\s*$", "", (name or "").lower()))


def infer_account_type(name: Optional[str]) -> str:
    n = name or ""
    if INVESTMENT_WORDS.search(n):
        return "Investment"
    if CASH_WORDS.search(n):
        return "Cash"
    if CARD_WORDS.search(n):
        return "Credit Card"
    return "Unknown"


def is_balances_only(account_type: Optional[str]) -> bool:
    t = (account_type or "").strip().lower()
    return t in ("investment", "unknown", "")


def is_credit(account_type: Optional[str]) -> bool:
    return "credit" in (account_type or "").lower()


@dataclass
class SfAccount:
    id: str
    name: str
    institution: str
    org_hint: str
    mask: Optional[str]
    currency: str
    balance_cents: Optional[int]
    balance_at: Optional[datetime]
    transactions: list = field(default_factory=list)
    conn_id: str = ""


def parse_accounts(body: dict) -> tuple[list[SfAccount], Counter]:
    """The /accounts body -> accounts + problems as NOTE_CODES counts."""
    conns = {}
    for c in body.get("connections") or []:
        if isinstance(c, dict) and c.get("conn_id"):
            conns[str(c["conn_id"])] = c
    out: list[SfAccount] = []
    problems: Counter = Counter()
    for a in body.get("accounts") or []:
        if not isinstance(a, dict) or not a.get("id"):
            problems["account_no_id"] += 1
            continue
        conn = conns.get(str(a.get("conn_id") or ""), {})
        org = a.get("org") if isinstance(a.get("org"), dict) else {}
        inst = clean(conn.get("name")) or clean(a.get("conn_name")) or clean(conn.get("org_name")) or clean(org.get("name")) or "Unknown"
        hint = " ".join(filter(None, [clean(conn.get("org_url")), clean(org.get("domain")), clean(org.get("url"))]))
        name = clean(a.get("name")) or "Account"
        bal_ts = a.get("balance-date")
        bal_at = datetime.fromtimestamp(int(bal_ts), tz=timezone.utc) if str(bal_ts or "").isdigit() and int(bal_ts) > 0 else None
        out.append(SfAccount(
            id=str(a["id"]),
            name=name,
            institution=inst,
            org_hint=hint,
            mask=last_four(name),
            currency=clean(a.get("currency"), 200) or "USD",
            balance_cents=to_cents(a.get("balance")),
            balance_at=bal_at,
            transactions=[t for t in (a.get("transactions") or []) if isinstance(t, dict)],
            conn_id=str(a.get("conn_id") or ""),
        ))
    return out, problems


def classify_error(code: Any) -> str:
    """A SimpleFIN errlist code -> one of our NOTE_CODES. An unknown subcode counts as the bare prefix (as the
    protocol asks); an unknown prefix or anything malformed is sf_unclassified. The message text is never read."""
    c = code.strip().lower() if isinstance(code, str) else ""
    if not re.fullmatch(r"[a-z]{1,10}\.[a-z0-9_.]{0,40}", c):
        return "sf_unclassified"
    prefix, _, sub = c.partition(".")
    return ERRLIST_CODES.get((prefix, sub.split(".")[0])) or ERRLIST_CODES.get((prefix, "")) or "sf_unclassified"


@dataclass(frozen=True)
class SfIssue:
    code: str              # a NOTE_CODES key
    conn_id: str = ""      # only to flag an account in the local --dry-run table; never written or logged
    account_id: str = ""


def _opaque_id(v: Any) -> str:
    return str(v)[:200] if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v) else ""


def connection_errors(body: dict) -> list[SfIssue]:
    """errlist (v2) -> distinct issues: our code + the connection / account SimpleFIN named. The deprecated `errors`
    strings are read only when there is no errlist (v2 servers send both), each as sf_unclassified."""
    issues: list[SfIssue] = []
    errlist = body.get("errlist")
    if isinstance(errlist, list) and errlist:
        for e in errlist:
            if isinstance(e, dict):
                issues.append(SfIssue(classify_error(e.get("code")), _opaque_id(e.get("conn_id")), _opaque_id(e.get("account_id"))))
            else:
                issues.append(SfIssue("sf_unclassified"))
    elif errlist not in (None, [], ""):
        issues.append(SfIssue("sf_unclassified"))  # an errlist that is not a list: the format changed
    else:
        errors = body.get("errors")
        if isinstance(errors, list):
            issues.extend(SfIssue("sf_unclassified") for e in errors if e)
        elif errors:
            issues.append(SfIssue("sf_unclassified"))
    out: list[SfIssue] = []
    for i in issues:
        if i not in out:
            out.append(i)
    return out


def txn_key(account_sf_id: str, txn_id: str) -> str:
    return hashlib.sha256(f"sfid|{account_sf_id}|{txn_id}".encode("utf-8")).hexdigest()[:32]


def new_account_key(account_sf_id: str) -> str:
    return hashlib.sha256(f"simplefin|{account_sf_id}".encode("utf-8")).hexdigest()[:24]


def normalize_transactions(acct: SfAccount, account_key: str) -> tuple[list[dict], Counter]:
    """SimpleFIN transactions -> ledger rows (expense-positive). Pending and unreadable rows are counted, not stored."""
    rows: dict[str, dict] = {}
    skipped: Counter = Counter()
    for t in acct.transactions:
        tid = t.get("id")
        if not tid:
            skipped["no id"] += 1
            continue
        if t.get("pending") is True or str(t.get("posted") or "0") in ("0", ""):
            skipped["pending"] += 1
            continue
        cents = to_cents(t.get("amount"))
        when = utc_date(t.get("transacted_at")) or utc_date(t.get("posted"))
        posted = utc_date(t.get("posted"))
        if cents is None or when is None:
            skipped["unreadable"] += 1
            continue
        description = clean(t.get("description"))
        name = clean(t.get("payee")) or description or "Unknown"
        key = txn_key(acct.id, str(tid))
        rows[key] = {
            "txn_key": key,
            "account_key": account_key,
            "txn_date": when.isoformat(),
            "original_date": posted.isoformat() if posted and posted != when else None,
            "name": name,
            "amount_cents": -cents,  # SimpleFIN: deposits positive. Ledger: expenses positive.
            "currency": acct.currency,
            "description": description,
            "source": SOURCE,
            "source_txn_id": f"sf:{acct.id}:{tid}"[:300],
            "category": None,
        }
    return list(rows.values()), skipped


# ---------------------------------------------------------------------------------------------------------------
# Pure matching, cutover and categories
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class Match:
    account_key: Optional[str]
    action: str        # 'linked' | 'matched' | 'new' | 'skip'
    reason: str = ""


def match_accounts(sf_accounts: list[SfAccount], ledger: list[dict]) -> dict[str, Match]:
    """SimpleFIN account id -> ledger account. Unique evidence only; anything doubtful is skipped, never guessed."""
    by_sf = {r["simplefin_id"]: r for r in ledger if r.get("simplefin_id")}
    taken = {r["account_key"] for r in by_sf.values()}
    result: dict[str, Match] = {}
    for a in sf_accounts:
        if a.id in by_sf:
            result[a.id] = Match(by_sf[a.id]["account_key"], "linked")
            continue
        inst = canonical_institution(a.institution, a.org_hint)
        same_inst = [
            r for r in ledger
            if r["account_key"] not in taken and not r.get("simplefin_id")
            and canonical_institution(r.get("institution")) == inst
        ]
        if not same_inst:
            result[a.id] = Match(None, "new", "no ledger account at this institution")
            continue
        if a.mask:
            hits = [r for r in same_inst if (r.get("mask") or last_four(r.get("account_name"))) == a.mask]
            if len(hits) == 1:
                result[a.id] = Match(hits[0]["account_key"], "matched", "institution + last four")
                taken.add(hits[0]["account_key"])
                continue
            if not hits:
                masks = [r.get("mask") or last_four(r.get("account_name")) for r in same_inst]
                if all(masks):
                    result[a.id] = Match(None, "new", "last four not in the ledger")
                    continue
        cname = compact_name(a.name)
        hits = [
            r for r in same_inst
            if cname and (compact_name(r.get("account_name")) == cname
                          or (len(cname) >= 5 and (cname in compact_name(r.get("account_name")) or compact_name(r.get("account_name")) in cname)))
        ]
        if not hits:
            # Some connections name the account after its owner ("Riley") and carry the product in the
            # connection name ("Apple Card (Updated Monthly)"): match a ledger name found inside it.
            conn = compact_name(a.institution)
            hits = [r for r in same_inst if len(compact_name(r.get("account_name"))) >= 5 and compact_name(r.get("account_name")) in conn]
        if len(hits) == 1:
            result[a.id] = Match(hits[0]["account_key"], "matched", "institution + name")
            taken.add(hits[0]["account_key"])
        else:
            result[a.id] = Match(None, "skip", "could not be matched uniquely to a ledger account")
    return result


# Cutover identity evidence (PIPE-04). Words that say nothing about which merchant it was.
GENERIC_WORDS = frozenset({
    "POS", "PURCHASE", "DEBIT", "CREDIT", "CARD", "ONLINE", "PAYMENT", "PMT", "ACH", "WEB", "RECURRING", "CHECKCARD",
    "VISA", "MASTERCARD", "TRANSACTION", "WITHDRAWAL", "DEPOSIT", "AUTHORIZED", "PENDING", "INC", "LLC", "LTD", "CORP",
    "THE", "AND", "FOR", "FROM", "WWW", "COM", "NET", "ORG", "HTTP", "HTTPS", "USA", "PAYPAL", "SQ", "TST",
})
# Words that name a kind of business, not which one. They count toward the shared words, but never as the word that
# identifies the merchant: "DEMOBREW COFFEE ATLANTA" and "OTHERBREW COFFEE ATLANTA" share two of three words and are
# still two merchants. Two DIFFERENT kinds are evidence against a match (trades_conflict): "DEMO CAFE ATLANTA" and
# "DEMO HOTEL ATLANTA" are two businesses.
TRADE_WORDS = frozenset({
    "COFFEE", "CAFE", "ESPRESSO", "TEA", "DELI", "BAKERY", "BAGEL", "DONUT", "DONUTS", "GROCER", "GROCERY", "GROCERIES",
    "MARKET", "SUPERMARKET", "FOODS", "FOOD", "PHARMACY", "DRUG", "DRUGS", "STORE", "STORES", "SHOP", "SHOPS", "MART",
    "OUTLET", "BOUTIQUE", "RESTAURANT", "BISTRO", "BAR", "GRILL", "KITCHEN", "PIZZA", "PIZZERIA", "TACO", "TACOS",
    "BURGER", "BURGERS", "SUSHI", "RAMEN", "DINER", "TAVERN", "PUB", "LOUNGE", "BREWING", "BREWERY", "WINE", "LIQUOR",
    "LIQUORS", "SPIRITS", "BEER", "GAS", "FUEL", "STATION", "PARKING", "GARAGE", "HOTEL", "INN", "SALON", "SPA",
    "BARBER", "GYM", "FITNESS", "CLUB", "STUDIO", "CENTER", "CENTRE", "SERVICE", "SERVICES", "COMPANY", "GROUP",
    "STREET", "AVENUE", "ROAD",
})
REVIEW_DECISIONS = ("stored_duplicate", "ambiguous", "unconfirmed")
CLAIM_DECISIONS = ("matched", "stored_duplicate")   # a recorded decision that ties a Rocket Money row to one SimpleFIN row
# A decision records EVERY Rocket Money key it names, never cut to a few: the candidates of an ambiguous row are what
# step 0 of apply_cutover holds on later runs, so a key left out would be free for another purchase (Codex review).
# They are few anyway: same account, amount and currency, within OVERLAP_DAYS.

STORE_NUMBER_DIGITS = 3   # a run of this many digits or more is a store / location number ('0042'); '11/14' is not


def _currency(row: dict) -> str:
    return (row.get("currency") or "USD").strip().upper()


def _row_dates(row: dict) -> set[date]:
    out = {date.fromisoformat(row["txn_date"])}
    if row.get("original_date"):
        out.add(date.fromisoformat(row["original_date"]))
    return out


def date_gap(a: dict, b: dict) -> int:
    """Smallest day gap between the two rows' dates (each has a date and maybe an original / posted date)."""
    return min(abs((x - y).days) for x in _row_dates(a) for y in _row_dates(b))


def _merchant_words(text: Optional[str]) -> list[str]:
    return [w for w in norm_text(text).split() if len(w) >= 3 and w not in GENERIC_WORDS]


def merchant_tokens(row: dict) -> frozenset:
    return frozenset(_merchant_words(row.get("description")) + _merchant_words(row.get("name")))


def _distinctive(words: Iterable[str]) -> frozenset:
    """Merchant words that can say WHICH business it is: not a GENERIC_WORD (already gone) nor a TRADE_WORD."""
    return frozenset(w for w in words if w not in TRADE_WORDS)


def ident_text(s: Optional[str]) -> str:
    """Upper-case letters AND digits, single spaces: the text two rows must share to be told apart by nothing (an
    'exact' twin). Unlike norm_text it keeps store numbers: 'DEMO DELI 0042' and 'DEMO DELI 0099' are two shops."""
    return " ".join(re.sub(r"[^A-Z0-9]+", " ", (s or "").upper()).split())


def merchant_leads(row: dict) -> frozenset:
    """The first merchant word of the description and of the name, where it names the business (not a TRADE_WORD).
    Bank descriptions start with the merchant ('DEMO CAFE 0042 ATLANTA GA') and end with the place."""
    out = set()
    for text in (row.get("description"), row.get("name")):
        words = _merchant_words(text)
        if words and words[0] not in TRADE_WORDS:
            out.add(words[0])
    return frozenset(out)


def names_conflict(a: dict, b: dict) -> bool:
    """Both rows name a payee / merchant and neither name's DISTINCTIVE words are all on the other row: two
    merchants, whatever the descriptions say ('PLAZA KIOSK' with payee 'Demo Cafe' vs 'PLAZA KIOSK' with merchant
    'Other Shop'). Words like STORE or COFFEE are left out of the comparison (Codex review): 'Demo Store' and
    'Other Store' share a word and are still two payees. A payee of generic words only ('Store') neither agrees nor
    conflicts. One side's distinctive payee words may sit in the other side's description, so a processor payee
    ('Square' on 'SQ *DEMO CAFE') still agrees with the merchant name 'Demo Cafe'."""
    na, nb = _distinctive(_merchant_words(a.get("name"))), _distinctive(_merchant_words(b.get("name")))
    if not (na and nb):
        return False
    return not (na <= _distinctive(merchant_tokens(b)) or nb <= _distinctive(merchant_tokens(a)))


def store_numbers(row: dict) -> frozenset:
    """The store / location numbers of a row: every run of STORE_NUMBER_DIGITS digits or more in its description and
    name, leading zeros dropped ('DEMO DELI #0042' -> {'42'}). Shorter numbers ('11/14', '#7') say nothing."""
    out = set()
    for text in (row.get("description"), row.get("name")):
        for tok in ident_text(text).split():
            if tok.isdigit() and len(tok) >= STORE_NUMBER_DIGITS:
                out.add(tok.lstrip("0") or "0")
    return frozenset(out)


def numbers_conflict(a: dict, b: dict) -> bool:
    """Both rows carry store numbers and neither row's numbers are all on the other: two shops of one chain
    ('DEMO DELI 0042' vs 'DEMO DELI 0099'; Codex review), even when their words agree. A number on one side only
    (the other feed left it out: 'DEMO CAFE 0042 ATLANTA' vs 'Demo Cafe'), or one side's numbers all on the other
    (an extra reference or date), is no conflict."""
    na, nb = store_numbers(a), store_numbers(b)
    return bool(na and nb) and not (na <= nb or nb <= na)


def trades_conflict(a: dict, b: dict) -> bool:
    """Both rows name a kind of business and neither row's kinds are all on the other: a cafe and a hotel ('DEMO
    CAFE ATLANTA' vs 'DEMO HOTEL ATLANTA'; Codex review), even when every other word agrees. A TRADE_WORD never says
    WHICH business it is, so it is no evidence for a match, but two different kinds are two businesses: evidence
    against one. Compared on each row's merchant words (description and name together), like the distinctive words
    in merchant_evidence, so a kind on one side only, or one side's kinds all on the other ('DEMO COFFEE BAR' vs
    'Demo Coffee'), is no conflict."""
    ka, kb = merchant_tokens(a) & TRADE_WORDS, merchant_tokens(b) & TRADE_WORDS
    return bool(ka and kb) and not (ka <= kb or kb <= ka)


def identity_conflict(a: dict, b: dict) -> bool:
    """The rows name two different payees, two different store numbers or two different kinds of business: never the
    same purchase."""
    return names_conflict(a, b) or numbers_conflict(a, b) or trades_conflict(a, b)


def exact_key(row: dict) -> Optional[tuple]:
    """Same account (callers compare one account), date, amount, currency and description text, store numbers
    included (ident_text). Only a description that names a merchant counts ('POS PURCHASE', '#1234' or 'COFFEE
    SHOP' alone say nothing). The payee names can still tell two such rows apart (identity_conflict)."""
    words = _merchant_words(row.get("description"))
    if not words or words[0] in TRADE_WORDS:
        return None
    return (row["txn_date"], row["amount_cents"], _currency(row), ident_text(row.get("description")))


def merchant_evidence(a: dict, b: dict) -> bool:
    """The rows name the same merchant: more than half of the shorter side's merchant words (description and name)
    are shared; the distinctive words of one side (its merchant words other than TRADE_WORDS) are ALL on the other
    side, so a bank text and its cleaned name agree ('DEMO CAFE 0042 ATLANTA GA' vs 'Demo Cafe') but two shops that
    share a first word, a city or a kind of business do not ('DEMO BOTTLE COFFEE' vs 'DEMO DONKEY COFFEE', 'DEMO
    ATLANTA' vs 'SHOP ATLANTA', 'DEMOBREW COFFEE' vs 'OTHERBREW COFFEE'); the shared words include the word that
    names the business on one side; and neither the payee names, the store numbers nor the kinds of business
    contradict each other (identity_conflict: merchant_tokens drop the digits, so 'DEMO DELI 0042' and 'DEMO DELI
    0099' share every word and are still two shops, and the distinctive words leave the TRADE_WORDS out, so 'DEMO
    CAFE ATLANTA' and 'DEMO HOTEL ATLANTA' agree on them and are still two businesses)."""
    ta, tb = merchant_tokens(a), merchant_tokens(b)
    shared = ta & tb
    if not shared or 2 * len(shared) <= min(len(ta), len(tb)):
        return False
    da, db = ta - TRADE_WORDS, tb - TRADE_WORDS
    if not (da and db) or not (da <= db or db <= da):
        return False
    if not (merchant_leads(a) & tb or merchant_leads(b) & ta):
        return False
    return not identity_conflict(a, b)


def same_purchase(a: dict, b: dict) -> Optional[str]:
    """'exact' | 'merchant' when the two rows carry identity evidence, else None (amount, currency, dates, words)."""
    if a["amount_cents"] != b["amount_cents"] or _currency(a) != _currency(b) or date_gap(a, b) > OVERLAP_DAYS:
        return None
    ka = exact_key(a)
    if ka is not None and ka == exact_key(b) and not identity_conflict(a, b):
        return "exact"
    return "merchant" if merchant_evidence(a, b) else None


def recorded_claims(saved: Optional[dict]) -> dict[str, set[str]]:
    """Recorded decisions -> {Rocket Money txn_key: SimpleFIN keys that claimed it} (matched / stored_duplicate)."""
    claims: dict[str, set[str]] = defaultdict(set)
    for sf_key, rec in (saved or {}).items():
        if rec.get("decision") in CLAIM_DECISIONS and len(rec.get("history_txn_keys") or []) == 1:
            claims[rec["history_txn_keys"][0]].add(sf_key)
    return dict(claims)


def recorded_holds(saved: Optional[dict]) -> dict[str, tuple]:
    """Recorded 'ambiguous' decisions -> {SimpleFIN txn_key: the Rocket Money candidates it competed for}. While that
    SimpleFIN row is missing from a response its candidates are held (apply_cutover, step 0): the record cannot
    say which of them, if any, is its twin, so none may be matched to another row."""
    return {sf_key: tuple(rec.get("history_txn_keys") or ()) for sf_key, rec in (saved or {}).items()
            if rec.get("decision") == "ambiguous" and rec.get("history_txn_keys")}


def in_cutover_window(row: dict, cutover: date) -> bool:
    """Whether the cutover rule judges the row on evidence. A row transacted more than OVERLAP_DAYS before the
    account's last Rocket Money date and posted by that date is in the Rocket Money history already (it was posted
    while the harvester still read the account). A row posted after that date may not be: Rocket Money skipped
    pending rows."""
    if date.fromisoformat(row["txn_date"]) >= cutover - timedelta(days=OVERLAP_DAYS):
        return True
    posted = row.get("original_date")
    return bool(posted) and date.fromisoformat(posted) > cutover


def _signature(row: dict) -> tuple:
    """What two same-amount rows of one feed can be told apart by: their dates and text (store numbers included)."""
    return (row["txn_date"], row.get("original_date") or "", ident_text(row.get("description")), ident_text(row.get("name")))


def _components(edges: Iterable[tuple[str, str]]) -> list[tuple[list, list]]:
    """(SimpleFIN key, Rocket Money key) edges -> connected groups, each (SimpleFIN keys, Rocket Money keys), sorted."""
    parent: dict[tuple, tuple] = {}

    def root(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for sk, hk in edges:
        a, b = root(("s", sk)), root(("h", hk))
        if a != b:
            parent[b] = a
    groups: dict[tuple, tuple] = {}
    for node in sorted(parent):
        groups.setdefault(root(node), ([], []))[0 if node[0] == "s" else 1].append(node[1])
    return sorted((sorted(s), sorted(h)) for s, h in groups.values())


def _resolve(ss: list, hs: list, sf: dict, hist: dict) -> Optional[list]:
    """One connected group of candidate pairs (sorted SimpleFIN keys, sorted Rocket Money keys) -> its pairs, or None
    when the group must not be guessed. A group is a match when it is one to one, or when it has as many SimpleFIN
    rows as Rocket Money rows and the rows on each side cannot be told apart (_signature): every row on both sides
    is then paired, so the order of the pairs changes nothing about what is kept, dropped or taken. A group of
    unequal size is never paired (Codex + Claude review): more SimpleFIN rows than twins (two identical new rows
    for one Rocket Money row), and also fewer (one row for two identical Rocket Money rows: which one, or whether
    either, is its twin is not known, and key order is not identity evidence). Rows that can be told apart
    competing are never guessed either. The rows of such a group are kept as ambiguous and its Rocket Money rows
    held (apply_cutover)."""
    if len(ss) != len(hs):
        return None
    if len(ss) == 1:
        return [(ss[0], hs[0])]
    if len({_signature(sf[k]) for k in ss}) != 1 or len({_signature(hist[k]) for k in hs}) != 1:
        return None
    return list(zip(ss, hs))   # equal sizes: every row on both sides is paired


@dataclass(frozen=True)
class CutoverDecision:
    sf_txn_key: str
    account_key: str
    decision: str              # matched | stored_duplicate | ambiguous | unconfirmed
    evidence: Optional[str]    # exact | merchant (matched / stored_duplicate), else None
    history_txn_keys: tuple    # the Rocket Money twin, or the candidates
    cutover_date: str = ""     # the account's last Rocket Money date the decision was made against
    kept: bool = True          # the row is in the ledger (not stored in the record: only kept rows are for review)


def apply_cutover(sf_rows: list[dict], history: list[dict], cutover: Optional[date], stored_keys: set[str],
                  claims: Optional[dict] = None,
                  records: Optional[dict] = None) -> tuple[list[dict], Counter, list[CutoverDecision]]:
    """SimpleFIN rows -> (kept, dropped counts, decisions) against one account's Rocket Money history (module
    docstring, step 3). Deterministic and order-independent. A row is dropped only when it is matched on identity
    evidence or when it is before the cutover window (in_cutover_window); a row stored by an earlier run is always
    kept (a match then marks it 'stored_duplicate').

    Every SimpleFIN row takes part in the matching, also the rows before the window: their Rocket Money twins are
    taken by them, so a later purchase of the same amount cannot claim one, and their decisions are recorded too.
    `records` (the saved decisions of earlier runs, {sf_txn_key: {'decision', 'history_txn_keys'}}; `claims` alone
    is recorded_claims of them) keeps those decisions: a Rocket Money row claimed by a row missing from this
    response stays taken, a claim whose row is still here and still carries the evidence is kept as it was, and
    the candidates of a row recorded as ambiguous are held while that row is missing (Codex review: two rows
    competing for one twin, then a later answer without them, must not let a third purchase take it). A recorded
    claim or ambiguity whose row is here but that this run no longer makes is replaced by a decision: the new one,
    or 'unconfirmed' with the keys the record named (kept for review), so a stale claim or hold is never left in
    the record (Codex review: a matched row whose amount changed, then a later answer without it)."""
    kept: list[dict] = []
    dropped: Counter = Counter()
    if cutover is None:
        return list(sf_rows), dropped, []
    if claims is None:
        claims = recorded_claims(records)
    rows = sorted(sf_rows, key=lambda r: (r["txn_date"], r["txn_key"]))
    in_zone = {r["txn_key"]: in_cutover_window(r, cutover) for r in rows}
    present = {r["txn_key"]: r for r in rows}
    pool = sorted(history, key=lambda h: (h["txn_date"], h["txn_key"]))
    hist = {h["txn_key"]: h for h in pool}

    used: set[str] = set()     # Rocket Money rows taken: never matched again, not a candidate either
    held: set[str] = set()     # Rocket Money rows held: never matched, still a candidate (others become ambiguous)
    found: dict[str, tuple] = {}   # sf txn_key -> (decision, evidence, history keys)
    carried: dict[str, set] = defaultdict(set)   # present sf txn_key -> Rocket Money keys its record named

    # 0. Earlier decisions.
    #    Claims: a Rocket Money row claimed by a SimpleFIN row absent from this response stays taken (a narrower or
    #    incomplete answer must not free it for another purchase); a claim still present and still evidenced is
    #    kept, so a new same-merchant row cannot turn a settled match into a new ambiguity. A present claimant whose
    #    evidence is gone (its amount or text changed) no longer holds the row: it is decided again (step 4). A
    #    present claimant's record is carried whether or not its Rocket Money row is in `history` (Codex review):
    #    build_plan reads every Rocket Money row a record names, whatever its date, so a row missing here is not in
    #    the ledger at all, and the claimant is then decided again and kept for review, never written unremarked.
    for hk in sorted(claims):
        claimants = claims[hk]
        here = sorted(claimants & present.keys())
        for sk in here:
            carried[sk].add(hk)
        h = hist.get(hk)
        if h is None:
            continue   # not this account's, or no longer in the ledger: nothing to take or hold
        evidenced = [(sk, same_purchase(present[sk], h)) for sk in here]
        evidenced = [(sk, how) for sk, how in evidenced if how and sk not in found]
        if len(evidenced) == 1:
            used.add(hk)
            found[evidenced[0][0]] = ("matched", evidenced[0][1], (hk,))
        elif claimants - present.keys():
            used.add(hk)
        elif evidenced:
            held.add(hk)   # two present claimants still evidenced (a record this code never writes): never guessed
    #    Ambiguities: the candidates of a row recorded as ambiguous and missing from this response are held. A row
    #    recorded as ambiguous that is here competes again on its own.
    for sk, keys in recorded_holds(records).items():
        if sk in present:
            carried[sk].update(keys)
        else:
            held.update(k for k in keys if k in hist and k not in used)

    # 1. Exact: same date, amount, currency and description text, payees and store numbers not contradicting. Each
    #    connected group of such pairs is decided by _resolve: one to one, or as many indistinguishable rows on each
    #    side, is a match; anything else (a group of unequal size, rows that can be told apart, or a twin held by step
    #    0) is ambiguous, and the group's Rocket Money rows are held for it, so no other row can take them in step 2.
    by_key: dict[tuple, list] = defaultdict(list)
    for h in pool:
        k = exact_key(h)
        if k and h["txn_key"] not in used:
            by_key[k].append(h)
    exact_edges = [(r["txn_key"], h["txn_key"]) for r in rows if r["txn_key"] not in found
                   for h in by_key.get(exact_key(r), ()) if not identity_conflict(r, h)]
    for ss, hs in _components(exact_edges):
        pairs = None if held.intersection(hs) else _resolve(ss, hs, present, hist)
        if pairs is None:
            held.update(hs)
            for sk in ss:
                cands = tuple(sorted(hk for s, hk in exact_edges if s == sk))
                found[sk] = ("ambiguous", None, cands)
            continue
        for sk, hk in pairs:
            used.add(hk)
            found[sk] = ("matched", "exact", (hk,))

    # 2. Merchant: same amount and currency, dates within OVERLAP_DAYS, the same merchant (merchant_evidence). A
    #    candidate pair counts only at the smallest date gap of BOTH its rows, so a purchase repeated on the next
    #    days pairs day by day (the next day's row is the next day's twin). Each group of such pairs is decided by
    #    _resolve, like step 1. Rounds repeat on what is left until one matches nothing. A row still holding
    #    candidates then is ambiguous (a tie, rows that can be told apart, a group of unequal size, or a twin held by
    #    step 1) and is kept. Every candidate is recorded, none cut: step 0 holds them all on later runs.
    #    The smallest date gaps are taken over EVERY contender (Codex review R4): a held Rocket Money row (step 0 or
    #    1) and a SimpleFIN row step 1 left ambiguous count too. Held and ambiguous rows are never matched here, but a
    #    group they are nearest in is not matched either, so a row whose nearest candidate is held, or a Rocket Money
    #    row whose nearest SimpleFIN row is ambiguous, is never paired with a farther row instead (that would guess
    #    another purchase and drop a real one). A row step 1 left ambiguous also records its merchant candidates, so
    #    they stay held while it is missing from a later answer.
    rest = [r for r in rows if r["txn_key"] not in found]
    contested = {sk for sk, (decision, _, _) in found.items() if decision == "ambiguous"}   # step 1: never matched
    contenders = rest + [r for r in rows if r["txn_key"] in contested]
    free = {h["txn_key"]: h for h in pool if h["txn_key"] not in used}   # held rows included: contenders only
    near = {r["txn_key"]: [h for h in free.values() if h["amount_cents"] == r["amount_cents"]
                           and _currency(h) == _currency(r) and date_gap(r, h) <= OVERLAP_DAYS] for r in contenders}
    edge_gap = {(r["txn_key"], h["txn_key"]): date_gap(r, h)
                for r in contenders for h in near[r["txn_key"]] if merchant_evidence(r, h)}
    while True:
        live = {e: g for e, g in edge_gap.items() if (e[0] not in found or e[0] in contested) and e[1] not in used}
        s_min: dict[str, int] = {}
        h_min: dict[str, int] = {}
        for (sk, hk), g in live.items():
            s_min[sk] = min(g, s_min.get(sk, g))
            h_min[hk] = min(g, h_min.get(hk, g))
        nearest = sorted(e for e, g in live.items() if g == s_min[e[0]] == h_min[e[1]])
        matched = 0
        for ss, hs in _components(nearest):
            if held.intersection(hs) or contested.intersection(ss):
                continue   # a nearest contender is held or ambiguous: never matched, never moved to a farther row
            pairs = _resolve(ss, hs, present, free)
            if pairs is None:
                continue   # never guessed; the rows stay candidates and end up ambiguous unless a later round frees them
            for sk, hk in pairs:
                used.add(hk)
                found[sk] = ("matched", "merchant", (hk,))
                matched += 1
        if not matched:
            break
    for r in contenders:
        sk = r["txn_key"]
        cands = {hk for (s, hk) in edge_gap if s == sk and hk not in used}
        if sk in contested:
            found[sk] = ("ambiguous", None, tuple(sorted(cands.union(found[sk][2]))))
        elif sk not in found and cands:
            found[sk] = ("ambiguous", None, tuple(sorted(cands)))

    # 3. Unconfirmed: an unclaimed Rocket Money row with the same amount is near, but nothing says it is the same
    #    purchase (the case an amount-only rule used to drop). Kept.
    for r in rest:
        if r["txn_key"] in found or not in_zone[r["txn_key"]]:
            continue
        cands = tuple(sorted(h["txn_key"] for h in near[r["txn_key"]] if h["txn_key"] not in used))
        if cands:
            found[r["txn_key"]] = ("unconfirmed", None, cands)

    # 4. A row here whose recorded claim or ambiguity this run no longer makes, and that got no other decision:
    #    recorded as 'unconfirmed' with the keys its record named. That replaces the record before the ledger is
    #    written, so the stale claim or hold is gone when the row is missing from a later answer (and the Rocket
    #    Money row is free for its real twin), while the row is still listed for review. 'unconfirmed' holds nothing.
    for sk, keys in carried.items():
        if sk not in found:
            found[sk] = ("unconfirmed", None, tuple(sorted(keys)))

    decisions: list[CutoverDecision] = []
    for r in rows:
        sk = r["txn_key"]
        stored = sk in stored_keys
        decision, how, hkeys = found.get(sk, (None, None, ()))
        if decision == "matched" and stored:
            decision = "stored_duplicate"
        if not in_zone[sk]:
            # Before the window: the Rocket Money history already has it, so it is dropped (unless stored) whatever
            # was decided. Its decision is recorded all the same: a match keeps the Rocket Money row it took taken on
            # later runs, an ambiguity keeps its candidates held while the row is missing from a later answer, and a
            # replaced claim clears the old one. Not for review unless the row is in the ledger (kept=False).
            keep = stored
            if stored:
                kept.append(r)
            else:
                dropped["before the Rocket Money cutover"] += 1
        elif decision == "matched":
            keep = False
            dropped["already in the Rocket Money history"] += 1
        else:
            keep = True
            kept.append(r)
        if decision:
            decisions.append(CutoverDecision(sk, r["account_key"], decision, how, hkeys, cutover.isoformat(), keep))
    return kept, dropped, sorted(decisions, key=lambda d: d.sf_txn_key)


def cutover_counts(decisions: Iterable[CutoverDecision]) -> Counter:
    """Decisions -> counts for the log: matched exact / matched merchant / stored_duplicate / ambiguous / unconfirmed;
    a decision on a row dropped before the window (not in the ledger, so not for review) is '<decision> before the
    window'."""
    def label(d: CutoverDecision) -> str:
        if d.decision == "matched":
            return f"matched {d.evidence}"
        return d.decision if d.kept else f"{d.decision} before the window"

    return Counter(label(d) for d in decisions)


def review_state(d: CutoverDecision, rec: Optional[dict]) -> Optional[str]:
    """The record's review_state for this decision (Codex review: reporting is tracked apart from the decision).
    'pending' = a row kept for review that no written heartbeat has carried yet; 'reported' = one has; None = nothing
    to report (a match, or a row not in the ledger: a decision before the window is recorded for its hold only). A
    reported decision stays reported while it is unchanged; a new or changed review decision is pending; and a
    pending report is never dropped, so it is carried until a heartbeat with it is written (run: mark_reported).
    `rec` is the recorded decision of this row, if any ({'decision', 'review_state', ...})."""
    rec = rec or {}
    prev = rec.get("review_state")
    if d.kept and d.decision in REVIEW_DECISIONS:
        return "reported" if prev == "reported" and rec.get("decision") == d.decision else "pending"
    return "pending" if prev == "pending" else None


def decision_rows(decisions: Iterable[CutoverDecision], now: datetime, saved: Optional[dict] = None) -> list[dict]:
    """pds.finance_cutover_matches rows: keys, the decision, its evidence and its review_state only (no amount, date
    or text). Every row carries the same columns (one upsert must carry one key set). `saved` = the recorded
    decisions the run read ({sf_txn_key: {'decision', 'review_state', ...}})."""
    saved = saved or {}
    return [{
        "sf_txn_key": d.sf_txn_key, "account_key": d.account_key, "decision": d.decision, "evidence": d.evidence,
        "history_txn_keys": list(d.history_txn_keys), "cutover_date": d.cutover_date, "decided_at": now.isoformat(),
        "review_state": review_state(d, saved.get(d.sf_txn_key)),
    } for d in decisions]


def review_pending(saved: Optional[dict], rows: Iterable[dict] = ()) -> list[str]:
    """The keys of every row kept for review that is still to report once these decision rows are on record: this
    run's new or changed review decisions, and those of earlier runs that no written heartbeat has carried yet (a
    lost heartbeat, or a run stopped after it saved the record), also when the row is not in this answer."""
    merged = {k: rec.get("review_state") for k, rec in (saved or {}).items()}
    merged.update({r["sf_txn_key"]: r.get("review_state") for r in rows})
    return sorted(k for k, state in merged.items() if state == "pending")


def new_review_count(decisions: Iterable[CutoverDecision], saved: Optional[dict]) -> int:
    """How many rows kept for review a run with these decisions reports (review_pending; the --dry-run preview).
    `saved` = the recorded decisions ({sf_txn_key: {'decision', 'review_state', 'history_txn_keys'}}), or None when
    the record table is missing (then every review decision is new)."""
    return len(review_pending(saved, decision_rows(decisions, datetime.now(timezone.utc), saved)))


def learn_categories(history: Iterable[dict]) -> dict[str, dict[str, str]]:
    """Rocket Money rows -> {'desc': {norm description: category}, 'name': {...}, 'prefix': {...}}.
    A key is learned when it has >= 2 rows (3 for name / prefix) and one category holds >= 80% (85%) of them."""
    tallies: dict[str, dict[str, Counter]] = {"desc": defaultdict(Counter), "name": defaultdict(Counter), "prefix": defaultdict(Counter)}
    for h in history:
        cat = (h.get("category") or "").strip()
        if cat.lower() in SKIP_LEARNED:
            continue
        d = norm_text(h.get("description"))
        if d:
            tallies["desc"][d][cat] += 1
            words = d.split()
            if len(words) >= 2:
                tallies["prefix"][" ".join(words[:2])][cat] += 1
        n = norm_text(h.get("custom_name") or h.get("name"))
        if n:
            tallies["name"][n][cat] += 1
    rules = {"desc": (2, 0.8), "name": (3, 0.85), "prefix": (3, 0.85)}
    learned: dict[str, dict[str, str]] = {}
    for kind, table in tallies.items():
        min_n, share = rules[kind]
        learned[kind] = {}
        for key, counts in table.items():
            total = sum(counts.values())
            cat, n = counts.most_common(1)[0]
            if total >= min_n and n / total >= share:
                learned[kind][key] = cat
    return learned


def _words(row: dict) -> str:
    return norm_text(" ".join(filter(None, [row.get("description"), row.get("name")])))


def pair_transfers(rows: list[dict], pool: list[dict], account_types: dict[str, str]) -> dict[str, str]:
    """txn_key -> category for rows that pair with an opposite row on another of Riley's accounts."""
    out: dict[str, str] = {}
    used: set[str] = set()
    row_keys = {r["txn_key"] for r in rows}
    candidates = {p["txn_key"]: p for p in pool}
    for r in rows:
        candidates.setdefault(r["txn_key"], r)
    others = sorted(candidates.values(), key=lambda p: (p["txn_date"], p["txn_key"]))
    for r in sorted(rows, key=lambda r: (r["txn_date"], r["txn_key"])):
        if r["txn_key"] in used or not r["amount_cents"]:
            continue
        d = date.fromisoformat(r["txn_date"])
        best = None
        for p in others:
            if p["txn_key"] in used or p["txn_key"] == r["txn_key"] or p["account_key"] == r["account_key"]:
                continue
            if p["amount_cents"] != -r["amount_cents"]:
                continue
            gap = abs((date.fromisoformat(p["txn_date"]) - d).days)
            if gap > PAIR_DAYS:
                continue
            w = _words(r) + " " + _words(p)
            if not PAYMENT_WORDS.search(w) or P2P_WORDS.search(w):
                continue
            if best is None or gap < best[0]:
                best = (gap, p)
        if best:
            p = best[1]
            credit = is_credit(account_types.get(r["account_key"])) or is_credit(account_types.get(p["account_key"]))
            cat = "Credit Card Payment" if credit else "Internal Transfers"
            out[r["txn_key"]] = cat
            used.add(r["txn_key"])
            used.add(p["txn_key"])
            if p["txn_key"] in row_keys:
                out[p["txn_key"]] = cat
    return out


def keyword_category(row: dict, account_type: Optional[str]) -> Optional[str]:
    w = _words(row)
    if not w or P2P_WORDS.search(w):
        return None
    if is_credit(account_type) and row["amount_cents"] < 0 and re.search(r"\b(PAYMENT|AUTOPAY|THANK YOU)\b", w):
        return "Credit Card Payment"
    if not is_credit(account_type) and row["amount_cents"] > 0 and CARD_ISSUER_WORDS.search(w) and re.search(r"\b(PAYMENT|PMT|EPAY|AUTOPAY)\b", w):
        return "Credit Card Payment"
    if TRANSFER_WORDS.search(w):
        return "Internal Transfers"
    return None


def assign_categories(rows: list[dict], pool: list[dict], learned: dict, account_types: dict[str, str]) -> Counter:
    """Sets row['category'] in place; returns counts by rule."""
    paired = pair_transfers(rows, pool, account_types)
    how: Counter = Counter()
    for r in rows:
        if r["txn_key"] in paired:
            r["category"] = paired[r["txn_key"]]
            how["paired transfer"] += 1
            continue
        d = norm_text(r.get("description"))
        n = norm_text(r.get("name"))
        prefix = " ".join(d.split()[:2]) if len(d.split()) >= 2 else ""
        cat = learned.get("desc", {}).get(d) or learned.get("name", {}).get(n) or (learned.get("prefix", {}).get(prefix) if prefix else None)
        if cat:
            r["category"] = cat
            how["learned from history"] += 1
            continue
        cat = keyword_category(r, account_types.get(r["account_key"]))
        r["category"] = cat
        how["payment/transfer wording" if cat else "uncategorized"] += 1
    return how


def balance_row(acct: SfAccount, account_key: str, kind: Optional[str]) -> Optional[dict]:
    if acct.balance_cents is None or acct.balance_at is None:
        return None
    cents = acct.balance_cents
    if kind == "liability":
        cents = abs(cents)  # the Rocket Money history stores what is owed as a positive number
    return {
        "account_key": account_key,
        "captured_at": acct.balance_at.isoformat(),
        "balance_cents": cents,
        "currency": acct.currency,
        "kind": kind,
        "source": SOURCE,
    }


# ---------------------------------------------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------------------------------------------
def supabase_client():
    from supabase import create_client

    url = (os.environ.get("SUPABASE_URL") or "").strip() or DEFAULT_SUPABASE_URL
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not key:
        try:
            key = SUPABASE_SECRET_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            key = ""
    if not key:
        raise SimpleFinError("supabase_key_missing", "no Supabase service key (SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret)")
    return create_client(url, key)


def _t(supa, table):
    return supa.schema("pds").from_(table)


MISSING_RELATION_CODES = ("PGRST205", "42P01")   # PostgREST / Postgres: the table does not exist (not applied yet)
MISSING_COLUMN_CODES = ("42703", "PGRST204")      # Postgres / PostgREST: a column does not exist (not applied yet)


def is_missing_relation(e: BaseException) -> bool:
    """A read error that only means the table is not there yet (postgrest APIError.code); never reads its text."""
    return str(getattr(e, "code", "") or "") in MISSING_RELATION_CODES


def is_missing_column(e: BaseException) -> bool:
    """A read error that only means a column is not there yet (the review_state statement of
    sql/finance_cutover_matches.sql not applied); never reads its text."""
    return str(getattr(e, "code", "") or "") in MISSING_COLUMN_CODES


def read_all(build) -> list[dict]:
    rows: list[dict] = []
    while True:
        got = build().range(len(rows), len(rows) + PAGE - 1).execute().data or []
        rows.extend(got)
        if len(got) < PAGE:
            return rows


class Store:
    def __init__(self, supa):
        self.supa = supa

    def accounts(self) -> list[dict]:
        return _t(self.supa, "finance_accounts").select(
            "account_key,institution,account_name,account_type,mask,source,simplefin_id").execute().data or []

    def latest_kind(self, account_key: str) -> Optional[str]:
        data = (_t(self.supa, "finance_balance_snapshots").select("kind").eq("account_key", account_key)
                .neq("source", SOURCE).not_.is_("kind", "null").order("captured_at", desc=True).limit(1).execute().data)
        return data[0]["kind"] if data else None

    def cutover(self, account_key: str) -> Optional[date]:
        data = (_t(self.supa, "finance_transactions").select("txn_date").eq("account_key", account_key)
                .neq("source", SOURCE).order("txn_date", desc=True).limit(1).execute().data)
        return date.fromisoformat(data[0]["txn_date"]) if data else None

    def window_rows(self, since: date) -> list[dict]:
        cols = "txn_key,account_key,txn_date,original_date,amount_cents,currency,name,description,source"
        return read_all(lambda: _t(self.supa, "finance_transactions").select(cols)
                        .gte("txn_date", since.isoformat()).order("txn_date").order("txn_key"))

    def history_for_learning(self, since: date) -> list[dict]:
        cols = "txn_key,description,name,custom_name,category"
        return read_all(lambda: _t(self.supa, "finance_transactions").select(cols).neq("source", SOURCE)
                        .gte("txn_date", since.isoformat()).order("txn_key"))

    def link_account(self, account_key: str, sf_id: str, today: date) -> None:
        _t(self.supa, "finance_accounts").update(
            {"simplefin_id": sf_id, "last_seen": today.isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("account_key", account_key).execute()

    def create_account(self, row: dict) -> None:
        _t(self.supa, "finance_accounts").upsert(row, on_conflict="account_key").execute()

    def upsert_transactions(self, rows: list[dict]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        for i in range(0, len(rows), CHUNK):
            chunk = [{**r, "last_seen_at": now} for r in rows[i:i + CHUNK]]
            _t(self.supa, "finance_transactions").upsert(chunk, on_conflict="txn_key").execute()

    def upsert_balances(self, rows: list[dict]) -> None:
        if rows:
            _t(self.supa, "finance_balance_snapshots").upsert(rows, on_conflict="account_key,captured_at").execute()

    def cutover_decisions(self) -> dict[str, dict]:
        """The recorded cutover decisions, sf_txn_key -> {decision, history_txn_keys, review_state}; a small table
        (cutover-window rows only). Keys only: no amount, date or text is stored there."""
        rows = read_all(lambda: _t(self.supa, "finance_cutover_matches")
                        .select("sf_txn_key,decision,history_txn_keys,review_state").order("sf_txn_key"))
        return {r["sf_txn_key"]: {"decision": r.get("decision"),
                                  "history_txn_keys": list(r.get("history_txn_keys") or []),
                                  "review_state": r.get("review_state")}
                for r in rows}

    def history_rows(self, keys: Iterable[str]) -> list[dict]:
        """Rocket Money rows by txn_key, whatever their date: the rows recorded decisions name (build_plan), so a
        recorded match is replayed even when its Rocket Money row is outside the run's date window."""
        cols = "txn_key,account_key,txn_date,original_date,amount_cents,currency,name,description,source"
        keys, out = sorted(set(keys)), []
        for i in range(0, len(keys), 100):
            out.extend(_t(self.supa, "finance_transactions").select(cols).in_("txn_key", keys[i:i + 100])
                       .neq("source", SOURCE).execute().data or [])
        return out

    def mark_reported(self, keys: Iterable[str]) -> None:
        """review_state 'pending' -> 'reported' for these keys: a written heartbeat has carried them (run())."""
        keys = sorted(set(keys))
        for i in range(0, len(keys), 100):
            (_t(self.supa, "finance_cutover_matches").update({"review_state": "reported"})
             .in_("sf_txn_key", keys[i:i + 100]).eq("review_state", "pending").execute())

    def ledger_keys(self, keys: Iterable[str]) -> set[str]:
        """Which of these txn_keys are in the ledger (--dry-run only: the recorded rows still to review)."""
        keys, out = sorted(set(keys)), set()
        for i in range(0, len(keys), 100):
            data = (_t(self.supa, "finance_transactions").select("txn_key").in_("txn_key", keys[i:i + 100])
                    .execute().data or [])
            out.update(r["txn_key"] for r in data)
        return out

    def save_cutover_decisions(self, rows: list[dict]) -> None:
        """The run's whole decision set in ONE upsert request (Codex review R5). PostgREST runs a request as one
        statement in one transaction, so the set is on record completely or not at all. Never chunked: with chunks,
        a later chunk failing left part of the set on record, and a contender whose decision was in the lost chunk
        could not hold its Rocket Money candidate on a later answer without it, letting the surviving contender be
        matched to it. The set is one run's cutover decisions (keys only): at most one small row per transaction in
        the response. A key appears once (rows are unique per account and keys name the account); deduplicated all
        the same, because one statement cannot upsert the same key twice."""
        unique = list({r["sf_txn_key"]: r for r in rows}.values())
        if unique:
            _t(self.supa, "finance_cutover_matches").upsert(unique, on_conflict="sf_txn_key").execute()

    def heartbeat(self, data_type: str, status: str, records: int, started: float, error: Optional[str],
                  start: Optional[date] = None, end: Optional[date] = None) -> bool:
        """Writes the heartbeat; True when it was written (a failed write is logged as a code, never raised)."""
        from sync_log_helper import write_sync

        return write_sync(self.supa, SOURCE, data_type, status, records=records, started_at=started, error=error,
                          date_range_start=start, date_range_end=end)


# ---------------------------------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class Plan:
    matches: dict
    accounts: list
    new_accounts: list
    links: list
    transactions: list
    balances: list
    notes: Counter       # NOTE_CODES -> count; the only problem text a heartbeat or the log carries
    per_account: list
    categories: Counter
    dropped: Counter
    skipped: Counter
    cutover: list = field(default_factory=list)   # CutoverDecision per SimpleFIN row near the cutover (keys only)
    saved: Optional[dict] = None                   # the decisions recorded before this run (None: the table is missing)


def et_today(now: Optional[datetime] = None) -> date:
    from zoneinfo import ZoneInfo

    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York")).date()


def build_plan(body: dict, store, today: date, days: int) -> Plan:
    sf_accounts, notes = parse_accounts(body)
    issues = connection_errors(body)
    notes.update(i.code for i in issues)
    ledger = store.accounts()
    matches = match_accounts(sf_accounts, ledger)
    by_key = {r["account_key"]: r for r in ledger}
    account_types = {k: r.get("account_type") for k, r in by_key.items()}

    new_accounts, links, txns, balances, per_account = [], [], [], [], []
    dropped: Counter = Counter()
    skipped: Counter = Counter()
    decisions: list[CutoverDecision] = []
    window_start = today - timedelta(days=days)
    # The ledger rows read for matching start before EVERY date in SimpleFIN's answer (Codex review): SimpleFIN
    # returns rows by posted date, and a row posted late can be transacted weeks before the window, with its Rocket
    # Money twin (and its own stored copy) dated alike.
    earliest = min([window_start] + response_dates(sf_accounts))
    pool = store.window_rows(earliest - timedelta(days=PAIR_DAYS + OVERLAP_DAYS * 2))
    stored_sf = {p["txn_key"] for p in pool if p.get("source") == SOURCE}
    history_by_account: dict[str, list] = defaultdict(list)
    for p in pool:
        if p.get("source") != SOURCE:
            history_by_account[p["account_key"]].append(p)
    # Earlier cutover decisions keep their Rocket Money rows taken or held (apply_cutover, step 0). Before
    # sql/finance_cutover_matches.sql is applied the table is missing (saved = None): the plan matches on its own
    # response, and run() stops before writing if any decision would need recording. The table without its
    # review_state column fails the run here (cutover_provenance_unsaved: apply the file), and so does any OTHER
    # read error (db_read_failed), before anything is written: matching without the record would free Rocket Money
    # rows earlier runs matched, and saving that result would overwrite the record.
    try:
        saved = store.cutover_decisions()
    except Exception as e:
        if is_missing_column(e):
            raise SimpleFinError("cutover_provenance_unsaved") from None
        if not is_missing_relation(e):
            raise SimpleFinError("db_read_failed") from None
        saved = None
    claims = recorded_claims(saved)   # computed once; holds and replaced claims come from `saved` itself
    # Every Rocket Money row a recorded match or ambiguity names is read by key when the date window missed it
    # (Codex review), so the record is replayed whatever the window: a claimant still in the answer stays matched,
    # never written again unreviewed. A failed read stops the run like a failed read of the record.
    in_pool = {p["txn_key"] for p in pool}
    named = {k for rec in (saved or {}).values() if rec.get("decision") in CLAIM_DECISIONS + ("ambiguous",)
             for k in rec.get("history_txn_keys") or ()} - in_pool
    if named:
        try:
            extra = store.history_rows(named)
        except Exception:
            raise SimpleFinError("db_read_failed") from None
        for k, p in sorted({p["txn_key"]: p for p in extra}.items()):
            if p.get("source") != SOURCE and k in named:
                history_by_account[p["account_key"]].append(p)

    for a in sf_accounts:
        m = matches[a.id]
        line = {"institution": a.institution, "name": a.name, "mask": a.mask, "action": m.action, "reason": m.reason,
                "kept": 0, "dropped": 0, "balances_only": False,
                # local --dry-run only: which of our codes SimpleFIN raised for this account or its connection
                "issues": sorted({i.code for i in issues
                                  if (i.account_id and i.account_id == a.id) or (i.conn_id and i.conn_id == a.conn_id)})}
        if m.action == "skip":
            notes["account_unmatched"] += 1
            per_account.append(line)
            continue
        if m.action == "new":
            key = new_account_key(a.id)
            acct_type = infer_account_type(a.name)
            new_accounts.append({
                "account_key": key, "institution": a.institution, "account_name": a.name, "account_type": acct_type,
                "mask": a.mask, "source": SOURCE, "simplefin_id": a.id,
                "first_seen": today.isoformat(), "last_seen": today.isoformat(),
            })
            account_types[key] = acct_type
            kind = None
        else:
            key = m.account_key
            if m.action == "matched":
                links.append((key, a.id))
            kind = store.latest_kind(key)
        line["account_key"] = key
        acct_type = account_types.get(key)
        bal = balance_row(a, key, kind)
        if bal:
            balances.append(bal)
        if is_balances_only(acct_type):
            line["balances_only"] = True
            if acct_type in (None, "", "Unknown"):
                notes["account_type_unset"] += 1
            per_account.append(line)
            continue
        rows, skip = normalize_transactions(a, key)
        skipped.update(skip)
        cutover = store.cutover(key) if m.action != "new" else None
        kept, drop, decided = apply_cutover(rows, history_by_account.get(key, []), cutover, stored_sf, claims, saved)
        dropped.update(drop)
        decisions.extend(decided)
        line["kept"], line["dropped"] = len(kept), sum(drop.values())
        line["cutover"] = cutover.isoformat() if cutover else None
        line["review"] = {k: n for k, n in cutover_counts(decided).items() if k in REVIEW_DECISIONS}
        txns.extend(kept)
        per_account.append(line)

    learned = learn_categories(store.history_for_learning(today - timedelta(days=365 * LEARN_YEARS)))
    categories = assign_categories(txns, pool, learned, account_types)
    return Plan(matches, sf_accounts, new_accounts, links, txns, balances, notes, per_account, categories, dropped, skipped,
                cutover=decisions, saved=saved)


def run(store, http, access_url: str, days: int, dry_run: bool, now: Optional[datetime] = None, out=print) -> int:
    started = time.time()
    today = et_today(now)
    start = today - timedelta(days=days - 1)  # `days` calendar days including today
    try:
        body = fetch_accounts(access_url, start, today + timedelta(days=1), http)
        plan = build_plan(body, store, today, days)
    except Exception as e:
        code, detail = failure_code(e)
        msg = format_notes({code: 1})
        out(f"FAILED: {msg}" + (f" ({detail})" if detail else ""))
        if not dry_run:
            store.heartbeat("transactions", "failed", 0, started, msg)
            store.heartbeat("balances", "failed", 0, started, msg)
        return 1

    if dry_run:
        out(f"DRY RUN window {start} .. {today}: {len(plan.accounts)} SimpleFIN account(s)")
        for line in plan.per_account:
            why = f" ({line['reason']})" if line["reason"] else ""
            if line["balances_only"]:
                what = "balances only"
            else:
                what = f"keep {line['kept']}, drop {line['dropped']}, cutover {line.get('cutover')}"
                if line.get("review"):
                    what += f", kept for review {line['review']}"
            flag = f" | SimpleFIN issue: {', '.join(line['issues'])}" if line.get("issues") else ""
            out(f"  {line['institution']} | {line['name']} | last4 {line.get('mask') or '-'} | {line['action']}{why} | {what}{flag}")
        out(f"  transactions to write: {len(plan.transactions)}; balances: {len(plan.balances)}; new accounts: {len(plan.new_accounts)}")
        out(f"  categories: {dict(plan.categories)}; dropped: {dict(plan.dropped)}; not stored: {dict(plan.skipped)}")
        to_report = new_review_count(plan.cutover, plan.saved) if plan.cutover else len(review_pending(plan.saved))
        if plan.cutover:
            # Reconciliation preview of the cutover window, counts only (pds.finance_cutover_matches has the keys).
            out(f"  cutover decisions: {dict(cutover_counts(plan.cutover))}; to report: {to_report}"
                + ("" if plan.saved is not None else " (no decision record yet)"))
        elif to_report:
            out(f"  cutover review to report (no written heartbeat has carried it yet): {to_report}")
        review_keys = {k for k, rec in (plan.saved or {}).items() if rec.get("decision") in REVIEW_DECISIONS}
        if review_keys:
            # Every row kept for review so far (all runs), still to check by hand (docs/financials-simplefin.md). Only
            # rows in the ledger: the record also keeps decisions on rows dropped before the window (their holds).
            try:
                in_ledger = store.ledger_keys(review_keys)
            except Exception as e:
                out(f"  recorded for review (all runs): could not be counted ({safe_type_name(e)})")
            else:
                recorded = Counter(plan.saved[k]["decision"] for k in review_keys if k in in_ledger)
                if recorded:
                    out(f"  recorded for review (all runs): {dict(sorted(recorded.items()))}")
        if plan.cutover and plan.saved is None:
            out("  a real run would stop before writing: the cutover record table is missing (apply sql/finance_cutover_matches.sql)")
        if plan.notes:
            out(f"  heartbeat note: {format_notes(plan.notes)}")
        return 0

    def fail(code: str, detail: Optional[str], review_keys: Iterable[str] = ()) -> int:
        review_keys = list(review_keys)
        counts = Counter({code: 1})
        if review_keys:
            counts["cutover_review"] = len(review_keys)
        msg = format_notes(counts)
        out(f"FAILED: {msg}" + (f" ({detail})" if detail else ""))
        written = [store.heartbeat("transactions", "failed", 0, started, msg),
                   store.heartbeat("balances", "failed", 0, started, msg)]
        mark_reported(store, review_keys, any(written), out)
        return 1

    # The cutover decisions are recorded BEFORE the ledger is written, and a run that cannot record them writes
    # nothing (PIPE-04, Codex review). A matched row is left out of the ledger and its Rocket Money twin is taken
    # only by a durable record: a best-effort record after the writes could fail, and a later SimpleFIN answer
    # without the claimant would then let another purchase take the same Rocket Money row. The whole set is saved in
    # one statement (Store.save_cutover_decisions), so a failed save leaves the record as it was, never in part
    # (Codex review R5): a contender left off the record could not hold its candidate. Recorded only by a run
    # that read the record (saved is None only while the table is missing), so it is never rewritten from
    # decisions made without it; the table missing is then a failed run too (cutover_provenance_unsaved). The
    # workflow's concurrency group keeps two runs from deciding at once.
    # Reporting is tracked apart from the decision (review_state, Codex review): a row kept for review is 'pending'
    # on record until a heartbeat that carries it is WRITTEN, then it is marked 'reported' (mark_reported). Every run
    # reports every pending row, this run's and earlier runs', also when the row is not in this answer, so a lost
    # heartbeat, a failed run or a run stopped after it saved the record never hides one. A row may be reported a
    # second time (the heartbeat was written but the mark was not), never not at all.
    if plan.cutover and plan.saved is None:
        return fail("cutover_provenance_unsaved", None)
    review_keys = review_pending(plan.saved)
    if plan.cutover:
        rows = decision_rows(plan.cutover, now or datetime.now(timezone.utc), plan.saved)
        try:
            store.save_cutover_decisions(rows)
        except Exception as e:
            return fail("db_write_failed", safe_type_name(e), review_on_record(store, plan, rows))
        review_keys = review_pending(plan.saved, rows)

    try:
        for row in plan.new_accounts:
            store.create_account(row)
        for key, sf_id in plan.links:
            store.link_account(key, sf_id, today)
        store.upsert_transactions(plan.transactions)
        store.upsert_balances(plan.balances)
    except Exception as e:
        return fail("db_write_failed", safe_type_name(e), review_keys)

    if review_keys:
        plan.notes["cutover_review"] = len(review_keys)
    note = format_notes(plan.notes)
    status = "partial" if note else "success"
    written = [store.heartbeat("transactions", status, len(plan.transactions), started, note, start, today),
               store.heartbeat("balances", status, len(plan.balances), started, note)]
    out(f"{status}: {len(plan.accounts)} account(s), {len(plan.transactions)} transaction(s), "
        f"{len(plan.balances)} balance(s), {len(plan.new_accounts)} new account(s), {len(plan.links)} linked")
    out(f"  categories: {dict(plan.categories)}; dropped: {dict(plan.dropped)}; not stored: {dict(plan.skipped)}")
    if plan.cutover:
        out(f"  cutover decisions: {dict(cutover_counts(plan.cutover))}")
    if note:
        out(f"  heartbeat codes: {note_codes_summary(plan.notes)}")
    mark_reported(store, review_keys, any(written), out)
    return 0


def mark_reported(store, keys: list[str], written: bool, out=print) -> None:
    """After a run's heartbeats: the rows kept for review that they carried are marked 'reported' on record, but only
    when at least one of the two was written (the SimpleFIN card shows the worse of the two). Otherwise, and when the
    mark itself fails, the rows stay 'pending' and the next run reports them again. Never fails the run; the log
    gets counts and a type name only."""
    if not keys:
        return
    if not written:
        out(f"  cutover review: no heartbeat was written; {len(keys)} row(s) stay pending for the next run")
        return
    try:
        store.mark_reported(keys)
    except Exception as e:
        out(f"  cutover review: {len(keys)} row(s) could not be marked reported ({safe_type_name(e)}); "
            "the next run reports them again")


def review_on_record(store, plan: Plan, rows: list[dict]) -> list[str]:
    """After a failed save of the cutover record: the rows kept for review that are pending on record all the same.
    The save is one statement, so this run's rows are all there when the write went through and its answer was lost
    (Codex review R5), and none of them when it did not; earlier runs' pending rows are there either way. The failed
    heartbeat reports them and, once written, marks them reported. When the record cannot be read back, every row
    this run would report is reported there (the retry may report some again; none is left unreported)."""
    try:
        after = store.cutover_decisions()
    except Exception:
        return review_pending(plan.saved, rows)
    return review_pending(after)


def safe_type_name(e: BaseException) -> str:
    """An exception's class name for the log (a name from code, never its message); anything odd -> 'error'."""
    name = type(e).__name__
    return name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,60}", name) else "error"


def failure_code(e: BaseException) -> tuple[str, Optional[str]]:
    """A failed run -> (NOTE_CODES key for the heartbeat, detail for the log only)."""
    if isinstance(e, SimpleFinError) and e.code in NOTE_CODES:
        detail = e.detail if isinstance(e.detail, str) and re.fullmatch(r"HTTP \d{1,3}", e.detail) else None
        return e.code, detail
    return "etl_error", safe_type_name(e)


def note_codes_summary(counts) -> str:
    """'sf_reauth x1, account_unmatched x2' (NOTE_CODES order): the codes only, for the log."""
    return ", ".join(f"{c} x{min(int(counts[c]), NOTE_MAX_COUNT)}" for c in NOTE_CODES if counts.get(c))


def claim_command(set_github_secret: bool, http) -> int:
    try:
        token = SETUP_FILE.read_text(encoding="utf-8")
    except OSError:
        print(f"FAILED: put the SimpleFIN setup token in {SETUP_FILE} first")
        return 1
    try:
        access_url = claim_access_url(token, http)
    except SimpleFinError as e:
        print(f"FAILED: {e}")
        return 1
    ACCESS_FILE.write_text(access_url + "\n", encoding="utf-8")
    print(f"claimed: Access URL saved to {ACCESS_FILE} (the setup token is now used up)")
    if set_github_secret:
        res = subprocess.run(["gh", "secret", "set", "SIMPLEFIN_ACCESS_URL", "--repo", GITHUB_REPO],
                             input=access_url, text=True, capture_output=True)
        if res.returncode != 0:
            print("FAILED: gh secret set did not succeed (is gh signed in?); the Access URL file is saved")
            return 1
        print("GitHub secret SIMPLEFIN_ACCESS_URL set")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="SimpleFIN Bridge -> pds.finance_* (read-only bank feed)")
    ap.add_argument("--claim", action="store_true", help="exchange the setup token in ~/.simplefin_setup_token")
    ap.add_argument("--set-github-secret", action="store_true", help="with --claim: also set the GitHub secret")
    ap.add_argument("--dry-run", action="store_true", help="read SimpleFIN and the ledger, write nothing")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS, help=f"window in calendar days including today (1..{MAX_DAYS})")
    args = ap.parse_args()
    try:  # account names carry characters a Windows console cannot print; never crash on them
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

    import httpx

    with httpx.Client() as http:
        if args.claim:
            return claim_command(args.set_github_secret, http)
        days = min(max(args.days, 1), MAX_DAYS)
        try:
            store = Store(supabase_client())
        except SimpleFinError as e:
            print(f"FAILED: {e}")
            return 1
        try:
            access_url = load_access_url()
        except SimpleFinError as e:
            print(f"FAILED: {e}")
            if args.dry_run:
                return 1
            started = time.time()
            msg = format_notes({failure_code(e)[0]: 1})
            store.heartbeat("transactions", "failed", 0, started, msg)
            store.heartbeat("balances", "failed", 0, started, msg)
            # Before Riley has connected SimpleFIN the scheduled run only reports it (red /status card),
            # without turning every Actions run red.
            if os.environ.get("GITHUB_ACTIONS") == "true":
                print("::warning::SimpleFIN is not connected yet (no SIMPLEFIN_ACCESS_URL secret)")
                return 0
            return 1
        return run(store, http, access_url, days, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
