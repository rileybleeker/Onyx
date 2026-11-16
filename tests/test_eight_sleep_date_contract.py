"""Offline tests for the Eight Sleep date contract (docs/eight-sleep-date-contract.md).

The contract: a row's calendar_date is the trends API `day` unchanged (the wake-up
date in EIGHTSLEEP_TIMEZONE, the stationary bed's zone); interval values (bed / room
temps, fallback biometrics) attach to that day by its mainSessionId, never by the
interval's own timestamp; no row is written without a trend day; a session that
reports a zone with another UTC offset turns the run partial with a GUARD line.

Everything is synthetic: made-up session ids, times and temperatures, no network,
no database, no credentials.

Run: python tests/test_eight_sleep_date_contract.py
     python tests/run_offline_tests.py tests/test_eight_sleep_date_contract.py
"""
from __future__ import annotations

import os
import re
import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("EIGHTSLEEP_EMAIL", "stub@example.com")
os.environ.setdefault("EIGHTSLEEP_PASSWORD", "stub")
os.environ.setdefault("EIGHTSLEEP_CLIENT_ID", "stub")
os.environ.setdefault("EIGHTSLEEP_CLIENT_SECRET", "stub")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import eight_sleep_etl as es  # noqa: E402
import eight_sleep_temp_backfill as backfill  # noqa: E402

NY = "America/New_York"

# Columns the deployed table accepts from the sync (unchanged by the contract fix).
ROW_COLUMNS = {
    "calendar_date", "bed_side", "sleep_score", "sleep_fitness_score",
    "sleep_quality_score", "sleep_duration_score", "latency_asleep_score",
    "latency_out_score", "wakeup_consistency_score", "sleep_routine_score",
    "avg_heart_rate", "avg_hrv", "avg_breath_rate", "median_bed_temp",
    "median_room_temp", "time_slept_seconds", "awake_seconds", "light_sleep_seconds",
    "deep_sleep_seconds", "rem_sleep_seconds", "time_slept_main_session_seconds",
    "awake_main_session_seconds", "light_sleep_main_session_seconds",
    "deep_sleep_main_session_seconds", "rem_sleep_main_session_seconds",
    "toss_and_turns", "latency_asleep_seconds", "snore_duration_seconds",
    "heavy_snore_duration_seconds", "session_date", "raw_json",
}


# ---------------------------------------------------------------------------
# Synthetic payloads
# ---------------------------------------------------------------------------

def _session(sid: str, start: str, end: str, tz: str | None = NY) -> dict:
    s = {"id": sid, "ts": start, "sleepStart": start, "sleepEnd": end,
         "presenceEnd": end,
         "stageSummary": {"sleepDuration": 25000, "awakeDuration": 1200,
                          "lightDuration": 14000, "deepDuration": 5000,
                          "remDuration": 6000}}
    if tz is not None:
        s["timezone"] = tz
    return s


def _day(day: str, sessions: list[dict], main: str | None = None, **extra) -> dict:
    main = main or sessions[0]["id"]
    d = {"day": day, "mainSessionId": main, "sessionIds": [s["id"] for s in sessions],
         "sessions": sessions, "score": 80,
         "presenceStart": sessions[0]["ts"], "sleepStart": sessions[0]["sleepStart"],
         "sleepEnd": sessions[-1]["sleepEnd"], "presenceEnd": sessions[-1]["presenceEnd"]}
    d.update(extra)
    return d


def _interval(sid: str, start: str, bed: float, room: float) -> dict:
    return {"id": sid, "ts": start,
            "timeseries": {"tempBedC": [[start, bed]] * 3, "tempRoomC": [[start, room]] * 3},
            "stages": [{"stage": "light", "duration": 3600}]}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data):
        self.data = data


