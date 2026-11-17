"""
iCloud CalDAV source for google_calendar_etl.py (read-only).

Apple has no ICS "secret address" for iCloud calendars and its OAuth is a closed
pilot, so the only route is CalDAV (caldav.icloud.com) with an Apple ID and an
APP-SPECIFIC password (appleid.apple.com > Sign-In and Security > App-Specific
Passwords). The password also opens iCloud Mail, so it lives only in the GitHub
secret ICLOUD_CALDAV_SECRET, never in a file under OneDrive or in chat.

Secret format (one Apple ID; a JSON list holds several):
    {"account": "iCloud", "username": "<apple id>", "password": "<app-specific password>"}

What this module does (all GET-like: PROPFIND + REPORT, nothing is ever written):
  1. PROPFIND caldav.icloud.com            -> current-user-principal
  2. PROPFIND <principal>                  -> calendar-home-set
  3. PROPFIND <home> (Depth 1)             -> the event calendars (VEVENT-capable)
  4. REPORT calendar-query per calendar    -> every event resource overlapping the window
The resources are merged into ONE iCalendar text per calendar, which the existing
google_calendar_etl.expand_events() expands exactly like a feed from Google.

Privacy / safety (the repo and its Actions logs are public):
  - The username and password never reach a log line, an exception message or a
    heartbeat; errors are plain messages from None.
  - The credential is only ever sent to hosts ending in .icloud.com over https:
    redirects are followed by hand and checked host by host.
  - Calendar labels are Riley's own calendar names (sanitised to the label rule);
    they appear in the owner-only heartbeat and on /health, never in a public log
    (logs name a calendar by position).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import httpx
import icalendar

ENV_NAME = "ICLOUD_CALDAV_SECRET"
START_URL = "https://caldav.icloud.com/"
ALLOWED_HOST_SUFFIX = ".icloud.com"
MAX_REDIRECTS = 5
MAX_CALENDARS = 40
LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}")

NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav"}


class CaldavConfigError(Exception):
    """The secret is missing or malformed. Safe to log (never contains a value)."""


class CaldavError(Exception):
    """One CalDAV step failed. Safe to log (no credential, no event text)."""


@dataclass(frozen=True)
class CaldavSource:
    account: str
    username: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True)
class CaldavCalendar:
    account: str
    calendar: str
    href: str                                # absolute URL of the collection
    username: str = field(repr=False)
    password: str = field(repr=False)


def parse_caldav_secret(raw: str | None) -> list[CaldavSource]:
    """ICLOUD_CALDAV_SECRET -> sources. None / empty = not configured = []. Errors name a position, never a value."""
    import json

    if raw is None or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        raise CaldavConfigError(f"{ENV_NAME} is not valid JSON (expected {{account, username, password}})") from None
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise CaldavConfigError(f"{ENV_NAME} must be an object or a non-empty list of {{account, username, password}}")
    out: list[CaldavSource] = []
    seen: set[str] = set()
    for i, entry in enumerate(data, start=1):
        if not isinstance(entry, dict):
            raise CaldavConfigError(f"{ENV_NAME} entry {i} is not an object")
        account = entry.get("account")
        account = account.strip() if isinstance(account, str) else ""
        if not LABEL_RE.fullmatch(account):
            raise CaldavConfigError(f"{ENV_NAME} entry {i}: 'account' must be a short label "
                                    "(1-40 letters, digits, space, _ . -), not an address")
        username = entry.get("username")
        password = entry.get("password")
        if not isinstance(username, str) or not username.strip():
            raise CaldavConfigError(f"{ENV_NAME} entry {i}: 'username' (the Apple ID) is missing")
        if not isinstance(password, str) or not password.strip():
            raise CaldavConfigError(f"{ENV_NAME} entry {i}: 'password' (an app-specific password) is missing")
        if account.lower() in seen:
            raise CaldavConfigError(f"{ENV_NAME} entry {i} repeats the account label of an earlier entry")
        seen.add(account.lower())
        out.append(CaldavSource(account=account, username=username.strip(), password=password.strip()))
    return out


def mask_values(sources: list[CaldavSource]) -> list[str]:
    """Strings to hide in a public Actions log."""
    out: list[str] = []
    for s in sources:
        for value in (s.username, s.password):
            if len(value) >= 4 and value not in out:
                out.append(value)
    return out


def calendar_label(display_name: str | None, taken: set[str], position: int) -> str:
    """A calendar's display name as a short label that follows the label rule and is unique per account."""
    cleaned = re.sub(r"[^A-Za-z0-9 _.\-]+", " ", display_name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" _.-")[:40].strip()
    if not cleaned or not LABEL_RE.fullmatch(cleaned):
        cleaned = f"calendar {position}"
    label, n = cleaned, 2
    while label.lower() in taken:
        suffix = f" {n}"
        label = cleaned[:40 - len(suffix)].rstrip() + suffix
        n += 1
    taken.add(label.lower())
    return label


