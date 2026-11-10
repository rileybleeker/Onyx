"""
Delivery Email ETL — Uber Eats receipt emails → pds.delivery_orders
====================================================================
Uber has no API for a customer's own order history (and the claude.ai Uber
Eats connector only searches restaurants), so the receipt email is the only
automatic record of a delivery order. This module reads every configured
Gmail account over IMAP (read-only, All Mail — same plumbing as
flights_email_etl.py) and parses the receipts from noreply@uber.com:

    subject   "[Personal] Your Monday evening order with Uber Eats"

Two templates exist (verified on the whole Oct 2022 → Nov 2026 mailbox):

    Nov 2025 →   merchant, total, ORDER time, pickup time + merchant address,
                 DELIVERY time ("Order completed <date> at <time>"); variants:
                 canceled, refund notice, tip-only receipt.
    → Nov 2025   merchant, total, order DATE only, card-charge time. The charge
                 posts 70 min after delivery in ~81% of orders (the tip window)
                 and the next morning in most of the rest — so the delivery
                 time is estimated as charge − 70 min ONLY when that agrees
                 with the weekday + daypart in the subject ("Friday evening
                 order"); otherwise the row keeps just its date + daypart.

Neither template lists the ITEMS (they sit behind the "full receipt" link),
so this feeds meal TIMING and delivery COUNTS — not calories.

One row per order in pds.delivery_orders, natural key (provider, order_key).
One order can produce several emails; latest email wins, a tip-only receipt
never overwrites the order total, a full refund marks the order 'refunded'.
The printed times are naive local wall clock — the table trigger resolves
them to instants and the ADR-0001 date quad. The delivery address (home) is
never stored.

Usage:
    python delivery_email_etl.py                # last 30 days
    python delivery_email_etl.py --days 1500    # history backfill
    python delivery_email_etl.py --reprocess    # re-parse emails already in delivery_email_log
    python delivery_email_etl.py --dry-run      # parse + print, no DB access at all
    python delivery_email_etl.py --file x.html  # parse one saved email body (parser QA)

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the IMAP_EMAIL* /
     IMAP_APP_PASSWORD* pairs shared with flights_email_etl.py.
"""

from __future__ import annotations

import argparse
import email
import imaplib
import json
import logging
import os
import re
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

# Shared IMAP / HTML plumbing — one implementation for both email ETLs.
from flights_email_etl import (
    IMAP_HOST, _fetch_chunks, _imap_date, account_fingerprint, body_lines, decode_hdr,
    html_to_lines, imap_accounts, plain_to_lines, select_all_mail,
)

log = logging.getLogger("delivery_email_etl")

# Uber receipts go to this mailbox; if it isn't configured the heartbeat says so.
REQUIRED_ACCOUNTS = ("rileybleeklm@gmail.com",)
SENDER_DOMAIN = "uber.com"
SUBJECT_RE = re.compile(r"\border with Uber Eats\b", re.I)
SUBJECT_WHEN_RE = re.compile(r"Your (\w+day) (morning|afternoon|evening|night) order", re.I)
PROFILE_RE = re.compile(r"^\s*\[([^\]]+)\]")
DEFAULT_DAYS = 30
PROVIDER = "uber_eats"
# Old-template time estimate: the card charge posts when the tip window closes.
CHARGE_AFTER_DELIVERY = timedelta(minutes=70)
TYPICAL_ORDER_TO_DELIVERY = timedelta(minutes=30)  # median over the printed-time era

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_DATE = r"([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})"
_TIME = r"(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?"
DATE_RE = re.compile(_DATE)
ORDERED_RE = re.compile(_DATE + r"\s*,?\s*(?:at\s+)?" + _TIME)
COMPLETED_RE = re.compile(r"Order completed\s+" + _DATE + r"\s*,?\s*(?:at\s+)?" + _TIME)
MERCHANT_RE = re.compile(
    r"(?:receipt for (?:your canceled order from )?|recent order from )(.+?)\.?\s+Total\s+(?=[A-Z]{0,3}[$€£])", re.I)
MONEY = r"(-?)([A-Z]{0,3}[$€£])\s?([\d,]+\.\d{2})"
TOTAL_RE = re.compile(r"(?<!Previous )(?<!New )\bTotal\s+" + MONEY)
NEW_TOTAL_RE = re.compile(r"\bNew Total\s+" + MONEY)
CHARGE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2})\s+" + _TIME)
PICKUP_RE = re.compile(_TIME + r"\s*-\s*Pickup\s+(.+?)\s+\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?\s*-\s*Delivery")
CURRENCY = {"$": "USD", "US$": "USD", "CA$": "CAD", "MX$": "MXN", "A$": "AUD", "€": "EUR", "£": "GBP"}