class FakeSB:
    """Records upserts. Any other access (a read, an RPC, tz_for_instant) raises,
    which is part of the contract: the sync consults nothing about the wearer."""

    def __init__(self):
        self.batches: list[list[dict]] = []

    def schema(self, name):
        assert name == "pds", name
        return self

    def table(self, name):
        assert name == "eight_sleep_trends", name
        return self

    def upsert(self, rows, on_conflict=None, returning=None):
        assert on_conflict == "calendar_date,bed_side", on_conflict
        self.batches.append([dict(r) for r in rows])
        self._n = len(rows)
        return self

    def execute(self):
        return _Result([{}] * self._n)

    def rows(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for batch in self.batches:
            for r in batch:
                out.setdefault(r["calendar_date"], {}).update(r)
        return out


class FakeClient:
    def __init__(self, days=None, intervals=None, trends_errors=0):
        self.days = list(days or [])
        self.intervals = list(intervals or [])
        self.trends_errors = trends_errors    # first N get_trends calls raise
        self.trend_calls: list[tuple[str, str]] = []

    def get_intervals(self, user_id):
        return list(self.intervals)

    def get_trends(self, user_id, start, end):
        self.trend_calls.append((start, end))
        if self.trends_errors > 0:
            self.trends_errors -= 1
            raise RuntimeError("synthetic trends failure")
        return [d for d in self.days if start <= d["day"] <= end]


@contextmanager
def _no_sleep():
    real = es.time.sleep
    es.time.sleep = lambda _s: None
    try:
        yield
    finally:
        es.time.sleep = real


def _sync(client, start="2026-01-01", end="2026-12-31", side="left"):
    sb = FakeSB()
    with _no_sleep():
        stats = es.sync_user(client, sb, "u-left", side,
                             date.fromisoformat(start), date.fromisoformat(end))
    return sb, stats


# ---------------------------------------------------------------------------
# Interval pairing (the established mismatch)
# ---------------------------------------------------------------------------

def test_night_that_starts_before_local_midnight_keeps_its_own_temps() -> None:
    # Night A wakes 2026-02-08, starting 23:00 EST on 02-07 (04:00 UTC 02-08).
    # Night B wakes 2026-02-09, starting 22:30 EST on 02-08 (03:30 UTC 02-09).
    # Keyed by local START date, B landed on the 02-08 row and 02-09 got none.
    a = _session("A", "2026-02-08T04:00:00Z", "2026-02-08T12:00:00Z")
    b = _session("B", "2026-02-09T03:30:00Z", "2026-02-09T11:30:00Z")
    client = FakeClient(
        days=[_day("2026-02-08", [a]), _day("2026-02-09", [b])],
        intervals=[_interval("B", b["ts"], 31.0, 21.0), _interval("A", a["ts"], 27.0, 19.0)])
    sb, stats = _sync(client, "2026-02-01", "2026-02-10")
    rows = sb.rows()
    assert rows["2026-02-08"]["median_bed_temp"] == 27.0, rows["2026-02-08"]
    assert rows["2026-02-09"]["median_bed_temp"] == 31.0, rows["2026-02-09"]
    assert rows["2026-02-09"]["median_room_temp"] == 21.0
    assert stats["intervals_unmatched"] == 0 and stats["records"] == 2, stats


def test_nap_on_the_same_day_never_replaces_the_main_session() -> None:
    main = _session("M", "2026-04-14T05:00:00Z", "2026-04-14T12:00:00Z")
    nap = _session("P", "2026-04-14T19:00:00Z", "2026-04-14T20:30:00Z")
    client = FakeClient(
        days=[_day("2026-04-14", [main, nap], main="M")],
        intervals=[_interval("M", main["ts"], 28.0, 20.0), _interval("P", nap["ts"], 33.0, 24.0)])
    sb, stats = _sync(client, "2026-04-10", "2026-04-15")
    row = sb.rows()["2026-04-14"]
    assert (row["median_bed_temp"], row["median_room_temp"]) == (28.0, 20.0), row
    assert stats["intervals_unmatched"] == 1, stats   # the nap: used by no row


def _without_main(day: dict) -> dict:
    day = dict(day)
    del day["mainSessionId"]
    return day


def test_several_sessions_without_a_main_session_id_pair_with_nothing() -> None:
    # sessionIds lists the nap first; with no mainSessionId the main session is
    # unknown, so neither interval is attached and stored temps stay as they are.
    nap = _session("P", "2026-04-14T19:00:00Z", "2026-04-14T20:30:00Z")
    main = _session("M", "2026-04-14T05:00:00Z", "2026-04-14T12:00:00Z")
    client = FakeClient(
        days=[_without_main(_day("2026-04-14", [nap, main]))],
        intervals=[_interval("P", nap["ts"], 33.0, 24.0), _interval("M", main["ts"], 28.0, 20.0)])
    sb, stats = _sync(client, "2026-04-10", "2026-04-15")
    (batch,) = sb.batches
    assert set(batch[0]) == ROW_COLUMNS - set(es.TEMP_COLUMNS), batch[0]
    assert stats["intervals_matched"] == 0 and stats["intervals_unmatched"] == 2, stats
    # Unknown is not a pairing failure: no day had a known main session.
    assert stats["interval_pairing_failed"] == 0, stats


def test_a_sole_session_without_a_main_session_id_still_pairs() -> None:
    s = _session("O", "2026-04-20T05:00:00Z", "2026-04-20T12:00:00Z")
    client = FakeClient(days=[_without_main(_day("2026-04-20", [s]))],
                        intervals=[_interval("O", s["ts"], 27.5, 19.5)])
    sb, stats = _sync(client, "2026-04-15", "2026-04-20")
    assert sb.rows()["2026-04-20"]["median_bed_temp"] == 27.5
    assert stats["intervals_matched"] == 1, stats


def test_ids_that_never_match_are_reported_not_silently_dropped() -> None:
    # If /intervals ever keyed its items differently from the trend session ids,
    # nothing would pair and the sync would stop writing temps without a word.
    a = _session("A", "2026-05-10T05:00:00Z", "2026-05-10T12:00:00Z")
    b = _session("B", "2026-05-11T05:00:00Z", "2026-05-11T12:00:00Z")
    client = FakeClient(days=[_day("2026-05-10", [a]), _day("2026-05-11", [b])],
                        intervals=[_interval("other-A", a["ts"], 30.0, 20.0),
                                   _interval("other-B", b["ts"], 30.0, 20.0)])
    sb, stats = _sync(client, "2026-05-05", "2026-05-11")
    assert stats["records"] == 2 and stats["interval_pairing_failed"] == 1, stats
    assert all("median_bed_temp" not in r for r in sb.rows().values())
    problems = es.trends_problems(0, stats, None)
    assert len(problems) == 1 and problems[0].startswith("no interval paired"), problems


def _id_renamed(interval: dict) -> dict:
    # The same item with its id under another key, as a provider rename would ship it.
    item = dict(interval)
    item["sessionId"] = item.pop("id")
    return item


def test_intervals_without_an_id_are_reported_not_mistaken_for_a_quiet_window() -> None:
    # If /intervals renamed or dropped its id field, every item would be
    # discarded before pairing; the window check must still count them.
    a = _session("A", "2026-05-10T05:00:00Z", "2026-05-10T12:00:00Z")
    b = _session("B", "2026-05-11T05:00:00Z", "2026-05-11T12:00:00Z")
    client = FakeClient(days=[_day("2026-05-10", [a]), _day("2026-05-11", [b])],
                        intervals=[_id_renamed(_interval("A", a["ts"], 30.0, 20.0)),
                                   _id_renamed(_interval("B", b["ts"], 30.0, 20.0))])
    sb, stats = _sync(client, "2026-05-05", "2026-05-11")
    assert stats["records"] == 2 and stats["intervals_without_id"] == 2, stats
    assert stats["interval_pairing_failed"] == 1, stats
    assert all("median_bed_temp" not in r for r in sb.rows().values())
    problems = es.trends_problems(0, stats, None)
    assert len(problems) == 2, problems
    assert "carry no session id" in problems[0], problems
    assert problems[1].startswith("no interval paired"), problems
    # Counts only: no id, date or value in the heartbeat text.
    assert not any(t in " ".join(problems) for t in ("2026-05", "30.0", "A,", "B,")), problems


def test_one_interval_without_an_id_next_to_paired_ones_is_still_reported() -> None:
    a = _session("A", "2026-05-20T05:00:00Z", "2026-05-20T12:00:00Z")
    b = _session("B", "2026-05-21T05:00:00Z", "2026-05-21T12:00:00Z")
    client = FakeClient(days=[_day("2026-05-20", [a]), _day("2026-05-21", [b])],
                        intervals=[_interval("A", a["ts"], 29.0, 20.0),
                                   _id_renamed(_interval("B", b["ts"], 31.0, 21.0)),
                                   "not an object"])
    sb, stats = _sync(client, "2026-05-15", "2026-05-21")
    rows = sb.rows()
    assert rows["2026-05-20"]["median_bed_temp"] == 29.0, rows["2026-05-20"]
    assert "median_bed_temp" not in rows["2026-05-21"], "unpaired day keeps its stored temps"
    assert stats["intervals_without_id"] == 2 and stats["interval_pairing_failed"] == 0, stats
    problems = es.trends_problems(0, stats, None)
    assert len(problems) == 1 and "carry no session id" in problems[0], problems


def test_a_window_older_than_the_recent_sessions_is_not_a_pairing_failure() -> None:
    # A --date / backfill run over an old window: the 10 recent intervals all
    # started after it, so no match is expected and nothing is reported.
    old = _session("OLD", "2026-02-08T05:00:00Z", "2026-02-08T12:00:00Z")
    recent = _session("NEW", "2026-03-20T05:00:00Z", "2026-03-20T12:00:00Z")
    client = FakeClient(days=[_day("2026-02-08", [old])],
                        intervals=[_interval("NEW", recent["ts"], 30.0, 20.0)])
    sb, stats = _sync(client, "2026-02-08", "2026-02-08")
    assert stats["records"] == 1 and stats["interval_pairing_failed"] == 0, stats
    assert es.trends_problems(0, stats, None) == []


def test_provider_day_is_stored_unchanged_whatever_the_utc_or_local_start_date() -> None:
    # 23:30 EST on 01-14 = 04:30 UTC on 01-15; the provider calls it 2026-01-15.
    s = _session("S", "2026-01-15T04:30:00Z", "2026-01-15T12:30:00Z")
    client = FakeClient(days=[_day("2026-01-15", [s])],
                        intervals=[_interval("S", s["ts"], 26.0, 18.5)])
    sb, _ = _sync(client, "2026-01-10", "2026-01-16")
    rows = sb.rows()
    assert set(rows) == {"2026-01-15"}, rows.keys()
    assert rows["2026-01-15"]["session_date"] == "2026-01-15"
    assert rows["2026-01-15"]["median_bed_temp"] == 26.0


def test_dst_nights_keep_the_provider_day_and_pair_by_session() -> None:
    # Fall back: 23:30 EDT 10-31 -> 08:00 EST 11-01. Spring forward: 01:30 EST -> 08:30 EDT 03-08.
    fall = _session("F", "2026-11-01T03:30:00Z", "2026-11-01T13:00:00Z")
    spring = _session("V", "2026-03-08T06:30:00Z", "2026-03-08T12:30:00Z")
    client = FakeClient(
        days=[_day("2026-03-08", [spring]), _day("2026-11-01", [fall])],
        intervals=[_interval("F", fall["ts"], 29.5, 20.5), _interval("V", spring["ts"], 25.5, 17.5)])
    sb, stats = _sync(client, "2026-03-01", "2026-11-02")
    rows = sb.rows()
    assert rows["2026-11-01"]["median_bed_temp"] == 29.5, rows["2026-11-01"]
    assert rows["2026-03-08"]["median_bed_temp"] == 25.5, rows["2026-03-08"]
    assert stats["bed_tz_mismatch"] == 0 and stats["bed_tz_unknown"] == 0, stats


def test_parse_interval_needs_an_id_and_returns_no_date() -> None:
    assert es.parse_interval({"ts": "2026-02-09T03:30:00Z"}, "left") is None
    parsed = es.parse_interval(_interval("X", "2026-02-09T03:30:00Z", 30.0, 20.0), "left")
    assert parsed["session_id"] == "X" and "calendar_date" not in parsed, parsed


# ---------------------------------------------------------------------------
# No row without a trend day (missing context, failure, retry)
# ---------------------------------------------------------------------------

def test_interval_of_a_night_still_processing_writes_no_row() -> None:
    s = _session("N", "2026-05-02T05:00:00Z", "2026-05-02T12:00:00Z")
    client = FakeClient(days=[_day("2026-05-02", [s], processing=True)],
                        intervals=[_interval("N", s["ts"], 30.0, 20.0)])
    sb, stats = _sync(client, "2026-04-28", "2026-05-02")
    assert sb.batches == [], sb.batches
    assert stats["records"] == 0 and stats["intervals_unmatched"] == 1, stats


def test_failed_trends_fetch_writes_nothing_then_recovers_next_run() -> None:
    s = _session("R", "2026-06-10T05:00:00Z", "2026-06-10T12:00:00Z")
    days = [_day("2026-06-10", [s])]
    intervals = [_interval("R", s["ts"], 30.0, 20.0)]
    # Run 1: the trends call fails. An interval-only row would have upserted NULL
    # scores and raw_json over the stored row; nothing is written instead.
    sb, stats = _sync(FakeClient(days, intervals, trends_errors=1), "2026-06-04", "2026-06-10")
    assert sb.batches == [], sb.batches
    assert stats["trend_chunks"] == 1 and stats["trend_chunks_failed"] == 1, stats
    problems = es.trends_problems(0, stats, None)
    assert len(problems) == 1 and "trends fetch failed for 1 of 1" in problems[0], problems
    # Run 2 (the retry): the same window is written normally.
    sb2, stats2 = _sync(FakeClient(days, intervals), "2026-06-04", "2026-06-10")
    assert sb2.rows()["2026-06-10"]["median_bed_temp"] == 30.0
    assert stats2["trend_chunks_failed"] == 0 and es.trends_problems(0, stats2, None) == []


def test_one_failed_chunk_of_two_writes_only_the_other_chunk() -> None:
    early = _session("E", "2026-07-02T05:00:00Z", "2026-07-02T12:00:00Z")
    late = _session("L", "2026-08-05T05:00:00Z", "2026-08-05T12:00:00Z")
    client = FakeClient(days=[_day("2026-07-02", [early]), _day("2026-08-05", [late])],
                        trends_errors=1)   # the first 30-day chunk fails
    sb, stats = _sync(client, "2026-07-01", "2026-08-09")
    assert set(sb.rows()) == {"2026-08-05"}, sb.rows().keys()
    assert stats["trend_chunks"] == 2 and stats["trend_chunks_failed"] == 1, stats


def test_traveler_away_night_has_no_row_and_neighbours_keep_their_days() -> None:
    # Away on the night that would wake 2026-09-11: the bed recorded nothing, so
    # the provider has no day for it. The sync never asks where the wearer was.
    # The return night starts before midnight (23:00 EDT on 09-11): keyed by its
    # start date it used to create a temps-only row ON the away night.
    before = _session("B1", "2026-09-10T05:00:00Z", "2026-09-10T12:00:00Z")
    after = _session("A1", "2026-09-12T03:00:00Z", "2026-09-12T11:00:00Z")
    client = FakeClient(days=[_day("2026-09-10", [before]), _day("2026-09-12", [after])],
                        intervals=[_interval("A1", after["ts"], 29.0, 21.0),
                                   _interval("B1", before["ts"], 27.0, 20.0)])
    sb, _ = _sync(client, "2026-09-08", "2026-09-12")
    rows = sb.rows()
    assert set(rows) == {"2026-09-10", "2026-09-12"}, rows.keys()
    assert rows["2026-09-12"]["median_bed_temp"] == 29.0


def test_upsert_payload_keys_are_unchanged() -> None:
    s = _session("K", "2026-02-20T05:00:00Z", "2026-02-20T12:00:00Z")
    client = FakeClient(days=[_day("2026-02-20", [s]), _day("2026-02-21", [
        _session("K2", "2026-02-21T05:00:00Z", "2026-02-21T12:00:00Z")])],
        intervals=[_interval("K", s["ts"], 30.0, 20.0)])
    sb, _ = _sync(client, "2026-02-18", "2026-02-21")
    with_temp, without_temp = sb.batches
    assert set(with_temp[0]) == ROW_COLUMNS, set(with_temp[0]) ^ ROW_COLUMNS
    # A day whose session is not among the recent intervals keeps its stored temps.
    assert set(without_temp[0]) == ROW_COLUMNS - set(es.TEMP_COLUMNS)


# ---------------------------------------------------------------------------
# Bed time zone (stationary vs relocated bed)
# ---------------------------------------------------------------------------

def _tz_day(tz, end="2026-01-20T12:00:00Z"):
    return {"sessions": [_session("Z", "2026-01-20T05:00:00Z", end, tz=tz)]}


def test_bed_tz_check_cases() -> None:
    assert es.bed_tz_check(_tz_day(NY), NY) == {"mismatch": 0, "unknown": 0}
    # Same offset at that instant: no date can differ, not a move.
    assert es.bed_tz_check(_tz_day("America/Toronto"), NY) == {"mismatch": 0, "unknown": 0}
    assert es.bed_tz_check(_tz_day("America/Chicago"), NY) == {"mismatch": 1, "unknown": 0}
    # A zone without DST matches Eastern in winter and not in summer.
    assert es.bed_tz_check(_tz_day("America/Bogota"), NY)["mismatch"] == 0
    summer = _tz_day("America/Bogota", end="2026-07-20T12:00:00Z")
    summer["sessions"][0]["ts"] = "2026-07-20T05:00:00Z"
    assert es.bed_tz_check(summer, NY)["mismatch"] == 1
    # Unknown stays unknown: never counted as a match or a move.
    assert es.bed_tz_check(_tz_day(None), NY) == {"mismatch": 0, "unknown": 1}
    assert es.bed_tz_check(_tz_day("Not/AZone"), NY) == {"mismatch": 0, "unknown": 1}
    no_time = {"sessions": [{"id": "Q", "timezone": NY}]}
    assert es.bed_tz_check(no_time, NY) == {"mismatch": 0, "unknown": 1}
    assert es.bed_tz_check({}, NY) == {"mismatch": 0, "unknown": 0}


def test_relocated_bed_is_stored_unshifted_and_reported_with_guard_first() -> None:
    s = _session("W", "2026-10-05T07:00:00Z", "2026-10-05T14:00:00Z", tz="America/Los_Angeles")
    client = FakeClient(days=[_day("2026-10-05", [s])],
                        intervals=[_interval("W", s["ts"], 30.0, 20.0)])
    sb, stats = _sync(client, "2026-10-01", "2026-10-05")
    assert set(sb.rows()) == {"2026-10-05"}, "the provider day must never be shifted"
    assert stats["bed_tz_mismatch"] == 1, stats
    problems = es.trends_problems(1, stats, "temp self-heal: synthetic")
    assert problems[0].startswith("GUARD eight_sleep_bed_tz:"), problems
    assert problems[1:] == ["1 error(s)", "temp self-heal: synthetic"], problems
    assert "Los_Angeles" not in problems[0] and "America" not in problems[0], problems[0]
    assert ".github/workflows/eight-sleep-etl.yml" in problems[0], problems[0]


def test_clean_run_has_no_problems() -> None:
    assert es.trends_problems(0, es._new_sync_stats(), None) == []


# ---------------------------------------------------------------------------
# Downstream contract pins (no date correction in SQL; one -1 move in Python)
# ---------------------------------------------------------------------------

def test_trigger_is_a_calendar_date_passthrough_and_nothing_reads_start_time() -> None:
    sql_dir = ROOT / "sql"
    defs = []
    for f in sorted(sql_dir.glob("*.sql")):
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+([^;]+);",
                             text, re.IGNORECASE):
            if re.search(r"\bON\s+pds\.eight_sleep_trends\b", m.group(2), re.IGNORECASE):
                defs.append((f.name, m.group(1), m.group(2)))
    onyx = [d for d in defs if d[1] == "eight_sleep_trends_set_onyx_dates"]
    assert onyx, "the onyx_* trigger on eight_sleep_trends is not in sql/"
    # Every definition ever shipped is a calendar_date copy (the original function
    # and the consolidated one). A trigger that re-dates rows from an instant would
    # double-shift hrv_alignment's one-day move.
    allowed = ("set_onyx_dates_calendar_passthrough", "set_onyx_dates_eight_sleep_trends")
    for name, trig, body in onyx:
        fn = re.search(r"EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+pds\.(\w+)", body, re.IGNORECASE)
        assert fn and fn.group(1) in allowed, (name, body)
    assert any("set_onyx_dates_calendar_passthrough" in body for _, _, body in onyx)
    for name, trig, body in defs:
        assert "start_time" not in body, (name, trig)
    consolidated = (sql_dir / "audit_re_2026_06_07_consolidate_identical_onyx_triggers.sql"
                    ).read_text(encoding="utf-8")
    fn_body = re.search(r"FUNCTION\s+pds\.set_onyx_dates_calendar_passthrough\(\)(.*?)\$\$;",
                        consolidated, re.IGNORECASE | re.DOTALL).group(1)
    for col in ("onyx_et_date", "onyx_behavioral_date", "onyx_local_date"):
        assert re.search(rf"NEW\.{col}\s*:=\s*NEW\.calendar_date", fn_body), col


