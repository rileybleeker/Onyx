"""
Flights Email ETL — Delta confirmation emails → pds.flights
============================================================
Delta has no public API for a traveler's own bookings (the developer portal
is partner-only) and TripIt closed its public API to new integrations in
Feb 2026, so the only machine-readable record of Riley's flight schedule is
the operational email Delta sends. Those emails carry NO schema.org
FlightReservation markup — this module parses their HTML/text instead.

Reads EVERY configured Gmail account over IMAP (read-only: BODY.PEEK, the
"[Gmail]/All Mail" folder so archived mail counts) and handles:

    kind              subject (DeltaAirLines@t.delta.com / @g.delta.com)
    receipt           "Your Flight Receipt - NAME DDMONYY"
    award_receipt     "Congrats On Your SkyMiles Award Trip"
    trip_details      "Your XXX > YYY Trip Details"            (~3 days before each direction)
    checkin           "It's Time To Check In For Your Flight"  (the day before)
    schedule_change   "Important Update: Flight Schedule Change"
    cancellation      "...Cancellation Confirmation" / "...Refund Confirmation..."

One row per flight SEGMENT in pds.flights, natural key
(confirmation_number, flight_number, dep_local_date). Every email kind
carries those three fields, so receipt → trip_details → checkin all land on
the same row; a row is only overwritten by an email at least as new as the
one that wrote it ("latest email wins"). Receipts name cities, not airports:
IATA codes come from the receipt's baggage block (one "Sun 01 Nov 2026
ATL-YYZ" row per direction), a small city map, or the later trip_details
email. IATA → IANA timezone via the `airportsdata` package.

Downstream: the /check-in "Traveled on a plane?" pre-fill, the
user_tz_log flight-auto path (landed segment whose arrival-airport TZ has a
different UTC offset than the log resolves → new user_tz_log row), and the
/status "Flights" card (flights|email heartbeat every run).

Usage:
    python flights_email_etl.py                 # last 60 days, both accounts
    python flights_email_etl.py --days 730      # history backfill
    python flights_email_etl.py --reprocess     # re-parse emails already in flight_email_log
    python flights_email_etl.py --dry-run       # parse + print, no DB writes
    python flights_email_etl.py --file x.html   # parse one saved email body (parser dev/QA)

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAP_HOST (default imap.gmail.com),
     IMAP_EMAIL + IMAP_APP_PASSWORD (account 1), IMAP_EMAIL_2 + IMAP_APP_PASSWORD_2
     (account 2) … up to _5. Each needs a Gmail App Password (IMAP enabled).
"""

from __future__ import annotations

import argparse
import email
import email.message
import imaplib
import json
import logging
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.header import decode_header
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Any, Optional
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("flights_email_etl")

IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
EXPECTED_ACCOUNTS = 2          # rileybleeklm@ + rileybleeker@ — fewer configured = partial heartbeat
SENDER_DOMAIN = "delta.com"
DEFAULT_DAYS = 60

MONTHS = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], start=1)}
MONTHS_FULL = {m: i for i, m in enumerate(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"], start=1)}
DOW = r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)"
DOW_FULL = r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
MONTH_ABBR = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
MONTH_FULL = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"

CARRIER_CODES = {
    "DELTA": "DL", "DELTA CONNECTION": "DL", "KLM": "KL", "AIR FRANCE": "AF", "VIRGIN ATLANTIC": "VS",
    "AEROMEXICO": "AM", "LATAM": "LA", "KOREAN AIR": "KE", "WESTJET": "WS", "AIR CANADA": "AC",
    "UNITED": "UA", "AMERICAN": "AA",
}
# Receipt itinerary cells name CITIES. The baggage block supplies the IATA
# route per direction; this map is the fallback for the cities Riley actually
# flies through when the two can't be paired (connections). Extend as needed.
CITY_TO_IATA = {
    "ATLANTA": "ATL", "TORONTO": "YYZ", "TORONTO, CA": "YYZ", "MADRID": "MAD", "MADRID, ES": "MAD",
    "NEW YORK-JFK": "JFK", "NEW YORK-KENNEDY": "JFK", "NEW YORK-LAGUARDIA": "LGA", "NEW YORK-LGA": "LGA",
    "NEWARK": "EWR", "BOSTON": "BOS", "CHICAGO-O'HARE": "ORD", "LOS ANGELES": "LAX", "SAN FRANCISCO": "SFO",
    "SEATTLE": "SEA", "MINNEAPOLIS/ST PAUL": "MSP", "DETROIT": "DTW", "SALT LAKE CITY": "SLC",
    "WASHINGTON-REAGAN": "DCA", "WASHINGTON-DULLES": "IAD", "MIAMI": "MIA", "ORLANDO": "MCO",
    "DENVER": "DEN", "LONDON-HEATHROW": "LHR", "PARIS-DE GAULLE": "CDG", "AMSTERDAM": "AMS",
}

_AIRPORTS: dict[str, dict] | None = None


def airports() -> dict[str, dict]:
    global _AIRPORTS
    if _AIRPORTS is None:
        try:
            import airportsdata  # type: ignore
            _AIRPORTS = airportsdata.load("IATA")
        except Exception as e:  # pragma: no cover — missing dep is a config error, not a parse error
            log.warning(f"airportsdata unavailable ({e}); timezones will be NULL")
            _AIRPORTS = {}
    return _AIRPORTS


def tz_for_iata(iata: str | None) -> str | None:
    if not iata:
        return None
    rec = airports().get(iata.upper())
    return rec.get("tz") if rec else None


# ---------------------------------------------------------------------------
# HTML → text (one line per table cell / <br> / block element)
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "td", "th", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
             "section", "article", "ul", "ol", "header", "footer", "center", "blockquote"}
    SKIP = {"script", "style", "head", "title"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def html_to_lines(html: str) -> list[str]:
    p = _TextExtractor()
    p.feed(html)
    p.close()
    text = "".join(p.parts).replace("\xa0", " ").replace("‌", "")
    lines = []
    for raw in text.split("\n"):
        line = re.sub(r"\s+", " ", raw).strip()
        if line:
            lines.append(line)
    return lines


def plain_to_lines(text: str) -> list[str]:
    text = re.sub(r"https?://\S+", "", text)
    text = text.replace("\xa0", " ").replace("&nbsp;", " ").replace("&#36;", "$")
    return [re.sub(r"\s+", " ", l).strip() for l in text.split("\n") if l.strip()]


# ---------------------------------------------------------------------------
# Small parsing helpers
# ---------------------------------------------------------------------------

TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$")


def parse_clock(s: str) -> Optional[tuple[int, int]]:
    m = TIME_RE.match(s.strip())
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3).upper()
    if h == 12:
        h = 0
    if ap == "P":
        h += 12
    return h, mi


