"""
Online Orders ETL: shipping and delivery emails -> pds.online_order_events -> pds.online_orders
================================================================================================
Tracks online orders (stores, Amazon-delivered packages, UPS / FedEx / USPS notices) from the
emails they send, so /orders can show what is on the way, what arrived, and what is overdue.
No store or carrier offers Riley an API for this, so the emails are the source.

Read-only on Gmail, same plumbing as flights_email_etl.py: both accounts, Gmail's All Mail
SELECTed readonly, every fetch is BODY.PEEK, nothing is stored back. Only messages whose SUBJECT
reads like an order or shipping update are fetched (one Gmail search, Promotions and Social
excluded, food-delivery and travel senders excluded).

What is stored per email (pds.online_order_events): Message-ID, account FINGERPRINT (not the
address), received time, sender address + name, subject, the parsed status (ordered / shipped /
out_for_delivery / delivered / delayed / exception / canceled), store name, order number,
tracking numbers + carrier, expected delivery date and up to five item names. Never stored:
bodies, the shipping address, phone numbers, prices or payment details. USPS numbers printed
with the 420+ZIP routing prefix are stored without it.

After reading mail, every run RECOMPUTES pds.online_orders from all stored events: emails are
joined into one order when they share a store + order number or a tracking number (so a store's
"shipped" email, Amazon's or UPS's "delivered" email and the store's "delivered" email land on
one row). The page decides "overdue" at read time, so the clock moves without a run.

Every run writes ONE pds.sync_log heartbeat (source 'online_orders', data_type 'email'):
success / partial (an account failed or is not configured, or an email failed to parse) /
failed (no account worked, or the database write failed). CI logs print counts only.

Usage:
    python orders_email_etl.py                 # last 45 days (400 when the table is empty)
    python orders_email_etl.py --days 400      # backfill
    python orders_email_etl.py --reprocess     # re-parse emails already stored
    python orders_email_etl.py --dry-run       # read Gmail, print counts, no database access
    python orders_email_etl.py --file x.eml    # parse one saved email and print the result

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAP_HOST and the IMAP_EMAIL* /
     IMAP_APP_PASSWORD* pairs shared with flights_email_etl.py.
"""

from __future__ import annotations

import argparse
import email
import email.policy
import hashlib
import imaplib
import logging
import re
import sys
import time
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

from flights_email_etl import (
    IMAP_HOST, REQUIRED_ACCOUNTS, _fetch_chunks, account_fingerprint, body_lines, decode_hdr, html_to_lines,
    imap_accounts, plain_to_lines, select_all_mail,
)

log = logging.getLogger("orders_email_etl")

SOURCE, DATA_TYPE = "online_orders", "email"
PARSER_VERSION = 1
DEFAULT_DAYS = 45
BACKFILL_DAYS = 400
MAX_MESSAGES = 5000           # per account per run (a 400-day backfill read ~620 in one mailbox)
MAX_BODY_BYTES = 8_000_000    # bigger = attachments; read from the subject alone
SUBJECT_MAX = 200
MAX_ITEMS = 5
ET = ZoneInfo("America/New_York")

EVENTS, ORDERS = "online_order_events", "online_orders"

# One Gmail search per account. Subject words only: the body is fetched for matches alone.
SUBJECT_WORDS = (
    'shipped OR delivered OR "out for delivery" OR "on its way" OR "on the way" OR shipment OR '
    'arriving OR "running late" OR delayed OR "delivery date" OR "order confirmation" OR confirmed OR '
    '"your order" OR "thank you for your order" OR "thanks for your order" OR "ship notification" OR '
    '"delivery notification" OR "has arrived" OR "tracking number" OR "order number" OR canceled OR cancelled'
)
# Restaurant / same-day delivery apps (Uber Eats has its own pipeline), travel, digital goods
# and newsletters that use shipping words. Matched on the sender domain suffix.
EXCLUDED_SENDER_DOMAINS = (
    "uber.com", "doordash.com", "grubhub.com", "seamless.com", "postmates.com", "squareup.com",
    "toasttab.com", "chipotle.com", "chick-fil-a.com", "dominos.com", "gopuff.com", "yelp.com",
    "instacart.com", "caviar.com", "opentable.com", "resy.com", "delta.com", "gobrightline.com",
    "audible.com", "github.com", "tldrnewsletter.com", "intuit.com", "solvhealth.com", "apple.com",
    "spotify.com", "netflix.com", "business.amazon.com",
)
EXCLUDED_SENDERS = ("digital-no-reply@amazon.com",)

# Senders that report on a package for someone else's order: (domain suffix, carrier name, kind).
CARRIER_SENDERS = (
    ("shipping.amazon.com", "Amazon", "marketplace"),
    ("ups.com", "UPS", "carrier"),
    ("fedex.com", "FedEx", "carrier"),
    ("usps.com", "USPS", "carrier"),
    ("dhl.com", "DHL", "carrier"),
    ("ontrac.com", "OnTrac", "carrier"),
)

# --- status ----------------------------------------------------------------------------------
# First match wins, so the more specific readings come first ("not on its way" before "on its
# way", "order successful: ... on the way" before shipped).
STATUS_RULES: tuple[tuple[str, re.Pattern], ...] = tuple((s, re.compile(p, re.I)) for s, p in (
    ("exception", r"\b(delivery (attempt|exception)|attempted delivery|unable to deliver|could ?n[o']t (be )?deliver"
                  r"|returned to (the )?sender|being returned|not on (its|the) way|lost in transit|undeliverable)\b"),
    ("delivered", r"\b(was|were|been|is|has|have)\s+(successfully\s+)?delivered\b|^\W*delivered\b"
                  r"|\bdelivered\b\s*([:!.\-]|$)|\b(has|have)\s+arrived\b|\border has arrived\b|\bdelivery notification\b"
                  r"|\bdropped off\b"),
    ("out_for_delivery", r"\bout for delivery\b|\barriving today\b"),
    ("delayed", r"\brunning late\b|\bdelay(ed)?\b|\bdelivery date\b.{0,40}\bchanged\b|\brescheduled\b"
                r"|\bnew (delivery|arrival) date\b"),
    ("canceled", r"\b(order|purchase|shipment)\b.{0,40}\bcancel+ed\b|\bcancel+ation (confirm|notice)|^\W*cancel+ed\b"),
    ("ordered", r"\border (successful|placed|received|confirmed)\b|\bready to ship\b|\bpreparing your order\b"),
    ("shipped", r"\bshipped\b|\bon (its|the|their) way\b|\bwith the carrier\b|\bship(ping)? (notification|confirmation)\b"
                r"|\bin transit\b|\bshipment\b|\bhas been sent\b|\bdispatched\b"
                r"|\bwill arrive\b|\bpackage coming\b"),
    ("ordered", r"\border\b.{0,30}\b(confirm(ed|ation)|received|placed)\b|\bconfirm(ed|ation)\b.{0,25}\border\b"
                r"|\bthank(s| you) for (your )?(order|purchase|shopping)\b|\bwe('ve| have) (got|received) your order\b"
                r"|\b(order|purchase) (is|has been) (confirmed|placed)\b|\border\b.{0,30}\bconfirmed\b"),
))
# Partial cancellations ("canceled an item from your order"), subscription edits, reminders and
# bookings are not order events.
NOT_AN_ORDER_EVENT = re.compile(r"\bcancel+ed an item\b|\bsubscription (has been )?(updated|paused|skipped|renew)"
                                r"|\bpassword\b|\bsign-?in\b|\bverify\b"
                                r"|\b(upcoming|next) order\b|\border is coming soon\b|\bready for pick-?up\b"
                                r"|\bappointment\b|\breservation\b", re.I)
