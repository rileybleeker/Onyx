"""Google Calendar (iCal feed) ETL: parsing, expansion, keys, reconciliation, heartbeat, secrecy.

Covers google_calendar_etl.py:
  * parse_feeds_secret / mask_values: shape errors name a position and never a value;
  * expand_events + build_row: UTC / TZID / floating / all-day times, inclusive end dates, the
    X-WR-TIMEZONE trap (the header must be removed before expansion), EXDATE in every form,
    RECURRENCE-ID overrides matched by instant, moved / cancelled / orphan instances, RRULE
    UNTIL / COUNT / RDATE / month-end rules, DST edge times, malformed series, text decoding,
    other component types, and that nothing but the listed fields is ever in a row;
  * stable keys: a moved one-off keeps its row, a moved instance keeps its original slot;
  * run() against an in-memory fake Supabase: upsert, removal of events that left the feed,
    NO removal for a calendar whose fetch or parse failed, the large-removal guard, calendars
    taken out of the secret;
  * main(): exactly one sync_log heartbeat per run (success / partial / failed), a missing table
    names the SQL file, and no feed URL or event title in any heartbeat or log line.

Synthetic data only (invented titles, example.com). No network, no credentials.

Run: python tests/test_google_calendar.py
"""
import logging
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx  # noqa: E402

import google_calendar_etl as etl  # noqa: E402

etl.RETRY_WAIT_S = 0   # no real waiting in tests

TODAY = date(2026, 11, 13)
WIN = etl.window_bounds(TODAY, 400)           # 2025-10-09 .. 2027-12-18
TOKEN = "private-0123456789abcdef0123456789abcdef"
URL_A = f"https://calendar.example.com/calendar/ical/owner%40example.com/{TOKEN}/basic.ics"
URL_B = "https://calendar.example.com/calendar/ical/second%40example.com/private-fedcba9876543210fedcba9876543210/basic.ics"
FEED_A = etl.Feed("acct one", "main", URL_A)
FEED_B = etl.Feed("acct two", "side", URL_B)
SECRET_TITLE = "Synthetic Planning Session"


def cal(body: str, tz: str | None = "America/New_York", extra: str = "") -> str:
    head = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//Test//EN\r\nCALSCALE:GREGORIAN\r\n"
    if tz:
        head += f"X-WR-TIMEZONE:{tz}\r\n"
    return head + extra + body.strip("\n").replace("\n", "\r\n") + "\r\nEND:VCALENDAR\r\n"


def vevent(*lines: str) -> str:
    return "BEGIN:VEVENT\n" + "\n".join(lines) + "\nEND:VEVENT\n"


def expand(body: str, tz: str | None = "America/New_York", win=WIN, extra: str = ""):
    return etl.expand_events(cal(body, tz, extra), "acct one", "main", *win)


def rows_of(body: str, **kw) -> list[dict]:
    return expand(body, **kw)[0]


def starts(rows: list[dict]) -> list[str]:
    return [r["start_at"][:16] for r in rows]


def by_title(rows: list[dict], title: str) -> list[dict]:
    return [r for r in rows if r["title"] == title]


# ---------------------------------------------------------------------------
# Secret parsing and masking
# ---------------------------------------------------------------------------

def test_secret_parses_a_list_of_feeds():
    raw = '[{"account": "acct one", "calendar": "main", "url": "%s"}, {"account": "acct two", "calendar": "side", "url": "%s"}]' % (URL_A, URL_B)
    feeds = etl.parse_feeds_secret(raw)
    assert [(f.account, f.calendar, f.url) for f in feeds] == [("acct one", "main", URL_A), ("acct two", "side", URL_B)]
    assert URL_A not in repr(feeds[0]), "the URL must not appear in a repr"
    webcal = etl.parse_feeds_secret('[{"account": "a", "calendar": "c", "url": "webcal://calendar.example.com/x/basic.ics"}]')
    assert webcal[0].url == "https://calendar.example.com/x/basic.ics"


def test_secret_errors_never_quote_a_value():
    bad = [
        None, "", "   ", "not json " + URL_A, "{}", "[]", '["x"]',
        '[{"account": "a", "calendar": "c"}]',
        '[{"account": "a", "calendar": "c", "url": "http://calendar.example.com/%s"}]' % TOKEN,
        '[{"account": "owner@example.com", "calendar": "c", "url": "%s"}]' % URL_A,
        '[{"account": "%s", "calendar": "c", "url": "%s"}]' % (URL_A, URL_A),
        '[{"account": "a", "calendar": "", "url": "%s"}]' % URL_A,
        '[{"account": "a", "calendar": "c", "url": "%s"}, {"account": "A", "calendar": "C", "url": "%s"}]' % (URL_A, URL_B),
    ]
    for raw in bad:
        try:
            etl.parse_feeds_secret(raw)
        except etl.ConfigError as exc:
            text = str(exc)
            assert "example.com" not in text and TOKEN not in text, text
            assert exc.__cause__ is None and exc.__suppress_context__ in (True, False)
            assert exc.__context__ is None or exc.__suppress_context__, "no chained JSON error carrying the secret"
        else:
            raise AssertionError(f"accepted a bad secret: {raw!r}")


def test_mask_values_cover_the_url_and_its_private_parts():
    values = etl.mask_values([FEED_A, FEED_B])
    assert URL_A in values and URL_B in values
    assert TOKEN in values and "owner%40example.com" in values and "owner@example.com" in values
    assert "basic.ics" not in values and "ical" not in values, "short public words would garble every log line"


# ---------------------------------------------------------------------------
# Times: UTC form, TZID, floating, all-day
# ---------------------------------------------------------------------------

def test_single_utc_event_uses_the_calendar_zone_for_its_local_date():
    rows = rows_of(vevent("UID:single-1@example.com", "DTSTART:20261113T030000Z", "DTEND:20261113T040000Z", "SUMMARY:Late call"))
    assert len(rows) == 1
    r = rows[0]
    assert r["start_at"] == "2026-11-13T03:00:00+00:00" and r["end_at"] == "2026-11-13T04:00:00+00:00"
    assert r["tz"] == "America/New_York" and r["all_day"] is False and r["recurring"] is False
    assert (r["start_date"], r["end_date"]) == ("2026-11-12", "2026-11-12"), "03:00Z is the evening before in ET"
    assert r["status"] == "confirmed" and r["location"] is None


def test_event_with_its_own_zone_keeps_it():
    rows = rows_of(vevent("UID:madrid@example.com", "DTSTART;TZID=Europe/Madrid:20261113T003000",
                          "DTEND;TZID=Europe/Madrid:20261113T013000", "SUMMARY:Abroad"))
    r = rows[0]
    assert r["tz"] == "Europe/Madrid"
    assert r["start_at"] == "2026-11-12T23:30:00+00:00"
    assert (r["start_date"], r["end_date"]) == ("2026-11-13", "2026-11-13"), "local dates are in the event's zone"