def resolve_year(month: int, day: int, anchor: date, lo_days: int = -45, hi_days: int = 400) -> date:
    """Pick the year that places (month, day) within [anchor+lo, anchor+hi]."""
    for y in (anchor.year - 1, anchor.year, anchor.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if lo_days <= (d - anchor).days <= hi_days:
            return d
    return date(anchor.year, month, day)


def find_confirmation(text: str) -> Optional[str]:
    m = re.search(r"Confirmation\s*(?:Number|#)\s*[:#]?\s*([A-Z0-9]{6})\b", text, flags=re.I)
    if m and not m.group(1).isdigit():
        return m.group(1).upper()
    return None


def find_tickets(text: str) -> list[str]:
    return sorted(set(re.findall(r"\b(006\d{10})\b", text)))


def carrier_code(name: str) -> str:
    n = name.strip().upper()
    if len(n) == 2 and n.isalpha():
        return n
    return CARRIER_CODES.get(n, n[:2])


def city_to_iata(city: str | None) -> Optional[str]:
    if not city:
        return None
    c = re.sub(r"\s+", " ", city).strip().upper().rstrip(",")
    if c in CITY_TO_IATA:
        return CITY_TO_IATA[c]
    base = c.split(",")[0].strip()
    return CITY_TO_IATA.get(base)


# ---------------------------------------------------------------------------
# Parsers — each returns {"confirmation", "tickets", "passenger", "segments": [...]}
# A segment dict: flight_number, carrier_code, dep_local_date (date), dep_clock (h,m),
# arr_clock (h,m), arr_local_date (date|None), dep_city, arr_city, dep_iata, arr_iata,
# cabin, seat, operated_by
# ---------------------------------------------------------------------------

def _empty(kind: str) -> dict:
    return {"kind": kind, "confirmation": None, "tickets": [], "passenger": None, "segments": [], "issue_date": None}


def parse_receipt(lines: list[str], email_date: datetime, kind: str = "receipt") -> dict:
    text = "\n".join(lines)
    out = _empty(kind)
    out["confirmation"] = find_confirmation(text)
    out["tickets"] = find_tickets(text)
    m = re.search(r"Name:\s*([A-Z][A-Z' -]+?)(?:\n|$)", text)
    out["passenger"] = m.group(1).strip() if m else None
    m = re.search(r"Issue Date:\s*(\d{2})([A-Z]{3})(\d{2})", text)
    issue: Optional[date] = None
    if m and m.group(2) in MONTHS:
        issue = date(2000 + int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)))
    out["issue_date"] = issue
    anchor = issue or email_date.date()

    # Baggage block: "Sun 01 Nov 2026" + "ATL-YYZ" (same line in plain text, separate <td>s in HTML)
    bag: list[tuple[date, str, str]] = []
    bag_re = re.compile(rf"^{DOW}\s+(\d{{1,2}})\s+({MONTH_ABBR})\s+(\d{{4}})\s*(?:([A-Z]{{3}})-([A-Z]{{3}}))?$")
    for i, line in enumerate(lines):
        m = bag_re.match(line)
        if not m:
            continue
        d = date(int(m.group(3)), MONTHS[m.group(2).upper()], int(m.group(1)))
        dep_i, arr_i = m.group(4), m.group(5)
        if not dep_i and i + 1 < len(lines):
            m2 = re.match(r"^([A-Z]{3})-([A-Z]{3})$", lines[i + 1])
            if m2:
                dep_i, arr_i = m2.group(1), m2.group(2)
        if dep_i:
            bag.append((d, dep_i, arr_i))

    # Itinerary blocks: "Sun, 01NOV" header (optionally glued to "DEPART ARRIVE" in plain text)
    hdr_re = re.compile(rf"^{DOW},\s*(\d{{1,2}})([A-Z]{{3}})(?:\s*DEPART\s*ARRIVE)?$")
    flight_re = re.compile(r"^([A-Z][A-Z ]{1,24}?)\s+(\d{1,4})$")
    arr_marker_re = re.compile(rf"^\*+\s*{DOW}\s+(\d{{1,2}})([A-Z]{{3}})")
    hdr_idx = [i for i, l in enumerate(lines) if hdr_re.match(l)]
    segments: list[dict] = []
    for n, i in enumerate(hdr_idx):
        end = hdr_idx[n + 1] if n + 1 < len(hdr_idx) else min(len(lines), i + 16)
        hm = hdr_re.match(lines[i])
        dd, mon = int(hm.group(1)), hm.group(2)
        if mon not in MONTHS:
            continue
        block = lines[i + 1:end]
        seg: dict[str, Any] = {"flight_number": None, "carrier_code": None, "cabin": None, "seat": None,
                               "operated_by": None, "dep_city": None, "arr_city": None, "dep_iata": None,
                               "arr_iata": None, "arr_local_date": None}
        times: list[tuple[int, int]] = []
        cities: list[str] = []
        for j, l in enumerate(block):
            if l in ("DEPART", "ARRIVE"):
                continue
            fm = flight_re.match(l)
            if fm and seg["flight_number"] is None and fm.group(1).upper() not in ("CARRY ON", "FIRST", "SECOND"):
                code = carrier_code(fm.group(1))
                seg["flight_number"] = f"{code}{int(fm.group(2))}"
                seg["carrier_code"] = code
                if j + 1 < len(block) and not parse_clock(block[j + 1]) and not flight_re.match(block[j + 1]):
                    cand = block[j + 1]
                    if re.search(r"Delta|Main|Comfort|First|Premium|Basic|One|\(", cand):
                        seg["cabin"] = cand
                continue
            clk = parse_clock(l)
            if clk and len(times) < 2:
                times.append(clk)
                if j > 0 and block[j - 1] != seg.get("cabin") and not parse_clock(block[j - 1]):
                    cities.append(block[j - 1])
                else:
                    cities.append("")
                continue
            am = arr_marker_re.match(l)
            if am and am.group(2) in MONTHS:
                seg["arr_local_date"] = resolve_year(MONTHS[am.group(2)], int(am.group(1)), anchor)
            if len(times) == 2 and (am or j > 8):
                break
        if seg["flight_number"] is None or len(times) < 2:
            continue
        seg["dep_clock"], seg["arr_clock"] = times[0], times[1]
        seg["dep_city"] = cities[0] or None
        seg["arr_city"] = cities[1] or None
        seg["dep_local_date"] = resolve_year(MONTHS[mon], dd, anchor, lo_days=-10)
        segments.append(seg)

    # Pair with the baggage block: same date → that direction's route. With one
    # segment per direction (direct flights) the pairing is exact; connections fall
    # back to the city map for the legs the route can't label.
    for seg in segments:
        matches = [b for b in bag if b[0] == seg["dep_local_date"]]
        same_date_segs = [s for s in segments if s["dep_local_date"] == seg["dep_local_date"]]
        if len(matches) == 1 and len(same_date_segs) == 1:
            seg["dep_iata"], seg["arr_iata"] = matches[0][1], matches[0][2]
        else:
            if len(matches) == 1 and same_date_segs and same_date_segs[0] is seg:
                seg["dep_iata"] = matches[0][1]
            if len(matches) == 1 and same_date_segs and same_date_segs[-1] is seg:
                seg["arr_iata"] = matches[0][2]
        seg["dep_iata"] = seg["dep_iata"] or city_to_iata(seg["dep_city"])
        seg["arr_iata"] = seg["arr_iata"] or city_to_iata(seg["arr_city"])
    out["segments"] = segments
    return out


