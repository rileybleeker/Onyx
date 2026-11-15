"""Pollen (Atlanta Allergy & Asthma): page parser, row building, and the ETL run.

Covers
  * pollen_etl.parse_page on a saved SYNTHETIC page (tests/fixtures/pollen_atlanta_2026_04_08.html,
    the site's markup with made-up numbers): every calendar cell read with the date from its
    own link (neighbouring-month padding included), "1,482" -> 1482, a published 0 kept, blank
    and "N/A" cells give no count, the day's tree / grass / weed / mold block;
  * rows_from_page: missing days never become rows or zeros, days after today are dropped, the
    day's own total wins over its calendar cell, the layout guards (no calendar, requested date
    absent, an all-blank calendar, an unrecognised day block);
  * run_etl with a fake HTTP client and a fake Supabase client: the routine run makes exactly ONE
    request with a person-free User-Agent; backfill is one request per month, paused; success /
    partial / failure each write exactly one pollen|daily heartbeat; a missing table names
    sql/pollen_schema.sql; a dry run writes nothing.

Synthetic data only. No network, no credentials.

Run: python tests/test_pollen_etl.py
"""
import calendar
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx  # noqa: E402

import pollen_etl as etl  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "pollen_atlanta_2026_04_08.html"
PAGE = FIXTURE.read_text(encoding="utf-8")
TODAY = date(2026, 4, 8)
NOW = datetime(2026, 4, 8, 13, 0, tzinfo=etl.ET)


def _month_page(year, month, counts=None, detail_html=None):
    """A minimal synthetic month page: one cell per day (counts {day: text}), a 'no data' block."""
    counts = counts or {}
    cells = []
    for d in range(1, calendar.monthrange(year, month)[1] + 1):
        text = counts.get(d, "")
        cls = " current" + (" low" if text not in ("", "N/A") else "")
        cells.append(f'<div class="calendar-day{cls}"><div class="calendar-day-inner"><span class="day-num">{d}</span>'
                     f'<span class="count"><a href="/pollen_counts/index/{year}/{month:02d}/{d:02d}">{text}</a>'
                     f'</span></div></div>')
    detail = detail_html if detail_html is not None else f"<p>There is no pollen data for {month:02d}/01/{year}</p>"
    return (f'<html><body><div class="widget-body">{detail}</div><div class="calendar-wrapper">'
            f'<div class="calendar-body rows-5">{"".join(cells)}</div></div><div class="certification"></div></body></html>')


def _rows(page_html, requested=TODAY, today=TODAY):
    return etl.rows_from_page(etl.parse_page(page_html), requested, today)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def test_calendar_cells_carry_their_own_dates():
    page = etl.parse_page(PAGE)
    assert len(page.days) == 35, "Mar 29 .. May 2: the month plus its padding days"
    assert page.days[0].day == date(2026, 3, 29) and page.days[-1].day == date(2026, 5, 2)
    by_day = {c.day: c for c in page.days}
    assert (by_day[date(2026, 3, 30)].count, by_day[date(2026, 3, 30)].level) == (2315, "extreme")
    assert (by_day[date(2026, 4, 1)].count, by_day[date(2026, 4, 1)].level) == (1482, "high")
    assert by_day[date(2026, 4, 3)].count == 0, "a published 0 is a real count"
    assert (by_day[date(2026, 3, 31)].count, by_day[date(2026, 3, 31)].text) == (None, "N/A")
    assert by_day[date(2026, 4, 4)].count is None and by_day[date(2026, 4, 4)].level is None
    assert page.warnings == []


def test_month_only_links_are_not_calendar_cells():
    page = etl.parse_page(PAGE)
    assert all(c.day.day != 1 or c.day.month in (4, 5) for c in page.days), "quick links (YYYY/MM) are ignored"


def test_day_block_levels_and_contributors():
    page = etl.parse_page(PAGE)
    d = page.detail
    assert d is not None and d.day == TODAY and d.total == 87
    assert (d.tree_level, d.grass_level, d.weed_level, d.mold_level) == ("medium", "low", "low", "medium")
    assert d.tree_contributors == "OAK, PINE, BIRCH", "&nbsp; and spacing removed"
    assert d.grass_contributors == "GRASS"
    assert d.weed_contributors is None, "nothing listed -> NULL, not an empty string"
    assert page.no_data_for is None and page.detail_recognised


def test_no_data_page_is_recognised():
    html = _month_page(2026, 10, {1: "62", 2: "284"})
    page = etl.parse_page(html)
    assert page.detail is None and page.no_data_for == date(2026, 10, 1) and page.detail_recognised
    assert page.warnings == []


def test_parse_count():
    assert etl.parse_count("39") == 39 and etl.parse_count(" 1,482 ") == 1482 and etl.parse_count("0") == 0
    for text in ("", "N/A", "n/a", "12a", "1,48", "-3", "3.5"):
        assert etl.parse_count(text) is None, text


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