def test_floating_time_uses_the_calendar_zone_and_falls_back_to_et():
    body = vevent("UID:float@example.com", "DTSTART:20261112T100000", "DTEND:20261112T110000", "SUMMARY:Floating")
    with_header = rows_of(body, tz="America/Chicago")[0]
    assert with_header["start_at"] == "2026-11-12T16:00:00+00:00" and with_header["tz"] == "America/Chicago"
    no_header = rows_of(body, tz=None)[0]
    assert no_header["start_at"] == "2026-11-12T15:00:00+00:00" and no_header["tz"] == "America/New_York"


def test_unknown_zone_is_read_in_the_calendar_zone_and_windows_names_are_mapped():
    rows = rows_of(
        vevent("UID:bogus@example.com", "DTSTART;TZID=Nowhere/Bogus:20261112T100000", "DTEND;TZID=Nowhere/Bogus:20261112T110000", "SUMMARY:Bogus zone")
        + vevent("UID:win@example.com", "DTSTART;TZID=Eastern Standard Time:20261112T100000", "DTEND;TZID=Eastern Standard Time:20261112T110000", "SUMMARY:Windows zone"),
        tz="America/Chicago")
    bogus, win = by_title(rows, "Bogus zone")[0], by_title(rows, "Windows zone")[0]
    assert bogus["start_at"] == "2026-11-12T16:00:00+00:00" and bogus["tz"] == "America/Chicago"
    assert win["start_at"] == "2026-11-12T15:00:00+00:00" and win["tz"] == "America/New_York"


def test_all_day_single_event_is_one_date_with_no_instant():
    rows = rows_of(vevent("UID:allday@example.com", "DTSTART;VALUE=DATE:20261113", "DTEND;VALUE=DATE:20261114", "SUMMARY:Day off"))
    r = rows[0]
    assert r["all_day"] is True and r["start_at"] is None and r["end_at"] is None and r["tz"] is None
    assert (r["start_date"], r["end_date"]) == ("2026-11-13", "2026-11-13"), "DTEND is exclusive; no -6 h shift"


