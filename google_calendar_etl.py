"""
Calendar (iCal feed) -> Supabase ETL

Reads one or more iCalendar feeds (Google Calendar's "secret address in iCal
format" today; any ICS feed works, e.g. a published Outlook calendar), expands
recurring events to single instances inside a rolling window and upserts one
row per event instance into pds.calendar_events (service-role only). /health
(Month + Agenda) and /today (Calendar panel) read that table through
GET /api/calendar/events. One way only: calendar -> Onyx. Nothing is ever
written to a calendar.

Usage:
    python google_calendar_etl.py              # sync every configured feed (ET today -400 d .. +400 d)
    python google_calendar_etl.py --days 60    # a narrower window
    python google_calendar_etl.py --dry-run    # fetch + expand, print COUNTS only, no database
    python google_calendar_etl.py --file x.ics # parser check on a saved file, COUNTS only

Configuration: GOOGLE_CALENDAR_ICS_SECRET = a JSON list of
    [{"account": "<label>", "calendar": "<label>", "url": "https://.../basic.ics"}, ...]
`account` and `calendar` are short labels Riley picks (letters, digits, space,
_ . -), shown on /health and Today. They are not addresses.

Stored per instance: title, start/end, all-day flag, inclusive start/end dates,
time zone, location, status, the two labels, recurring flag.
NOT stored: description, attendees, organizer, conference links, the UID, the
feed URL.

Secrets and privacy (the repo and its Actions logs are public):
  - A feed URL is a bearer credential for the whole calendar. It never reaches a
    log line, an exception message, a traceback or pds.sync_log: httpx/httpcore
    loggers are raised to WARNING (httpx logs the full request URL at INFO),
    every URL is registered with ::add-mask:: on GitHub Actions, and fetch
    errors are re-raised as a plain FeedError `from None`.
  - Event titles never reach a log line or a heartbeat. Logs and --dry-run
    print counts only, and name a feed by its position ("calendar 1/2").
    Library and database error TEXT is never echoed either (a parse error can
    quote a line of the feed, a constraint error can quote a row): only the
    exception type and error code are reported.

Parsing rules that matter (measured against real Google feeds, 2026-11-13):
  - X-WR-TIMEZONE trap: recurring-ical-events applies Google's X-WR-TIMEZONE
    header by default, which rewrites UTC-form series into the calendar zone
    BEFORE expansion. Such series then drift by an hour across DST changes and
    come out twice next to their edited instances. The header is read (it is
    the display zone for UTC-form and floating times) and then REMOVED before
    expansion. tests/test_google_calendar.py pins this.
  - An instance's key is its ORIGINAL slot (RECURRENCE-ID as a UTC instant), so
    a moved instance keeps its row. A one-off event has an empty slot, so
    moving it updates the same row instead of adding one.
  - All-day events are dates, never instants; their DTEND is exclusive and is
    stored as an inclusive end_date.
  - The feed lists what exists NOW. A deleted event simply stops appearing, so
    after a fully validated fetch + parse the rows of that calendar that were
    not seen this run (inside the window) are removed. This is NEVER done for a
    calendar whose fetch or parse failed, and a removal of more than half of a
    calendar's rows is refused unless --allow-large-removal is passed.

Heartbeat: one pds.sync_log row per run (source='google_calendar',
data_type='events'): success / partial (a feed failed, a malformed series or
event was skipped, a large removal was refused) / failed (every feed failed,
the secret is missing or malformed, the table is missing, a database error).
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

import httpx
import icalendar
import recurring_ical_events

from sync_log_helper import log_sync as _shared_log_sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
# httpx logs "HTTP Request: GET <full url>" at INFO. The URL is the credential.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("google_calendar_etl")

ENV_NAME = "GOOGLE_CALENDAR_ICS_SECRET"
SOURCE = "google_calendar"
DATA_TYPE = "events"
TABLE = "calendar_events"
SQL_FILE = "sql/calendar_events_schema.sql"
ET_NAME = "America/New_York"
ET = ZoneInfo(ET_NAME)
UTC = timezone.utc

DEFAULT_WINDOW_DAYS = 400     # each side of ET today
UPSERT_BATCH = 500
FETCH_TIMEOUT_S = 60.0
RETRY_WAIT_S = 5.0            # one slow retry for a network error or 5xx; never for 403/404/429
MAX_TEXT = 300                # title / location length cap
# Removal guard: a run may not remove more than half of a calendar's rows in the window
# (once there are more than GUARD_MIN_ROWS of them) unless --allow-large-removal is given.
GUARD_MIN_ROWS = 25
LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}")
STATUSES = {"CONFIRMED": "confirmed", "TENTATIVE": "tentative", "CANCELLED": "cancelled", "CANCELED": "cancelled"}


class ConfigError(Exception):
    """The secret is missing or malformed. The message is safe to log (never contains a value)."""


class FeedError(Exception):
    """One feed could not be fetched or parsed. The message is safe to log (no URL, no feed text)."""


@dataclass(frozen=True)
class Feed:
    account: str
    calendar: str
    url: str = field(repr=False)   # never printed, even by an accidental repr()


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/test_google_calendar.py - no network, no database)
# ---------------------------------------------------------------------------

def parse_feeds_secret(raw: str | None) -> list[Feed]:
    """GOOGLE_CALENDAR_ICS_SECRET -> feeds. Every error names a position, never a value."""
    if raw is None or not raw.strip():
        raise ConfigError(f"{ENV_NAME} is not set. Add it as a GitHub Actions secret: a JSON list of "
                          '{"account", "calendar", "url"} with each calendar\'s secret iCal address.')
    try:
        data = json.loads(raw)
    except ValueError:
        raise ConfigError(f"{ENV_NAME} is not valid JSON (expected a list of {{account, calendar, url}})") from None
    if not isinstance(data, list) or not data:
        raise ConfigError(f"{ENV_NAME} must be a non-empty JSON list of {{account, calendar, url}}")
    feeds: list[Feed] = []
    seen: set[tuple[str, str]] = set()
    for i, entry in enumerate(data, start=1):
        if not isinstance(entry, dict):
            raise ConfigError(f"{ENV_NAME} entry {i} is not an object")
        labels = []
        for name in ("account", "calendar"):
            value = entry.get(name)
            value = value.strip() if isinstance(value, str) else ""
            if not LABEL_RE.fullmatch(value):
                raise ConfigError(f"{ENV_NAME} entry {i}: '{name}' must be a short label "
                                  "(1-40 letters, digits, space, _ . -), not an address or a URL")
            labels.append(value)
        url = entry.get("url")
        url = url.strip() if isinstance(url, str) else ""
        if url.lower().startswith("webcal://"):
            url = "https://" + url[len("webcal://"):]
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.netloc:
            raise ConfigError(f"{ENV_NAME} entry {i}: 'url' must be an https:// iCal address")
        pair = (labels[0].lower(), labels[1].lower())
        if pair in seen:
            raise ConfigError(f"{ENV_NAME} entry {i} repeats the account + calendar labels of an earlier entry")
        seen.add(pair)
        feeds.append(Feed(account=labels[0], calendar=labels[1], url=url))
    return feeds


def mask_values(feeds: list[Feed]) -> list[str]:
    """Strings to hide in a public Actions log: each URL plus its long path parts (calendar id, token)."""
    out: list[str] = []
    for feed in feeds:
        parts = urlsplit(feed.url)
        candidates = [feed.url, parts.path, parts.query]
        for segment in parts.path.split("/"):
            candidates += [segment, unquote(segment)]
        for value in candidates:
            if len(value) >= 12 and value not in out:
                out.append(value)
    return out


def event_key(account: str, calendar: str, uid: str, slot: str) -> str:
    """Stable row key. `slot` is '' for a one-off event, else the instance's original slot."""
    raw = "\x1f".join((account, calendar, uid, slot))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def window_bounds(today: date, days: int) -> tuple[date, date]:
    return today - timedelta(days=days), today + timedelta(days=days)