# "Review your order" / "rate your purchase" are not order events, but "Your order has been
# delivered. Leave a review!" still is: this only drops an email that would read as 'ordered'.
SOFT_NOT_AN_ORDER = re.compile(r"\breview\b|\bsurvey\b|\brate your\b|\bfeedback\b", re.I)
# An email without an order or tracking number counts only when its subject is about an order
# or a package (keeps "Your W-2 has arrived" and "Peachtree season has arrived" out).
ORDERISH_SUBJECT = re.compile(r"\b(order|package|shipment|parcel|purchase|delivery)\b", re.I)
# Body fallback is limited to unambiguous phrases (body text says "delivered every month" etc.).
BODY_STATUS = tuple((s, re.compile(p, re.I)) for s, p in (
    ("delivered", r"\b(has|have) (now )?been delivered\b|\bwas delivered\b|\border has arrived\b"),
    ("out_for_delivery", r"\bis out for delivery\b"),
    ("shipped", r"\b(has|have) (been )?shipped\b|\bis on (its|the) way\b"),
    ("ordered", r"\bthank(s| you) for (your )?(order|purchase|shopping)\b|\bthis email confirms your order\b"),
))
STATUS_RANK = {"ordered": 1, "shipped": 2, "out_for_delivery": 3, "delivered": 4}

# --- identifiers -----------------------------------------------------------------------------
UPS_RE = re.compile(r"\b1Z[0-9A-Z]{16}\b")
AMAZON_TRK_RE = re.compile(r"\bTBA\d{9,15}\b")
USPS_RE = re.compile(r"(?<!\d)(?:420\d{5}(?:\d{4})?)?(9[1-5]\d{18,20})(?!\d)")
FEDEX_RE = re.compile(r"(?<!\d)(\d{12}|\d{15})(?!\d)")
GENERIC_TRK_RE = re.compile(r"\btracking\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9]{8,35})\b", re.I)
HREF_TRK = (
    (re.compile(r"track\.amazon\.com/tracking/(TBA\d{9,15})", re.I), "Amazon"),
    (re.compile(r"ups\.com/\S*?tracknum=(1Z[0-9A-Z]{16})", re.I), "UPS"),
    (re.compile(r"fedex\.com/\S*?(?:trknbr|tracknumbers)=(\d{12}|\d{15})", re.I), "FedEx"),
    (re.compile(r"usps\.com/\S*?tLabels=(9[1-5]\d{18,20})", re.I), "USPS"),
)
ORDER_PATTERNS = tuple(re.compile(p, re.I) for p in (
    r"\border\s*(?:number|no\.?|num|id)\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,30})",
    r"\border\s*[:#]{1,2}\s*#?\s*([A-Z0-9][A-Z0-9-]{3,30})",
    r"\breference\s*[:#]?\s*([A-Z]{1,4}\d{6,20})\b",
    r"\border\s*\(\s*#?\s*([A-Z0-9][A-Z0-9-]{3,30})\s*\)",
    r"\bfrom order\s+#?\s*([A-Z0-9][A-Z0-9-]{3,30})",
    r"\border\s+([A-Z]{0,5}-?\d[A-Z0-9-]{3,30})\b",
    r"\b(?:your|the)\s+[\w.&'-]+(?:\s[\w.&'-]+)?\s+order\s+#?\s*([A-Z]{0,5}-?\d[A-Z0-9-]{3,30})\b",
))
DATE_LIKE = re.compile(r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^(19|20)\d{2}$")

# --- dates -----------------------------------------------------------------------------------
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
WEEKDAYS = {d: i for i, d in enumerate(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])}
EXPECT_RE = re.compile(
    r"\b(?:will be delivered(?: on)?|(?:is )?(?:now )?arriving(?: on)?|arrives?(?: on| by)?|expected(?: delivery)?(?: date)?"
    r"|estimated delivery(?: date)?|delivery (?:date|by)|deliver(?:ed)? by|get it by|should arrive(?: by| on)?)"
    r"\s*[:\-]?\s*(.{2,60})", re.I)
_MONTH = (r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?"
          r"|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?")
MD_RE = re.compile(r"\b" + _MONTH + r"\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?", re.I)
DM_RE = re.compile(r"\b(\d{1,2})\s+" + _MONTH + r"(?:,?\s+(\d{4}))?", re.I)
NUM_DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
ISO_RE = re.compile(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b")
# Full weekday names or real abbreviations only ("monthly" is not Monday).
WEEKDAY_RE = re.compile(r"^\W*(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?"
                        r"|sat(?:urday)?|sun(?:day)?)\b\.?", re.I)

# --- items -----------------------------------------------------------------------------------
NAME_QTY_RE = re.compile(r"^(.{3,90}?)\s+[×xX]\s*(\d{1,3})$")
QTY_RE = re.compile(r"^(?:[×xX]|qty\.?:?|quantity:?)\s*(\d{1,3})$", re.I)
TOTAL_PRICE_RE = re.compile(r"^\(?-?(?:US)?\$\s?\d[\d,]*\.\d{2}\)?$|^\d[\d,]*\.\d{2}$")
UNIT_PRICE_RE = re.compile(r"^\$?\d[\d,]*(\.\d+)?\s*(/\s*\w+|ea\.?|each)$", re.I)
KV_RE = re.compile(r"^[^:]{2,40}:\s*\S")
ITEM_HEADER_RE = re.compile(
    r"^(items?( ordered| in (this|your) (shipment|order|package)| delivered| shipped)?(\s*\(\d+\))?|shipped items|"
    r"order summary|what'?s inside|your order|your items|\d+ items? (arrived|delivered|shipped)|in this (shipment|package)|"
    r"items? (in|from) your order|product|products|description|order details)\s*:?$", re.I)
ITEM_STOP = re.compile(
    r"^(view|track|manage|subtotal|total|shipping|tax|discount|qty|quantity|price|order|items?|hi\b|hello|hey|thank|"
    r"delivered every|every \d|ships every|deliver(ed|y) every|item discount|free|sold by|seller|return|buy again|write a review|"
    r"visit|see (all|details)|details|click|learn more|shop now|need help|replaced with|unavailable|substitut|your order|"
    r"your package|complimentary|gift card|amazon ?shipping)",
    re.I)
ADDRESS_RE = re.compile(
    r"\b\d{5}(-\d{4})?\b|\bunited states\b|\b(unit|apt|suite|ste)\.?\s*#?\s*\w+\b|^\+?\d[\d\s().-]{6,}$|@|\btel\b"
    r"|^\d+\s+\w+(\s+\w+){0,4}\s+(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place"
    r"|pkwy|parkway|hwy|highway|cir|circle|ter|terrace)\b", re.I)


def et_today() -> date:
    return datetime.now(ET).date()


# ---------------------------------------------------------------------------------------------
# Pure helpers (tests/test_orders_email_etl.py)
# ---------------------------------------------------------------------------------------------

def sender_domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].strip().lower() if "@" in address else ""


def domain_matches(domain: str, suffix: str) -> bool:
    return domain == suffix or domain.endswith("." + suffix)


def is_excluded_sender(address: str) -> bool:
    address = address.strip().lower()
    dom = sender_domain(address)
    return address in EXCLUDED_SENDERS or any(domain_matches(dom, s) for s in EXCLUDED_SENDER_DOMAINS)


def carrier_sender(address: str) -> Optional[tuple[str, str]]:
    """(carrier, kind) when the sender is a carrier or Amazon's shipping service, else None."""
    dom = sender_domain(address)
    for suffix, carrier, kind in CARRIER_SENDERS:
        if domain_matches(dom, suffix):
            return carrier, kind
    return None


_SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu"}