def test_hrv_alignment_moves_eight_sleep_one_day_earlier() -> None:
    src = (ROOT / "hrv_alignment.py").read_text(encoding="utf-8")
    m = re.search(r"PREVIOUS_NIGHT_PREFIXES\s*=\s*\(([^)]*)\)", src)
    assert m and '"eight_sleep_"' in m.group(1), "eight_sleep_ must stay a wake-up-day prefix"


# ---------------------------------------------------------------------------
# Read-only history comparison (affected-history plan, step 1)
# ---------------------------------------------------------------------------

class FakeReadSB:
    """Select-only table with PostgREST-style ordering and range paging.

    No update / upsert attribute, so a write would raise."""

    def __init__(self, rows):
        self._all = [dict(r) for r in rows]
        self.ranges: list[tuple[int, int]] = []

    def schema(self, _):
        return self

    def from_(self, table):
        assert table == "eight_sleep_trends"
        self._orders: list[tuple[str, bool]] = []
        self._range = None
        return self

    def select(self, _cols):
        return self

    def order(self, col, desc=False):
        self._orders.append((col, desc))
        return self

    def range(self, start, end):
        self._range = (start, end)
        self.ranges.append((start, end))
        return self

    def execute(self):
        assert self._range is not None, "the comparison must page, not read one capped batch"
        rows = list(self._all)
        for col, desc in reversed(self._orders):      # first order() = primary key
            rows.sort(key=lambda r: r[col], reverse=desc)
        start, end = self._range
        return _Result(rows[start:end + 1])