def parse_trip_details(lines: list[str], email_date: datetime) -> dict:
    text = "\n".join(lines)
    out = _empty("trip_details")
    out["confirmation"] = find_confirmation(text)
    anchor = email_date.date()
    hdr = re.search(rf"({DOW_FULL}),\s*({MONTH_FULL})\s+(\d{{1,2}})", text)
    header_date = resolve_year(MONTHS_FULL[hdr.group(2).upper()], int(hdr.group(3)), anchor) if hdr else None

    seg_idx = [i for i, l in enumerate(lines) if re.match(r"^Flight \d+ of \d+$", l)]
    flight_re = re.compile(r"^([A-Z]{2})\s?(\d{1,4})$")
    date_re = re.compile(rf"^{DOW},\s*({MONTH_ABBR})\s+(\d{{1,2}})$")
    segments: list[dict] = []
    prev_arr: Optional[date] = None
    for n, i in enumerate(seg_idx):
        end = seg_idx[n + 1] if n + 1 < len(seg_idx) else len(lines)
        block = lines[i + 1:end]
        seg: dict[str, Any] = {"flight_number": None, "carrier_code": None, "cabin": None, "seat": None,
                               "operated_by": None, "dep_city": None, "arr_city": None, "dep_iata": None,
                               "arr_iata": None, "arr_local_date": None, "duration_min": None}
        times: list[tuple[int, int]] = []
        iatas: list[str] = []
        cities: list[str] = []
        for j, l in enumerate(block):
            if l.startswith("Your Onboard Experience") or l.startswith("Tips For Your Trip"):
                # seat lives in the onboard block: "Seat" … "19D"
                tail = block[j:j + 12]
                for k, t in enumerate(tail):
                    if t.lower() == "seat":
                        for s in tail[k + 1:k + 4]:
                            if re.match(r"^\d{1,2}[A-K]$", s):
                                seg["seat"] = s
                                break
                        if seg["seat"] is None:
                            pass
                    if re.search(r"Delta (?:Main|Comfort|Premium|First|One)", t) and seg["cabin"] is None:
                        seg["cabin"] = t
                break
            fm = flight_re.match(l)
            if fm and seg["flight_number"] is None:
                seg["carrier_code"] = fm.group(1)
                seg["flight_number"] = f"{fm.group(1)}{int(fm.group(2))}"
                continue
            clk = parse_clock(l)
            if clk and len(times) < 2:
                times.append(clk)
                continue
            dm = re.match(r"^(\d+)h\s*(\d+)m$", l)
            if dm:
                seg["duration_min"] = int(dm.group(1)) * 60 + int(dm.group(2))
                continue
            dtm = date_re.match(l)
            if dtm:
                seg["arr_local_date"] = resolve_year(MONTHS[dtm.group(1).upper()], int(dtm.group(2)), anchor)
                continue
            if re.match(r"^[A-Z]{3}$", l) and len(iatas) < 2:
                iatas.append(l)
                continue
            if len(iatas) == 2 and len(cities) < 2 and re.match(r"^[A-Z][A-Za-z .'-]+(,\s*[A-Za-z .'-]+)*$", l):
                cities.append(l)
        if seg["flight_number"] is None or len(times) < 2:
            continue
        seg["dep_clock"], seg["arr_clock"] = times[0], times[1]
        if len(iatas) == 2:
            seg["dep_iata"], seg["arr_iata"] = iatas
        if len(cities) == 2:
            seg["dep_city"], seg["arr_city"] = cities
        # Leg 1 departs on the header date; a connecting leg departs on the previous leg's arrival day.
        seg["dep_local_date"] = header_date if n == 0 else (prev_arr or header_date)
        if seg["dep_local_date"] is None:
            continue
        prev_arr = seg["arr_local_date"] or seg["dep_local_date"]
        segments.append(seg)
    out["segments"] = segments
    return out


