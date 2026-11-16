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
  3. Cutover from the Rocket Money history, per account: rows dated more than OVERLAP_DAYS before the last Rocket
     Money row are dropped (that history already has them). A row near or after it is dropped only on identity
     evidence (PIPE-04; the two feeds share no transaction id): same account, amount and currency, and either the
     same date and normalized description ('exact', paired one for one) or a date within OVERLAP_DAYS and a shared
     merchant word where that one SimpleFIN row and that one Rocket Money row have no other such candidate
     ('merchant'). An equal amount alone never drops a row: a row with competing candidates ('ambiguous') or with
     a same-amount Rocket Money row nearby but no merchant evidence ('unconfirmed') is KEPT and counted for review.
     Every decision is recorded in pds.finance_cutover_matches (keys only). Rows Rocket Money never saw (it skipped
     pending ones) are kept. Rows already stored by an earlier SimpleFIN run are always rewritten in place.
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
    "cutover_provenance_unsaved": "the cutover match record was not saved (apply sql/finance_cutover_matches.sql); the next run retries",
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
REVIEW_DECISIONS = ("stored_duplicate", "ambiguous", "unconfirmed")
MAX_CANDIDATES = 10    # Rocket Money keys kept per decision record


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


def exact_key(row: dict) -> Optional[tuple]:
    """Same account (callers compare one account), date, amount, currency and normalized description."""
    d = norm_text(row.get("description"))
    return (row["txn_date"], row["amount_cents"], _currency(row), d) if d else None


def merchant_tokens(row: dict) -> frozenset:
    words = set(norm_text(row.get("description")).split()) | set(norm_text(row.get("name")).split())
    return frozenset(w for w in words if len(w) >= 3 and w not in GENERIC_WORDS)


def merchant_evidence(a: dict, b: dict) -> bool:
    """The descriptions share merchant words: more than half of the shorter side's distinctive words (so a shared
    city name alone, 'DEMO ATLANTA' vs 'SHOP ATLANTA', is not evidence)."""
    ta, tb = merchant_tokens(a), merchant_tokens(b)
    shared = len(ta & tb)
    return shared > 0 and 2 * shared > min(len(ta), len(tb))


@dataclass(frozen=True)
class CutoverDecision:
    sf_txn_key: str
    account_key: str
    decision: str              # matched | stored_duplicate | ambiguous | unconfirmed
    evidence: Optional[str]    # exact | merchant (matched / stored_duplicate), else None
    history_txn_keys: tuple    # the Rocket Money twin, or the candidates
    cutover_date: str = ""     # the account's last Rocket Money date the decision was made against