def test_all_day_multi_day_event_is_one_row_with_an_inclusive_end():
    rows = rows_of(vevent("UID:trip@example.com", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261113", "SUMMARY:Three days"))
    assert len(rows) == 1
    assert (rows[0]["start_date"], rows[0]["end_date"]) == ("2026-11-10", "2026-11-12")


def test_missing_dtend_is_zero_duration_or_one_day():
    rows = rows_of(vevent("UID:noend@example.com", "DTSTART:20261112T100000Z", "SUMMARY:No end")
                   + vevent("UID:noend-day@example.com", "DTSTART;VALUE=DATE:20261112", "SUMMARY:No end day"))
    timed, day = by_title(rows, "No end")[0], by_title(rows, "No end day")[0]
    assert timed["start_at"] == timed["end_at"] and timed["start_date"] == timed["end_date"] == "2026-11-12"
    assert (day["start_date"], day["end_date"]) == ("2026-11-12", "2026-11-12")


def test_timed_events_across_midnight_several_days_and_a_dst_change():
    rows = rows_of(
        vevent("UID:late@example.com", "DTSTART;TZID=America/New_York:20261112T230000", "DTEND;TZID=America/New_York:20261113T010000", "SUMMARY:Past midnight")
        + vevent("UID:tomidnight@example.com", "DTSTART;TZID=America/New_York:20261112T200000", "DTEND;TZID=America/New_York:20261113T000000", "SUMMARY:Ends at midnight")
        + vevent("UID:long@example.com", "DTSTART;TZID=America/New_York:20261120T090000", "DTEND;TZID=America/New_York:20261123T170000", "SUMMARY:Several days")
        + vevent("UID:dst@example.com", "DTSTART;TZID=America/New_York:20261031T220000", "DTEND;TZID=America/New_York:20261101T060000", "SUMMARY:Over the clock change"))
    late = by_title(rows, "Past midnight")[0]
    assert (late["start_date"], late["end_date"]) == ("2026-11-12", "2026-11-13")
    edge = by_title(rows, "Ends at midnight")[0]
    assert (edge["start_date"], edge["end_date"]) == ("2026-11-12", "2026-11-12"), "an end at local midnight belongs to the day before"
    long = by_title(rows, "Several days")[0]
    assert (long["start_date"], long["end_date"]) == ("2026-11-20", "2026-11-23")
    dst = by_title(rows, "Over the clock change")[0]
    hours = (datetime.fromisoformat(dst["end_at"]) - datetime.fromisoformat(dst["start_at"])).total_seconds() / 3600
    assert hours == 9, "22:00 EDT to 06:00 EST is nine real hours"


def test_all_day_events_on_the_first_and_last_window_day_are_included():
    win = etl.window_bounds(TODAY, 10)   # 2026-11-03 .. 2026-11-23
    rows = rows_of(
        vevent("UID:first@example.com", "DTSTART;VALUE=DATE:20261103", "DTEND;VALUE=DATE:20261104", "SUMMARY:First day")
        + vevent("UID:last@example.com", "DTSTART;VALUE=DATE:20261123", "DTEND;VALUE=DATE:20261124", "SUMMARY:Last day")
        + vevent("UID:before@example.com", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102", "SUMMARY:Before")
        + vevent("UID:after@example.com", "DTSTART;VALUE=DATE:20261125", "DTEND;VALUE=DATE:20261126", "SUMMARY:After"),
        win=win)
    assert sorted(r["title"] for r in rows) == ["First day", "Last day"]


# ---------------------------------------------------------------------------
# Recurrence: DST, the X-WR-TIMEZONE trap, EXDATE, overrides
# ---------------------------------------------------------------------------

def test_tzid_series_keeps_local_time_across_the_clock_change():
    rows = rows_of(vevent("UID:weekly@example.com", "DTSTART;TZID=America/New_York:20261022T090000",
                          "DTEND;TZID=America/New_York:20261022T100000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Weekly local"))
    assert starts(rows) == ["2026-10-22T13:00", "2026-10-29T13:00", "2026-11-05T14:00", "2026-11-12T14:00"]
    assert all(r["recurring"] and r["tz"] == "America/New_York" for r in rows)
    assert len({r["event_key"] for r in rows}) == 4


def test_utc_series_stays_constant_in_utc_the_x_wr_timezone_trap():
    """Regression for the library default: with X-WR-TIMEZONE applied, this series is rewritten to
    09:00 local before expansion and its November instances come out at 14:00Z instead of 13:00Z."""
    rows = rows_of(vevent("UID:utc-weekly@example.com", "DTSTART:20261022T130000Z", "DTEND:20261022T140000Z",
                          "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Weekly utc"))
    assert starts(rows) == ["2026-10-22T13:00", "2026-10-29T13:00", "2026-11-05T13:00", "2026-11-12T13:00"]
    assert [r["tz"] for r in rows] == ["America/New_York"] * 4, "the header still supplies the display zone"


def test_the_timezone_header_is_removed_before_expansion():
    seen = {}
    real = etl.recurring_ical_events.of

    def spy(calendar, *args, **kwargs):
        seen["has_header"] = "X-WR-TIMEZONE" in calendar
        return real(calendar, *args, **kwargs)

    etl.recurring_ical_events.of = spy
    try:
        rows_of(vevent("UID:any@example.com", "DTSTART:20261113T150000Z", "SUMMARY:Any"))
    finally:
        etl.recurring_ical_events.of = real
    assert seen == {"has_header": False}


def test_override_is_matched_by_instant_across_utc_and_tzid_forms():
    utc_master = rows_of(
        vevent("UID:mix-a@example.com", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Base A")
        + vevent("UID:mix-a@example.com", "RECURRENCE-ID;TZID=America/New_York:20261103T090000",
                 "DTSTART;TZID=America/New_York:20261103T090000", "DTEND;TZID=America/New_York:20261103T100000", "SUMMARY:Edited A"))
    assert [r["title"] for r in utc_master] == ["Base A", "Edited A", "Base A"], "no base-plus-override pair"
    tz_master = rows_of(
        vevent("UID:mix-b@example.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
               "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Base B")
        + vevent("UID:mix-b@example.com", "RECURRENCE-ID:20261103T140000Z", "DTSTART:20261103T140000Z", "DTEND:20261103T150000Z", "SUMMARY:Edited B"))
    assert [r["title"] for r in tz_master] == ["Base B", "Edited B", "Base B"]
    assert len({r["event_key"] for r in tz_master}) == 3


def test_exdate_in_every_form_removes_the_instance():
    rows = rows_of(
        vevent("UID:ex@example.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
               "RRULE:FREQ=DAILY;COUNT=6",
               "EXDATE;TZID=America/New_York:20261103T090000",
               "EXDATE:20261104T140000Z",
               "EXDATE;TZID=America/New_York:20261106T090000",
               "SUMMARY:With gaps")
        + vevent("UID:ex-day@example.com", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103", "RRULE:FREQ=DAILY;COUNT=4",
                 "EXDATE;VALUE=DATE:20261104", "SUMMARY:Day series"))
    assert [r["start_date"] for r in by_title(rows, "With gaps")] == ["2026-11-02", "2026-11-05", "2026-11-07"]
    assert [r["start_date"] for r in by_title(rows, "Day series")] == ["2026-11-02", "2026-11-03", "2026-11-05"]


def test_all_day_series_override_can_change_its_length():
    rows = rows_of(
        vevent("UID:len@example.com", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Weekly day")
        + vevent("UID:len@example.com", "RECURRENCE-ID;VALUE=DATE:20261109", "DTSTART;VALUE=DATE:20261109", "DTEND;VALUE=DATE:20261112", "SUMMARY:Weekly day long"))
    assert [(r["title"], r["start_date"], r["end_date"]) for r in rows] == [
        ("Weekly day", "2026-11-02", "2026-11-02"), ("Weekly day long", "2026-11-09", "2026-11-11"), ("Weekly day", "2026-11-16", "2026-11-16")]


SERIES = vevent("UID:series@example.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
                "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Daily")


def test_moved_instance_keeps_the_key_of_its_original_slot():
    before = {r["start_date"]: r["event_key"] for r in rows_of(SERIES)}
    moved = rows_of(SERIES + vevent("UID:series@example.com", "RECURRENCE-ID;TZID=America/New_York:20261104T090000",
                                    "DTSTART;TZID=America/New_York:20261109T150000", "DTEND;TZID=America/New_York:20261109T160000", "SUMMARY:Daily moved"))
    instance = by_title(moved, "Daily moved")[0]
    assert instance["start_date"] == "2026-11-09" and instance["start_at"] == "2026-11-09T20:00:00+00:00"
    assert instance["event_key"] == before["2026-11-04"], "the key is the original slot, not the new time"
    assert len(moved) == 5 and "2026-11-04" not in [r["start_date"] for r in moved]


def test_title_only_override_keeps_the_same_key():
    before = {r["start_date"]: r["event_key"] for r in rows_of(SERIES)}
    after = rows_of(SERIES + vevent("UID:series@example.com", "RECURRENCE-ID:20261104T140000Z",
                                    "DTSTART;TZID=America/New_York:20261104T090000", "DTEND;TZID=America/New_York:20261104T100000", "SUMMARY:Daily renamed"))
    renamed = by_title(after, "Daily renamed")[0]
    assert renamed["event_key"] == before["2026-11-04"]
    assert {r["start_date"]: r["event_key"] for r in after} == before


def test_single_event_moved_between_runs_keeps_one_key():
    first = rows_of(vevent("UID:oneoff@example.com", "DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", "SUMMARY:One-off"))
    second = rows_of(vevent("UID:oneoff@example.com", "DTSTART:20261120T170000Z", "DTEND:20261120T180000Z", "SUMMARY:One-off"))
    assert first[0]["event_key"] == second[0]["event_key"] and second[0]["start_date"] == "2026-11-20"
    assert first[0]["recurring"] is False


def test_override_moved_out_of_or_into_the_window():
    win = etl.window_bounds(TODAY, 10)   # 2026-11-03 .. 2026-11-23
    series = vevent("UID:edge@example.com", "DTSTART;TZID=America/New_York:20261101T090000", "DTEND;TZID=America/New_York:20261101T100000",
                    "RRULE:FREQ=DAILY;COUNT=40", "SUMMARY:Edge")
    plain = {r["start_date"]: r["event_key"] for r in rows_of(series, win=win)}
    moved_out = rows_of(series + vevent("UID:edge@example.com", "RECURRENCE-ID;TZID=America/New_York:20261110T090000",
                                        "DTSTART;TZID=America/New_York:20261205T090000", "DTEND;TZID=America/New_York:20261205T100000", "SUMMARY:Edge out"), win=win)
    assert plain["2026-11-10"] not in {r["event_key"] for r in moved_out} and len(moved_out) == len(plain) - 1
    moved_in = rows_of(series + vevent("UID:edge@example.com", "RECURRENCE-ID;TZID=America/New_York:20261130T090000",
                                       "DTSTART;TZID=America/New_York:20261115T150000", "DTEND;TZID=America/New_York:20261115T160000", "SUMMARY:Edge in"), win=win)
    extra = by_title(moved_in, "Edge in")
    assert len(extra) == 1 and extra[0]["start_date"] == "2026-11-15" and len(moved_in) == len(plain) + 1
    assert extra[0]["event_key"] not in plain.values()


def test_cancelled_instances_are_kept_as_cancelled_and_not_counted():
    rows, stats = expand(SERIES + vevent("UID:series@example.com", "RECURRENCE-ID:20261103T140000Z", "DTSTART:20261103T140000Z",
                                         "DTEND:20261103T150000Z", "STATUS:CANCELLED", "SUMMARY:Daily"))
    assert [r["status"] for r in rows] == ["confirmed", "cancelled", "confirmed", "confirmed", "confirmed"]
    assert stats["events"] == 4 and stats["cancelled"] == 1 and stats["recurring"] == 4
    all_off, stats = expand(vevent("UID:off@example.com", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z",
                                   "RRULE:FREQ=DAILY;COUNT=3", "STATUS:CANCELLED", "SUMMARY:Called off"))
    assert [r["status"] for r in all_off] == ["cancelled"] * 3 and stats["events"] == 0


def test_tentative_status_is_carried_and_unknown_status_is_confirmed():
    rows = rows_of(vevent("UID:maybe@example.com", "DTSTART:20261113T150000Z", "STATUS:TENTATIVE", "SUMMARY:Maybe")
                   + vevent("UID:odd@example.com", "DTSTART:20261113T160000Z", "STATUS:WHATEVER", "SUMMARY:Odd"))
    assert by_title(rows, "Maybe")[0]["status"] == "tentative" and by_title(rows, "Odd")[0]["status"] == "confirmed"


def test_orphan_override_is_stored_once():
    rows = rows_of(vevent("UID:orphan@example.com", "RECURRENCE-ID;TZID=America/New_York:20261105T090000",
                          "DTSTART;TZID=America/New_York:20261105T100000", "DTEND;TZID=America/New_York:20261105T110000", "SUMMARY:Orphan"))
    assert len(rows) == 1 and rows[0]["recurring"] is True
    assert rows[0]["event_key"] == etl.event_key("acct one", "main", "orphan@example.com", "20261105T140000Z")


def test_rrule_until_count_and_rdate():
    rows = rows_of(
        vevent("UID:until-utc@example.com", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z",
               "RRULE:FREQ=DAILY;UNTIL=20261104T140000Z", "SUMMARY:Until instant")
        + vevent("UID:until-date@example.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
                 "RRULE:FREQ=DAILY;UNTIL=20261104", "SUMMARY:Until date")
        + vevent("UID:count@example.com", "DTSTART:20261102T160000Z", "DTEND:20261102T170000Z", "RRULE:FREQ=WEEKLY;COUNT=2", "SUMMARY:Counted")
        + vevent("UID:rdate@example.com", "DTSTART:20261102T180000Z", "DTEND:20261102T190000Z",
                 "RDATE:20261105T180000Z,20261109T180000Z", "SUMMARY:Extra dates"))
    assert [r["start_date"] for r in by_title(rows, "Until instant")] == ["2026-11-02", "2026-11-03", "2026-11-04"], "UNTIL is inclusive"
    assert [r["start_date"] for r in by_title(rows, "Until date")] == ["2026-11-02", "2026-11-03"], "a bare-date UNTIL ends at the start of that date"
    assert [r["start_date"] for r in by_title(rows, "Counted")] == ["2026-11-02", "2026-11-09"]
    extra = by_title(rows, "Extra dates")
    assert [r["start_date"] for r in extra] == ["2026-11-02", "2026-11-05", "2026-11-09"] and all(r["recurring"] for r in extra)


def test_month_end_and_leap_day_rules_skip_instead_of_shifting():
    rows = rows_of(
        vevent("UID:m31@example.com", "DTSTART;VALUE=DATE:20260131", "DTEND;VALUE=DATE:20260201", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4", "SUMMARY:Month end")
        + vevent("UID:leap@example.com", "DTSTART;VALUE=DATE:20240229", "DTEND;VALUE=DATE:20240301", "RRULE:FREQ=YEARLY", "SUMMARY:Leap day"),
        win=(date(2024, 1, 1), date(2029, 12, 31)))
    assert [r["start_date"] for r in by_title(rows, "Month end")] == ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]
    assert [r["start_date"] for r in by_title(rows, "Leap day")] == ["2024-02-29", "2028-02-29"]


def test_nonexistent_and_ambiguous_local_times_give_one_instance_each():
    body = (vevent("UID:spring@example.com", "DTSTART;TZID=America/New_York:20270313T023000", "DTEND;TZID=America/New_York:20270313T030000",
                   "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Spring forward")
            + vevent("UID:fall@example.com", "DTSTART;TZID=America/New_York:20261031T013000", "DTEND;TZID=America/New_York:20261031T020000",
                     "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Fall back"))
    first, second = rows_of(body), rows_of(body)
    assert first == second, "deterministic"
    spring, fall = by_title(first, "Spring forward"), by_title(first, "Fall back")
    assert len(spring) == 3 and len(fall) == 3
    assert len({r["event_key"] for r in first}) == 6 and len({r["start_at"] for r in first}) == 6


def test_this_and_following_split_does_not_double_count():
    rows = rows_of(
        vevent("UID:base@google.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
               "RRULE:FREQ=WEEKLY;UNTIL=20261116T045959Z", "SUMMARY:Standup")
        + vevent("UID:base_R20261116T160000@google.com", "DTSTART;TZID=America/New_York:20261116T110000", "DTEND;TZID=America/New_York:20261116T120000",
                 "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Standup"))
    assert [r["start_at"][:16] for r in rows] == ["2026-11-02T14:00", "2026-11-09T14:00", "2026-11-16T16:00", "2026-11-23T16:00", "2026-11-30T16:00"]


def test_duplicate_override_keeps_the_higher_sequence_and_is_reported():
    rows, stats = expand(
        vevent("UID:dup@example.com", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Base")
        + vevent("UID:dup@example.com", "RECURRENCE-ID:20261103T140000Z", "DTSTART:20261103T160000Z", "DTEND:20261103T170000Z", "SEQUENCE:1", "SUMMARY:Older edit")
        + vevent("UID:dup@example.com", "RECURRENCE-ID:20261103T140000Z", "DTSTART:20261103T180000Z", "DTEND:20261103T190000Z", "SEQUENCE:2", "SUMMARY:Newer edit"))
    assert [r["title"] for r in rows] == ["Base", "Newer edit", "Base"]
    assert stats["duplicates"] >= 1 and etl.calendar_notes(stats), "a duplicate makes the run partial"


def test_malformed_series_is_skipped_and_healthy_events_survive():
    rows, stats = expand(
        vevent("UID:bad@example.com", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z", "RRULE:FREQ=NOPE;COUNT=3", "SUMMARY:Broken rule")
        + vevent("UID:good@example.com", "DTSTART:20261102T160000Z", "DTEND:20261102T170000Z", "SUMMARY:Healthy"))
    assert [r["title"] for r in rows] == ["Healthy"]
    assert stats["bad_series"] is True and any("malformed" in n for n in etl.calendar_notes(stats))


def test_event_without_a_start_or_uid_is_skipped_not_fatal():
    rows, stats = expand(vevent("UID:nostart@example.com", "SUMMARY:No start")
                         + vevent("DTSTART:20261102T150000Z", "SUMMARY:No uid")
                         + vevent("UID:fine@example.com", "DTSTART:20261102T160000Z", "SUMMARY:Fine"))
    assert [r["title"] for r in rows] == ["Fine"] and stats["skipped"] == 2
    assert any("skipped" in n for n in etl.calendar_notes(stats))


# ---------------------------------------------------------------------------
# Text, other components, and what a row may contain
# ---------------------------------------------------------------------------

def test_text_escapes_folding_and_emoji():
    title_line = "SUMMARY:Café ☕ plan\\, part 1\\; notes\\nsecond line"
    encoded = title_line.encode("utf-8")
    cut = encoded.index("☕".encode("utf-8")) + 1          # fold in the middle of a multi-byte character
    folded = encoded[:cut] + b"\r\n " + encoded[cut:]
    ics = (b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//Test//EN\r\nX-WR-TIMEZONE:America/New_York\r\n"
           b"BEGIN:VEVENT\r\nUID:text@example.com\r\nDTSTART:20261113T150000Z\r\n" + folded +
           b"\r\nLOCATION:Room 4\\, North wing\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    rows, _ = etl.expand_events(ics.decode("utf-8", errors="replace"), "acct one", "main", *WIN)
    assert len(rows) == 1 and rows[0]["location"] == "Room 4, North wing"
    assert rows[0]["title"].endswith("plan, part 1; notes second line") and rows[0]["title"].startswith("Café")
    long = rows_of(vevent("UID:long@example.com", "DTSTART:20261113T150000Z", "SUMMARY:" + "x" * 900))
    assert len(long[0]["title"]) == etl.MAX_TEXT


def test_rows_hold_only_the_listed_fields():
    private = ["Agenda with private notes", "guest@example.com", "boss@example.com", "meet.example.com/abc-defg", "Guest Person"]
    rows = rows_of(vevent(
        "UID:private@example.com", "DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", f"SUMMARY:{SECRET_TITLE}",
        "DESCRIPTION:Agenda with private notes https://meet.example.com/abc-defg",
        "ORGANIZER;CN=Boss Person:mailto:boss@example.com",
        "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=Guest Person;X-NUM-GUESTS=0:mailto:guest@example.com",
        "X-GOOGLE-CONFERENCE:https://meet.example.com/abc-defg",
        "URL:https://meet.example.com/abc-defg", "LOCATION:Room 4", "TRANSP:TRANSPARENT", "CLASS:PRIVATE"))
    assert len(rows) == 1
    assert set(rows[0]) == {"event_key", "account", "calendar", "title", "start_at", "end_at", "all_day",
                            "start_date", "end_date", "tz", "location", "status", "recurring"}
    blob = repr(rows[0])
    assert all(p not in blob for p in private) and "private@example.com" not in blob, "no description, guests, links or UID"
    assert rows[0]["title"] == SECRET_TITLE and rows[0]["location"] == "Room 4"


def test_meeting_links_and_passcodes_never_stored():
    """Invitations put join links, meeting ids and passcodes in LOCATION or the title: none of it is kept."""
    secrets = ["zoom.us", "meet.example.com", "https://", "998877", "pwd=", "abcDEF", "987 654 321"]
    cases = [
        ("https://zoom.us/j/123456789?pwd=abcDEF", "Online meeting"),
        ("Conference Room B; https://meet.example.com/abc-defg", "Conference Room B"),
        ("Meeting ID 987 654 321, Passcode: 998877", "Online meeting"),
        ("zoom.us/j/555", "Online meeting"),
        ("Room 4, North wing", "Room 4, North wing"),
        ("Pinewood Studios", "Pinewood Studios"),
    ]
    for i, (location, expected) in enumerate(cases):
        rows = rows_of(vevent(f"UID:loc{i}@example.com", "DTSTART:20261113T150000Z",
                              "SUMMARY:Standup https://zoom.us/j/1?pwd=abcDEF", f"LOCATION:{location}"))
        assert rows[0]["location"] == expected, (location, rows[0]["location"])
        assert rows[0]["title"] == "Standup"
        assert all(s not in repr(rows[0]) for s in secrets), rows[0]
    only_link = rows_of(vevent("UID:t@example.com", "DTSTART:20261113T150000Z", "SUMMARY:https://zoom.us/j/1"))
    assert only_link[0]["title"] == "(no title)"


def test_other_components_are_ignored_and_foreign_uids_work():
    rows, stats = expand(
        "BEGIN:VTODO\nUID:todo@example.com\nDTSTART:20261113T150000Z\nSUMMARY:A task\nEND:VTODO\n"
        "BEGIN:VFREEBUSY\nUID:fb@example.com\nDTSTART:20261113T150000Z\nDTEND:20261113T160000Z\nEND:VFREEBUSY\n"
        + vevent("UID:busy@example.com", "DTSTART:20261113T170000Z", "DTEND:20261113T180000Z", "SUMMARY:Busy")
        + vevent("UID:040000008200E00074C5B7101A82E00800000000A1B2C3D4", "DTSTART:20261113T190000Z", "SUMMARY:Foreign hex")
        + vevent("UID:3f2c9a1e-8b7d-4c6f-9e2a-1d0c5b4a3f21", "DTSTART:20261113T200000Z", "SUMMARY:Foreign uuid"))
    assert [r["title"] for r in rows] == ["Busy", "Foreign hex", "Foreign uuid"] and stats["skipped"] == 0
    assert len({r["event_key"] for r in rows}) == 3


def test_identical_feeds_with_a_new_dtstamp_give_identical_rows():
    def body(stamp):
        return (vevent("UID:a@example.com", f"DTSTAMP:{stamp}", "DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", "SUMMARY:Stable")
                + vevent("UID:b@example.com", f"DTSTAMP:{stamp}", "DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=WEEKLY;COUNT=5", "SUMMARY:Stable series"))
    assert rows_of(body("20261113T120000Z")) == rows_of(body("20261113T130003Z"))


def test_not_a_calendar_or_a_cut_off_body_is_a_feed_error():
    for bad in ("<!DOCTYPE html><html><title>Error 404 (Not Found)!!1</title></html>", "",
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@example.com\r\nSUMMARY:" + SECRET_TITLE + "\r\n"):
        try:
            etl.expand_events(bad, "acct one", "main", *WIN)
        except etl.FeedError as exc:
            assert SECRET_TITLE not in str(exc) and exc.__cause__ is None
        else:
            raise AssertionError("accepted a body that is not a complete calendar")


def test_empty_calendar_is_valid_and_has_no_rows():
    rows, stats = expand("")
    assert rows == [] and stats["events"] == 0 and stats["first_date"] is None and not etl.calendar_notes(stats)


def test_event_key_is_stable_and_scoped_to_the_calendar():
    a = etl.event_key("acct one", "main", "uid@example.com", "")
    assert a == etl.event_key("acct one", "main", "uid@example.com", "") and len(a) == 32
    assert len({a, etl.event_key("acct two", "main", "uid@example.com", ""), etl.event_key("acct one", "side", "uid@example.com", ""),
                etl.event_key("acct one", "main", "uid@example.com", "20261113T150000Z")}) == 4


# ---------------------------------------------------------------------------
# fetch_feed: failures carry no URL
# ---------------------------------------------------------------------------

def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_returns_the_body_and_decodes_utf8():
    with _client(lambda request: httpx.Response(200, content=cal("").encode("utf-8"))) as client:
        assert etl.fetch_feed(client, URL_A).startswith("BEGIN:VCALENDAR")


def test_fetch_errors_never_carry_the_url():
    calls = []

    def status(code):
        def handler(request):
            calls.append(code)
            return httpx.Response(code, text="<html>nope</html>")
        return handler

    def boom(request):
        calls.append("net")
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    for handler, expect, attempts in ((status(404), "404", 1), (status(429), "429", 1), (status(403), "403", 1),
                                      (status(500), "500", 2), (boom, "network error", 2)):
        calls.clear()
        with _client(handler) as client:
            try:
                etl.fetch_feed(client, URL_A)
            except etl.FeedError as exc:
                text = str(exc)
                assert expect in text and "example.com" not in text and TOKEN not in text, text
                assert exc.__cause__ is None and (exc.__context__ is None or exc.__suppress_context__), "raised from None"
            else:
                raise AssertionError("a failed fetch must raise")
        assert len(calls) == attempts, f"{expect}: {len(calls)} attempt(s); 403/404/429 are never retried"
    try:
        with _client(status(200)) as client:
            etl.fetch_feed(client, "not a url " + TOKEN)
    except etl.FeedError as exc:
        assert TOKEN not in str(exc)


def test_http_client_loggers_are_quiet():
    assert logging.getLogger("httpx").level >= logging.WARNING and logging.getLogger("httpcore").level >= logging.WARNING


# ---------------------------------------------------------------------------
# run() and main() against an in-memory fake Supabase
# ---------------------------------------------------------------------------

class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.op, self.payload, self.filters, self.count, self._negate = None, None, [], None, False

    def select(self, _cols, count=None):
        self.op, self.count = "select", count
        return self

    def upsert(self, rows, on_conflict=None):
        assert self.table == etl.TABLE and on_conflict == "event_key"
        self.op, self.payload = "upsert", rows
        return self

    def insert(self, row):
        self.op, self.payload = "insert", row
        return self

    def delete(self):
        self.op = "delete"
        return self

    def _where(self, test):
        self.filters.append(test)
        return self

    def eq(self, col, value):
        return self._where(lambda r: r[col] == value)

    def lt(self, col, value):
        return self._where(lambda r: r[col] < value)

    def gte(self, col, value):
        return self._where(lambda r: r[col] >= value)

    def lte(self, col, value):
        return self._where(lambda r: r[col] <= value)

    @property
    def not_(self):
        self._negate = True
        return self

    def in_(self, col, values):
        negate, self._negate = self._negate, False
        return self._where(lambda r: (r[col] in values) != negate)

    def limit(self, _n):
        return self

    def execute(self):
        class Result:
            data, count = [], None
        result = Result()
        if self.table == "sync_log":
            assert self.op == "insert"
            self.db.heartbeats.append(self.payload)
            return result
        assert self.table == etl.TABLE, self.table
        if self.db.fail:
            raise RuntimeError(self.db.fail)
        rows = self.db.rows
        if self.op == "upsert":
            assert len(self.payload) <= etl.UPSERT_BATCH
            for row in self.payload:
                rows[row["event_key"]] = dict(row)
            self.db.upserts += 1
        else:
            assert self.filters, "a read or removal without a filter would hit the whole table"
            hit = [k for k, r in rows.items() if all(test(r) for test in self.filters)]
            if self.op == "delete":
                for key in hit:
                    del rows[key]
                self.db.removed += len(hit)
            else:
                result.count = len(hit)
        return result


class FakeSupabase:
    def __init__(self, fail=None):
        self.rows, self.heartbeats, self.fail = {}, [], fail
        self.upserts = self.removed = 0

    def schema(self, name):
        assert name == "pds"
        return self

    def table(self, name):
        return FakeQuery(self, name)

    def titles(self, calendar=None):
        return sorted(r["title"] for r in self.rows.values() if calendar in (None, r["calendar"]))


def _run(sb, bodies, feeds=(FEED_A,), days=400, **kw):
    """bodies: {url: ICS text | Exception}. Runs etl.run with the fetch replaced."""
    def fake_fetch(_client, url):
        value = bodies[url]
        if isinstance(value, Exception):
            raise value
        return value

    real = etl.fetch_feed
    etl.fetch_feed = fake_fetch
    try:
        return etl.run(sb, list(feeds), days, today=TODAY, **kw)
    finally:
        etl.fetch_feed = real


ONE = vevent("UID:one@example.com", "DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", "SUMMARY:One")
TWO = vevent("UID:two@example.com", "DTSTART:20261114T150000Z", "DTEND:20261114T160000Z", "SUMMARY:Two")


def test_run_upserts_rows_and_is_idempotent():
    sb = FakeSupabase()
    status, total, note = _run(sb, {URL_A: cal(ONE + TWO + SERIES)})
    assert (status, total, note) == ("success", 7, None)
    first = {k: {c: v for c, v in r.items() if c not in ("last_seen_at", "synced_at")} for k, r in sb.rows.items()}
    assert len(first) == 7 and all(r["last_seen_at"] and r["synced_at"] for r in sb.rows.values())
    status, total, _ = _run(sb, {URL_A: cal(ONE + TWO + SERIES)})
    second = {k: {c: v for c, v in r.items() if c not in ("last_seen_at", "synced_at")} for k, r in sb.rows.items()}
    assert (status, total) == ("success", 7) and second == first and sb.removed == 0


def test_run_removes_events_that_left_the_feed():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE + TWO)})
    status, total, _ = _run(sb, {URL_A: cal(ONE)})
    assert (status, total) == ("success", 1) and sb.titles() == ["One"] and sb.removed == 1


def test_run_flips_a_stored_instance_to_cancelled():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(SERIES)})
    assert sorted(r["status"] for r in sb.rows.values()) == ["confirmed"] * 5
    status, total, _ = _run(sb, {URL_A: cal(SERIES + vevent(
        "UID:series@example.com", "RECURRENCE-ID:20261103T140000Z", "DTSTART:20261103T140000Z", "DTEND:20261103T150000Z", "STATUS:CANCELLED", "SUMMARY:Daily"))})
    assert (status, total) == ("success", 4) and len(sb.rows) == 5
    assert [r["status"] for r in sb.rows.values() if r["start_date"] == "2026-11-03"] == ["cancelled"]


def test_run_series_retimed_split_or_converted_leaves_no_leftovers():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(SERIES)})
    retimed = SERIES.replace("T090000", "T110000").replace("T100000", "T120000")
    _run(sb, {URL_A: cal(retimed)})
    assert len(sb.rows) == 5 and {r["start_at"][11:16] for r in sb.rows.values()} == {"16:00"}, "old keys removed, new keys stored"

    sb = FakeSupabase()
    weekly = vevent("UID:base@google.com", "DTSTART;TZID=America/New_York:20261102T090000", "DTEND;TZID=America/New_York:20261102T100000",
                    "RRULE:FREQ=WEEKLY;COUNT=5", "SUMMARY:Standup")
    _run(sb, {URL_A: cal(weekly)})
    split = (weekly.replace("RRULE:FREQ=WEEKLY;COUNT=5", "RRULE:FREQ=WEEKLY;UNTIL=20261116T045959Z")
             + vevent("UID:base_R20261116T160000@google.com", "DTSTART;TZID=America/New_York:20261116T110000",
                      "DTEND;TZID=America/New_York:20261116T120000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Standup"))
    _run(sb, {URL_A: cal(split)})
    assert sorted(r["start_at"][:16] for r in sb.rows.values()) == [
        "2026-11-02T14:00", "2026-11-09T14:00", "2026-11-16T16:00", "2026-11-23T16:00", "2026-11-30T16:00"]

    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE)})
    _run(sb, {URL_A: cal(ONE.replace("SUMMARY:One", "RRULE:FREQ=DAILY;COUNT=3\nSUMMARY:One"))})
    assert len(sb.rows) == 3 and all(r["recurring"] for r in sb.rows.values()), "the one-off row is gone, no duplicate"


