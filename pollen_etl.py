"""
Pollen (Atlanta) -> Supabase ETL

Reads the daily pollen count that Atlanta Allergy & Asthma publishes (the Atlanta
counting station certified by the National Allergy Bureau) from its keyless public
page and upserts one row per count day into pds.pollen_daily.

Usage:
    python pollen_etl.py                        # routine run: ONE request (today's page)
    python pollen_etl.py --backfill-months 35   # the last 35 calendar months, one request per month, 5 s apart
    python pollen_etl.py --dry-run              # fetch + parse, print the rows, write nothing (no .env needed)

Design notes:
  - Source page: https://www.atlantaallergy.com/pollen_counts/index/YYYY/MM/DD (or
    .../YYYY/MM for a month). It shows "Total Pollen Count for MM/DD/YYYY: N" with the
    tree / grass / weed levels, their top contributors and the mold level of that day,
    plus a calendar of the month's daily totals (and the neighbouring months' days that
    share its first and last week). Every calendar cell links to its own dated page, so
    each total is read with the full date from that link, never from its position.
  - Polite: robots.txt allows everything, but this is a clinic's site with no reuse
    statement, so the data is stored privately and the routine run makes ONE request.
    The calendar on that page re-upserts every count of the month on each run, so a
    count posted late or corrected heals itself. Backfill is one request per month with
    a pause in between. The User-Agent names the tool, never a person.
  - What a count means: pollen grains per cubic metre of air over the previous 24 hours.
    The count dated D is sampled up to the morning of D, so it mostly describes clock day
    D-1. The table keeps the published date (count_date); whoever lines it up with other
    data moves it one day earlier (see sql/pollen_schema.sql).
  - Missing is missing: the station does not count most weekends and holidays, and some
    days say "N/A" (technical difficulties). Those days get no row, never a zero, and an
    empty cell never overwrites a stored count. A published 0 is stored as 0.
  - Layout guards: a page without the calendar, or whose calendar does not contain the
    requested date, fails the run (failed heartbeat) instead of quietly writing nothing.
    A detail block that is not recognised, a cell with unexpected text, or a calendar
    with many past weekdays and not one count still stores what was read and writes a
    partial heartbeat that says why.
  - Heartbeat: one pds.sync_log row per run (source='pollen', data_type='daily'),
    written on success, partial, failure and an uncaught exception.
"""

import argparse
import html
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import httpx

from retry_helper import retry_http
from sync_log_helper import log_sync as _shared_log_sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("pollen_etl")
logging.getLogger("httpx").setLevel(logging.WARNING)

BASE_URL = "https://www.atlantaallergy.com/pollen_counts/index"
# Names the tool and how it behaves; no person, e-mail address or account.
USER_AGENT = "Mozilla/5.0 (compatible; OnyxPollenETL/1.0; private non-commercial use; one request per run)"
ET = ZoneInfo("America/New_York")
SOURCE = "atlanta-allergy-nab"
TABLE = "pollen_daily"

LEVELS = ("low", "medium", "high", "extreme")
BACKFILL_PAUSE_S = 5.0          # between month pages during a backfill
MAX_BACKFILL_MONTHS = 120
# A calendar with at least this many past weekdays and not a single count is not a quiet
# fortnight: the station counts on weekdays all year. Most likely the markup changed.
EMPTY_CALENDAR_WEEKDAYS = 10
UPSERT_BATCH = 500


class LayoutError(ValueError):
    """The page no longer looks like the pollen page this parser was written for."""


@dataclass(frozen=True)
class CalendarDay:
    day: date
    count: int | None       # None: a blank cell (no count that day) or "N/A"
    level: str | None       # the site's level for the total: low / medium / high / extreme
    text: str               # the cell as published ("", "N/A", "39")


@dataclass(frozen=True)
class Detail:
    day: date
    total: int
    tree_level: str | None = None
    grass_level: str | None = None
    weed_level: str | None = None
    mold_level: str | None = None
    tree_contributors: str | None = None
    grass_contributors: str | None = None
    weed_contributors: str | None = None


@dataclass
class PollenPage:
    days: list[CalendarDay]
    detail: Detail | None             # the day's own block, when it has a count
    no_data_for: date | None          # "There is no pollen data for MM/DD/YYYY"
    warnings: list[str] = field(default_factory=list)

    @property
    def detail_recognised(self) -> bool:
        return self.detail is not None or self.no_data_for is not None


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/test_pollen_etl.py - no network, no database)
# ---------------------------------------------------------------------------

