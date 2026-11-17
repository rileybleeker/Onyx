"""iCloud CalDAV source (caldav_source.py + its use in google_calendar_etl.run). Synthetic only:
httpx.MockTransport plays iCloud; no network, no database, no real account."""

import json
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx  # noqa: E402
import pytest  # noqa: E402

import caldav_source as cd  # noqa: E402
import google_calendar_etl as etl  # noqa: E402

USER = "someone@example.com"
PASSWORD = "abcd-efgh-ijkl-mnop"
SOURCE = cd.CaldavSource("iCloud", USER, PASSWORD)
WIN = (date(2026, 1, 1), date(2027, 1, 1))

PRINCIPAL = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat>'
             '<d:prop><d:current-user-principal><d:href>/123456/principal/</d:href></d:current-user-principal>'
             "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>")
HOME = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>'
        "<d:href>/123456/principal/</d:href><d:propstat><d:prop><c:calendar-home-set>"
        "<d:href>https://p12-caldav.icloud.com:443/123456/calendars/</d:href></c:calendar-home-set></d:prop>"
        "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>")


def collection(href, name, comps=("VEVENT",), calendar=True):
    rtype = "<d:collection/><c:calendar/>" if calendar else "<d:collection/>"
    comp_xml = "".join(f'<c:comp name="{c}"/>' for c in comps)
    return (f"<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype>{rtype}</d:resourcetype>"
            f"<d:displayname>{name}</d:displayname><c:supported-calendar-component-set>{comp_xml}"
            "</c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")


LISTING = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
           + collection("/123456/calendars/", "", calendar=False)
           + collection("/123456/calendars/home/", "Home")
           + collection("/123456/calendars/work/", "Work / Family!")
           + collection("/123456/calendars/tasks/", "Reminders", comps=("VTODO",))
           + collection("/123456/calendars/dup/", "Home")
           + "</d:multistatus>")


def event(uid, summary, start="20260315T140000Z", extra=""):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//EN\r\nBEGIN:VEVENT\r\n"
            f"UID:{uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:{start}\r\nDTEND:20260315T150000Z\r\n"
            f"SUMMARY:{summary}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n")


def report(*resources):
    body = "".join(f"<d:response><d:href>/x/{i}.ics</d:href><d:propstat><d:prop><c:calendar-data>"
                   f"{r.replace('&', '&amp;')}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status>"
                   "</d:propstat></d:response>" for i, r in enumerate(resources))
    return ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            + body + "</d:multistatus>")


def icloud(calendars, seen=None):
    """MockTransport handler: REPORT answers keyed by collection path."""
    def handler(request):
        if seen is not None:
            seen.append((request.method, str(request.url), request.headers.get("authorization")))
        host, path = request.url.host, request.url.path
        if host == "caldav.icloud.com" and path == "/" and request.method == "PROPFIND":
            return httpx.Response(307, headers={"location": "https://p12-caldav.icloud.com/"})
        if path == "/" and request.method == "PROPFIND":
            return httpx.Response(207, text=PRINCIPAL)
        if path == "/123456/principal/":
            return httpx.Response(207, text=HOME)
        if path == "/123456/calendars/" and request.method == "PROPFIND":
            return httpx.Response(207, text=LISTING)
        if request.method == "REPORT" and path in calendars:
            return httpx.Response(207, text=calendars[path])
        return httpx.Response(404)
    return handler


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


# --- secret ------------------------------------------------------------------

def test_secret_unset_means_not_configured():
    assert cd.parse_caldav_secret(None) == []
    assert cd.parse_caldav_secret("  ") == []


def test_secret_parses_object_or_list_and_hides_credentials_in_repr():
    one = cd.parse_caldav_secret(json.dumps({"account": "iCloud", "username": USER, "password": PASSWORD}))
    assert one[0].account == "iCloud"
    assert USER not in repr(one) and PASSWORD not in repr(one)
    assert cd.mask_values(one) == [USER, PASSWORD]


@pytest.mark.parametrize("raw", [
    "not json", "[]", "[1]",
    json.dumps({"account": USER, "username": USER, "password": PASSWORD}),   # an address is not a label
    json.dumps({"account": "iCloud", "username": "", "password": PASSWORD}),
    json.dumps({"account": "iCloud", "username": USER}),
    json.dumps([{"account": "a", "username": "u", "password": "p"}, {"account": "A", "username": "u", "password": "p"}]),
])
def test_secret_errors_never_quote_a_value(raw):
    with pytest.raises(cd.CaldavConfigError) as err:
        cd.parse_caldav_secret(raw)
    assert PASSWORD not in str(err.value) and USER not in str(err.value)


def test_labels_are_short_unique_and_follow_the_label_rule():
    taken = set()
    assert cd.calendar_label("Home", taken, 1) == "Home"
    assert cd.calendar_label("Home", taken, 2) == "Home 2"
    assert cd.calendar_label("Work / Family!", taken, 3) == "Work Family"
    assert cd.calendar_label("日本語", taken, 4) == "calendar 4"
    assert cd.LABEL_RE.fullmatch(cd.calendar_label("x" * 90, taken, 5))


# --- XML parsing -------------------------------------------------------------

def test_listing_keeps_only_event_calendars():
    names = [n for _, n in cd.parse_calendars(LISTING)]
    assert names == ["Home", "Work / Family!", "Home"]          # no home collection, no reminders list