def merchant_key(address: str) -> str:
    """A stable store id from the sender: registrable domain, with the shared senders split per store.

    Shopify's store+<id>@t.shopifyemail.com and <store>.aftershiptracking.com are shared domains,
    so the store id inside them is the key.
    """
    address = address.strip().lower()
    local, _, dom = address.partition("@")
    if domain_matches(dom, "shopifyemail.com"):
        m = re.match(r"store\+(\d+)", local)
        return f"shopify:{m.group(1)}" if m else "shopifyemail.com"
    if domain_matches(dom, "aftershiptracking.com") and dom != "aftershiptracking.com":
        return dom.split(".")[0] + ".com"
    labels = [l for l in dom.split(".") if l]
    if len(labels) >= 3 and labels[-2] in _SECOND_LEVEL and len(labels[-1]) == 2:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:]) if len(labels) >= 2 else dom


def clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", (name or "")).strip().strip('"').strip()
    name = re.sub(r"(?i)\b(customer (care|service|support)|support team|team|orders?|no-?reply|notifications?"
                  r"|tracking|shipping|delivery status|updates?)\b", "", name)
    name = re.sub(r"\s+", " ", name).strip(" -|·,")
    return name[:80]


def norm_store_name(name: str) -> str:
    """'Bare Performance Nutrition LLC' and 'Bare Performance Nutrition' -> one key."""
    s = re.sub(r"(?i)\.com\b|\b(llc|inc|ltd|corp|co|company|official|store|shop)\b\.?", "", name or "")
    return re.sub(r"[^a-z0-9]", "", s.lower())


# Platforms that send on behalf of many stores and whose sender name may be a person: the store
# is read from the subject ("your NHC order") instead.
SHARED_PLATFORMS = ("netsuite.com", "rechargemail.com", "klaviyomail.com", "shipstation.com", "narvar.com",
                    "route.com", "aftership.com", "shopify.com")
# Of those, platforms whose sender name is the store's brand (NetSuite / ShipStation can be a person).
BRANDED_SENDER_PLATFORMS = ("rechargemail.com", "klaviyomail.com", "narvar.com", "route.com", "aftership.com", "shopify.com")
SUBJECT_STORE_RE = re.compile(r"\byour\s+([A-Z0-9][\w&.'-]*(?:\s[A-Z0-9][\w&.'-]*){0,2})\s+order\b")
_NOT_A_STORE = {"recent", "new", "next", "upcoming", "online", "latest", "first", "subscription", "monthly"}


def store_from_subject(subject: str) -> Optional[str]:
    m = SUBJECT_STORE_RE.search(subject or "")
    if not m or m.group(1).split()[0].lower() in _NOT_A_STORE:
        return None
    return clean_name(m.group(1))


def merchant_display(sender_name: str, address: str) -> str:
    name = clean_name(re.sub(r"\(?\s*[\w.+-]+@[\w.-]+\s*\)?", "", sender_name or ""))
    if name and not re.fullmatch(r"(?i)(info|support|hello|help|care|mail|email|store|shop)", name):
        return name
    key = merchant_key(address)
    base = key.split(":")[0] if key.startswith("shopify:") else key.split(".")[0]
    return base[:1].upper() + base[1:] if base else "Unknown store"


def classify_status(subject: str, lines: list[str]) -> Optional[str]:
    """Status from the subject; the first body lines only for unambiguous phrases."""
    subj = re.sub(r"\s+", " ", subject or "").strip()
    if NOT_AN_ORDER_EVENT.search(subj):
        return None
    soft = bool(SOFT_NOT_AN_ORDER.search(subj))
    for status, rx in STATUS_RULES:
        if rx.search(subj):
            return None if soft and status == "ordered" else status
    if soft:
        return None
    head = " ".join(lines[:12])
    for status, rx in BODY_STATUS:
        if rx.search(head):
            return status
    return None


def _valid_order_number(tok: str) -> bool:
    tok = tok.strip("-")
    digits = sum(c.isdigit() for c in tok)
    if digits < 3 or len(tok) < 4 or len(tok) > 30:
        return False
    if DATE_LIKE.match(tok) or UPS_RE.fullmatch(tok) or AMAZON_TRK_RE.fullmatch(tok):
        return False
    if tok.isdigit() and len(tok) >= 18:      # a carrier tracking number, not an order number
        return False
    return True


def find_order_number(subject: str, lines: list[str]) -> Optional[str]:
    texts = [subject] + lines[:120]
    for i, text in enumerate(texts):
        # "Order number:" on one line and the value on the next (Lenovo / AfterShip layout)
        if re.fullmatch(r"(?i)\s*order\s*(number|no\.?|#|id)\s*:?\s*", text) and i + 1 < len(texts):
            parts = texts[i + 1].strip().lstrip("#").split()
            tok = parts[0] if parts else ""
            if _valid_order_number(tok):
                return tok.strip("-").upper()
        for rx in ORDER_PATTERNS:
            for m in rx.finditer(text):
                tok = m.group(1).strip("-")
                if _valid_order_number(tok):
                    return tok.upper()
    return None


def _usps(num: str) -> str:
    m = USPS_RE.fullmatch(num)
    return m.group(1) if m else num


def find_tracking(lines: list[str], hrefs: Iterable[str], default_carrier: Optional[str]) -> list[dict]:
    """Tracking numbers with a carrier guess. USPS routing prefixes (420 + ZIP) are stripped."""
    found: dict[str, str] = {}

    def add(num: str, carrier: Optional[str]) -> None:
        num = num.strip().upper()
        if num and num not in found:
            found[num] = carrier or found.get(num) or ""

    for href in hrefs:
        u = urllib.parse.unquote(href)
        for rx, carrier in HREF_TRK:
            for m in rx.finditer(u):
                add(m.group(1), carrier)
    text = "\n".join(lines[:200])
    low = text.lower()
    for m in UPS_RE.finditer(text):
        add(m.group(0), "UPS")
    for m in AMAZON_TRK_RE.finditer(text):
        add(m.group(0), "Amazon")
    for m in USPS_RE.finditer(text):
        carrier = "DHL eCommerce" if "dhl" in low else "USPS"
        add(m.group(1), carrier)
    if "fedex" in low or default_carrier == "FedEx":
        for i, line in enumerate(lines[:200]):
            ctx = (lines[i - 1] if i else "") + " " + line
            if re.search(r"(?i)fedex|tracking", ctx):
                for m in FEDEX_RE.finditer(line):
                    add(m.group(1), "FedEx")
    for m in GENERIC_TRK_RE.finditer(text):
        tok = m.group(1)
        if sum(c.isdigit() for c in tok) >= 6:
            tok = _usps(tok)
            add(tok, None)
    out = []
    for num, carrier in found.items():
        if not carrier:
            if UPS_RE.fullmatch(num):
                carrier = "UPS"
            elif AMAZON_TRK_RE.fullmatch(num):
                carrier = "Amazon"
            elif re.fullmatch(r"9[1-5]\d{18,20}", num):
                carrier = "USPS"
            else:
                carrier = default_carrier or None
        out.append({"number": num, "carrier": carrier})
    return out[:6]


def _resolve(month: int, day: int, year: Optional[int], anchor: date) -> Optional[date]:
    try:
        if year:
            return date(year if year > 99 else 2000 + year, month, day)
        best = None
        for y in (anchor.year - 1, anchor.year, anchor.year + 1):
            d = date(y, month, day)
            if -20 <= (d - anchor).days <= 120:
                best = d if best is None or abs((d - anchor).days) < abs((best - anchor).days) else best
        return best
    except ValueError:
        return None