def test_run_moved_out_of_window_instance_is_removed():
    sb = FakeSupabase()
    series = vevent("UID:edge@example.com", "DTSTART;TZID=America/New_York:20261101T090000", "DTEND;TZID=America/New_York:20261101T100000",
                    "RRULE:FREQ=DAILY;COUNT=40", "SUMMARY:Edge")
    _run(sb, {URL_A: cal(series)}, days=10)
    before = len(sb.rows)
    _run(sb, {URL_A: cal(series + vevent("UID:edge@example.com", "RECURRENCE-ID;TZID=America/New_York:20261110T090000",
                                         "DTSTART;TZID=America/New_York:20261205T090000", "DTEND;TZID=America/New_York:20261205T100000", "SUMMARY:Edge out"))}, days=10)
    assert len(sb.rows) == before - 1 and "2026-11-10" not in {r["start_date"] for r in sb.rows.values()}


def test_run_never_reconciles_a_calendar_whose_fetch_or_parse_failed():
    for failure in (etl.FeedError("HTTP 404"), etl.FeedError("HTTP 429"), etl.FeedError("HTTP 500"),
                    "<html>Error 404</html>", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x@example.com\r\n"):
        sb = FakeSupabase()
        feeds = (FEED_A, FEED_B)
        _run(sb, {URL_A: cal(ONE + TWO), URL_B: cal(SERIES)}, feeds=feeds)
        assert len(sb.rows) == 7
        status, total, note = _run(sb, {URL_A: failure, URL_B: cal(SERIES)}, feeds=feeds)
        assert status == "partial" and total == 5 and "calendar 'main' (acct one)" in note
        assert sb.titles("main") == ["One", "Two"], "the failed calendar keeps every row"
        assert sb.removed == 0 and URL_A not in note and TOKEN not in note


def test_run_with_every_feed_failing_is_failed_and_writes_nothing():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE)})
    status, total, note = _run(sb, {URL_A: etl.FeedError("HTTP 404 (reset)")})
    assert status == "failed" and total == 0 and "404" in note
    assert sb.titles() == ["One"] and sb.removed == 0 and sb.upserts == 1