def reconcile_range(win_start: date, win_end: date) -> tuple[date, date]:
    """Dates whose rows the run is sure to have seen. One day in from each edge: an event's local
    start date can differ from its ET date by a day, so the edge days are never removed from."""
    return win_start + timedelta(days=1), win_end - timedelta(days=1)


def _zone_name(value) -> str | None:
    """A usable IANA zone name, else None."""
    name = str(value).strip() if value is not None else ""
    if not name:
        return None
    try:
        ZoneInfo(name)
    except Exception:  # noqa: BLE001 - unknown key, bad characters, missing tz database entry
        return None
    return name


def _text(value, limit: int = MAX_TEXT) -> str:
    """One line of plain text (iCal escapes are already decoded by the parser)."""
    return " ".join(str(value).split())[:limit] if value is not None else ""


# Meeting invitations often put the join link, meeting id and passcode in LOCATION (or the title).
# Those are credentials for the meeting, so they are never stored: links are cut out, and a field
# that was only a meeting link is stored as "Online meeting".
_LINK = re.compile(r"(?:https?://|www\.)\S+", re.I)
_MEETING_BITS = re.compile(
    r"\b(?:meeting|conference|webinar)\s*(?:id|number|no\.?)\s*[:#]?\s*[\d\s-]{6,}"
    r"|\b(?:passcode|password|pwd|pin|access code)\b\s*[:=#]?\s*\S+", re.I)