def parse_checkin(lines: list[str], email_date: datetime) -> dict:
    text = "\n".join(lines)
    out = _empty("checkin")
    out["confirmation"] = find_confirmation(text)
    anchor = email_date.date()
    m = re.search(rf"Your flight on\s+{DOW_FULL},\s*({MONTH_FULL})\s+(\d{{1,2}})", text)
    dep_date = resolve_year(MONTHS_FULL[m.group(1).upper()], int(m.group(2)), anchor, lo_days=-5, hi_days=10) if m else None
    flight_re = re.compile(r"^([A-Z]{2})\s?(\d{1,4})$")
    segments: list[dict] = []
    # Checkin bodies glue "Atlanta, Georgia<br>08:52 pm" in plain text → split on a time at end of line
    split: list[str] = []
    for l in lines:
        mm = re.match(r"^(.*?)(\d{1,2}:\d{2}\s*[AaPp][Mm])$", l)
        if mm and mm.group(1).strip() and not re.match(r"^\d{1,2}:\d{2}", l):
            split.extend([mm.group(1).strip(), mm.group(2)])
        else:
            split.append(l)
    lines = split
    idx = [i for i, l in enumerate(lines) if flight_re.match(l)]
    for n, i in enumerate(idx):
        end = idx[n + 1] if n + 1 < len(idx) else min(len(lines), i + 14)
        block = lines[i + 1:end]
        fm = flight_re.match(lines[i])
        seg: dict[str, Any] = {"flight_number": f"{fm.group(1)}{int(fm.group(2))}", "carrier_code": fm.group(1),
                               "cabin": None, "seat": None, "operated_by": None, "dep_city": None, "arr_city": None,
                               "dep_iata": None, "arr_iata": None, "arr_local_date": None,
                               "dep_local_date": dep_date}
        times: list[tuple[int, int]] = []
        for j, l in enumerate(block):
            om = re.match(r"^Operated by\s+(.+)$", l, flags=re.I)
            if om:
                seg["operated_by"] = om.group(1).strip()
                continue
            clk = parse_clock(l)
            if clk and len(times) < 2:
                times.append(clk)
                city = block[j - 1] if j > 0 else ""
                if parse_clock(city) or city.lower().startswith("operated by"):
                    city = ""
                if len(times) == 1:
                    seg["dep_city"] = city or None
                else:
                    seg["arr_city"] = city or None
                continue
            if len(times) == 2 and re.match(r"^\d{1,2}[A-K]$", l):
                seg["seat"] = l
                break
        if len(times) < 2 or dep_date is None:
            continue
        seg["dep_clock"], seg["arr_clock"] = times[0], times[1]
        seg["dep_iata"] = city_to_iata(seg["dep_city"])
        seg["arr_iata"] = city_to_iata(seg["arr_city"])
        if n > 0 and segments:
            # connecting leg: assume it departs on the previous leg's day (times decide the rest)
            seg["dep_local_date"] = segments[-1]["dep_local_date"]
        segments.append(seg)
    out["segments"] = segments
    return out


def parse_minimal(lines: list[str], kind: str) -> dict:
    text = "\n".join(lines)
    out = _empty(kind)
    m = re.search(r"Confirmation\s*#\s*([A-Z0-9]{6})\b", text, flags=re.I) or None
    out["confirmation"] = (m.group(1).upper() if m else None) or find_confirmation(text)
    out["tickets"] = find_tickets(text)
    return out


