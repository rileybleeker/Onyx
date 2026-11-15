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
     Money row are dropped (that history already has them); rows near or after it are dropped only when a Rocket
     Money row with the same amount within OVERLAP_DAYS is not yet claimed. Rows Rocket Money never saw (it
     skipped pending ones) are kept. Rows already stored by an earlier SimpleFIN run are always rewritten in place.
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


class SimpleFinError(Exception):
    """An error whose text is fixed wording, safe for logs and sync_log (never a URL, credential or row)."""


# ---------------------------------------------------------------------------------------------------------------
# Access URL + claim
# ---------------------------------------------------------------------------------------------------------------
def split_access_url(access_url: str) -> tuple[str, tuple[str, str]]:
    """Access URL -> (base URL without credentials, (user, password)). Refuses anything not on SimpleFIN's host."""
    try:
        parts = urlsplit((access_url or "").strip())
    except ValueError:
        raise SimpleFinError("the SimpleFIN Access URL could not be read") from None
    if parts.scheme != "https" or (parts.hostname or "").lower() not in ALLOWED_HOSTS:
        raise SimpleFinError("the SimpleFIN Access URL is not an https URL on SimpleFIN's host")
    if not parts.username or parts.password is None:
        raise SimpleFinError("the SimpleFIN Access URL has no credentials in it")
    host = parts.hostname + (f":{parts.port}" if parts.port else "")
    base = urlunsplit(("https", host, parts.path.rstrip("/"), "", ""))
    return base, (unquote(parts.username), unquote(parts.password))


def decode_setup_token(token: str) -> str:
    """Setup token (base64 of the claim URL) -> claim URL, checked to be https on SimpleFIN's host."""
    raw = re.sub(r"\s+", "", token or "")
    if not raw:
        raise SimpleFinError("the setup token file is empty")
    try:
        url = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=False).decode("utf-8").strip()
    except Exception:
        raise SimpleFinError("the setup token is not base64") from None
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in ALLOWED_HOSTS:
        raise SimpleFinError("the setup token does not point at SimpleFIN's claim URL")
    return url


def claim_access_url(token: str, http) -> str:
    """POSTs once to the claim URL (a setup token works only once) and returns the Access URL."""
    claim_url = decode_setup_token(token)
    try:
        res = http.post(claim_url, headers={"Content-Length": "0"}, timeout=30)
    except Exception:
        raise SimpleFinError("the claim request could not be sent") from None
    if res.status_code == 403:
        raise SimpleFinError("SimpleFIN refused the setup token (already used or wrong); create a new one")
    if res.status_code != 200:
        raise SimpleFinError(f"the claim request returned HTTP {res.status_code}")
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
        raise SimpleFinError("no SimpleFIN Access URL: set SIMPLEFIN_ACCESS_URL (GitHub secret) or run --claim")
    return text


# ---------------------------------------------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------------------------------------------
def epoch(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def fetch_accounts(access_url: str, start: date, end_exclusive: date, http) -> dict:
    """GET /accounts?version=2 over [start, end_exclusive). Raises SimpleFinError with fixed wording."""
    if (end_exclusive - start).days > MAX_DAYS:
        raise SimpleFinError(f"the window is longer than SimpleFIN's {MAX_DAYS}-day limit")
    base, auth = split_access_url(access_url)
    params = {"version": "2", "start-date": str(epoch(start)), "end-date": str(epoch(end_exclusive))}
    try:
        res = http.get(f"{base}/accounts", params=params, auth=auth, timeout=90, follow_redirects=True)
    except Exception:
        raise SimpleFinError("SimpleFIN could not be reached") from None
    if res.status_code == 403:
        raise SimpleFinError(
            "SimpleFIN refused the Access URL (revoked, disabled for too many requests, or wrong): "
            "create a new setup token at beta-bridge.simplefin.org and run simplefin_etl.py --claim --set-github-secret"
        )
    if res.status_code == 402:
        raise SimpleFinError("SimpleFIN says payment is required: renew the SimpleFIN Bridge subscription")
    if res.status_code != 200:
        raise SimpleFinError(f"SimpleFIN returned HTTP {res.status_code}")
    try:
        body = res.json()
    except Exception:
        raise SimpleFinError("SimpleFIN's answer was not JSON") from None
    if not isinstance(body, dict) or not isinstance(body.get("accounts"), list):
        raise SimpleFinError("SimpleFIN's answer had no accounts list (the format may have changed)")
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


def parse_accounts(body: dict) -> tuple[list[SfAccount], list[str]]:
    """The /accounts body -> accounts + counts-free problems (each a short fixed-shape note)."""
    conns = {}
    for c in body.get("connections") or []:
        if isinstance(c, dict) and c.get("conn_id"):
            conns[str(c["conn_id"])] = c
    out: list[SfAccount] = []
    problems: list[str] = []
    for a in body.get("accounts") or []:
        if not isinstance(a, dict) or not a.get("id"):
            problems.append("an account without an id was skipped")
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
        ))
    return out, problems