_MEETING_HOSTS = re.compile(r"\S*\b(?:zoom\.us|teams\.microsoft|meet\.google|webex\.com|gotomeeting|chime\.aws)\S*", re.I)


def _scrub(text: str) -> tuple[str, bool]:
    """Remove links and meeting credentials. Returns (clean text, whether anything was removed)."""
    clean = _MEETING_HOSTS.sub(" ", _MEETING_BITS.sub(" ", _LINK.sub(" ", text)))
    clean = " ".join(clean.split()).strip(" ,;|-–—:/")
    return clean, clean != text


def _place(value) -> str | None:
    text = _text(value)
    if not text:
        return None
    clean, changed = _scrub(text)
    if not clean or (changed and not re.search(r"[A-Za-z]{3}", clean)):
        return "Online meeting"
    return clean


def _title(value) -> str:
    text = _text(value)
    clean, _ = _scrub(text)
    return clean or ("(no title)" if text else "")


def et_today() -> date:
    """Today in ET. Tests replace this so fixed-date fixtures never age out."""
    return datetime.now(ET).date()


def _is_all_day(value) -> bool:
    return isinstance(value, date) and not isinstance(value, datetime)


def _slot(value, cal_zone: ZoneInfo) -> str:
    """Original slot of an instance: a UTC instant (timed) or a date (all-day)."""
    if _is_all_day(value):
        return value.strftime("%Y%m%d")
    if value.tzinfo is None:
        value = value.replace(tzinfo=cal_zone)
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _prop_dt(component, name: str):
    prop = component.get(name)
    return getattr(prop, "dt", None)