def test_rows_skip_missing_days_and_never_zero_fill():
    cal, detail, warnings = _rows(PAGE)
    assert [(r["count_date"], r["total_count"]) for r in cal] == [
        ("2026-03-30", 2315), ("2026-04-01", 1482), ("2026-04-02", 960), ("2026-04-03", 0),
        ("2026-04-06", 3021), ("2026-04-07", 512), ("2026-04-08", 87)]
    assert all(set(r) == {"count_date", "total_count", "count_level", "source"} for r in cal), "one key set per batch"
    assert detail["count_date"] == "2026-04-08" and detail["tree_contributors"] == "OAK, PINE, BIRCH"
    assert warnings == []


def test_days_after_today_are_never_stored():
    cal, detail, _ = _rows(PAGE, requested=date(2026, 4, 6), today=date(2026, 4, 6))
    assert max(r["count_date"] for r in cal) == "2026-04-06"
    assert detail is None, "the day block is for 04-08, after 'today'"


def test_day_block_total_wins_and_fills_a_blank_cell():
    disagree = PAGE.replace('2026/04/08">87</a>', '2026/04/08">86</a>')
    cal, _, _ = _rows(disagree)
    assert [r["total_count"] for r in cal if r["count_date"] == "2026-04-08"] == [87]
    blank = PAGE.replace('2026/04/08">87</a>', '2026/04/08"></a>')
    cal, detail, _ = _rows(blank)
    assert "2026-04-08" not in {r["count_date"] for r in cal} and detail["total_count"] == 87


def test_layout_guards():
    no_calendar = PAGE.split('<div class="calendar-body')[0]
    for html, requested in ((no_calendar, TODAY), (PAGE, date(2026, 6, 1))):
        try:
            _rows(html, requested=requested)
        except etl.LayoutError:
            pass
        else:
            raise AssertionError("a page that is not the expected pollen page must fail the run")


def test_all_blank_calendar_is_flagged_only_when_suspicious():
    blank = re.sub(r'(href="/pollen_counts/index/\d{4}/\d{2}/\d{2}"[^>]*>)[^<]+(</a>)', r"\1\2", PAGE)
    no_detail = blank.split("<h3>Total Pollen Count")[0] + "<p>There is no pollen data for 04/08/2026</p>" \
        + blank[blank.index('<div class="calendar-wrapper">'):]
    _, _, early = _rows(no_detail)                                      # 7 past weekdays: could be real
    _, _, late = _rows(no_detail, requested=date(2026, 4, 30), today=date(2026, 4, 30))   # 23 past weekdays
    assert early == []
    assert len(late) == 1 and "layout change" in late[0]


def test_unrecognised_day_block_keeps_the_calendar_and_warns():
    html = PAGE.replace("Total Pollen Count for", "Pollen today:")
    cal, detail, warnings = _rows(html)
    assert len(cal) == 7 and detail is None
    assert len(warnings) == 1 and "not recognised" in warnings[0]


def test_unexpected_cell_text_warns():
    html = PAGE.replace('2026/04/02">960</a>', '2026/04/02">pending</a>')
    cal, _, warnings = _rows(html)
    assert "2026-04-02" not in {r["count_date"] for r in cal}
    assert len(warnings) == 1 and "pending" in warnings[0]


def test_month_starts_and_urls():
    assert etl.month_starts(date(2026, 2, 17), 3) == [date(2025, 12, 1), date(2026, 1, 1), date(2026, 2, 1)]
    assert etl.page_url(date(2026, 4, 8)) == "https://www.atlantaallergy.com/pollen_counts/index/2026/04/08"
    assert etl.page_url(date(2026, 4, 1), whole_month=True) == "https://www.atlantaallergy.com/pollen_counts/index/2026/04"


# ---------------------------------------------------------------------------
# run_etl
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, url, text, status=200):
        self.url, self.text, self.status_code = url, text, status

    def raise_for_status(self):
        if self.status_code >= 400:
            req = httpx.Request("GET", self.url)
            raise httpx.HTTPStatusError("boom", request=req, response=httpx.Response(self.status_code, request=req))


class FakeHttp:
    """`pages` maps URL -> HTML (or an int HTTP status); anything else is a 404."""

    def __init__(self, pages):
        self.pages, self.urls = pages, []

    def get(self, url):
        self.urls.append(url)
        body = self.pages.get(url, 404)
        return FakeResponse(url, "", body) if isinstance(body, int) else FakeResponse(url, body)


class FakeSupabase:
    def __init__(self, upsert_error=None):
        self.upsert_error = upsert_error
        self.upserts, self.heartbeats = [], []
        self._table = None

    def schema(self, _):
        return self

    def table(self, name):
        self._table = name
        return self

    def insert(self, row):
        assert self._table == "sync_log"
        self.heartbeats.append(row)
        return self

    def upsert(self, rows, on_conflict=None):
        if self.upsert_error:
            raise RuntimeError(self.upsert_error)
        assert self._table == "pollen_daily" and on_conflict == "count_date"
        self.upserts.append(rows)
        return self

    def execute(self):
        return self