def parse_date_text(text: str, anchor: date) -> Optional[date]:
    """'Saturday, November 14' / 'July 7, 2026' / 'Tuesday, 06/30/2026' / 'tomorrow' -> date near anchor."""
    t = text.strip().lower()
    if not t or t.startswith("-"):
        return None
    if t.startswith("today"):
        return anchor
    if t.startswith("tomorrow"):
        return anchor + timedelta(days=1)
    m = ISO_RE.search(t)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = MD_RE.search(t)
    if m:
        return _resolve(MONTHS[m.group(1)[:3]], int(m.group(2)), int(m.group(3)) if m.group(3) else None, anchor)
    m = DM_RE.search(t)
    if m:
        return _resolve(MONTHS[m.group(2)[:3]], int(m.group(1)), int(m.group(3)) if m.group(3) else None, anchor)
    m = NUM_DATE_RE.search(t)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else None
        if a > 12 >= b:            # 27/04/2026 (day first)
            a, b = b, a
        return _resolve(a, b, year, anchor)
    m = WEEKDAY_RE.match(t)
    if m:
        delta = (WEEKDAYS[m.group(1)[:3]] - anchor.weekday()) % 7
        return anchor + timedelta(days=delta)
    return None


def find_expected_date(subject: str, lines: list[str], anchor: date) -> Optional[date]:
    texts = [subject] + lines[:150]
    for i, text in enumerate(texts):
        candidates = [text]
        if text.rstrip().endswith(":") and i + 1 < len(texts):
            candidates.append(text.rstrip() + " " + texts[i + 1])
        for cand in candidates:
            for m in EXPECT_RE.finditer(cand):
                d = parse_date_text(m.group(1), anchor)
                if d and -7 <= (d - anchor).days <= 120:
                    return d
    return None


def _is_item_boundary(line: str) -> bool:
    return bool(TOTAL_PRICE_RE.match(line) or QTY_RE.match(line) or NAME_QTY_RE.match(line)
                or ITEM_HEADER_RE.match(line.strip()))


PRICE_IN_TEXT_RE = re.compile(r"\$|\b(USD|EUR|GBP|CAD)\b|\b\d+\.\d{2}\b(?!\s*(fl\.?\s?oz|oz|ml|l|lbs?|g|kg|in|inch|ct|count|pk|pack|mg|mcg)\b)", re.I)
CITY_STATE_RE = re.compile(r"^[A-Za-z .'-]+,?\s+[A-Z]{2}$|^[A-Za-z .'-]+,\s*[A-Z]{2}\b")
ADDRESS_HEADER_RE = re.compile(r"(?i)^(ship(ping|ped)?\s+(to|address)|deliver(y|ed)?\s+(to|address)|billing( address)?|"
                               r"customer( info)?|recipient|your (order|package) was delivered to|sent to)\b")
GREETING_RE = re.compile(r"^(?i:hi|hello|hey|dear),?\s+([A-Z][a-z]{2,})\b")


def people_names(to_name: str, lines: list[str]) -> set[str]:
    """First / last names of the person the email is to (To header, "Hi <name>"): never an item."""
    out = {t.lower() for t in re.findall(r"[A-Za-z]{3,}", to_name or "")}
    for i, line in enumerate(lines[:40]):
        m = GREETING_RE.match(line)
        if m:
            out.add(m.group(1).lower())
        elif re.fullmatch(r"(?i)(hi|hello|hey|dear)\W*", line) and i + 1 < len(lines):
            m = re.match(r"^([A-Z][a-z]{2,})\b", lines[i + 1])
            if m:
                out.add(m.group(1).lower())
    return out


def _good_item_name(name: str, people: set[str] | str = frozenset()) -> bool:
    if isinstance(people, str):
        people = {t.lower() for t in re.findall(r"[A-Za-z]{3,}", people)}
    name = name.strip()
    if not (3 <= len(name) <= 90) or not re.search(r"[A-Za-z]{2}", name):
        return False
    if ITEM_STOP.match(name) or ADDRESS_RE.search(name) or KV_RE.match(name) or ADDRESS_HEADER_RE.match(name):
        return False
    if UNIT_PRICE_RE.match(name) or TOTAL_PRICE_RE.match(name) or PRICE_IN_TEXT_RE.search(name):
        return False
    if CITY_STATE_RE.match(name):
        return False
    if re.search(r"(?i)#\s*(tba)?\d{4,}", name) or re.search(r"(?i)\b(ups|fedex|usps|dhl|tracking)\b", name):
        return False
    words = {w.lower() for w in re.findall(r"[A-Za-z]{3,}", name)}
    if people and words & people:
        return False
    return True


def find_items(subject: str, lines: list[str], recipient: str = "") -> tuple[list[str], Optional[int]]:
    """Up to five item names and the item count when the email states one.

    Never an address, a price, a place or a person: names next to a "Ship to" style header, with a
    price, shaped like "City, ST", or containing the recipient's name are dropped.
    """
    names: list[str] = []
    count: Optional[int] = None
    people = people_names(recipient, lines)

    def add(name: str) -> None:
        name = re.sub(r"\s+", " ", name).strip(" -•·")
        if _good_item_name(name, people) and name not in names:
            names.append(name[:90])

    for i, line in enumerate(lines[:400]):
        m = NAME_QTY_RE.match(line)
        if m:
            add(m.group(1))
            continue
        if QTY_RE.match(line):
            j = i - 1
            while j >= max(0, i - 7) and not _is_item_boundary(lines[j]):
                j -= 1
            near_address = any(ADDRESS_HEADER_RE.match(lines[k]) for k in range(max(0, j), i))
            if (j >= max(0, i - 7) or j < 0) and not near_address:   # found a boundary (or reached the top)
                for k in range(j + 1, i):
                    if KV_RE.match(lines[k]) or UNIT_PRICE_RE.match(lines[k]):
                        continue
                    add(lines[k])
                    break
        m = re.match(r"(?i)^(\d{1,3}) items? (arrived|delivered|shipped)\b", line)
        if m and count is None:
            count = int(m.group(1))
    m = re.match(r"(?i)^\W*(?:delivered|shipped|arriving[^:]*|out for delivery)\s*:\s*(.+?)(?:\s+and (\d+) other items?)?\s*$",
                 subject or "")
    if m:
        first = m.group(1).rstrip(".… ")
        if not names and _good_item_name(first, people):
            names.append(first[:90])
        if m.group(2) and count is None:
            count = int(m.group(2)) + 1
    return names[:MAX_ITEMS], count


AMAZON_MERCHANT_RES = (
    re.compile(r"\bpackage from (.+?) (?:has shipped|is on the way|is out for delivery|was delivered|is now arriving"
               r"|is running late|will be delivered|is arriving|has been delivered)", re.I),
    re.compile(r"^your (.+?) package (?:was delivered|is out for delivery|has shipped|is on the way)", re.I),
)
SHIPPER_RES = (
    re.compile(r"\bat the request of ([A-Z0-9][\w&.,' -]{1,40}?) to notify", re.I),
)


def find_shipper(subject: str, lines: list[str]) -> Optional[str]:
    """The store a carrier / Amazon email is about ('package from X', UPS 'From: X')."""
    for text in [subject] + lines[:15]:
        for rx in AMAZON_MERCHANT_RES:
            m = rx.search(text)
            if m:
                return clean_name(re.sub(r"(?i),?\s*(llc|inc\.?|ltd\.?|corp\.?)$", "", m.group(1)))
    for i, line in enumerate(lines[:60]):
        for rx in SHIPPER_RES:
            m = rx.search(line)
            if m:
                return clean_name(m.group(1)).title()
        if line.strip().lower() in ("from:", "shipper:") and i + 1 < len(lines):
            nxt = lines[i + 1].strip()
            if nxt and not ADDRESS_RE.search(nxt):
                return clean_name(nxt).title()
    return None


def safe_hdr(msg: email.message.Message, name: str) -> str:
    """A header as text. Raw 8-bit or unknown-charset headers never raise (they become '?' / as-is)."""
    try:
        raw = msg.get(name)
    except Exception:
        return ""
    if raw is None:
        return ""
    try:
        return decode_hdr(str(raw))
    except Exception:
        try:
            return str(raw)
        except Exception:
            return ""