def build_row(occ, account: str, calendar: str, cal_tz: str | None, series_uids: set[str]) -> dict:
    """One expanded occurrence -> one table row (no last_seen_at / synced_at yet)."""
    start = _prop_dt(occ, "DTSTART")
    if not isinstance(start, date):
        raise ValueError("no usable DTSTART")
    end = _prop_dt(occ, "DTEND")
    uid = str(occ.get("UID") or "").strip()
    zone_name = cal_tz or ET_NAME
    cal_zone = ZoneInfo(zone_name)
    recurring = uid in series_uids
    slot = ""
    if recurring:
        original = _prop_dt(occ, "RECURRENCE-ID")
        slot = _slot(original if isinstance(original, date) else start, cal_zone)

    if _is_all_day(start):
        if isinstance(end, datetime):
            end = end.date()
        last = end - timedelta(days=1) if isinstance(end, date) else start   # DTEND is exclusive
        row_times = {"start_at": None, "end_at": None, "all_day": True,
                     "start_date": start.isoformat(), "end_date": max(start, last).isoformat(), "tz": None}
    else:
        tz_name = None
        if start.tzinfo is None:                       # floating time: the calendar's zone
            start = start.replace(tzinfo=cal_zone)
        else:
            key = getattr(start.tzinfo, "key", None)   # ZoneInfo only; fixed offsets have none
            if key and key.upper() not in ("UTC", "ETC/UTC", "ETC/GMT", "GMT", "Z"):
                tz_name = _zone_name(key)
        tz_name = tz_name or zone_name                 # UTC-form events show in the calendar's zone
        if not isinstance(end, datetime):
            end = start
        elif end.tzinfo is None:
            end = end.replace(tzinfo=cal_zone)
        start_utc = start.astimezone(UTC)
        end_utc = max(end.astimezone(UTC), start_utc)
        zone = ZoneInfo(tz_name)
        start_local = start_utc.astimezone(zone).date()
        # The end is exclusive: an event that ends at local midnight belongs to the day before.
        end_local = (end_utc - timedelta(microseconds=1)).astimezone(zone).date() if end_utc > start_utc else start_local
        row_times = {"start_at": start_utc.isoformat(), "end_at": end_utc.isoformat(), "all_day": False,
                     "start_date": start_local.isoformat(), "end_date": max(start_local, end_local).isoformat(),
                     "tz": tz_name}

    return {
        "event_key": event_key(account, calendar, uid, slot),
        "account": account,
        "calendar": calendar,
        "title": _title(occ.get("SUMMARY")),
        **row_times,
        "location": _place(occ.get("LOCATION")),
        "status": STATUSES.get(str(occ.get("STATUS") or "").strip().upper(), "confirmed"),
        "recurring": recurring,
    }


def _rank(component) -> tuple:
    """Which of two components with the same key wins: higher SEQUENCE, then later LAST-MODIFIED."""
    try:
        seq = int(component.get("SEQUENCE") or 0)
    except (TypeError, ValueError):
        seq = 0
    modified = _prop_dt(component, "LAST-MODIFIED")
    stamp = modified.replace(tzinfo=None).isoformat() if isinstance(modified, datetime) else ""
    return seq, stamp


def expand_events(ics_text: str, account: str, calendar: str, win_start: date, win_end: date) -> tuple[list[dict], dict]:
    """Feed text -> (rows for every instance overlapping the window, counts).

    Raises FeedError when the text is not a complete calendar or cannot be expanded.
    The window is [win_start 00:00 ET, win_end + 1 day 00:00 ET).
    """
    body = ics_text.lstrip("﻿ \t\r\n")
    if not body.upper().startswith("BEGIN:VCALENDAR"):
        raise FeedError("the answer is not an iCalendar file (a reset or revoked address answers with a web page)")
    if "END:VCALENDAR" not in body[-200:].upper():
        raise FeedError("the answer is cut off (no END:VCALENDAR)")
    try:
        cal = icalendar.Calendar.from_ical(body)
    except Exception as exc:  # noqa: BLE001 - the message can quote feed lines, so only the type is kept
        raise FeedError(f"the calendar could not be parsed ({type(exc).__name__})") from None

    cal_tz = _zone_name(cal.get("X-WR-TIMEZONE"))
    # The X-WR-TIMEZONE trap (module docstring): remove the header BEFORE expansion.
    cal.pop("X-WR-TIMEZONE", None)
    cal_zone = ZoneInfo(cal_tz or ET_NAME)

    # Raw scan: which UIDs are series, and which components cannot be expanded at all.
    series_uids: set[str] = set()
    raw_slots: set[tuple[str, str]] = set()
    skipped = duplicates = 0
    kept = []
    for component in cal.subcomponents:
        if component.name != "VEVENT":
            kept.append(component)          # VTIMEZONE is needed; VTODO / VFREEBUSY are ignored by the expander
            continue
        try:
            start = _prop_dt(component, "DTSTART")
        except Exception:  # noqa: BLE001
            start = None
        uid = str(component.get("UID") or "").strip()
        if not isinstance(start, date) or not uid:
            skipped += 1                    # the expander raises on an event with no start
            continue
        original = None
        if "RECURRENCE-ID" in component:
            try:
                original = _prop_dt(component, "RECURRENCE-ID")
            except Exception:  # noqa: BLE001
                original = None
        if "RRULE" in component or "RDATE" in component or "RECURRENCE-ID" in component:
            series_uids.add(uid)
        slot_key = (uid, _slot(original, cal_zone) if isinstance(original, date) else "")
        if slot_key in raw_slots:
            duplicates += 1
        raw_slots.add(slot_key)
        kept.append(component)
    cal.subcomponents = kept

    start_dt = datetime.combine(win_start, dtime.min, ET)
    end_dt = datetime.combine(win_end + timedelta(days=1), dtime.min, ET)
    bad_series = False
    try:
        occurrences = recurring_ical_events.of(cal).between(start_dt, end_dt)
    except Exception:  # noqa: BLE001 - a malformed rule: expand again without the broken series
        bad_series = True
        try:
            occurrences = recurring_ical_events.of(cal, skip_bad_series=True).between(start_dt, end_dt)
        except Exception as exc:  # noqa: BLE001
            raise FeedError(f"recurring events could not be expanded ({type(exc).__name__})") from None

    by_key: dict[str, tuple[tuple, dict]] = {}
    for occ in occurrences:
        if occ.name != "VEVENT":
            continue
        try:
            row = build_row(occ, account, calendar, cal_tz, series_uids)
        except Exception:  # noqa: BLE001 - one unusable instance must not sink the calendar
            skipped += 1
            continue
        rank = _rank(occ)
        previous = by_key.get(row["event_key"])
        if previous is not None:
            duplicates += 1
            if rank <= previous[0]:
                continue
        by_key[row["event_key"]] = (rank, row)

    rows = sorted((r for _, r in by_key.values()), key=lambda r: (r["start_date"], r["start_at"] or "", r["event_key"]))
    live = [r for r in rows if r["status"] != "cancelled"]
    stats = {
        "events": len(live),
        "cancelled": len(rows) - len(live),
        "recurring": sum(1 for r in live if r["recurring"]),
        "all_day": sum(1 for r in live if r["all_day"]),
        "skipped": skipped,
        "duplicates": duplicates,
        "bad_series": bad_series,
        "first_date": live[0]["start_date"] if live else None,
        "last_date": max(r["start_date"] for r in live) if live else None,
    }
    return rows, stats