def test_non_xml_answer_is_a_plain_error():
    with pytest.raises(cd.CaldavError):
        cd.parse_principal("<html>not xml")


def test_merge_keeps_every_event_and_each_timezone_once():
    tz = ("BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\n"
          "TZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")
    a = event("a@t", "One").replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT", 1)
    b = event("b@t", "Two").replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT", 1)
    text = cd.merge_resources([a, b])
    assert text.count("BEGIN:VEVENT") == 2 and text.count("BEGIN:VTIMEZONE") == 1


def test_merge_refuses_an_unreadable_resource_without_quoting_it():
    with pytest.raises(cd.CaldavError) as err:
        cd.merge_resources([event("a@t", "One"), "BEGIN:VCALENDAR\r\nSUMMARY:Secret Title\r\n"])
    assert "Secret Title" not in str(err.value)


def test_query_body_has_the_window_in_utc():
    body = cd.query_body(*WIN)
    assert 'start="20260101T000000Z"' in body and 'end="20270102T000000Z"' in body


# --- discovery + fetch -------------------------------------------------------

def test_discovery_follows_the_redirect_with_credentials_inside_icloud_only():
    seen = []
    with client(icloud({}, seen)) as c:
        cals = cd.discover_calendars(c, SOURCE)
    assert [x.calendar for x in cals] == ["Home", "Work Family", "Home 2"]
    assert all(x.href.startswith("https://p12-caldav.icloud.com") for x in cals)
    assert all(auth and auth.startswith("Basic ") for _, _, auth in seen)      # re-sent after the redirect


def test_a_redirect_outside_icloud_never_gets_the_credential():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(307, headers={"location": "https://evil.example.net/"})

    with client(handler) as c, pytest.raises(cd.CaldavError):
        cd.discover_calendars(c, SOURCE)
    assert seen == ["https://caldav.icloud.com/"]


def test_a_refused_sign_in_names_the_secret_not_the_password():
    with client(lambda r: httpx.Response(401)) as c, pytest.raises(cd.CaldavError) as err:
        cd.discover_calendars(c, SOURCE)
    assert "app-specific password" in str(err.value) and PASSWORD not in str(err.value)


def test_fetch_merges_the_event_resources_of_one_calendar():
    cal = cd.CaldavCalendar("iCloud", "Home", "https://p12-caldav.icloud.com/123456/calendars/home/", USER, PASSWORD)
    answer = report(event("a@t", "One"), event("b@t", "Two"))
    with client(icloud({"/123456/calendars/home/": answer})) as c:
        text = cd.fetch_calendar_ics(c, cal, *WIN)
    rows, stats = etl.expand_events(text, "iCloud", "Home", *WIN)
    assert stats["events"] == 2 and {r["title"] for r in rows} == {"One", "Two"}


# --- through run() -----------------------------------------------------------

class FakeTable:
    def __init__(self):
        self.upserts = []

    def upsert(self, rows, on_conflict=None):
        self.upserts.extend(rows)
        return self

    def execute(self):
        return type("R", (), {"count": 0, "data": []})()

    def __getattr__(self, name):                     # select / eq / gte / lte / lt / limit / delete / in_
        return lambda *a, **k: self

    @property
    def not_(self):
        return self


class FakeSb:
    def __init__(self):
        self.t = FakeTable()

    def schema(self, _):
        return self

    def table(self, _):
        return self.t


def run_with(monkeypatch, calendars, sources=(SOURCE,), feeds=()):
    handler = icloud(calendars)
    real = httpx.Client
    monkeypatch.setattr(etl.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler)))
    sb = FakeSb()
    result = etl.run(sb, list(feeds), 400, today=date(2026, 6, 1), caldav_sources=list(sources))
    return result, sb


def test_run_stores_icloud_events_under_the_icloud_account(monkeypatch):
    cals = {"/123456/calendars/home/": report(event("a@t", "One")),
            "/123456/calendars/work/": report(event("b@t", "Two")),
            "/123456/calendars/dup/": report()}
    (status, total, note), sb = run_with(monkeypatch, cals)
    assert (status, total, note) == ("success", 2, None)
    assert {(r["account"], r["calendar"]) for r in sb.t.upserts} == {("iCloud", "Home"), ("iCloud", "Work Family")}


def test_run_one_calendar_failing_is_partial_and_the_rest_is_still_stored(monkeypatch):
    cals = {"/123456/calendars/home/": report(event("a@t", "One")),
            "/123456/calendars/work/": report(event("b@t", "Two")),
            "/123456/calendars/dup/": "<html>"}
    (status, total, note), sb = run_with(monkeypatch, cals)
    assert status == "partial" and total == 2
    assert "Home 2" in note and PASSWORD not in note and USER not in note


def test_run_failed_discovery_is_failed_and_stores_nothing(monkeypatch):
    real = httpx.Client
    monkeypatch.setattr(etl.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(lambda r: httpx.Response(401))))
    sb = FakeSb()
    status, total, note = etl.run(sb, [], 400, today=date(2026, 6, 1), caldav_sources=[SOURCE])
    assert (status, total) == ("failed", 0) and sb.t.upserts == []
    assert PASSWORD not in note and USER not in note


if __name__ == "__main__":
    # run_offline_tests.py runs each file as a script; these are pytest-style tests (fixtures, parametrize).
    raise SystemExit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))