def classify(subject: str) -> Optional[str]:
    s = subject.lower()
    if "flight receipt" in s:
        return "receipt"
    if "award trip" in s or "award receipt" in s:
        return "award_receipt"
    if "trip details" in s:
        return "trip_details"
    if "check in for your flight" in s or "time to check in" in s:
        return "checkin"
    if "schedule change" in s:
        return "schedule_change"
    if "cancellation confirmation" in s or "refund confirmation" in s or "cancel itinerary" in s:
        return "cancellation"
    return None


def parse_email(kind: str, lines: list[str], email_date: datetime) -> dict:
    if kind in ("receipt", "award_receipt"):
        return parse_receipt(lines, email_date, kind)
    if kind == "trip_details":
        return parse_trip_details(lines, email_date)
    if kind == "checkin":
        return parse_checkin(lines, email_date)
    return parse_minimal(lines, kind)


# ---------------------------------------------------------------------------
# Segment → pds.flights row
# ---------------------------------------------------------------------------

def _offset_str(dt: datetime) -> str:
    off = dt.utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "-" if total < 0 else "+"
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}"


def build_row(seg: dict, parsed: dict, meta: dict) -> dict:
    dep_tz = tz_for_iata(seg.get("dep_iata"))
    arr_tz = tz_for_iata(seg.get("arr_iata"))
    dep_date: date = seg["dep_local_date"]
    dh, dm = seg["dep_clock"]
    ah, am = seg["arr_clock"]
    dep_local = datetime(dep_date.year, dep_date.month, dep_date.day, dh, dm)
    arr_date: Optional[date] = seg.get("arr_local_date")
    arr_local = datetime.combine(arr_date or dep_date, datetime.min.time()).replace(hour=ah, minute=am)

    dep_time = arr_time = None
    dep_off = None
    if dep_tz and arr_tz:
        dep_time = dep_local.replace(tzinfo=ZoneInfo(dep_tz))
        arr_time = arr_local.replace(tzinfo=ZoneInfo(arr_tz))
        if arr_date is None and arr_time <= dep_time:
            arr_local = arr_local + timedelta(days=1)
            arr_time = arr_local.replace(tzinfo=ZoneInfo(arr_tz))
        dep_off = _offset_str(dep_time)
    elif arr_date is None and (ah, am) < (dh, dm) and seg.get("duration_min"):
        arr_local = arr_local + timedelta(days=1)

    duration = seg.get("duration_min")
    if duration is None and dep_time and arr_time:
        duration = int((arr_time - dep_time).total_seconds() // 60)
        if duration <= 0 or duration > 24 * 60:
            duration = None

    row = {
        "confirmation_number": parsed["confirmation"],
        "flight_number": seg["flight_number"],
        "carrier_code": seg.get("carrier_code"),
        "operated_by": seg.get("operated_by"),
        "dep_local_date": dep_date.isoformat(),
        "dep_iata": seg.get("dep_iata"),
        "arr_iata": seg.get("arr_iata"),
        "dep_city": seg.get("dep_city"),
        "arr_city": seg.get("arr_city"),
        "dep_local": dep_local.isoformat(),
        "arr_local": arr_local.isoformat(),
        "arr_local_date": arr_local.date().isoformat(),
        "dep_tz": dep_tz,
        "arr_tz": arr_tz,
        "dep_utc_offset": dep_off,
        "dep_time": dep_time.isoformat() if dep_time else None,
        "arr_time": arr_time.isoformat() if arr_time else None,
        "arr_behavioral_date": (arr_local - timedelta(hours=6)).date().isoformat(),
        "duration_min": duration,
        "cabin": seg.get("cabin"),
        "seat": seg.get("seat"),
        "passenger_name": parsed.get("passenger"),
        "ticket_number": (parsed.get("tickets") or [None])[0],
        "status": "confirmed",
        "source_email_kind": parsed["kind"],
        "source_message_id": meta["message_id"],
        "source_email_date": meta["email_date"].isoformat(),
        "source_account": meta["account"],
        "raw_json": json.loads(json.dumps({"segment": seg, "subject": meta["subject"]}, default=str)),
    }
    return row


# ---------------------------------------------------------------------------
# Supabase I/O
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, supa, dry_run: bool = False) -> None:
        self.supa = supa
        self.dry_run = dry_run
        self.upserted = 0
        self.cancelled = 0
        self.changed = 0

    def pds(self, table: str):
        return self.supa.schema("pds").from_(table)

    def processed_ids(self, account: str) -> set[str]:
        ids: set[str] = set()
        offset = 0
        while True:
            res = self.pds("flight_email_log").select("message_id").eq("account", account).range(offset, offset + 999).execute()
            rows = res.data or []
            ids.update(r["message_id"] for r in rows)
            if len(rows) < 1000:
                break
            offset += 1000
        return ids

    def existing_for(self, confirmation: str) -> dict[tuple[str, str], dict]:
        res = self.pds("flights").select("*").eq("confirmation_number", confirmation).execute()
        return {(r["flight_number"], r["dep_local_date"]): r for r in (res.data or [])}

    def apply_segments(self, parsed: dict, meta: dict) -> int:
        """Upsert the parsed segments; returns the number written. 'latest email wins'."""
        conf = parsed["confirmation"]
        if not conf or not parsed["segments"]:
            return 0
        existing = self.existing_for(conf)
        email_date = meta["email_date"]
        written = 0
        new_keys: set[tuple[str, str]] = set()
        for seg in parsed["segments"]:
            row = build_row(seg, parsed, meta)
            key = (row["flight_number"], row["dep_local_date"])
            new_keys.add(key)
            old = existing.get(key)
            if old:
                old_date = datetime.fromisoformat(old["source_email_date"].replace("Z", "+00:00"))
                if old_date > email_date:
                    log.info(f"    {conf} {key[0]} {key[1]}: skipped (newer email already applied)")
                    continue
                # keep what the new email doesn't carry
                for col in ("dep_iata", "arr_iata", "dep_city", "arr_city", "cabin", "seat", "passenger_name",
                            "ticket_number", "operated_by", "carrier_code"):
                    if row.get(col) is None and old.get(col) is not None:
                        row[col] = old[col]
                if (row["dep_iata"] != seg.get("dep_iata") or row["arr_iata"] != seg.get("arr_iata")):
                    # IATA came from the stored row → recompute instants with the fuller segment
                    seg2 = dict(seg, dep_iata=row["dep_iata"], arr_iata=row["arr_iata"])
                    row2 = build_row(seg2, parsed, meta)
                    for col in ("dep_tz", "arr_tz", "dep_utc_offset", "dep_time", "arr_time", "arr_local",
                                "arr_local_date", "arr_behavioral_date", "duration_min"):
                        row[col] = row2[col]
            elif parsed["kind"] == "checkin":
                log.info(f"    {conf} {key[0]} {key[1]}: check-in email with no matching segment (city-only, skipped)")
                continue
            if self.dry_run:
                log.info(f"    DRY {conf} {row['flight_number']} {row['dep_iata']}→{row['arr_iata']} "
                         f"{row['dep_local']} → {row['arr_local']} [{row['source_email_kind']}]")
            else:
                self.pds("flights").upsert(row, on_conflict="confirmation_number,flight_number,dep_local_date").execute()
            written += 1
        # A receipt is the full itinerary: older segments of this PNR it no longer lists were rebooked away.
        if parsed["kind"] in ("receipt", "award_receipt"):
            for key, old in existing.items():
                if key in new_keys or old["status"] in ("cancelled", "superseded"):
                    continue
                old_date = datetime.fromisoformat(old["source_email_date"].replace("Z", "+00:00"))
                if old_date < email_date:
                    log.info(f"    {conf} {key[0]} {key[1]}: superseded by newer receipt")
                    if not self.dry_run:
                        self.pds("flights").update({"status": "superseded"}).eq("flight_id", old["flight_id"]).execute()
        self.upserted += written
        return written

    def mark_schedule_change(self, parsed: dict, meta: dict) -> int:
        conf = parsed["confirmation"]
        if not conf:
            return 0
        existing = self.existing_for(conf)
        n = 0
        for old in existing.values():
            old_date = datetime.fromisoformat(old["source_email_date"].replace("Z", "+00:00"))
            if old["status"] in ("cancelled", "superseded") or old_date > meta["email_date"]:
                continue
            n += 1
            if not self.dry_run:
                self.pds("flights").update({"status": "changed", "schedule_change_seen_at": meta["email_date"].isoformat()}) \
                    .eq("flight_id", old["flight_id"]).execute()
        self.changed += n
        return n

    def mark_cancelled(self, parsed: dict, meta: dict) -> int:
        n = 0
        targets: list[dict] = []
        if parsed["tickets"]:
            res = self.pds("flights").select("flight_id,status,source_email_date").in_("ticket_number", parsed["tickets"]).execute()
            targets.extend(res.data or [])
        if parsed["confirmation"]:
            targets.extend(self.existing_for(parsed["confirmation"]).values())
        seen: set[int] = set()
        for old in targets:
            if old["flight_id"] in seen or old["status"] == "cancelled":
                continue
            seen.add(old["flight_id"])
            n += 1
            if not self.dry_run:
                self.pds("flights").update({"status": "cancelled"}).eq("flight_id", old["flight_id"]).execute()
        self.cancelled += n
        return n

    def log_email(self, meta: dict, kind: str, parsed: Optional[dict], segments: int, status: str, error: str | None = None) -> None:
        if self.dry_run:
            return
        row = {
            "message_id": meta["message_id"],
            "account": meta["account"],
            "received_at": meta["email_date"].isoformat(),
            "subject": meta["subject"][:300],
            "kind": kind,
            "confirmation_number": (parsed or {}).get("confirmation"),
            "segments_parsed": segments,
            "status": status,
            "error": (error or None) and str(error)[:500],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        self.pds("flight_email_log").upsert(row, on_conflict="message_id").execute()


# ---------------------------------------------------------------------------
# user_tz_log flight-auto path
# ---------------------------------------------------------------------------

def propose_tz_entries(store: Store, since: date) -> list[dict]:
    """Landed segments whose arrival-airport TZ has a different UTC offset than
    user_tz_log resolves at the landing instant → new user_tz_log rows.
    Manual > GPS-auto > WHOOP-auto > flight-auto: we only fill gaps."""
    now = datetime.now(timezone.utc)
    res = (store.pds("flights").select("flight_number,confirmation_number,dep_iata,arr_iata,arr_tz,arr_time,status")
           .in_("status", ["confirmed", "changed"]).not_.is_("arr_time", "null")
           .gte("arr_time", datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc).isoformat())
           .lte("arr_time", now.isoformat()).order("arr_time").execute())
    proposals: list[dict] = []
    for f in res.data or []:
        arr_time = datetime.fromisoformat(f["arr_time"].replace("Z", "+00:00"))
        arr_tz = f["arr_tz"]
        if not arr_tz:
            continue
        try:
            db_tz = store.supa.schema("pds").rpc("tz_for_instant", {"ts": arr_time.isoformat()}).execute().data
        except Exception as e:
            log.warning(f"tz_for_instant failed: {e}")
            continue
        in_run = [p for p in proposals if datetime.fromisoformat(p["effective_from"]) <= arr_time]
        resolved = in_run[-1]["tz"] if in_run else (db_tz or "America/New_York")
        if resolved == arr_tz:
            continue
        try:
            if arr_time.astimezone(ZoneInfo(arr_tz)).utcoffset() == arr_time.astimezone(ZoneInfo(resolved)).utcoffset():
                continue  # same offset (e.g. Toronto vs New York) — no behavioral difference
        except Exception:
            continue
        proposals.append({
            "effective_from": arr_time.isoformat(),
            "tz": arr_tz,
            "notes": f"flight-auto: {f['flight_number']} {f['dep_iata']}→{f['arr_iata']} conf {f['confirmation_number']}; log was {resolved}",
        })
    return proposals