def test_run_refuses_to_empty_a_calendar_unless_allowed():
    many = "".join(vevent(f"UID:many-{i}@example.com", f"DTSTART:202611{10 + i % 15:02d}T150000Z", f"SUMMARY:Many {i}") for i in range(30))
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(many)})
    assert len(sb.rows) == 30
    status, total, note = _run(sb, {URL_A: cal("")})
    assert status == "partial" and total == 0 and len(sb.rows) == 30 and "more than half" in note
    status, _, _ = _run(sb, {URL_A: cal("")}, allow_large_removal=True)
    assert status == "success" and len(sb.rows) == 0

    few = "".join(vevent(f"UID:few-{i}@example.com", f"DTSTART:202611{10 + i:02d}T150000Z", f"SUMMARY:Few {i}") for i in range(5))
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(few)})
    status, _, _ = _run(sb, {URL_A: cal("")})
    assert status == "success" and len(sb.rows) == 0, "a small calendar can be emptied"


def test_run_only_removes_inside_the_window():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE + TWO)}, days=400)
    status, _, _ = _run(sb, {URL_A: cal(ONE)}, days=400)
    assert sb.titles() == ["One"]
    old = vevent("UID:old@example.com", "DTSTART:20260101T150000Z", "SUMMARY:Old")
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE + old)}, days=400)
    _run(sb, {URL_A: cal(ONE)}, days=10)
    assert sb.titles() == ["Old", "One"], "a row outside the narrower window is history, not a removal"