_CAL_START = re.compile(r'class="calendar-body\b')
_CAL_END = re.compile(r'class="(?:certification|calendar-quicklinks)\b')
# One calendar cell: its class list, then (without crossing into the next cell) the link
# to the day's own page and the link text. "calendar-day-inner" is not a cell.
_CAL_CELL = re.compile(
    r'class="calendar-day(?P<cls>(?: [^"]*)?)"'
    r'(?P<body>(?:(?!class="calendar-day[ "]).)*?)'
    r'href="/pollen_counts/index/(?P<y>\d{4})/(?P<m>\d{2})/(?P<d>\d{2})"[^>]*>(?P<inner>.*?)</a>',
    re.S,
)
_TOTAL = re.compile(
    r"Total Pollen Count for\s+(?P<m>\d{2})/(?P<d>\d{2})/(?P<y>\d{4})\s*:\s*(?:<[^>]+>\s*)*(?P<n>[\d,]+)",
    re.S,
)
_NO_DATA = re.compile(r"There is no pollen data for\s+(?P<m>\d{2})/(?P<d>\d{2})/(?P<y>\d{4})")
_GAUGE = re.compile(
    r"<h3>\s*(?P<name>Trees|Grass|Weeds)\b[^<]*</h3>\s*<p>(?P<top>[^<]*)</p>"
    r'(?P<rest>(?:(?!<h3>).)*?)class="(?P<lvl>low|medium|high|extreme) active"',
    re.S,
)
_MOLD = re.compile(
    r"Mold Activity for\s+\d{2}/\d{2}/\d{4}\s*:?\s*</h4>"
    r'(?P<rest>(?:(?!</h4>|<h3>).)*?)class="(?P<lvl>low|medium|high|extreme) active"',
    re.S,
)
_TAG = re.compile(r"<[^>]+>")
_COUNT = re.compile(r"\d{1,3}(?:,\d{3})+|\d+")


def _clean(text: str) -> str:
    """Markup-free, entity-decoded, single-spaced text."""
    return " ".join(html.unescape(_TAG.sub(" ", text)).replace("\xa0", " ").split())


def _date(y: str, m: str, d: str) -> date | None:
    try:
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def parse_count(text: str) -> int | None:
    """A published total ("39", "1,482", "0") as an int; blank, "N/A" and anything else are None."""
    t = text.strip()
    return int(t.replace(",", "")) if _COUNT.fullmatch(t) else None


def _contributors(raw: str) -> str | None:
    """'ELM, MULBERRY, PINE&nbsp;' -> 'ELM, MULBERRY, PINE'; nothing listed -> None."""
    parts = [p.strip() for p in _clean(raw).split(",")]
    joined = ", ".join(p for p in parts if p)[:200]   # page text is untrusted: keep it bounded
    return joined or None


def parse_calendar(page_html: str) -> tuple[list[CalendarDay], list[str]]:
    """Every dated cell of the month calendar, in page order, plus warnings."""
    start = _CAL_START.search(page_html)
    if not start:
        raise LayoutError("no month calendar on the page (calendar-body not found)")
    end = _CAL_END.search(page_html, start.end())
    section = page_html[start.start(): end.start() if end else len(page_html)]

    days: dict[date, CalendarDay] = {}
    warnings: list[str] = []
    for m in _CAL_CELL.finditer(section):
        day = _date(m["y"], m["m"], m["d"])
        if day is None:
            continue
        text = _clean(m["inner"])
        count = parse_count(text)
        if count is None and text not in ("", "N/A"):
            warnings.append(f"unexpected calendar text {text[:20]!r} on {day}")
        classes = set(m["cls"].split())
        level = next((lv for lv in LEVELS if lv in classes), None) if count is not None else None
        cell = CalendarDay(day, count, level, text)
        # A date appears once per calendar; if it ever repeats, a count beats a blank.
        if day not in days or (days[day].count is None and count is not None):
            days[day] = cell
    if not days:
        raise LayoutError("the month calendar has no dated cells")
    return sorted(days.values(), key=lambda c: c.day), warnings