def apply_cutover(sf_rows: list[dict], history: list[dict], cutover: Optional[date],
                  stored_keys: set[str]) -> tuple[list[dict], Counter, list[CutoverDecision]]:
    """SimpleFIN rows -> (kept, dropped counts, decisions) against one account's Rocket Money history (module
    docstring, step 3). Deterministic and order-independent. A row is dropped only when it is matched on identity
    evidence; a row stored by an earlier run is always kept (a match then marks it 'stored_duplicate')."""
    kept: list[dict] = []
    dropped: Counter = Counter()
    if cutover is None:
        return list(sf_rows), dropped, []
    floor = cutover - timedelta(days=OVERLAP_DAYS)
    pool = sorted(
        (h for h in history if date.fromisoformat(h["txn_date"]) >= floor - timedelta(days=OVERLAP_DAYS)),
        key=lambda h: (h["txn_date"], h["txn_key"]),
    )
    zone: list[dict] = []
    for r in sorted(sf_rows, key=lambda r: (r["txn_date"], r["txn_key"])):
        if date.fromisoformat(r["txn_date"]) >= floor:
            zone.append(r)
        elif r["txn_key"] in stored_keys:
            kept.append(r)
        else:
            dropped["before the Rocket Money cutover"] += 1

    used: set[str] = set()
    found: dict[str, tuple] = {}   # sf txn_key -> (decision, evidence, history keys)

    # 1. Exact: same date, amount, currency and description. Such rows cannot be told apart, so pairing them one
    #    for one in key order is exact whichever pairs; rows not stored yet pair first (stored ones stay anyway).
    by_key: dict[tuple, list] = defaultdict(list)
    for h in pool:
        k = exact_key(h)
        if k:
            by_key[k].append(h)
    groups: dict[tuple, list] = defaultdict(list)
    for r in zone:
        k = exact_key(r)
        if k and k in by_key:
            groups[k].append(r)
    for k, rs in groups.items():
        for r, h in zip(sorted(rs, key=lambda r: (r["txn_key"] in stored_keys, r["txn_key"])),
                        sorted(by_key[k], key=lambda h: h["txn_key"])):
            used.add(h["txn_key"])
            found[r["txn_key"]] = ("matched", "exact", (h["txn_key"],))

    # 2. Merchant: same amount and currency, dates within OVERLAP_DAYS, shared merchant words. Only a one-to-one
    #    group (one SimpleFIN row, one Rocket Money row, no other evidence either side) is a match; anything larger
    #    is ambiguous and every SimpleFIN row in it is kept.
    rest = [r for r in zone if r["txn_key"] not in found]
    free = [h for h in pool if h["txn_key"] not in used]
    near = {r["txn_key"]: [h for h in free if h["amount_cents"] == r["amount_cents"] and _currency(h) == _currency(r)
                           and date_gap(r, h) <= OVERLAP_DAYS] for r in rest}
    parent: dict[tuple, tuple] = {}

    def root(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for r in rest:
        for h in near[r["txn_key"]]:
            if merchant_evidence(r, h):
                parent[root(("h", h["txn_key"]))] = root(("s", r["txn_key"]))
    comps: dict[tuple, dict] = {}
    for node in sorted(parent):
        comps.setdefault(root(node), {"s": [], "h": []})[node[0]].append(node[1])
    for comp in comps.values():
        hs = tuple(sorted(comp["h"]))
        if len(comp["s"]) == 1 and len(hs) == 1:
            used.add(hs[0])
            found[comp["s"][0]] = ("matched", "merchant", hs)
        else:
            for sk in comp["s"]:
                found[sk] = ("ambiguous", None, hs[:MAX_CANDIDATES])

    # 3. Unconfirmed: an unclaimed Rocket Money row with the same amount is near, but nothing says it is the same
    #    purchase (the case an amount-only rule used to drop). Kept.
    for r in rest:
        if r["txn_key"] in found:
            continue
        cands = tuple(sorted(h["txn_key"] for h in near[r["txn_key"]] if h["txn_key"] not in used))
        if cands:
            found[r["txn_key"]] = ("unconfirmed", None, cands[:MAX_CANDIDATES])

    decisions: list[CutoverDecision] = []
    for r in zone:
        decision, evidence, hkeys = found.get(r["txn_key"], (None, None, ()))
        stored = r["txn_key"] in stored_keys
        if decision == "matched" and not stored:
            dropped["already in the Rocket Money history"] += 1
        else:
            kept.append(r)
        if decision:
            decision = "stored_duplicate" if decision == "matched" and stored else decision
            decisions.append(CutoverDecision(r["txn_key"], r["account_key"], decision, evidence, hkeys, cutover.isoformat()))
    return kept, dropped, sorted(decisions, key=lambda d: d.sf_txn_key)


def cutover_counts(decisions: Iterable[CutoverDecision]) -> Counter:
    """Decisions -> counts for the log: matched exact / matched merchant / stored_duplicate / ambiguous / unconfirmed."""
    return Counter(f"{d.decision} {d.evidence}" if d.decision == "matched" else d.decision for d in decisions)


def decision_rows(decisions: Iterable[CutoverDecision], now: datetime) -> list[dict]:
    """pds.finance_cutover_matches rows: keys, the decision and its evidence only (no amount, date or text)."""
    return [{
        "sf_txn_key": d.sf_txn_key, "account_key": d.account_key, "decision": d.decision, "evidence": d.evidence,
        "history_txn_keys": list(d.history_txn_keys), "cutover_date": d.cutover_date, "decided_at": now.isoformat(),
    } for d in decisions]


def new_review_count(decisions: Iterable[CutoverDecision], saved: Optional[dict]) -> int:
    """Rows kept for review whose decision is not recorded yet (each one is reported once, when first seen)."""
    return sum(1 for d in decisions
               if d.decision in REVIEW_DECISIONS and (saved is None or saved.get(d.sf_txn_key) != d.decision))


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

    def cutover_decisions(self) -> dict[str, str]:
        """The recorded cutover decisions (sf_txn_key -> decision); a small table (cutover-window rows only)."""
        rows = read_all(lambda: _t(self.supa, "finance_cutover_matches").select("sf_txn_key,decision").order("sf_txn_key"))
        return {r["sf_txn_key"]: r["decision"] for r in rows}

    def save_cutover_decisions(self, rows: list[dict]) -> None:
        for i in range(0, len(rows), CHUNK):
            _t(self.supa, "finance_cutover_matches").upsert(rows[i:i + CHUNK], on_conflict="sf_txn_key").execute()

    def heartbeat(self, data_type: str, status: str, records: int, started: float, error: Optional[str],
                  start: Optional[date] = None, end: Optional[date] = None) -> None:
        from sync_log_helper import log_sync

        log_sync(self.supa, SOURCE, data_type, status, records=records, started_at=started, error=error,
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
    pool = store.window_rows(window_start - timedelta(days=PAIR_DAYS + OVERLAP_DAYS * 2))
    stored_sf = {p["txn_key"] for p in pool if p.get("source") == SOURCE}
    history_by_account: dict[str, list] = defaultdict(list)
    for p in pool:
        if p.get("source") != SOURCE:
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
        kept, drop, decided = apply_cutover(rows, history_by_account.get(key, []), cutover, stored_sf)
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
                cutover=decisions)


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
        if plan.cutover:
            # Reconciliation preview of the cutover window, counts only (pds.finance_cutover_matches has the keys).
            try:
                saved = store.cutover_decisions()
            except Exception:
                saved = None
            out(f"  cutover decisions: {dict(cutover_counts(plan.cutover))}; new for review: "
                f"{new_review_count(plan.cutover, saved)}" + ("" if saved is not None else " (no decision record yet)"))
        if plan.notes:
            out(f"  heartbeat note: {format_notes(plan.notes)}")
        return 0

    try:
        for row in plan.new_accounts:
            store.create_account(row)
        for key, sf_id in plan.links:
            store.link_account(key, sf_id, today)
        store.upsert_transactions(plan.transactions)
        store.upsert_balances(plan.balances)
    except Exception as e:
        msg = format_notes({"db_write_failed": 1})
        out(f"FAILED: {msg} ({safe_type_name(e)})")
        store.heartbeat("transactions", "failed", 0, started, msg)
        store.heartbeat("balances", "failed", 0, started, msg)
        return 1

    if plan.cutover:
        # Provenance of every cutover decision; best-effort (the ledger writes above are done). A kept-for-review
        # row is reported in the heartbeat once, the first run that records it.
        try:
            saved = store.cutover_decisions()
        except Exception:
            saved = None
        review = new_review_count(plan.cutover, saved)
        if review:
            plan.notes["cutover_review"] += review
        try:
            store.save_cutover_decisions(decision_rows(plan.cutover, now or datetime.now(timezone.utc)))
        except Exception:
            plan.notes["cutover_provenance_unsaved"] += 1

    note = format_notes(plan.notes)
    status = "partial" if note else "success"
    store.heartbeat("transactions", status, len(plan.transactions), started, note, start, today)
    store.heartbeat("balances", status, len(plan.balances), started, note)
    out(f"{status}: {len(plan.accounts)} account(s), {len(plan.transactions)} transaction(s), "
        f"{len(plan.balances)} balance(s), {len(plan.new_accounts)} new account(s), {len(plan.links)} linked")
    out(f"  categories: {dict(plan.categories)}; dropped: {dict(plan.dropped)}; not stored: {dict(plan.skipped)}")
    if plan.cutover:
        out(f"  cutover decisions: {dict(cutover_counts(plan.cutover))}")
    if note:
        out(f"  heartbeat codes: {note_codes_summary(plan.notes)}")
    return 0


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