def parse_bytes(raw: bytes) -> email.message.Message:
    return email.message_from_bytes(raw, policy=email.policy.default)


def message_lines(msg: email.message.Message) -> list[str]:
    """body_lines() with a fallback for an unknown body charset (decoded as UTF-8 with replacement)."""
    try:
        return body_lines(msg)
    except (LookupError, UnicodeError):
        html = plain = None
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype not in ("text/html", "text/plain"):
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            text = payload.decode("utf-8", errors="replace")
            if ctype == "text/html" and html is None:
                html = text
            elif ctype == "text/plain" and plain is None:
                plain = text
        return html_to_lines(html) if html else plain_to_lines(plain) if plain else []


AMOUNT_RE = re.compile(r"(?:US|CA|C)?\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|CAD)\b|[€£]\s?\d[\d,]*(?:\.\d{1,2})?", re.I)


def scrub_subject(subject: str) -> str:
    """Stored subjects never carry an amount ("Your order of $54.99 has shipped")."""
    return AMOUNT_RE.sub("[amount]", subject)


def parse_message(header: email.message.Message, lines: list[str], hrefs: list[str]) -> dict:
    """One email -> an event dict (without account / message id). parse_status 'parsed' or 'ignored'.

    An ignored email keeps no subject or sender: the search also matches non-order mail
    ("your payment has been confirmed", appointments), which must not be stored.
    """
    subject = re.sub(r"\s+", " ", safe_hdr(header, "Subject")).strip()
    name, address = parseaddr(safe_hdr(header, "From"))
    address = address.strip().lower()
    to_name = parseaddr(safe_hdr(header, "To"))[0].strip()
    try:
        received = parsedate_to_datetime(safe_hdr(header, "Date"))
        if received.tzinfo is None:
            received = received.replace(tzinfo=timezone.utc)
    except Exception:
        received = None
    out: dict[str, Any] = {
        "received_at": received.astimezone(timezone.utc).isoformat() if received else None,
        "sender_address": "",
        "sender_name": None,
        "subject": None,
        "parse_status": "ignored",
        "note": None,
        "kind": None, "merchant_key": None, "merchant_name": None, "order_number": None,
        "tracking": [], "status": None, "expected_date": None, "items": [], "item_count": None,
        "parser_version": PARSER_VERSION,
    }
    if received is None:
        out["note"] = "no date"
        return out
    status = classify_status(subject, lines)
    if status is None:
        out["note"] = "not an order update"
        return out
    carrier = carrier_sender(address)
    kind = carrier[1] if carrier else "merchant"
    tracking = find_tracking(lines, hrefs, carrier[0] if carrier else None)
    order_number = None if carrier else find_order_number(subject, lines)
    if not order_number and not tracking and not carrier and not ORDERISH_SUBJECT.search(subject):
        out["note"] = "no order or tracking number"
        return out
    out.update({"sender_address": address[:320], "sender_name": clean_name(name) or None,
                "subject": scrub_subject(subject)[:SUBJECT_MAX] or None})
    anchor = received.astimezone(ET).date()
    expected = find_expected_date(subject, lines, anchor) if status not in ("delivered", "canceled") else None
    items, count = find_items(subject, lines, to_name)
    if kind == "merchant" and any(domain_matches(sender_domain(address), p) for p in SHARED_PLATFORMS) \
            and not merchant_key(address).startswith("shopify:"):
        # The store from the subject ("your NHC order"), else the sender name ("Gaia Herbs" via
        # Recharge) unless that name holds an address (a person at the store); the recompute maps a
        # name: key to the store's own domain when the store also emails directly.
        brand_sender = any(domain_matches(sender_domain(address), p) for p in BRANDED_SENDER_PLATFORMS)
        sender_label = clean_name(name) if brand_sender and "@" not in (name or "") else ""
        store = store_from_subject(subject) or (sender_label if norm_store_name(sender_label) else None)
        mkey = f"name:{norm_store_name(store)}" if store and norm_store_name(store) else merchant_key(address)
        mname = store or merchant_display("", address)
    elif kind == "merchant":
        mkey, mname = merchant_key(address), merchant_display(name, address)
    else:
        mkey, mname = None, find_shipper(subject, lines)
    out.update({
        "parse_status": "parsed",
        "kind": kind,
        "merchant_key": mkey,
        "merchant_name": mname,
        "order_number": order_number,
        "tracking": tracking,
        "status": status,
        "expected_date": expected.isoformat() if expected else None,
        "items": items,
        "item_count": count,
    })
    return out


def html_hrefs(msg: email.message.Message) -> list[str]:
    for part in msg.walk():
        if part.get_content_type() == "text/html" and not part.get("Content-Disposition", "").startswith("attachment"):
            payload = part.get_payload(decode=True)
            if payload:
                try:
                    html = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                except LookupError:      # unknown charset name
                    html = payload.decode("utf-8", errors="replace")
                return re.findall(r'href\s*=\s*["\']([^"\']+)["\']', html, re.I)[:300]
    return []


# ---------------------------------------------------------------------------------------------
# Joining emails into orders (pure; tests/test_orders_email_etl.py)
# ---------------------------------------------------------------------------------------------

class _DSU:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _ts(ev: dict) -> datetime:
    return datetime.fromisoformat(str(ev["received_at"]).replace("Z", "+00:00"))


def _short_hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:10]


def _items_overlap(a: Iterable[str], b: Iterable[str]) -> bool:
    la = [x.lower() for x in a]
    for y in b:
        y = y.lower()
        if any(x.startswith(y) or y.startswith(x) for x in la):
            return True
    return False