def test_run_removes_calendars_that_left_the_secret():
    sb = FakeSupabase()
    _run(sb, {URL_A: cal(ONE), URL_B: cal(TWO)}, feeds=(FEED_A, FEED_B))
    assert sb.titles() == ["One", "Two"]
    _run(sb, {URL_A: cal(ONE)}, feeds=(FEED_A,))
    assert sb.titles() == ["One"]


def test_run_malformed_series_is_partial_but_stores_the_rest():
    sb = FakeSupabase()
    status, total, note = _run(sb, {URL_A: cal(ONE + vevent("UID:bad@example.com", "DTSTART:20261102T140000Z", "RRULE:FREQ=NOPE", "SUMMARY:Broken"))})
    assert (status, total) == ("partial", 1) and "malformed" in note and sb.titles() == ["One"]


def test_dry_run_touches_no_database():
    status, total, note = _run(None, {URL_A: cal(ONE + TWO)}, dry_run=True)
    assert (status, total, note) == ("success", 2, None)


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


def _main(sb, bodies, secret, argv=()):
    """Run etl.main() with the secret set, the client and the fetch replaced. Returns (exit code, log text)."""
    capture = _Capture()
    logging.getLogger().addHandler(capture)
    real_fetch, real_sb = etl.fetch_feed, etl.get_supabase

    def fake_fetch(_client, url):
        value = bodies[url]
        if isinstance(value, Exception):
            raise value
        return value

    real_today = etl.et_today
    etl.fetch_feed, etl.get_supabase, etl.et_today = fake_fetch, lambda: sb, (lambda: TODAY)
    previous = os.environ.get(etl.ENV_NAME)
    if secret is None:
        os.environ.pop(etl.ENV_NAME, None)
    else:
        os.environ[etl.ENV_NAME] = secret
    try:
        code = etl.main(list(argv))
    finally:
        etl.fetch_feed, etl.get_supabase, etl.et_today = real_fetch, real_sb, real_today
        logging.getLogger().removeHandler(capture)
        if previous is None:
            os.environ.pop(etl.ENV_NAME, None)
        else:
            os.environ[etl.ENV_NAME] = previous
    return code, "\n".join(capture.lines)