def connection_errors(body: dict) -> list[str]:
    """errlist (v2 objects) + errors (deprecated strings) -> short texts, digits runs masked."""
    texts: list[str] = []
    for e in body.get("errlist") or []:
        if isinstance(e, dict):
            texts.append(clean(e.get("msg")) or clean(e.get("code")) or "error")
        elif isinstance(e, str):
            texts.append(clean(e) or "error")
    for e in body.get("errors") or []:
        if isinstance(e, str) and clean(e):
            texts.append(clean(e))
    out = []
    for t in texts:
        t = re.sub(r"\d{4,}", "####", t)[:160]
        if t not in out:
            out.append(t)
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


def apply_cutover(sf_rows: list[dict], history: list[dict], cutover: Optional[date], stored_keys: set[str]) -> tuple[list[dict], Counter]:
    """Drops SimpleFIN rows the Rocket Money history already holds (see module docstring, step 3). Deterministic."""
    kept: list[dict] = []
    dropped: Counter = Counter()
    if cutover is None:
        return list(sf_rows), dropped
    floor = cutover - timedelta(days=OVERLAP_DAYS)
    pool = sorted(
        (h for h in history if date.fromisoformat(h["txn_date"]) >= floor - timedelta(days=OVERLAP_DAYS)),
        key=lambda h: (h["txn_date"], h["txn_key"]),
    )
    used: set[str] = set()
    for r in sorted(sf_rows, key=lambda r: (r["txn_date"], r["txn_key"])):
        if r["txn_key"] in stored_keys:
            kept.append(r)
            continue
        d = date.fromisoformat(r["txn_date"])
        if d < floor:
            dropped["before the Rocket Money cutover"] += 1
            continue
        twin = next(
            (h for h in pool
             if h["txn_key"] not in used and h["amount_cents"] == r["amount_cents"]
             and abs((date.fromisoformat(h["txn_date"]) - d).days) <= OVERLAP_DAYS),
            None,
        )
        if twin:
            used.add(twin["txn_key"])
            dropped["already in the Rocket Money history"] += 1
        else:
            kept.append(r)
    return kept, dropped


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
        raise SimpleFinError("no Supabase service key (SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret)")
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
        cols = "txn_key,account_key,txn_date,amount_cents,name,description,source"
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
    notes: list
    per_account: list
    categories: Counter
    dropped: Counter
    skipped: Counter


def et_today(now: Optional[datetime] = None) -> date:
    from zoneinfo import ZoneInfo

    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York")).date()