def calendar_notes(stats: dict) -> list[str]:
    """Reasons a successfully parsed calendar still makes the run partial."""
    notes = []
    if stats["bad_series"]:
        notes.append("a recurring series with a malformed rule was skipped")
    if stats["skipped"]:
        notes.append(f"{stats['skipped']} event(s) without a usable start or id were skipped")
    if stats["duplicates"]:
        notes.append(f"{stats['duplicates']} duplicate instance(s) resolved (newest kept)")
    return notes


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass


def get_supabase():
    """Service-role client. Imported lazily so the pure helpers, --dry-run and the tests need no extras."""
    _load_env()
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def _http_reason(code: int) -> str:
    if code == 404:
        return f"HTTP 404 (the secret address was reset or is wrong: copy the new one into {ENV_NAME})"
    if code in (403, 429):
        return f"HTTP {code} (the calendar host is refusing or rate limiting; the next hourly run retries)"
    return f"HTTP {code}"


def fetch_feed(client: httpx.Client, url: str) -> str:
    """GET one feed. Any failure becomes a FeedError that carries no URL and no chained exception."""
    for attempt in (1, 2):
        try:
            response = client.get(url)
        except httpx.HTTPError as exc:
            if attempt == 1:
                time.sleep(RETRY_WAIT_S)
                continue
            raise FeedError(f"network error ({type(exc).__name__})") from None
        except Exception as exc:  # noqa: BLE001 - e.g. an invalid URL: its text would quote the URL
            raise FeedError(f"request could not be made ({type(exc).__name__})") from None
        code = response.status_code
        if code == 200:
            return response.content.decode("utf-8-sig", errors="replace")
        if 500 <= code < 600 and attempt == 1:
            time.sleep(RETRY_WAIT_S)
            continue
        raise FeedError(_http_reason(code))
    raise FeedError("no answer")  # unreachable