# ---------------------------------------------------------------------------
# XML helpers (pure, unit-tested)
# ---------------------------------------------------------------------------

def _xml(text: str):
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        raise CaldavError("the server answer was not valid XML") from None


def _responses(root) -> list:
    return root.findall("d:response", NS)


def _href_of(response) -> str:
    el = response.find("d:href", NS)
    return (el.text or "").strip() if el is not None else ""


def _ok_props(response) -> list:
    """The <prop> elements of propstat blocks whose status is 2xx."""
    out = []
    for ps in response.findall("d:propstat", NS):
        status = ps.find("d:status", NS)
        if status is not None and " 2" not in (status.text or ""):
            continue
        prop = ps.find("d:prop", NS)
        if prop is not None:
            out.append(prop)
    return out


def _first_href(root, path: str) -> str | None:
    """First <d:href> found under a property path such as 'd:current-user-principal'."""
    for response in _responses(root):
        for prop in _ok_props(response):
            holder = prop.find(path, NS)
            if holder is not None:
                href = holder.find("d:href", NS)
                if href is not None and (href.text or "").strip():
                    return href.text.strip()
    return None


def parse_principal(xml_text: str) -> str | None:
    return _first_href(_xml(xml_text), "d:current-user-principal")


def parse_home_set(xml_text: str) -> str | None:
    return _first_href(_xml(xml_text), "c:calendar-home-set")


def parse_calendars(xml_text: str) -> list[tuple[str, str | None]]:
    """(collection href, display name) of every VEVENT-capable calendar collection."""
    found: list[tuple[str, str | None]] = []
    for response in _responses(_xml(xml_text)):
        href = _href_of(response)
        if not href:
            continue
        for prop in _ok_props(response):
            rtype = prop.find("d:resourcetype", NS)
            if rtype is None or rtype.find("c:calendar", NS) is None:
                continue
            comps = prop.find("c:supported-calendar-component-set", NS)
            if comps is not None:
                names = {c.get("name", "").upper() for c in comps.findall("c:comp", NS)}
                if "VEVENT" not in names:
                    continue          # a reminders list (VTODO only)
            name = prop.find("d:displayname", NS)
            found.append((href, (name.text or "").strip() if name is not None else None))
            break
    return found


def parse_calendar_data(xml_text: str) -> list[str]:
    """The iCalendar text of each event resource in a calendar-query answer."""
    out = []
    for response in _responses(_xml(xml_text)):
        for prop in _ok_props(response):
            data = prop.find("c:calendar-data", NS)
            if data is not None and (data.text or "").strip():
                out.append(data.text)
    return out


def merge_resources(resources: list[str]) -> str:
    """Event resources -> ONE iCalendar text (every VEVENT, each VTIMEZONE once).

    Raises CaldavError when a resource cannot be parsed: expanding a partial set would let the
    ETL remove the stored events of the unreadable resource, so the whole calendar is skipped.
    """
    merged = icalendar.Calendar()
    merged.add("PRODID", "-//Onyx//CalDAV merge//EN")
    merged.add("VERSION", "2.0")
    zones: set[str] = set()
    for text in resources:
        try:
            part = icalendar.Calendar.from_ical(text)
        except Exception as exc:  # noqa: BLE001 - the message can quote event text; only the type is kept
            raise CaldavError(f"an event could not be parsed ({type(exc).__name__})") from None
        for comp in part.subcomponents:
            if comp.name == "VTIMEZONE":
                tzid = str(comp.get("TZID", ""))
                if tzid in zones:
                    continue
                zones.add(tzid)
                merged.add_component(comp)
            elif comp.name == "VEVENT":
                merged.add_component(comp)
    return merged.to_ical().decode("utf-8", errors="replace")