# merchant_kind is a name-keyword guess: only 'restaurant' orders count as a
# meal in pds.delivery_daily. Extend when a new non-restaurant merchant shows up.
ALCOHOL_WORDS = ("package store", "liquor", "wine & spirits", "wine and spirits", "total wine", "bottle shop",
                 "beverage", "spirits", "beer & wine", "beer and wine", "abc fine wine", "bevmo")
STORE_WORDS = ("quick save", "mini market", "mini mart", "minimart", "supermarket", "cvs", "walgreens", "pharmacy", "food mart",
               "7-eleven", "7 eleven", "convenience", "grocery", "kroger", "publix", "whole foods", "target",
               "costco", "walmart", "safeway", "sprouts", "trader joe", "petco", "petsmart", "dollar general",
               "family dollar", "gopuff", "circle k", "quiktrip", "racetrac", "food lion", "aldi",
               "shoppers drug mart", "sobeys")


def merchant_kind(name: str) -> str:
    n = name.lower()
    if any(w in n for w in ALCOHOL_WORDS):
        return "alcohol"
    if any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", n) for w in STORE_WORDS):
        return "store"
    return "restaurant"


def _clock(h: str, m: str, ap: str) -> tuple[int, int]:
    return int(h) % 12 + (12 if ap.lower() == "p" else 0), int(m)


def _dt(mon: str, day: str, year: str, h: str, m: str, ap: str) -> datetime:
    hour, minute = _clock(h, m, ap)
    return datetime(int(year), MONTHS[mon.lower()], int(day), hour, minute)


def daypart_of(hour: int) -> str:
    return "morning" if hour < 12 else "afternoon" if hour < 17 else "evening"


def normalize(lines: list[str]) -> str:
    text = " ".join(lines).replace("|", " ").replace("’", "'").replace("‘", "'")
    text = re.sub(r"[​-‏͏⁠﻿­]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_receipt(lines: list[str]) -> dict:
    """Parse one receipt body (either template). Fields are None when absent; the
    caller treats a missing merchant or order date as 'unmatched'."""
    text = normalize(lines)
    out: dict = {"merchant": None, "order_date": None, "ordered_local": None, "delivered_local": None,
                 "pickup_local": None, "charge_local": None, "merchant_address": None, "total": None,
                 "currency": None, "fulfillment": None, "canceled": False, "tip_only": False,
                 "refund": False, "text_head": text[:300]}

    m = MERCHANT_RE.search(text)
    if m:
        out["merchant"] = re.sub(r"(\.?\s*Rate order)+$", "", m.group(1)).strip(" .")
    m = ORDERED_RE.search(text[:200])           # new template opens with "Nov 7, 2026 9:57 PM"
    if m:
        out["ordered_local"] = _dt(*m.groups())
        out["order_date"] = out["ordered_local"].date()
    else:                                       # old template: "Total $39.93 November 5, 2022 Thanks for …"
        m = DATE_RE.search(text[:200])
        if m and m.group(1).lower() in MONTHS:
            out["order_date"] = date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)))

    out["canceled"] = bool(re.search(r"order has been cancell?ed|your cancell?ed order", text, re.I))
    out["tip_only"] = bool(re.search(r"tip has been processed", text, re.I))
    out["refund"] = bool(re.search(r"We adjusted the total|refund has been applied", text, re.I))
    m = (NEW_TOTAL_RE.search(text) if out["refund"] else None) or TOTAL_RE.search(text)
    if m:
        out["total"] = float(m.group(3).replace(",", "")) * (-1 if m.group(1) else 1)
        out["currency"] = CURRENCY.get(m.group(2), m.group(2))
    if re.search(r"\bUber Delivery\b|\bDelivered (?:to|by)\b", text):
        out["fulfillment"] = "delivery"
    elif re.search(r"\bPicked up\b|\bPickup order\b", text, re.I):
        out["fulfillment"] = "pickup"

    m = CHARGE_RE.search(text)
    if m:
        mo, dy, yy, h, mi, ap = m.groups()
        hour, minute = _clock(h, mi, ap)
        out["charge_local"] = datetime(2000 + int(yy), int(mo), int(dy), hour, minute)

    ordered = out["ordered_local"]
    m = COMPLETED_RE.search(text)
    if m and not out["canceled"]:
        out["delivered_local"] = _dt(*m.groups())
    m = PICKUP_RE.search(text)
    if m and ordered:
        h, mi = _clock(m.group(1), m.group(2), m.group(3))
        p = ordered.replace(hour=h, minute=mi)
        out["pickup_local"] = p + timedelta(days=1) if p < ordered - timedelta(minutes=5) else p
        out["merchant_address"] = m.group(4).strip()[:300]
    return out