SECRET = '[{"account": "acct one", "calendar": "main", "url": "%s"}, {"account": "acct two", "calendar": "side", "url": "%s"}]' % (URL_A, URL_B)
PRIVATE_EVENT = vevent("UID:private@example.com", "DTSTART:20261113T150000Z", "DTEND:20261113T160000Z", f"SUMMARY:{SECRET_TITLE}", "LOCATION:Hidden Room 9")


def _assert_private(text: str):
    for needle in (URL_A, URL_B, TOKEN, "calendar.example.com", "owner%40example.com", SECRET_TITLE, "Hidden Room 9"):
        assert needle not in text, f"leaked {needle!r}"


def test_main_success_writes_one_heartbeat_and_logs_counts_only():
    sb = FakeSupabase()
    code, logs = _main(sb, {URL_A: cal(PRIVATE_EVENT + SERIES), URL_B: cal(TWO)}, SECRET)
    assert code == 0 and len(sb.heartbeats) == 1
    beat = sb.heartbeats[0]
    assert (beat["source"], beat["data_type"], beat["status"], beat["records_synced"]) == ("google_calendar", "events", "success", 7)
    assert beat["error_message"] is None and beat["sync_start"] and beat["sync_end"] and beat["duration_seconds"] >= 0
    assert beat["date_range_start"] and beat["date_range_end"]
    assert "calendar 1/2: 6 event(s)" in logs and "calendar 2/2: 1 event(s)" in logs
    _assert_private(logs + repr(beat))