def build_plan(body: dict, store, today: date, days: int) -> Plan:
    sf_accounts, notes = parse_accounts(body)
    notes += [f"SimpleFIN: {e}" for e in connection_errors(body)]
    ledger = store.accounts()
    matches = match_accounts(sf_accounts, ledger)
    by_key = {r["account_key"]: r for r in ledger}
    account_types = {k: r.get("account_type") for k, r in by_key.items()}

    new_accounts, links, txns, balances, per_account = [], [], [], [], []
    dropped: Counter = Counter()
    skipped: Counter = Counter()
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
                "kept": 0, "dropped": 0, "balances_only": False}
        if m.action == "skip":
            notes.append(f"one {a.institution} account was not imported: {m.reason}")
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
                notes.append(f"one new {a.institution} account is balances-only until its account type is set")
            per_account.append(line)
            continue
        rows, skip = normalize_transactions(a, key)
        skipped.update(skip)
        cutover = store.cutover(key) if m.action != "new" else None
        kept, drop = apply_cutover(rows, history_by_account.get(key, []), cutover, stored_sf)
        dropped.update(drop)
        line["kept"], line["dropped"] = len(kept), sum(drop.values())
        line["cutover"] = cutover.isoformat() if cutover else None
        txns.extend(kept)
        per_account.append(line)

    learned = learn_categories(store.history_for_learning(today - timedelta(days=365 * LEARN_YEARS)))
    categories = assign_categories(txns, pool, learned, account_types)
    return Plan(matches, sf_accounts, new_accounts, links, txns, balances, notes, per_account, categories, dropped, skipped)


def run(store, http, access_url: str, days: int, dry_run: bool, now: Optional[datetime] = None, out=print) -> int:
    started = time.time()
    today = et_today(now)
    start = today - timedelta(days=days - 1)  # `days` calendar days including today
    try:
        body = fetch_accounts(access_url, start, today + timedelta(days=1), http)
        plan = build_plan(body, store, today, days)
    except Exception as e:
        msg = str(e) if isinstance(e, SimpleFinError) else f"SimpleFIN ETL failed ({type(e).__name__})"
        out(f"FAILED: {msg}")
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
            out(f"  {line['institution']} | {line['name']} | last4 {line.get('mask') or '-'} | {line['action']}{why} | {what}")
        out(f"  transactions to write: {len(plan.transactions)}; balances: {len(plan.balances)}; new accounts: {len(plan.new_accounts)}")
        out(f"  categories: {dict(plan.categories)}; dropped: {dict(plan.dropped)}; not stored: {dict(plan.skipped)}")
        for n in plan.notes:
            out(f"  note: {n}")
        return 0

    try:
        for row in plan.new_accounts:
            store.create_account(row)
        for key, sf_id in plan.links:
            store.link_account(key, sf_id, today)
        store.upsert_transactions(plan.transactions)
        store.upsert_balances(plan.balances)
    except Exception as e:
        msg = f"SimpleFIN ETL could not write to Supabase ({type(e).__name__})"
        out(f"FAILED: {msg}")
        store.heartbeat("transactions", "failed", 0, started, msg)
        store.heartbeat("balances", "failed", 0, started, msg)
        return 1

    note = "; ".join(plan.notes)[:300] or None
    status = "partial" if plan.notes else "success"
    store.heartbeat("transactions", status, len(plan.transactions), started, note, start, today)
    store.heartbeat("balances", status, len(plan.balances), started, note)
    out(f"{status}: {len(plan.accounts)} account(s), {len(plan.transactions)} transaction(s), "
        f"{len(plan.balances)} balance(s), {len(plan.new_accounts)} new account(s), {len(plan.links)} linked")
    out(f"  categories: {dict(plan.categories)}; dropped: {dict(plan.dropped)}; not stored: {dict(plan.skipped)}")
    if plan.notes:
        out(f"  {len(plan.notes)} note(s) written to the heartbeat")
    return 0


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
            store.heartbeat("transactions", "failed", 0, started, str(e))
            store.heartbeat("balances", "failed", 0, started, str(e))
            # Before Riley has connected SimpleFIN the scheduled run only reports it (red /status card),
            # without turning every Actions run red.
            if os.environ.get("GITHUB_ACTIONS") == "true":
                print("::warning::SimpleFIN is not connected yet (no SIMPLEFIN_ACCESS_URL secret)")
                return 0
            return 1
        return run(store, http, access_url, days, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