def build_row(parsed: dict, meta: dict) -> dict:
    iso = lambda d: d.isoformat(sep=" ") if d else None  # noqa: E731
    subject = meta.get("subject") or ""
    prof = PROFILE_RE.match(subject)
    when = SUBJECT_WHEN_RE.search(subject)
    daypart = when.group(2).lower() if when else None
    ordered, delivered, charge = parsed["ordered_local"], parsed["delivered_local"], parsed["charge_local"]

    if ordered:
        time_source = "receipt"
        daypart = daypart or daypart_of(ordered.hour)
        key = f"{parsed['merchant']}|{ordered:%Y-%m-%dT%H:%M}"
    else:
        # Old template: estimate delivery from the charge time, but only trust it
        # when the implied order time lands on the subject's weekday + daypart.
        time_source = "date_only"
        if charge and when and not parsed["canceled"]:
            est_delivered = charge - CHARGE_AFTER_DELIVERY
            est_ordered = est_delivered - TYPICAL_ORDER_TO_DELIVERY
            if WEEKDAYS[est_ordered.weekday()] == when.group(1).lower() and daypart_of(est_ordered.hour) == daypart:
                delivered, time_source = est_delivered, "payment_estimate"
        key = (f"{parsed['merchant']}|pay:{charge:%Y-%m-%dT%H:%M}" if charge
               else f"{parsed['merchant']}|date:{parsed['order_date']}|{parsed['total']}")

    full_refund = parsed["refund"] and parsed["total"] is not None and parsed["total"] <= 0
    status = "canceled" if parsed["canceled"] else "refunded" if full_refund else "delivered"
    return {
        "provider": PROVIDER,
        "order_key": key,
        "merchant_name": parsed["merchant"],
        "merchant_kind": merchant_kind(parsed["merchant"]),
        "merchant_address": parsed["merchant_address"],
        "profile": prof.group(1) if prof else None,
        "order_date_local": parsed["order_date"].isoformat(),
        "daypart": daypart,
        "ordered_local": iso(ordered),
        "delivered_local": None if status == "canceled" else iso(delivered),
        "time_source": time_source,
        "total": None if parsed["tip_only"] else parsed["total"],
        "currency": parsed["currency"],
        "fulfillment": parsed["fulfillment"],
        "status": status,
        "source_message_id": meta["message_id"],
        "source_email_date": meta["email_date"].isoformat(),
        "source_account": meta["account"],
        "raw_json": {
            "subject": subject,
            "pickup_local": iso(parsed["pickup_local"]),
            "charge_local": iso(charge),
            "printed_total": parsed["total"],
            "tip_only": parsed["tip_only"],
            "refund": parsed["refund"],
        },
    }