class FakeIntervalClient:
    def __init__(self, by_id):
        self.by_id = by_id
        self.calls: list[tuple[str, str]] = []

    def get_interval(self, user_id, session_id):
        self.calls.append((user_id, session_id))
        v = self.by_id.get(session_id)
        if isinstance(v, Exception):
            raise v
        return v


def _stored(cal, sid, bed, room, side="left"):
    raw = {"mainSessionId": sid, "sessionIds": [sid]} if sid else None
    return {"calendar_date": cal, "bed_side": side, "raw_json": raw,
            "median_bed_temp": bed, "median_room_temp": room}


def test_compare_counts_every_outcome_and_writes_nothing() -> None:
    rows = [
        _stored("2026-03-01", "S", 27.0, 19.0),
        _stored("2026-03-02", "D", 31.0, 21.0),          # stored from another session
        _stored("2026-03-03", None, 27.0, 19.0),         # no session id
        _stored("2026-03-04", "G", 27.0, 19.0),          # session gone
        _stored("2026-03-05", "E", 27.0, 19.0),          # lookup error
        _stored("2026-03-06", "T", 27.0, 19.0),          # no temp readings
        _stored("2026-03-07", "N", None, None),          # nothing stored: not compared
        _stored("2026-03-08", "S", 27.0, None, side="left"),  # same session again
    ]
    client = FakeIntervalClient({
        "S": _interval("S", "t", 27.0, 19.0), "D": _interval("D", "t", 28.0, 19.0),
        "G": None, "E": RuntimeError("synthetic"), "T": {"timeseries": {}},
    })
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"}, delay_s=0)
    assert stats == {"scanned": 8, "truncated": False, "rows": 7, "same": 2, "differ": 1,
                     "partial": 0, "unmapped_side": 0, "no_session": 1, "not_found": 1,
                     "no_temp": 1, "failed": 1, "over_cap": 0, "lookups": 5,
                     "not_verifiable": 3, "complete": False, "clean": False}, stats
    assert client.calls.count(("u-left", "S")) == 1, client.calls