def test_main_partial_when_one_feed_fails_and_exits_zero():
    sb = FakeSupabase()
    code, logs = _main(sb, {URL_A: cal(PRIVATE_EVENT), URL_B: etl.FeedError("HTTP 404 (reset)")}, SECRET)
    assert code == 0 and [b["status"] for b in sb.heartbeats] == ["partial"]
    assert "calendar 'side' (acct two): HTTP 404" in sb.heartbeats[0]["error_message"] and sb.heartbeats[0]["records_synced"] == 1
    _assert_private(logs + repr(sb.heartbeats))


def test_main_failed_when_every_feed_fails_and_exits_nonzero():
    sb = FakeSupabase()
    html = "<html>Error 404 (Not Found)!!1</html>"
    code, logs = _main(sb, {URL_A: html, URL_B: etl.FeedError("HTTP 429")}, SECRET)
    assert code == 1 and [b["status"] for b in sb.heartbeats] == ["failed"] and not sb.rows
    assert "not an iCalendar file" in sb.heartbeats[0]["error_message"] and "429" in sb.heartbeats[0]["error_message"]
    _assert_private(logs + repr(sb.heartbeats))


def test_main_missing_or_bad_secret_is_a_failed_heartbeat():
    for secret in (None, "not json " + URL_A, '[{"account": "a", "calendar": "c", "url": "ftp://x"}]'):
        sb = FakeSupabase()
        code, logs = _main(sb, {}, secret)
        assert code == 1 and [b["status"] for b in sb.heartbeats] == ["failed"]
        assert etl.ENV_NAME in sb.heartbeats[0]["error_message"]
        _assert_private(logs + repr(sb.heartbeats))


def test_main_missing_table_names_the_sql_file():
    sb = FakeSupabase(fail="Could not find the table 'pds.calendar_events' in the schema cache (PGRST205)")
    code, logs = _main(sb, {URL_A: cal(PRIVATE_EVENT), URL_B: cal(TWO)}, SECRET)
    assert code == 1 and len(sb.heartbeats) == 1 and sb.heartbeats[0]["status"] == "failed"
    assert "sql/calendar_events_schema.sql" in sb.heartbeats[0]["error_message"]
    _assert_private(logs + repr(sb.heartbeats))


def test_main_database_error_text_is_never_echoed():
    row_dump = f'new row violates check constraint; Failing row contains (abc, acct one, main, {SECRET_TITLE}, Hidden Room 9)'
    sb = FakeSupabase(fail=row_dump)
    code, logs = _main(sb, {URL_A: cal(PRIVATE_EVENT), URL_B: cal(TWO)}, SECRET)
    assert code == 1 and [b["status"] for b in sb.heartbeats] == ["failed"]
    assert sb.heartbeats[0]["error_message"] == "database error (RuntimeError)"
    _assert_private(logs + repr(sb.heartbeats))


def test_main_dry_run_writes_no_heartbeat_and_prints_counts_only():
    sb = FakeSupabase()
    code, logs = _main(sb, {URL_A: cal(PRIVATE_EVENT), URL_B: cal(TWO)}, SECRET, argv=["--dry-run"])
    assert code == 0 and not sb.heartbeats and not sb.rows
    assert "2 event(s) would be written" in logs
    _assert_private(logs)


def test_source_has_no_print_of_feed_text_or_exception_text():
    src = Path(etl.__file__).read_text(encoding="utf-8")
    assert "retry_http" not in src, "retry_helper logs the exception text, which can hold the URL"
    assert "from exc" not in src, "feed and config errors are raised `from None`"
    assert 'getLogger("httpx").setLevel(logging.WARNING)' in src and "::add-mask::" in src
    assert 'cal.pop("X-WR-TIMEZONE", None)' in src


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