class Store:
    def __init__(self, supa, dry_run: bool = False) -> None:
        self.supa = supa
        self.dry_run = dry_run
        self.written = 0
        self._dry: dict[str, dict] = {}   # dry-run stand-in for the table, so the dedupe rules still run

    def pds(self, table: str):
        return self.supa.schema("pds").from_(table)

    def processed_ids(self, account: str) -> set[str]:
        if self.supa is None:
            return set()
        ids: set[str] = set()
        offset = 0
        while True:
            res = self.pds("delivery_email_log").select("message_id").eq("account", account).range(offset, offset + 999).execute()
            rows = res.data or []
            ids.update(r["message_id"] for r in rows)
            if len(rows) < 1000:
                break
            offset += 1000
        return ids

    def _existing(self, row: dict) -> Optional[dict]:
        if self.dry_run:
            return self._dry.get(row["order_key"])
        res = (self.pds("delivery_orders").select("order_id,total,status,source_email_date")
               .eq("provider", row["provider"]).eq("order_key", row["order_key"]).execute())
        return (res.data or [None])[0]

    def apply(self, row: dict, tip_only: bool) -> str:
        """Upsert one order. Returns 'written' or the reason it was left alone."""
        old = self._existing(row)
        if old:
            if tip_only:
                return "tip-only receipt for an order already stored"
            old_date = datetime.fromisoformat(old["source_email_date"].replace("Z", "+00:00"))
            new_date = datetime.fromisoformat(row["source_email_date"])
            if old_date > new_date and old["total"] is not None:
                return "newer email already applied"
        if self.dry_run:
            self._dry[row["order_key"]] = row
        else:
            self.pds("delivery_orders").upsert(row, on_conflict="provider,order_key").execute()
        self.written += 1
        return "written"

    def log_email(self, meta: dict, kind: str, merchant: str | None, status: str, error: str | None = None) -> None:
        if self.dry_run or self.supa is None:
            return
        self.pds("delivery_email_log").upsert({
            "message_id": meta["message_id"],
            "account": meta["account"],
            "received_at": meta["email_date"].isoformat(),
            "subject": meta["subject"][:300],
            "kind": kind,
            "merchant_name": merchant,
            "status": status,
            "error": (error or None) and str(error)[:500],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="message_id").execute()


def search_uids(imap: imaplib.IMAP4_SSL, since: date) -> tuple[list[bytes], str]:
    try:
        status, data = imap.uid("SEARCH", None, "X-GM-RAW",
                                f'"from:{SENDER_DOMAIN} subject:(order with Uber Eats) after:{since:%Y/%m/%d}"')
        if status == "OK":
            return (data[0].split() if data and data[0] else []), "X-GM-RAW"
    except imaplib.IMAP4.error as e:
        log.info(f"X-GM-RAW search unavailable ({e}); using IMAP FROM")
    status, data = imap.uid("SEARCH", None, f'(FROM "{SENDER_DOMAIN}" SUBJECT "Uber Eats" SINCE {_imap_date(since)})')
    return (data[0].split() if status == "OK" and data and data[0] else []), "FROM"


def process_account(account: str, password: str, store: Store, since: date, reprocess: bool) -> dict:
    stats = {"account": account, "candidates": 0, "receipts": 0, "written": 0, "unmatched": 0, "errors": 0,
             "skipped_done": 0, "kinds": Counter(), "unmatched_subjects": []}
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        imap.login(account, password)
        box = select_all_mail(imap)
        uids, how = search_uids(imap, since)
        stats["candidates"] = len(uids)
        log.info(f"[{account}] fp={account_fingerprint(account)} {len(uids)} candidate email(s) since {since} in {box} via {how}")
        if not uids:
            return stats
        done = set() if reprocess else store.processed_ids(account)
        wanted: list[tuple[bytes, dict]] = []
        for uid, hdr in _fetch_chunks(imap, uids, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)])", chunk=100):
            h = email.message_from_bytes(hdr)
            subject = decode_hdr(h.get("Subject"))
            if not SUBJECT_RE.search(subject) or subject.lower().lstrip().startswith(("fwd:", "fw:", "re:")):
                continue
            stats["receipts"] += 1
            mid = (h.get("Message-ID") or "").strip() or f"<{account}:{uid.decode()}>"
            if mid in done:
                stats["skipped_done"] += 1
                continue
            try:
                edate = parsedate_to_datetime(h.get("Date"))
                if edate.tzinfo is None:
                    edate = edate.replace(tzinfo=timezone.utc)
            except Exception:
                edate = datetime.now(timezone.utc)
            wanted.append((uid, {"message_id": mid, "subject": subject, "email_date": edate, "account": account}))
        wanted.sort(key=lambda w: w[1]["email_date"])  # chronological, so "latest email wins" is cheap
        log.info(f"[{account}] {stats['receipts']} receipt(s), {stats['skipped_done']} already processed, {len(wanted)} to parse")
        bodies: dict[bytes, bytes] = {}
        for uid, raw in _fetch_chunks(imap, [u for u, _ in wanted], "(BODY.PEEK[])", chunk=10):
            bodies[uid] = raw
        for uid, meta in wanted:
            raw = bodies.get(uid)
            if raw is None:
                stats["errors"] += 1
                store.log_email(meta, "receipt", None, "error", "body fetch failed")
                continue
            try:
                parsed = parse_receipt(body_lines(email.message_from_bytes(raw)))
                kind = ("canceled" if parsed["canceled"] else "refund" if parsed["refund"]
                        else "tip_only" if parsed["tip_only"] else "receipt")
                if not parsed["merchant"] or not parsed["order_date"]:
                    stats["unmatched"] += 1
                    if len(stats["unmatched_subjects"]) < 8:
                        stats["unmatched_subjects"].append(
                            f"{meta['email_date']:%Y-%m-%d} {meta['subject'][:60]} :: {parsed['text_head']}")
                    store.log_email(meta, kind, parsed["merchant"], "unmatched",
                                    f"merchant={'ok' if parsed['merchant'] else 'missing'} "
                                    f"order_date={'ok' if parsed['order_date'] else 'missing'}")
                    continue
                row = build_row(parsed, meta)
                outcome = store.apply(row, parsed["tip_only"])
                stats["kinds"][f"{kind}/{row['time_source']}"] += 1
                if outcome == "written":
                    stats["written"] += 1
                store.log_email(meta, kind, parsed["merchant"], "parsed", None if outcome == "written" else outcome)
            except Exception as e:  # one bad email must not sink the run
                stats["errors"] += 1
                log.exception(f"  parse failed for {meta['subject']!r}")
                store.log_email(meta, "receipt", None, "error", repr(e))
        return stats
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def run_file(path: str) -> None:
    text = open(path, encoding="utf-8", errors="replace").read()
    lines = html_to_lines(text) if "<" in text[:2000] else plain_to_lines(text)
    parsed = parse_receipt(lines)
    print(json.dumps(parsed, indent=2, default=str))
    if parsed["merchant"] and parsed["order_date"]:
        meta = {"message_id": "<file>", "email_date": datetime.now(timezone.utc), "account": "file",
                "subject": os.path.basename(path)}
        print(json.dumps(build_row(parsed, meta), indent=2, default=str))