def test_compare_respects_the_lookup_cap() -> None:
    rows = [_stored(f"2026-04-0{i}", f"S{i}", 27.0, 19.0) for i in range(1, 5)]
    client = FakeIntervalClient({f"S{i}": _interval(f"S{i}", "t", 27.0, 19.0) for i in range(1, 5)})
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"},
                                   max_lookups=2, delay_s=0)
    assert stats["lookups"] == 2 and stats["over_cap"] == 2 and stats["same"] == 2, stats
    assert stats["differ"] == 0 and stats["complete"] is False, "over_cap rows are unchecked"


def test_compare_pages_through_the_whole_table() -> None:
    rows = [_stored(f"2026-05-0{i}", f"S{i}", 27.0, 19.0) for i in range(1, 6)]
    client = FakeIntervalClient({f"S{i}": _interval(f"S{i}", "t", 27.0, 19.0) for i in range(1, 6)})
    sb = FakeReadSB(rows)
    stats = backfill.compare_temps(client, sb, {"left": "u-left"}, page_size=2, delay_s=0)
    assert sb.ranges == [(0, 1), (2, 3), (4, 5)], sb.ranges
    assert stats["scanned"] == 5 and stats["same"] == 5 and stats["truncated"] is False, stats
    assert stats["complete"] is True and stats["not_verifiable"] == 0, stats
    assert stats["clean"] is True, "whole table read, every row checked, none differ"