def log_sync(sb, status: str, records: int, started_at: float, error: str | None = None,
             date_range: tuple[date, date] | None = None) -> None:
    _shared_log_sync(
        sb, source=SOURCE, data_type=DATA_TYPE, status=status, records=records,
        started_at=started_at, error=error[:500] if error else None,
        date_range_start=date_range[0] if date_range else None,
        date_range_end=date_range[1] if date_range else None,
    )


def safe_db_error(exc: Exception) -> str:
    """A database error as text that cannot carry row content.

    PostgREST / Postgres messages can quote the failing row (title included), so only the
    exception type and the error code are reported. A missing table names the SQL file to apply.
    """
    text = str(exc)
    if TABLE in text and any(s in text for s in ("PGRST205", "does not exist", "schema cache", "42P01")):
        return f"pds.{TABLE} is missing - apply {SQL_FILE}"
    code = getattr(exc, "code", None)
    code = f" {code}" if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9]{1,12}", code) else ""
    return f"database error ({type(exc).__name__}{code})"


def store_calendar(sb, feed: Feed, rows: list[dict], stamp: str, win_start: date, win_end: date,
                   allow_large_removal: bool = False) -> tuple[int, str | None]:
    """Upsert this run's rows, then remove the calendar's rows it did not see inside the window.

    Call ONLY after a validated fetch + parse. Returns (rows removed, guard note or None).
    """
    table = lambda: sb.schema("pds").table(TABLE)  # noqa: E731
    stamped = [{**r, "last_seen_at": stamp, "synced_at": stamp} for r in rows]
    for i in range(0, len(stamped), UPSERT_BATCH):
        table().upsert(stamped[i:i + UPSERT_BATCH], on_conflict="event_key").execute()

    lo, hi = (d.isoformat() for d in reconcile_range(win_start, win_end))

    def scoped(query):
        return (query.eq("account", feed.account).eq("calendar", feed.calendar)
                .gte("start_date", lo).lte("start_date", hi))

    stale = scoped(table().select("event_key", count="exact")).lt("last_seen_at", stamp).limit(1).execute().count or 0
    if stale == 0:
        return 0, None
    total = scoped(table().select("event_key", count="exact")).limit(1).execute().count or 0
    if not allow_large_removal and stale > GUARD_MIN_ROWS and stale * 2 > total:
        return 0, (f"{stale} of {total} stored events were not in the feed; that is more than half, so nothing "
                   "was removed (run the workflow with allow_large_removal if the calendar really was cleared)")
    scoped(table().delete()).lt("last_seen_at", stamp).execute()
    return stale, None


def purge_unconfigured(sb, feeds: list[Feed]) -> None:
    """Remove rows of calendars that are no longer in the secret (a renamed or removed feed)."""
    table = lambda: sb.schema("pds").table(TABLE)  # noqa: E731
    table().delete().not_.in_("account", sorted({f.account for f in feeds})).execute()
    table().delete().not_.in_("calendar", sorted({f.calendar for f in feeds})).execute()


def run(sb, feeds: list[Feed], days: int = DEFAULT_WINDOW_DAYS, dry_run: bool = False,
        allow_large_removal: bool = False, today: date | None = None) -> tuple[str, int, str | None]:
    """Sync every feed. Returns (heartbeat status, events written, note). Database errors propagate."""
    today = today or et_today()
    win_start, win_end = window_bounds(today, days)
    stamp = datetime.now(UTC).isoformat()
    failures: list[str] = []
    notes: list[str] = []
    total = 0
    log.info(f"{len(feeds)} calendar feed(s), window {win_start} -> {win_end}")
    with httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=True) as client:
        for n, feed in enumerate(feeds, start=1):
            tag = f"calendar {n}/{len(feeds)}"                      # public logs: position only
            name = f"calendar '{feed.calendar}' ({feed.account})"    # heartbeat (owner-only): the label
            try:
                rows, stats = expand_events(fetch_feed(client, feed.url), feed.account, feed.calendar, win_start, win_end)
            except FeedError as exc:
                log.error(f"{tag}: failed - {exc}")
                failures.append(f"{name}: {exc}")
                continue                                             # never reconcile a failed calendar
            removed = 0
            if not dry_run:
                removed, guard = store_calendar(sb, feed, rows, stamp, win_start, win_end, allow_large_removal)
                if guard:
                    notes.append(f"{name}: {guard}")
                    log.warning(f"{tag}: {guard}")
            total += stats["events"]
            for note in calendar_notes(stats):
                notes.append(f"{name}: {note}")
                log.warning(f"{tag}: {note}")
            log.info(f"{tag}: {stats['events']} event(s) ({stats['recurring']} recurring instance(s), "
                     f"{stats['all_day']} all-day, {stats['cancelled']} cancelled), "
                     f"{stats['first_date'] or '-'} -> {stats['last_date'] or '-'}"
                     + ("" if dry_run else f", {removed} removed"))
    if not dry_run and not failures:
        purge_unconfigured(sb, feeds)
    if failures and len(failures) == len(feeds):
        return "failed", 0, "; ".join(failures)
    status = "partial" if failures or notes else "success"
    return status, total, ("; ".join(failures + notes) or None)