def parse_detail(page_html: str) -> tuple[Detail | None, date | None]:
    """The day's own block above the calendar: (detail with a count, or the 'no data' date)."""
    cal = _CAL_START.search(page_html)
    region = page_html[: cal.start()] if cal else page_html
    total = _TOTAL.search(region)
    if total:
        day = _date(total["y"], total["m"], total["d"])
        n = parse_count(total["n"])
        if day is not None and n is not None:
            after = region[total.end():]
            fields: dict[str, str | None] = {}
            for g in _GAUGE.finditer(after):
                key = {"Trees": "tree", "Grass": "grass", "Weeds": "weed"}[g["name"]]
                fields.setdefault(f"{key}_level", g["lvl"])
                fields.setdefault(f"{key}_contributors", _contributors(g["top"]))
            mold = _MOLD.search(after)
            if mold:
                fields["mold_level"] = mold["lvl"]
            return Detail(day=day, total=n, **fields), None
    none = _NO_DATA.search(region)
    if none:
        return None, _date(none["y"], none["m"], none["d"])
    return None, None


def parse_page(page_html: str) -> PollenPage:
    days, warnings = parse_calendar(page_html)
    detail, no_data_for = parse_detail(page_html)
    page = PollenPage(days=days, detail=detail, no_data_for=no_data_for, warnings=warnings)
    if not page.detail_recognised:
        page.warnings.append("the day's count block was not recognised (layout change?); calendar totals stored")
    return page


def rows_from_page(page: PollenPage, requested: date, today: date) -> tuple[list[dict], dict | None, list[str]]:
    """Upsert rows for one page: (calendar rows, the detail row or None, warnings).

    Calendar rows carry count_date / total_count / count_level / source; the detail row
    carries the day's tree / grass / weed / mold columns too. The two are upserted
    separately so each batch has one set of keys and a calendar-only run never blanks
    the detail columns of a day stored earlier. Days after `today` are never stored.
    """
    if not any(c.day == requested for c in page.days):
        raise LayoutError(f"the calendar does not contain the requested date {requested}")
    warnings = list(page.warnings)
    detail = page.detail if page.detail and page.detail.day <= today else None

    cal_rows = []
    for c in page.days:
        if c.count is None or c.day > today:
            continue
        total = detail.total if detail and detail.day == c.day else c.count
        cal_rows.append({"count_date": c.day.isoformat(), "total_count": total,
                         "count_level": c.level, "source": SOURCE})

    past_weekdays = sum(1 for c in page.days if c.day < today and c.day.weekday() < 5)
    if not cal_rows and past_weekdays >= EMPTY_CALENDAR_WEEKDAYS:
        warnings.append(f"no count in a calendar with {past_weekdays} past weekdays (layout change?)")

    detail_row = None
    if detail:
        detail_row = {
            "count_date": detail.day.isoformat(), "total_count": detail.total,
            "tree_level": detail.tree_level, "grass_level": detail.grass_level,
            "weed_level": detail.weed_level, "mold_level": detail.mold_level,
            "tree_contributors": detail.tree_contributors, "grass_contributors": detail.grass_contributors,
            "weed_contributors": detail.weed_contributors, "source": SOURCE,
        }
    return cal_rows, detail_row, warnings


def month_starts(today: date, months: int) -> list[date]:
    """The first day of the last `months` calendar months, oldest first, this month last."""
    out = []
    y, m = today.year, today.month
    for _ in range(months):
        out.append(date(y, m, 1))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def page_url(day: date, whole_month: bool = False) -> str:
    return f"{BASE_URL}/{day:%Y/%m}" if whole_month else f"{BASE_URL}/{day:%Y/%m/%d}"


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def get_supabase():
    """Service-role client. Imports are lazy so the pure helpers (and the tests) need no extras."""
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def make_client() -> httpx.Client:
    return httpx.Client(timeout=30.0, follow_redirects=True,
                        headers={"User-Agent": USER_AGENT, "Accept": "text/html"})


def fetch_page(client, url: str) -> str:
    try:
        return retry_http(lambda: client.get(url), max_attempts=3, base_wait=5.0, log=log).text
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f"atlantaallergy.com HTTP {exc.response.status_code} for {url}") from exc


def log_sync(sb, status: str, records: int, started_at: float, error: str | None = None,
             date_range: tuple[date, date] | None = None) -> None:
    _shared_log_sync(
        sb, source="pollen", data_type="daily", status=status, records=records,
        started_at=started_at, error=error,
        date_range_start=date_range[0] if date_range else None,
        date_range_end=date_range[1] if date_range else None,
    )


def _missing_table(exc: Exception) -> bool:
    msg = str(exc)
    return TABLE in msg and any(s in msg for s in ("PGRST205", "does not exist", "schema cache", "42P01"))