def test_compare_that_stops_at_its_row_cap_is_incomplete() -> None:
    rows = [_stored(f"2026-06-0{i}", f"S{i}", 27.0, 19.0) for i in range(1, 7)]
    client = FakeIntervalClient({f"S{i}": _interval(f"S{i}", "t", 27.0, 19.0) for i in range(1, 7)})
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"},
                                   page_size=2, max_rows=4, delay_s=0)
    assert stats["scanned"] == 4 and stats["truncated"] is True, stats
    assert stats["differ"] == 0 and stats["complete"] is False, stats


def test_compare_counts_a_temp_it_could_not_check_as_partial_not_same() -> None:
    no_room = {"timeseries": {"tempBedC": [["t", 27.0]] * 3}}
    rows = [_stored("2026-07-01", "P1", 27.0, 19.0),     # bed matches, room unreadable
            _stored("2026-07-02", "P2", 31.0, 19.0)]     # bed differs, room unreadable
    client = FakeIntervalClient({"P1": no_room, "P2": no_room})
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"}, delay_s=0)
    assert stats["partial"] == 1 and stats["differ"] == 1 and stats["same"] == 0, stats
    assert stats["complete"] is False, stats


def test_compare_reports_rows_it_cannot_verify_and_never_counts_them_clean() -> None:
    multi = {"sessionIds": ["X1", "X2"]}                  # no main session: unknown
    rows = [_stored("2026-08-01", "S", 27.0, 19.0, side="away"),
            {**_stored("2026-08-02", None, 27.0, 19.0), "raw_json": multi}]
    client = FakeIntervalClient({"S": _interval("S", "t", 27.0, 19.0)})
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"}, delay_s=0)
    assert stats["unmapped_side"] == 1 and stats["no_session"] == 1, stats
    assert stats["same"] == 0 and stats["not_verifiable"] == 2, stats
    assert client.calls == [], "nothing to look up"
    # Every row was read and counted, so the scan is complete, but nothing in it
    # is clean: the two rows are reported as not verifiable.
    assert stats["complete"] is True and stats["clean"] is False, stats