def build_orders(events: list[dict]) -> list[dict]:
    """Parsed events -> one row per order. Deterministic: the same events always give the same rows.

    1. Emails join when they share a store + order number, or a tracking number.
    2. Weak groups (no tracking number, and no order number or only "out for delivery" /
       "delivered" emails: Thorne's delivered email quotes another number, some Amazon emails carry
       no tracking link) join the same store's order nearest in time, 21 days before to 5 after.
       A delivered / out-for-delivery email only joins an order that shipped and is not delivered;
       a shipping email prefers an order that has not shipped yet. When several orders fit equally
       and the item names do not decide, the email stays on its own (a wrong join would mark the
       wrong package as delivered).
    3. Order keys are unique: o:<store>:<order no> (the first order number seen), t:<tracking>,
       or m:<hash of the first email>. Every key an order ever had stays in its aliases (each
       email adds its own m: alias), so Riley's marks survive a key change.
    """
    evs = sorted((e for e in events if e.get("parse_status") == "parsed" and e.get("status") and e.get("received_at")),
                 key=lambda e: (_ts(e), e["message_id"]))
    n = len(evs)

    # Store resolution: names map only to REAL store keys (a domain or a Shopify store id), never
    # to a "name:" key, so a store reached both directly and through a platform resolves to one key.
    name_to_key: dict[str, str] = {}
    for e in evs:
        k0 = e.get("merchant_key")
        if e.get("kind") == "merchant" and k0 and not k0.startswith("name:"):
            label = "" if k0.startswith("shopify:") else k0.split(".")[0]
            for nm in (e.get("merchant_name"), label):
                k = norm_store_name(nm or "")
                if len(k) >= 4:
                    name_to_key.setdefault(k, k0)

    def store_of(e: dict) -> Optional[str]:
        key = e.get("merchant_key")
        if key and key.startswith("name:"):
            return name_to_key.get(key[5:], key)
        return key or name_to_key.get(norm_store_name(e.get("merchant_name") or "")) or None

    stores = [store_of(e) for e in evs]
    dsu = _DSU(n)
    by_order: dict[tuple[str, str], int] = {}
    by_trk: dict[str, int] = {}
    for i, e in enumerate(evs):
        if e.get("kind") == "merchant" and stores[i] and e.get("order_number"):
            k = (stores[i], e["order_number"])
            if k in by_order:
                dsu.union(i, by_order[k])
            else:
                by_order[k] = i
        for t in e.get("tracking") or []:
            num = t.get("number")
            if not num:
                continue
            if num in by_trk:
                dsu.union(i, by_trk[num])
            else:
                by_trk[num] = i

    members: dict[int, list[int]] = {}
    for i in range(n):
        members.setdefault(dsu.find(i), []).append(i)

    def weak(idx: list[int]) -> bool:
        if any(evs[k].get("tracking") for k in idx):
            return False
        if not any(evs[k].get("order_number") for k in idx):
            return True
        return all(evs[k]["status"] in ("out_for_delivery", "delivered") for k in idx)

    def group_store(idx: list[int]) -> Optional[str]:
        return next((stores[k] for k in idx if stores[k]), None)

    def shipped(idx: list[int]) -> bool:
        return any(STATUS_RANK.get(evs[k]["status"], 0) >= 2 or evs[k].get("tracking") for k in idx)

    for root in sorted(members, key=lambda r: min(members[r])):
        if root not in members or not weak(members[root]):
            continue
        idx = members[root]
        store = group_store(idx)
        if not store:
            continue
        t = _ts(evs[min(idx)])
        statuses = {evs[k]["status"] for k in idx}
        confirms_arrival = bool(statuses & {"delivered", "out_for_delivery"})
        only_ordered = statuses <= {"ordered"}
        g_items = [it for k in idx for it in (evs[k].get("items") or [])]
        cands = []
        for other, oidx in members.items():
            if other == root or group_store(oidx) != store:
                continue
            near = [g for g in ((_ts(evs[k]) - t).total_seconds() / 86400 for k in oidx) if -21 <= g <= 5]
            if not near:
                continue
            o_delivered = [evs[k] for k in oidx if evs[k]["status"] == "delivered"]
            duplicate = False
            if confirms_arrival:
                if o_delivered:
                    # The same package reported by a second sender (the store and Amazon) within a day.
                    if "delivered" in statuses and min(abs((_ts(d) - t).total_seconds()) for d in o_delivered) <= 86400:
                        duplicate = True
                    else:
                        continue
                elif not shipped(oidx):
                    continue
            elif any(_ts(d) <= t for d in o_delivered):
                continue
            strong = any(evs[k].get("order_number") or evs[k].get("tracking") for k in oidx)
            stage = 1 if ("shipped" in statuses and shipped(oidx)) else 0   # a shipping email prefers an unshipped order
            o_items = [it for k in oidx for it in (evs[k].get("items") or [])]
            overlap = bool(g_items and o_items and _items_overlap(g_items, o_items))
            tier = (0 if overlap else 1, 1 if duplicate else 0, 0 if strong else 1, stage)
            first_at = min(_ts(evs[k]) for k in oidx)
            cands.append((tier, min(abs(g) for g in near), first_at, other))
        if not cands:
            continue
        # Best tier first. Within a tier: an order-confirmation email takes the nearest order; a
        # shipping / delivery email takes the OLDEST open order (packages mostly arrive in the order
        # they shipped; a swap still ends with both orders delivered once the second email comes).
        if only_ordered:
            cands.sort(key=lambda c: (c[0], c[1], c[2], c[3]))
        else:
            cands.sort(key=lambda c: (c[0], c[2], c[1], c[3]))
        best = cands[0][3]
        dsu.union(root, best)
        new_root = dsu.find(root)
        merged = members.pop(root) + members.pop(best)
        members[new_root] = merged

    # Stores that have ever sent a shipping email (a "not shipped yet" order matters only for them).
    merchant_ships = {stores[i] for i, e in enumerate(evs) if e.get("kind") == "merchant" and stores[i] and
                      (STATUS_RANK.get(e["status"], 0) >= 2 or e.get("tracking"))}

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(dsu.find(i), []).append(i)

    rows: list[dict] = []
    used_keys: set[str] = set()
    for gidx in groups.values():
        gidx.sort(key=lambda k: (_ts(evs[k]), evs[k]["message_id"]))
        mem = [evs[k] for k in gidx]
        merchant_idx = [k for k in gidx if evs[k].get("kind") == "merchant"]
        mkey = next((stores[k] for k in merchant_idx if stores[k]), None) or group_store(gidx)
        names = [evs[k]["merchant_name"] for k in merchant_idx if evs[k].get("merchant_name")] or \
                [e["merchant_name"] for e in mem if e.get("merchant_name")]
        merchant_name = max(set(names), key=lambda x: (names.count(x), -names.index(x))) if names else "Unknown store"
        numbered = [k for k in merchant_idx if evs[k].get("order_number") and stores[k]]
        order_numbers = list(dict.fromkeys(evs[k]["order_number"] for k in numbered))
        tracking: dict[str, dict] = {}
        for e in mem:
            for t in e.get("tracking") or []:
                cur = tracking.setdefault(t["number"], {"number": t["number"], "carrier": t.get("carrier"), "delivered": False})
                if not cur.get("carrier") and t.get("carrier"):
                    cur["carrier"] = t["carrier"]
                if e["status"] == "delivered":
                    cur["delivered"] = True
        m_aliases = {f"m:{_short_hash(e['message_id'])}" for e in mem}
        if numbered:
            k0 = numbered[0]
            key = f"o:{stores[k0]}:{evs[k0]['order_number']}"
        elif tracking:
            key = f"t:{sorted(tracking)[0]}"
        else:
            key = f"m:{_short_hash(mem[0]['message_id'])}"
        if key in used_keys:          # cannot happen given the joins above; never send a duplicate key
            log.warning("duplicate order key from recompute; using the email key instead")
            key = f"m:{_short_hash(mem[0]['message_id'])}"
        used_keys.add(key)
        aliases = sorted({f"o:{stores[k]}:{evs[k]['order_number']}" for k in numbered}
                         | {f"o:{evs[k]['merchant_key']}:{evs[k]['order_number']}" for k in numbered if evs[k].get("merchant_key")}
                         | {f"t:{t}" for t in tracking} | m_aliases | {key})

        def first(statuses: set[str]) -> Optional[dict]:
            return next((e for e in mem if e["status"] in statuses), None)

        def last(statuses: set[str]) -> Optional[dict]:
            return next((e for e in reversed(mem) if e["status"] in statuses), None)

        delivered_events = [e for e in mem if e["status"] == "delivered"]
        untracked_delivery = any(not e.get("tracking") for e in delivered_events)
        partially = bool(delivered_events and not untracked_delivery and tracking
                         and not all(v["delivered"] for v in tracking.values()))
        progress = max((STATUS_RANK.get(e["status"], 0) for e in mem), default=0)
        canceled = [e for e in mem if e["status"] == "canceled"]
        others = [e for e in mem if e["status"] != "canceled"]
        if delivered_events and not partially:
            status = "delivered"
        elif canceled and progress <= 1 and not tracking and (not others or _ts(canceled[-1]) >= _ts(others[-1])):
            status = "canceled"
        elif progress >= 3 and not partially:
            status = "out_for_delivery"
        elif progress >= 2 or partially or tracking:
            status = "shipped"
        else:
            status = "ordered"        # includes "delayed" before anything shipped: the delay is the issue
        # A delay / problem counts only if nothing better happened after it (a problem always counts).
        issue = None
        if status not in ("delivered", "canceled"):
            last_progress = max((_ts(e) for e in mem if STATUS_RANK.get(e["status"], 0) >= 2), default=None)
            for e in reversed(mem):
                if e["status"] in ("delayed", "exception"):
                    if last_progress is None or _ts(e) >= last_progress or e["status"] == "exception":
                        issue = e["status"]
                    break
        # The newest date wins, and a date older than the latest "out for delivery" email is stale.
        dated = next((e for e in reversed(mem) if e.get("expected_date")), None)
        latest_ofd = last({"out_for_delivery"})
        expected = str(dated["expected_date"])[:10] if dated else None
        if dated and latest_ofd and _ts(latest_ofd) > _ts(dated):
            expected = None
        items: list[str] = []
        for e in mem:
            for it in e.get("items") or []:
                low = it.lower()
                clash = next((x for x in items if low.startswith(x.lower()) or x.lower().startswith(low)), None)
                if clash is None:
                    items.append(it)
                elif len(it) < len(clash):        # "Lion's Mane Mushroom" over "Lion's Mane Mushroom - 40 ct"
                    items[items.index(clash)] = it
        counts = [e["item_count"] for e in mem if e.get("item_count")]
        ordered_ev = first({"ordered"})
        shipped_ev = first({"shipped", "out_for_delivery", "delivered", "delayed", "exception"}) if (progress >= 2 or tracking) else None
        rows.append({
            "_senders": sorted({sender_domain(e["sender_address"]) for e in mem if e.get("kind") != "merchant"}),
            "order_key": key,
            "aliases": aliases,
            "merchant_key": mkey,
            "merchant_name": merchant_name[:80],
            "order_number": order_numbers[0] if order_numbers else None,
            "tracking": [tracking[t] for t in sorted(tracking)],
            "items": items[:MAX_ITEMS],
            "item_count": max(counts) if counts else (len(items) or None),
            "status": status,
            "issue": issue,
            "partially_delivered": partially,
            "ordered_at": (ordered_ev or mem[0])["received_at"],
            "shipped_at": shipped_ev["received_at"] if shipped_ev else None,
            "out_for_delivery_at": latest_ofd["received_at"] if latest_ofd else None,
            "delivered_at": delivered_events[0]["received_at"] if status == "delivered" else None,
            "canceled_at": canceled[-1]["received_at"] if status == "canceled" else None,
            "expected_date": expected,
            "first_event_at": mem[0]["received_at"],
            "last_event_at": mem[-1]["received_at"],
            "event_count": len(mem),
            "confirms_delivery": False,
            "ships_physically": bool(tracking or progress >= 2 or (mkey and mkey in merchant_ships)),
        })

    # Does this store (or Amazon / the carrier) normally email when a package arrives? Judged on
    # its six most recent shipped orders that are more than 10 days old (relative to the newest
    # email, so the result does not depend on when the job runs): at least two, 60 % delivered.
    # Thorne emailed "delivered" for 1 of 8 orders in 2026; a missing email from it is not a sign.
    newest = max((_ts(e) for e in evs), default=None)
    cutoff = newest - timedelta(days=10) if newest else None

    def reliable(selector) -> set[str]:
        hist: dict[str, list[tuple[datetime, bool]]] = {}
        for r in rows:
            if not r["shipped_at"] or cutoff is None:
                continue
            at = _ts({"received_at": r["shipped_at"]})
            if at > cutoff:
                continue
            for k in selector(r):
                hist.setdefault(k, []).append((at, r["status"] == "delivered"))
        out = set()
        for k, h in hist.items():
            recent = sorted(h, key=lambda x: x[0], reverse=True)[:6]
            if len(recent) >= 2 and sum(d for _, d in recent) / len(recent) >= 0.6:
                out.add(k)
        return out

    stores_ok = reliable(lambda r: [r["merchant_key"]] if r["merchant_key"] else [])
    senders_ok = reliable(lambda r: r["_senders"])
    for r in rows:
        r["confirms_delivery"] = bool((r["merchant_key"] and r["merchant_key"] in stores_ok)
                                      or any(s in senders_ok for s in r["_senders"]))
        del r["_senders"]
    rows.sort(key=lambda r: r["order_key"])
    return rows