def query_body(win_start: date, win_end: date) -> str:
    """calendar-query REPORT body: VEVENTs overlapping [win_start, win_end + 1 day) in UTC."""
    lo = datetime.combine(win_start, dtime.min, tzinfo=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    hi = datetime.combine(win_end + timedelta(days=1), dtime.min, tzinfo=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        "<d:prop><c:calendar-data/></d:prop>"
        '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
        f'<c:time-range start="{lo}" end="{hi}"/>'
        "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
    )


PRINCIPAL_BODY = ('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:">'
                  "<d:prop><d:current-user-principal/></d:prop></d:propfind>")
HOME_BODY = ('<?xml version="1.0" encoding="utf-8"?>'
             '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
             "<d:prop><c:calendar-home-set/></d:prop></d:propfind>")
LIST_BODY = ('<?xml version="1.0" encoding="utf-8"?>'
             '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
             "<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>")


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def _allowed(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and (host == "icloud.com" or host.endswith(ALLOWED_HOST_SUFFIX))


def _reason(code: int) -> str:
    if code in (401, 403):
        return (f"HTTP {code} (iCloud refused the sign-in: check the Apple ID and the app-specific password in "
                f"{ENV_NAME}; a password reset or a revoked app password stops it)")
    if code == 429:
        return "HTTP 429 (iCloud is rate limiting; the next hourly run retries)"
    return f"HTTP {code}"


def dav(client: httpx.Client, source: CaldavSource, method: str, url: str, body: str,
        depth: str = "0") -> tuple[str, str]:
    """One PROPFIND / REPORT with basic auth, redirects followed by hand, never leaving *.icloud.com.
    Returns (answer text, the URL that answered): relative hrefs resolve against the latter."""
    headers = {"Depth": depth, "Content-Type": "application/xml; charset=utf-8"}
    for _ in range(MAX_REDIRECTS + 1):
        if not _allowed(url):
            raise CaldavError("the server pointed outside iCloud; the credential was not sent there")
        try:
            response = client.request(method, url, content=body.encode("utf-8"), headers=headers,
                                      auth=(source.username, source.password), follow_redirects=False)
        except httpx.HTTPError as exc:
            raise CaldavError(f"network error ({type(exc).__name__})") from None
        except Exception as exc:  # noqa: BLE001 - e.g. an invalid URL: its text could quote it
            raise CaldavError(f"request could not be made ({type(exc).__name__})") from None
        if response.status_code in (301, 302, 307, 308) and response.headers.get("location"):
            url = urljoin(url, response.headers["location"])
            continue
        if response.status_code in (200, 207):
            return response.content.decode("utf-8-sig", errors="replace"), url
        raise CaldavError(_reason(response.status_code))
    raise CaldavError("too many redirects")


def discover_calendars(client: httpx.Client, source: CaldavSource) -> list[CaldavCalendar]:
    """Steps 1-3: the account's event calendars, each with a unique short label."""
    text, base = dav(client, source, "PROPFIND", START_URL, PRINCIPAL_BODY)
    principal = parse_principal(text)
    if not principal:
        raise CaldavError("no account principal in the answer")
    principal_url = urljoin(base, principal)
    text, base = dav(client, source, "PROPFIND", principal_url, HOME_BODY)
    home = parse_home_set(text)
    if not home:
        raise CaldavError("no calendar home in the answer")
    home_url = urljoin(base, home)
    text, base = dav(client, source, "PROPFIND", home_url, LIST_BODY, depth="1")
    listing = parse_calendars(text)
    taken: set[str] = set()
    out: list[CaldavCalendar] = []
    for i, (href, name) in enumerate(listing[:MAX_CALENDARS], start=1):
        out.append(CaldavCalendar(account=source.account, calendar=calendar_label(name, taken, i),
                                  href=urljoin(base, href), username=source.username,
                                  password=source.password))
    return out


def fetch_calendar_ics(client: httpx.Client, cal: CaldavCalendar, win_start: date, win_end: date) -> str:
    """Step 4: every event resource overlapping the window, merged into one iCalendar text."""
    src = CaldavSource(cal.account, cal.username, cal.password)
    answer, _ = dav(client, src, "REPORT", cal.href, query_body(win_start, win_end), depth="1")
    return merge_resources(parse_calendar_data(answer))