def print_dry_summary(store: Store) -> None:
    rows = sorted(store._dry.values(), key=lambda r: (r["order_date_local"], r["ordered_local"] or r["delivered_local"] or ""))
    by_year: dict[str, Counter] = {}
    for r in rows:
        c = by_year.setdefault(r["order_date_local"][:4], Counter())
        c[f"{r['status']}/{r['merchant_kind']}"] += 1
        c[f"time:{r['time_source']}"] += 1
    for y in sorted(by_year):
        log.info(f"  {y}: {dict(sorted(by_year[y].items()))}")
    for r in rows[-12:]:
        log.info(f"    {r['status']:9} {r['merchant_kind']:10} {r['time_source']:16} {r['order_date_local']} "
                 f"ordered={r['ordered_local']} delivered={r['delivered_local']} {r['currency'] or ''} {r['total']}  {r['merchant_name']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS, help=f"look-back window (default {DEFAULT_DAYS})")
    ap.add_argument("--reprocess", action="store_true", help="re-parse emails already in delivery_email_log")
    ap.add_argument("--dry-run", action="store_true", help="parse and print; touches no database")
    ap.add_argument("--file", help="parse one saved email body and exit")
    args = ap.parse_args()

    if args.file:
        run_file(args.file)
        return 0

    supa = None
    if not args.dry_run:
        from supabase import create_client
        supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    store = Store(supa, dry_run=args.dry_run)
    started = time.time()
    since = date.today() - timedelta(days=args.days)
    accounts = imap_accounts()
    per_account: list[dict] = []
    failures: list[str] = []
    for acct, pw in accounts:
        try:
            per_account.append(process_account(acct, pw, store, since, args.reprocess))
        except Exception as e:
            log.exception(f"[{acct}] account failed")
            failures.append(f"{account_fingerprint(acct)}: {e!r}"[:200])

    written = sum(s["written"] for s in per_account)
    errors = sum(s["errors"] for s in per_account)
    unmatched = sum(s["unmatched"] for s in per_account)
    kinds: Counter = Counter()
    for s in per_account:
        kinds.update(s["kinds"])
        for subj in s["unmatched_subjects"]:
            log.info(f"  unmatched: {subj}")
    log.info(f"Done: {len(per_account)}/{len(accounts)} account(s) ok, {written} order write(s) "
             f"{dict(sorted(kinds.items()))}, {unmatched} unmatched, {errors} parse error(s)")

    if args.dry_run:
        print_dry_summary(store)
        return 0
    from sync_log_helper import log_sync
    status = "success"
    notes: list[str] = []
    if not accounts:
        status, notes = "failed", ["no IMAP accounts configured"]
    elif failures and len(failures) == len(accounts):
        status, notes = "failed", failures
    else:
        if failures:
            status, notes = "partial", failures
        configured = {a.lower() for a, _ in accounts}
        missing = [a for a in REQUIRED_ACCOUNTS if a not in configured]
        if missing:
            status = "partial"
            notes.append(f"Gmail account not configured: {', '.join(missing)}")
        if errors or unmatched:
            status = "partial"
            notes.append(f"{errors} error(s), {unmatched} unmatched receipt(s) — see pds.delivery_email_log")
    log_sync(supa, "delivery", "email", status, records=written, started_at=started,
             error="; ".join(notes) or None, date_range_start=since, date_range_end=date.today())
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # heartbeat on crash, per the Onyx ETL convention
        log.exception("fatal")
        try:
            from supabase import create_client
            from sync_log_helper import log_sync
            supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
            log_sync(supa, "delivery", "email", "failed", records=0, error=repr(e)[:500])
        except Exception:
            pass
        sys.exit(1)