def apply_tz_entries(store: Store, proposals: list[dict]) -> int:
    n = 0
    for p in proposals:
        log.info(f"  user_tz_log += {p['effective_from']} → {p['tz']}  ({p['notes']})")
        if store.dry_run:
            continue
        try:
            store.pds("user_tz_log").insert(p).execute()
            n += 1
        except Exception as e:
            log.warning(f"  skipped user_tz_log insert at {p['effective_from']}: {e}")
    return n


# ---------------------------------------------------------------------------
# IMAP
# ---------------------------------------------------------------------------

def imap_accounts() -> list[tuple[str, str]]:
    accts: list[tuple[str, str]] = []
    for suffix in ("", "_2", "_3", "_4", "_5"):
        e = (os.environ.get(f"IMAP_EMAIL{suffix}") or "").strip()
        p = (os.environ.get(f"IMAP_APP_PASSWORD{suffix}") or "").strip()
        if e and p:
            accts.append((e, p))
        elif e or p:
            log.warning(f"IMAP_EMAIL{suffix} / IMAP_APP_PASSWORD{suffix}: only one of the pair is set — skipping")
    return accts


def _imap_date(d: date) -> str:
    return f"{d.day:02d}-{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.month-1]}-{d.year}"


def select_all_mail(imap: imaplib.IMAP4_SSL) -> str:
    """Prefer Gmail's \\All folder so archived (non-INBOX) mail is searched."""
    try:
        status, boxes = imap.list()
        if status == "OK":
            for b in boxes or []:
                s = b.decode("utf-8", "replace") if isinstance(b, bytes) else str(b)
                if "\\All" in s:
                    name = s.split(' "/" ')[-1].strip()
                    if not name.startswith('"'):
                        name = f'"{name}"'
                    st, _ = imap.select(name, readonly=True)
                    if st == "OK":
                        return name
    except Exception as e:
        log.warning(f"LIST failed ({e}); falling back to INBOX")
    imap.select("INBOX", readonly=True)
    return "INBOX"