# ---------------------------------------------------------------------------------------------
# IMAP (read-only)
# ---------------------------------------------------------------------------------------------

def gmail_query(since: date) -> str:
    # -in:sent -in:drafts -from:me: Riley's own replies ("Re: Your order #4455 is delayed") are not store mail.
    excluded = " ".join(f"-from:{d}" for d in EXCLUDED_SENDER_DOMAINS)
    return (f"subject:({SUBJECT_WORDS}) -category:promotions -category:social -in:sent -in:drafts -from:me "
            f"{excluded} after:{since:%Y/%m/%d}")


def search_candidates(imap: imaplib.IMAP4_SSL, since: date) -> list[bytes]:
    q = gmail_query(since).replace("\\", "\\\\").replace('"', '\\"')
    status, data = imap.uid("SEARCH", None, "X-GM-RAW", f'"{q}"')
    if status != "OK":
        raise RuntimeError(f"Gmail search failed ({status})")
    return data[0].split() if data and data[0] else []


def bare_message_id(raw: Optional[str], uid: bytes, account: str) -> str:
    mid = (raw or "").strip().strip("<>").strip()
    return mid[:500] if mid else f"nomid:{account_fingerprint(account)}:{uid.decode()}"


def error_row(base: dict, header: Optional[email.message.Message], synced_at: str, err: Exception) -> dict:
    """An email that failed to parse: kept (and re-read next run) with no subject or sender stored."""
    received = synced_at
    if header is not None:
        try:
            received = parsedate_to_datetime(safe_hdr(header, "Date")).astimezone(timezone.utc).isoformat()
        except Exception:
            pass
    return {**base, "received_at": received, "sender_address": "", "sender_name": None, "subject": None,
            "parse_status": "error", "note": type(err).__name__[:200], "kind": None, "merchant_key": None,
            "merchant_name": None, "order_number": None, "tracking": [], "status": None,
            "expected_date": None, "items": [], "item_count": None, "parser_version": PARSER_VERSION}


def process_account(account: str, password: str, since: date, known: set[str], reprocess: bool,
                    synced_at: str, own_addresses: Iterable[str] = ()) -> tuple[list[dict], dict]:
    stats = {"candidates": 0, "dropped_by_cap": 0, "skipped_known": 0, "excluded": 0, "own": 0,
             "parsed": 0, "ignored": 0, "errors": 0}
    fp = account_fingerprint(account)
    own = {a.strip().lower() for a in own_addresses} | {account.strip().lower()}
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    rows: list[dict] = []
    try:
        imap.login(account, password)
        select_all_mail(imap)
        found = search_candidates(imap, since)
        stats["candidates"] = len(found)
        stats["dropped_by_cap"] = max(0, len(found) - MAX_MESSAGES)
        uids = found[-MAX_MESSAGES:]
        if not uids:
            return rows, stats
        headers: dict[bytes, email.message.Message] = {}
        for uid, raw in _fetch_chunks(imap, uids, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM TO)])", chunk=100):
            try:
                headers[uid] = parse_bytes(raw)
            except Exception:
                stats["errors"] += 1
        todo: list[bytes] = []
        for uid in uids:
            h = headers.get(uid)
            if h is None:
                continue
            mid = bare_message_id(safe_hdr(h, "Message-ID"), uid, account)
            if mid in known and not reprocess:
                stats["skipped_known"] += 1
                continue
            address = parseaddr(safe_hdr(h, "From"))[1].strip().lower()
            if address in own:
                stats["own"] += 1
                continue
            if is_excluded_sender(address):
                stats["excluded"] += 1
                continue
            todo.append(uid)
        for uid, raw in _fetch_chunks(imap, todo, "(BODY.PEEK[])", chunk=10):
            h = headers.get(uid)
            mid = bare_message_id(safe_hdr(h, "Message-ID") if h is not None else None, uid, account)
            base = {"message_id": mid, "account_fp": fp, "synced_at": synced_at}
            try:
                if len(raw) > MAX_BODY_BYTES:
                    ev = parse_message(h, [], [])
                else:
                    msg = parse_bytes(raw)
                    ev = parse_message(h, message_lines(msg), html_hrefs(msg))
                if ev["received_at"] is None:
                    raise ValueError("no Date header")
                rows.append({**base, **ev})
                stats["parsed" if ev["parse_status"] == "parsed" else "ignored"] += 1
            except Exception as e:
                stats["errors"] += 1
                rows.append(error_row(base, h, synced_at, e))
        return rows, stats
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------------------------