def _run(sb, pages, months=None, dry_run=False):
    http, sleeps = FakeHttp(pages), []
    try:
        n = etl.run_etl(months, dry_run=dry_run, sb=sb, client=http, now=NOW, sleep=sleeps.append)
    except SystemExit as exc:
        n = exc
    return n, http.urls, sleeps


def test_routine_run_makes_one_request_and_one_success_heartbeat():
    sb = FakeSupabase()
    url = etl.page_url(TODAY)
    n, urls, sleeps = _run(sb, {url: PAGE})
    assert urls == [url] and sleeps == [], "one request per routine run"
    assert n == 7
    cal_batch, detail_batch = sb.upserts
    assert len(cal_batch) == 7 and all("synced_at" in r for r in cal_batch)
    assert len({frozenset(r) for r in cal_batch}) == 1, "PostgREST batch with one key set"
    assert detail_batch[0]["count_date"] == "2026-04-08" and detail_batch[0]["mold_level"] == "medium"
    assert "tree_level" not in cal_batch[0], "a calendar row never blanks the day-block columns"
    assert len(sb.heartbeats) == 1
    beat = sb.heartbeats[0]
    assert (beat["source"], beat["data_type"], beat["status"], beat["records_synced"]) == ("pollen", "daily", "success", 7)
    assert (beat["date_range_start"], beat["date_range_end"]) == ("2026-03-30", "2026-04-08")


def test_user_agent_names_the_tool_not_a_person():
    ua = etl.USER_AGENT
    assert "OnyxPollenETL" in ua and "@" not in ua and "riley" not in ua.lower() and "bleeker" not in ua.lower()
    with etl.make_client() as client:
        assert client.headers["User-Agent"] == ua


def test_backfill_is_one_request_per_month_with_pauses():
    sb = FakeSupabase()
    pages = {
        etl.page_url(date(2026, 2, 1), whole_month=True): _month_page(2026, 2, {2: "12", 3: "N/A", 4: "1,020"}),
        etl.page_url(date(2026, 3, 1), whole_month=True): _month_page(2026, 3, {2: "40"}),
        etl.page_url(date(2026, 4, 1), whole_month=True): PAGE,
    }
    n, urls, sleeps = _run(sb, pages, months=3)
    assert urls == list(pages), "oldest month first, one request each"
    assert sleeps == [etl.BACKFILL_PAUSE_S] * 2
    assert n == 3 + 7, "Feb 2 + Feb 4 + Mar 2, then April's seven"
    assert [b["status"] for b in sb.heartbeats] == ["success"]


def test_http_error_is_a_failed_heartbeat_and_a_nonzero_exit():
    sb = FakeSupabase()
    n, urls, _ = _run(sb, {})
    assert isinstance(n, SystemExit) and n.code == 1
    assert len(urls) == 1, "a 404 is not retried"
    assert [b["status"] for b in sb.heartbeats] == ["failed"]
    assert "HTTP 404" in sb.heartbeats[0]["error_message"]


def test_layout_change_is_a_failed_heartbeat():
    sb = FakeSupabase()
    n, _, _ = _run(sb, {etl.page_url(TODAY): "<html><body>We moved the pollen count.</body></html>"})
    assert isinstance(n, SystemExit)
    assert not sb.upserts
    assert [b["status"] for b in sb.heartbeats] == ["failed"]
    assert "LayoutError" in sb.heartbeats[0]["error_message"]


def test_unrecognised_day_block_is_a_partial_heartbeat():
    sb = FakeSupabase()
    html = PAGE.replace("Total Pollen Count for", "Pollen today:")
    n, _, _ = _run(sb, {etl.page_url(TODAY): html})
    assert n == 7 and len(sb.upserts) == 1
    assert [b["status"] for b in sb.heartbeats] == ["partial"]
    assert "not recognised" in sb.heartbeats[0]["error_message"]


def test_missing_table_error_names_the_sql_file():
    sb = FakeSupabase(upsert_error="Could not find the table 'pds.pollen_daily' in the schema cache (PGRST205)")
    n, _, _ = _run(sb, {etl.page_url(TODAY): PAGE})
    assert isinstance(n, SystemExit)
    assert len(sb.heartbeats) == 1 and sb.heartbeats[0]["status"] == "failed"
    assert "sql/pollen_schema.sql" in sb.heartbeats[0]["error_message"]


def test_dry_run_writes_nothing():
    n, urls, _ = _run(None, {etl.page_url(TODAY): PAGE}, dry_run=True)
    assert n == 7 and len(urls) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