def decode_hdr(raw: str | None) -> str:
    if not raw:
        return ""
    out = []
    for part, charset in decode_header(raw):
        out.append(part.decode(charset or "utf-8", errors="replace") if isinstance(part, bytes) else part)
    return " ".join(out).strip()


def body_lines(msg: email.message.Message) -> list[str]:
    html = plain = None
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype not in ("text/html", "text/plain") or part.get("Content-Disposition", "").startswith("attachment"):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if ctype == "text/html" and html is None:
            html = text
        elif ctype == "text/plain" and plain is None:
            plain = text
    if html:
        return html_to_lines(html)
    if plain:
        return plain_to_lines(plain)
    return []


def _fetch_chunks(imap: imaplib.IMAP4_SSL, uids: list[bytes], item: str, chunk: int = 50):
    for i in range(0, len(uids), chunk):
        batch = uids[i:i + chunk]
        status, data = imap.uid("FETCH", b",".join(batch), item)
        if status != "OK":
            continue
        for d in data:
            if isinstance(d, tuple) and len(d) == 2:
                m = re.search(rb"UID (\d+)", d[0])
                if m:
                    yield m.group(1), d[1]


def process_account(account: str, password: str, store: Store, since: date, reprocess: bool) -> dict:
    stats = {"account": account, "candidates": 0, "operational": 0, "parsed": 0, "segments": 0, "errors": 0, "skipped_done": 0}
    imap = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        imap.login(account, password)
        box = select_all_mail(imap)
        status, data = imap.uid("SEARCH", None, f'(FROM "{SENDER_DOMAIN}" SINCE {_imap_date(since)})')
        uids = data[0].split() if status == "OK" and data and data[0] else []
        stats["candidates"] = len(uids)
        log.info(f"[{account}] {len(uids)} email(s) from {SENDER_DOMAIN} since {since} in {box}")
        if not uids:
            return stats
        done = set() if reprocess else store.processed_ids(account)
        wanted: list[tuple[bytes, dict]] = []
        for uid, hdr in _fetch_chunks(imap, uids, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)])", chunk=100):
            h = email.message_from_bytes(hdr)
            subject = decode_hdr(h.get("Subject"))
            kind = classify(subject)
            if not kind:
                continue
            stats["operational"] += 1
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
            wanted.append((uid, {"message_id": mid, "subject": subject, "kind": kind, "email_date": edate, "account": account}))
        wanted.sort(key=lambda w: w[1]["email_date"])  # chronological: receipts before the trip-details that refine them
        log.info(f"[{account}] {stats['operational']} operational, {stats['skipped_done']} already processed, {len(wanted)} to parse")
        by_uid = {u: m for u, m in wanted}
        bodies: dict[bytes, bytes] = {}
        for uid, raw in _fetch_chunks(imap, [u for u, _ in wanted], "(BODY.PEEK[])", chunk=10):
            bodies[uid] = raw
        for uid, meta in wanted:
            raw = bodies.get(uid)
            kind = meta["kind"]
            if raw is None:
                stats["errors"] += 1
                store.log_email(meta, kind, None, 0, "error", "body fetch failed")
                continue
            try:
                lines = body_lines(email.message_from_bytes(raw))
                parsed = parse_email(kind, lines, meta["email_date"])
                log.info(f"  [{kind}] {meta['email_date']:%Y-%m-%d} {meta['subject'][:60]!r} conf={parsed['confirmation']} segs={len(parsed['segments'])}")
                if kind in ("receipt", "award_receipt", "trip_details", "checkin"):
                    if not parsed["confirmation"] or not parsed["segments"]:
                        store.log_email(meta, kind, parsed, 0, "unmatched", "no confirmation or no segments parsed")
                        continue
                    n = store.apply_segments(parsed, meta)
                    stats["segments"] += n
                    store.log_email(meta, kind, parsed, n, "parsed" if n else "unmatched")
                elif kind == "schedule_change":
                    n = store.mark_schedule_change(parsed, meta)
                    store.log_email(meta, kind, parsed, n, "parsed" if n else "unmatched")
                elif kind == "cancellation":
                    n = store.mark_cancelled(parsed, meta)
                    store.log_email(meta, kind, parsed, n, "parsed" if n else "unmatched")
                stats["parsed"] += 1
            except Exception as e:  # one bad email must not sink the run
                stats["errors"] += 1
                log.exception(f"  parse failed for {meta['subject']!r}")
                store.log_email(meta, kind, None, 0, "error", repr(e))
        return stats
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def run_file(path: str) -> None:
    """Parser dev aid: parse a saved .html/.txt body and print the result."""
    text = open(path, encoding="utf-8", errors="replace").read()
    lines = html_to_lines(text) if "<" in text[:2000] else plain_to_lines(text)
    kind = None
    for k in ("receipt", "trip", "checkin", "check_in", "schedule", "cancel"):
        if k in os.path.basename(path).lower():
            kind = {"trip": "trip_details", "check_in": "checkin", "schedule": "schedule_change", "cancel": "cancellation"}.get(k, k)
            break
    kind = kind or "receipt"
    parsed = parse_email(kind, lines, datetime.now(timezone.utc))
    print(json.dumps(parsed, indent=2, default=str))
    for seg in parsed["segments"]:
        row = build_row(seg, parsed, {"message_id": "<file>", "email_date": datetime.now(timezone.utc), "account": "file", "subject": path})
        print(json.dumps({k: v for k, v in row.items() if k != "raw_json"}, indent=2, default=str))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS, help="look-back window (default 60)")
    ap.add_argument("--reprocess", action="store_true", help="re-parse emails already in flight_email_log")
    ap.add_argument("--dry-run", action="store_true", help="parse but write nothing")
    ap.add_argument("--file", help="parse one saved email body and exit")
    args = ap.parse_args()

    if args.file:
        run_file(args.file)
        return 0

    from supabase import create_client
    from sync_log_helper import log_sync

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
            failures.append(f"{acct}: {e!r}"[:200])

    tz_added = 0
    if not args.dry_run or True:
        try:
            props = propose_tz_entries(store, since)
            tz_added = apply_tz_entries(store, props)
        except Exception as e:
            log.warning(f"tz_log proposal step failed: {e}")

    total_segments = sum(s["segments"] for s in per_account)
    errors = sum(s["errors"] for s in per_account)
    log.info(f"Done: {len(per_account)}/{len(accounts)} account(s) ok, {total_segments} segment write(s), "
             f"{store.changed} changed, {store.cancelled} cancelled, {tz_added} user_tz_log row(s), {errors} parse error(s)")

    if args.dry_run:
        return 0
    status = "success"
    notes: list[str] = []
    if not accounts:
        status, notes = "failed", ["no IMAP accounts configured"]
    elif failures and len(failures) == len(accounts):
        status, notes = "failed", failures
    else:
        if failures:
            status, notes = "partial", failures
        if len(accounts) < EXPECTED_ACCOUNTS:
            status = "partial"
            notes.append(f"only {len(accounts)} of {EXPECTED_ACCOUNTS} Gmail accounts configured (set IMAP_EMAIL_2/IMAP_APP_PASSWORD_2)")
        if errors:
            status = "partial"
            notes.append(f"{errors} email(s) failed to parse — see pds.flight_email_log status='error'")
    log_sync(supa, "flights", "email", status, records=total_segments, started_at=started,
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
            log_sync(supa, "flights", "email", "failed", records=0, error=repr(e)[:500])
        except Exception:
            pass
        sys.exit(1)