EVENT_COLS = ("message_id,account_fp,received_at,sender_address,sender_name,subject,parse_status,note,kind,"
              "merchant_key,merchant_name,order_number,tracking,status,expected_date,items,item_count,parser_version")


def load_events(supa: Any, since: Optional[date] = None, cols: str = EVENT_COLS) -> list[dict]:
    out: list[dict] = []
    start = 0
    while True:
        q = supa.schema("pds").table(EVENTS).select(cols).order("message_id")
        if since is not None:
            q = q.gte("received_at", since.isoformat())
        page = q.range(start, start + 999).execute().data or []
        out.extend(page)
        if len(page) < 1000:
            return out
        start += 1000


def known_message_ids(supa: Any, since: date) -> set[str]:
    """Messages already read with the current parser. Errors are re-read every run."""
    return {r["message_id"] for r in load_events(supa, since - timedelta(days=2), "message_id,parse_status,parser_version")
            if r["parse_status"] != "error" and int(r.get("parser_version") or 0) >= PARSER_VERSION}


def store_events(supa: Any, rows: list[dict]) -> None:
    # The same message can sit in both mailboxes: one row per Message-ID.
    unique = {r["message_id"]: r for r in rows}
    batch = list(unique.values())
    for i in range(0, len(batch), 200):
        supa.schema("pds").table(EVENTS).upsert(batch[i:i + 200], on_conflict="message_id").execute()


def recompute_orders(supa: Any, now_iso: str) -> int:
    events = load_events(supa)
    orders = build_orders(events)
    table = lambda: supa.schema("pds").table(ORDERS)  # noqa: E731
    existing: list[str] = []
    start = 0
    while True:
        page = table().select("order_key").order("order_key").range(start, start + 999).execute().data or []
        existing.extend(r["order_key"] for r in page)
        if len(page) < 1000:
            break
        start += 1000
    if not orders and len(existing) > 10:
        raise RuntimeError(f"recompute produced 0 orders but {len(existing)} exist; refusing to clear the table")
    for r in orders:
        r["updated_at"] = now_iso
    for i in range(0, len(orders), 200):
        table().upsert(orders[i:i + 200], on_conflict="order_key").execute()
    stale = sorted(set(existing) - {r["order_key"] for r in orders})
    for i in range(0, len(stale), 100):
        table().delete().in_("order_key", stale[i:i + 100]).execute()
    return len(orders)


def table_is_empty(supa: Any) -> bool:
    data = supa.schema("pds").table(EVENTS).select("message_id").limit(1).execute().data
    return not data


def run(supa: Any, accounts: list[tuple[str, str]], days: Optional[int], reprocess: bool = False,
        dry_run: bool = False) -> tuple[str, int, Optional[str]]:
    """Returns (heartbeat status, records, error note)."""
    synced_at = datetime.now(timezone.utc).isoformat()
    if days is None:
        days = BACKFILL_DAYS if (not dry_run and table_is_empty(supa)) else DEFAULT_DAYS
    since = et_today() - timedelta(days=days)
    known = set() if dry_run else known_message_ids(supa, since)
    if not accounts:
        return "failed", 0, "no IMAP accounts configured"
    failures: list[str] = []
    notes: list[str] = []
    new_rows: list[dict] = []
    errors = 0
    own = [a for a, _ in accounts]
    for account, password in accounts:
        fp = account_fingerprint(account)
        try:
            rows, stats = process_account(account, password, since, known, reprocess, synced_at, own)
            new_rows.extend(rows)
            errors += stats["errors"]
            log.info(f"[fp={fp}] {stats['candidates']} candidate(s) since {since}: {stats['parsed']} order update(s), "
                     f"{stats['ignored']} ignored, {stats['excluded']} excluded sender, {stats['own']} own mail, "
                     f"{stats['skipped_known']} already read, {stats['errors']} error(s)")
            if stats["dropped_by_cap"]:
                notes.append(f"account {fp}: {stats['dropped_by_cap']} older email(s) not read (cap {MAX_MESSAGES}); "
                             f"raise MAX_MESSAGES to read them")
        except Exception as e:
            log.error(f"[fp={fp}] account failed: {type(e).__name__}")
            failures.append(f"account {fp}: {type(e).__name__}: {str(e)[:120]}")
    if len(failures) == len(accounts):
        return "failed", 0, "; ".join(failures)
    parsed = sum(1 for r in new_rows if r["parse_status"] == "parsed")
    orders = 0
    if dry_run:
        orders = len(build_orders([r for r in new_rows if r["parse_status"] == "parsed"]))
        log.info(f"dry run: {parsed} order update(s) -> {orders} order(s)")
    else:
        store_events(supa, new_rows)
        orders = recompute_orders(supa, synced_at)
        log.info(f"stored {len(new_rows)} email(s) ({parsed} order updates); {orders} order(s) after recompute")
    if errors:
        notes.append(f"{errors} email(s) failed to parse (pds.online_order_events parse_status='error')")
    configured = {a.strip().lower() for a, _ in accounts}
    missing = [a for a in REQUIRED_ACCOUNTS if a not in configured]
    if missing:
        notes.append(f"{len(missing)} Gmail account(s) not configured (add IMAP_EMAIL_n/IMAP_APP_PASSWORD_n secrets)")
    status = "partial" if failures or notes else "success"
    return status, orders, ("; ".join(failures + notes) or None)


def run_file(path: str) -> None:
    with open(path, "rb") as f:
        msg = email.message_from_bytes(f.read())
    ev = parse_message(msg, body_lines(msg), html_hrefs(msg))
    for k, v in ev.items():
        print(f"{k:16s} {v}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=None, help=f"look-back window (default {DEFAULT_DAYS}; {BACKFILL_DAYS} when empty)")
    ap.add_argument("--reprocess", action="store_true", help="re-parse emails already stored")
    ap.add_argument("--dry-run", action="store_true", help="read Gmail and print counts; no database access")
    ap.add_argument("--file", help="parse one saved .eml file and print the result")
    args = ap.parse_args()
    if args.file:
        run_file(args.file)
        return 0
    started = time.time()
    accounts = imap_accounts()
    if args.dry_run:
        status, total, error = run(None, accounts, args.days or DEFAULT_DAYS, dry_run=True)
        log.info(f"dry run: {status}, {total} order(s); {error or 'no notes'}")
        return 0
    import os
    from supabase import create_client
    from sync_log_helper import log_sync
    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    try:
        status, total, error = run(supa, accounts, args.days, reprocess=args.reprocess)
    except Exception as e:
        missing_table = "online_order" in str(e) and ("does not exist" in str(e) or "PGRST205" in str(e))
        status, total = "failed", 0
        error = ("tables missing: apply sql/online_orders_schema.sql" if missing_table
                 else f"{type(e).__name__}: {str(e)[:300]}")
        log.error(f"run failed: {error}")
    log.info(f"Done: {status}, {total} order(s)")
    window = args.days or DEFAULT_DAYS
    log_sync(supa, SOURCE, DATA_TYPE, status, records=total, started_at=started, error=error,
             date_range_start=et_today() - timedelta(days=window), date_range_end=et_today())
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