def check_file(path: str, days: int) -> int:
    """Parser check on a saved .ics file. Prints counts only."""
    win_start, win_end = window_bounds(et_today(), days)
    try:
        text = Path(path).read_bytes().decode("utf-8-sig", errors="replace")
        rows, stats = expand_events(text, "file", "file", win_start, win_end)
    except FeedError as exc:
        log.error(f"file: {exc}")
        return 1
    log.info(f"file: {len(rows)} row(s) in {win_start} -> {win_end}: {stats}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Calendar (iCal feed) ETL -> pds.calendar_events")
    ap.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS,
                    help=f"window on each side of ET today (default {DEFAULT_WINDOW_DAYS})")
    ap.add_argument("--dry-run", action="store_true", help="fetch and expand, print counts only, no database")
    ap.add_argument("--file", help="parse a saved .ics file and print counts only (no network, no database)")
    ap.add_argument("--allow-large-removal", action="store_true",
                    help="let one run remove more than half of a calendar's stored events")
    args = ap.parse_args(argv)
    if not 1 <= args.days <= 3660:
        ap.error("--days must be between 1 and 3660")
    if args.file:
        return check_file(args.file, args.days)

    started = time.time()
    _load_env()
    try:
        feeds = parse_feeds_secret(os.environ.get(ENV_NAME))
    except ConfigError as exc:
        log.error(str(exc))
        if not args.dry_run:
            log_sync(get_supabase(), "failed", 0, started, error=str(exc))
        return 1
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for value in mask_values(feeds):       # GitHub only masks a secret's whole value, not the URLs inside it
            print(f"::add-mask::{value}", flush=True)

    if args.dry_run:
        status, total, _ = run(None, feeds, args.days, dry_run=True)
        log.info(f"Dry run: {status}, {total} event(s) would be written")
        return 0 if status != "failed" else 1

    sb = get_supabase()
    window = window_bounds(et_today(), args.days)
    try:
        status, total, note = run(sb, feeds, args.days, allow_large_removal=args.allow_large_removal)
    except Exception as exc:  # noqa: BLE001 - a database error: heartbeat without row content, then fail the job
        message = safe_db_error(exc)
        log.error(message)
        log_sync(sb, "failed", 0, started, error=message, date_range=window)
        return 1
    log.info(f"Done: {status}, {total} event(s)")
    log_sync(sb, status, total, started, error=note, date_range=window)
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    # Top-level failure heartbeat so an uncaught exception still surfaces on /status. The exception
    # TEXT is never printed or stored (it could quote a feed line or a row): type and frames only.
    _t0 = time.time()
    try:
        _code = main()
    except Exception as exc:  # noqa: BLE001 - top-level safety net
        _message = f"Uncaught exception: {type(exc).__name__}"
        log.error(_message)
        sys.stderr.write("".join(traceback.format_tb(exc.__traceback__)))
        if "--dry-run" not in sys.argv and "--file" not in sys.argv:
            try:
                log_sync(get_supabase(), "failed", 0, _t0, error=_message)
            except Exception as log_exc:  # noqa: BLE001
                log.error(f"Could not write the failure heartbeat ({type(log_exc).__name__})")
        _code = 1
    sys.exit(_code)