def _upsert(sb, rows: list[dict], stamp: str) -> None:
    for i in range(0, len(rows), UPSERT_BATCH):
        batch = [{**r, "synced_at": stamp} for r in rows[i:i + UPSERT_BATCH]]
        sb.schema("pds").table(TABLE).upsert(batch, on_conflict="count_date").execute()


def run_etl(backfill_months: int | None = None, dry_run: bool = False, sb=None, client=None,
            now: datetime | None = None, sleep=time.sleep) -> int:
    """Fetch, parse and upsert. Returns the number of distinct count days written.

    backfill_months=None is the routine run: today's dated page (one request). N fetches
    the month pages of the last N calendar months, oldest first, BACKFILL_PAUSE_S apart.
    """
    started = time.time()
    now_et = (now or datetime.now(ET)).astimezone(ET)
    today = now_et.date()
    written: set[str] = set()
    warnings: list[str] = []
    own_client = client is None
    try:
        if not dry_run:
            sb = sb or get_supabase()
        if backfill_months is None:
            targets = [(today, page_url(today))]
        else:
            targets = [(d, page_url(d, whole_month=True)) for d in month_starts(today, backfill_months)]
        log.info(f"Pollen: {len(targets)} page(s), {targets[0][0]} -> {today}")

        client = client or make_client()
        for i, (requested, url) in enumerate(targets):
            if i:
                sleep(BACKFILL_PAUSE_S)
            page = parse_page(fetch_page(client, url))
            cal_rows, detail_row, page_warnings = rows_from_page(page, requested, today)
            warnings += [f"{requested:%Y-%m}: {w}" for w in page_warnings]
            if dry_run:
                for r in cal_rows[-5:]:
                    log.info(f"  [dry-run] {r}")
                if detail_row:
                    log.info(f"  [dry-run] detail {detail_row}")
            else:
                stamp = datetime.now(timezone.utc).isoformat()
                _upsert(sb, cal_rows, stamp)
                if detail_row:
                    _upsert(sb, [detail_row], stamp)
            written.update(r["count_date"] for r in cal_rows)
            if detail_row:
                written.add(detail_row["count_date"])
            log.info(f"  {requested:%Y-%m}: {len(cal_rows)} count(s)"
                     + (f", detail for {detail_row['count_date']}" if detail_row else ""))

        if dry_run:
            log.info(f"Dry run: {len(written)} day row(s) would be written")
            for w in warnings:
                log.warning(f"  {w}")
            return len(written)
        rng = (date.fromisoformat(min(written)), date.fromisoformat(max(written))) if written else None
        if warnings:
            log_sync(sb, "partial", len(written), started, error="; ".join(warnings)[:500], date_range=rng)
            for w in warnings:
                log.warning(w)
        else:
            log_sync(sb, "success", len(written), started, date_range=rng)
        log.info(f"Done: {len(written)} day row(s) upserted")
        return len(written)
    except Exception as exc:  # noqa: BLE001 - heartbeat, then fail the Actions run
        if dry_run or sb is None:
            raise
        msg = f"{type(exc).__name__}: {exc}"
        if _missing_table(exc):
            msg = f"pds.{TABLE} is missing - apply sql/pollen_schema.sql. {msg}"
        if written:
            msg += f" (after {len(written)} day row(s))"
        log.error(msg)
        log_sync(sb, "failed", len(written), started, error=msg[:500])
        sys.exit(1)
    finally:
        if own_client and client is not None:
            client.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Pollen ETL - Atlanta Allergy & Asthma daily count -> pds.pollen_daily")
    ap.add_argument("--backfill-months", type=int,
                    help=f"re-sync the last N calendar months, one request each (1-{MAX_BACKFILL_MONTHS})")
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, write nothing")
    args = ap.parse_args()
    if args.backfill_months is not None and not 1 <= args.backfill_months <= MAX_BACKFILL_MONTHS:
        ap.error(f"--backfill-months must be between 1 and {MAX_BACKFILL_MONTHS}")
    run_etl(args.backfill_months, dry_run=args.dry_run)


if __name__ == "__main__":
    # Top-level failure heartbeat so an uncaught exception (bad argument, no Supabase
    # credentials) still surfaces on /status instead of silently going stale.
    _t0 = time.time()
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - top-level safety net
        if "--dry-run" not in sys.argv:
            try:
                log_sync(get_supabase(), "failed", 0, _t0, error=f"Uncaught exception: {exc}"[:500])
            except Exception as log_exc:  # noqa: BLE001
                log.error(f"Could not write failure sync_log row: {log_exc}")
        raise