def test_compare_with_a_difference_is_complete_but_not_clean() -> None:
    rows = [_stored("2026-08-10", "S", 27.0, 19.0), _stored("2026-08-11", "D", 31.0, 19.0)]
    client = FakeIntervalClient({"S": _interval("S", "t", 27.0, 19.0),
                                 "D": _interval("D", "t", 28.0, 19.0)})
    stats = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"}, delay_s=0)
    assert stats["differ"] == 1 and stats["complete"] is True, stats
    assert stats["clean"] is False, stats


def test_compare_lookup_cap_can_be_raised_so_a_rerun_reaches_every_row() -> None:
    # An identical re-run repeats the same capped lookups (the scan restarts at the
    # newest row); a larger --max-lookups is what reaches the rest.
    rows = [_stored(f"2026-09-0{i}", f"S{i}", 27.0, 19.0) for i in range(1, 6)]
    client = FakeIntervalClient({f"S{i}": _interval(f"S{i}", "t", 27.0, 19.0) for i in range(1, 6)})
    first = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"},
                                   max_lookups=3, delay_s=0)
    again = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"},
                                   max_lookups=3, delay_s=0)
    assert first == again and first["over_cap"] == 2 and first["complete"] is False, first
    wider = backfill.compare_temps(client, FakeReadSB(rows), {"left": "u-left"},
                                   max_lookups=first["lookups"] + first["over_cap"], delay_s=0)
    assert wider["over_cap"] == 0 and wider["same"] == 5 and wider["clean"] is True, wider


def test_max_lookups_flag_is_parsed_and_bounded() -> None:
    assert backfill._max_lookups(["--compare"]) == backfill.BACKFILL_MAX_LOOKUPS
    assert backfill._max_lookups(["--compare", "--max-lookups", "2500"]) == 2500
    for bad in (["--max-lookups"], ["--max-lookups", "x"], ["--max-lookups", "0"],
                ["--max-lookups", str(backfill.COMPARE_MAX_LOOKUPS + 1)]):
        try:
            backfill._max_lookups(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"{bad} must be refused")
    try:
        backfill.main(["--max-lookups", "5"])
    except SystemExit as exc:
        assert "--compare" in str(exc)
    else:
        raise AssertionError("--max-lookups without --compare must refuse before connecting")


def test_compare_cannot_be_combined_with_apply() -> None:
    try:
        backfill.main(["--compare", "--apply"])
    except SystemExit as exc:
        assert "read-only" in str(exc)
    else:
        raise AssertionError("--compare --apply must refuse before connecting")


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    if failures:
        print(f"{failures} failure(s)")
        sys.exit(1)
    print("OK - eight_sleep date contract tests passed.")
