"""WHOOP daily steps: the ETL row, the cycles-only backfill mode, and the HRV-pipeline merge.

Covers
  * whoop_etl.parse_step_count / cycle_row: step_count is read from the top level of a v2
    cycle, null stays None (never 0), and every pre-existing column is unchanged for both a
    v2 record and a v1 record (which has no step_count key);
  * whoop_etl.WhoopClient: cycles come from /v2/cycle; profile and body measurement use /v2
    and fall back to /v1 only on 404 / 410;
  * whoop_etl.main: a normal run syncs every endpoint, writes whoop|full_sync and runs the
    time-zone pass; --cycles-only syncs cycles alone, writes whoop|cycles_backfill and never
    runs the time-zone pass;
  * hrv_analysis.merge_whoop_steps_features: each cycle is dated from its own local start
    (a night-time onset dated D lands on row D + 1, the waking day it counts; an onset after
    06:00 local counts its own clock day), cycles on the same day are summed, a day with an
    open cycle or a null count stays NaN (never zero), fail-open, idempotent;
  * hrv_alignment: cycle_waking_day (local offset, ET fallback), and the runtime guard
    catching a WHOOP-steps column that sits on the wrong day;
  * the wiring: forecast exclusion, labels, causal treatment, no negative shift.

Synthetic data only. No network, no credentials.

Run: python tests/test_whoop_steps.py
"""
import inspect
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("WHOOP_CLIENT_ID", "test-client")
os.environ.setdefault("WHOOP_CLIENT_SECRET", "test-secret")

import httpx  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402
import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402
import whoop_etl as etl  # noqa: E402

# The example cycle from WHOOP's API reference (invented ids and values).
V2_CYCLE = {
    "id": 93845, "user_id": 10129,
    "created_at": "2022-04-24T11:25:44.774Z", "updated_at": "2022-04-24T14:25:44.774Z",
    "start": "2022-04-24T02:25:44.774Z", "end": "2022-04-24T10:25:44.774Z",
    "timezone_offset": "-05:00", "score_state": "SCORED",
    "score": {"strain": 5.2951527, "kilojoule": 8288.297, "average_heart_rate": 68, "max_heart_rate": 141},
    "step_count": 8234,
}
V1_CYCLE = {k: v for k, v in V2_CYCLE.items() if k != "step_count"}
EXISTING_COLUMNS = {
    "cycle_id": 93845, "user_id": 10129,
    "created_at": "2022-04-24T11:25:44.774Z", "updated_at": "2022-04-24T14:25:44.774Z",
    "start_time": "2022-04-24T02:25:44.774Z", "end_time": "2022-04-24T10:25:44.774Z",
    "timezone_offset": "-05:00", "score_state": "SCORED",
    "strain": 5.2951527, "kilojoule": 8288.297, "average_heart_rate": 68, "max_heart_rate": 141,
}


# ---------------------------------------------------------------------------
# ETL: the row
# ---------------------------------------------------------------------------

def test_parse_step_count():
    assert etl.parse_step_count(8234) == 8234
    assert etl.parse_step_count(0) == 0, "a real zero is kept"
    assert etl.parse_step_count(8234.0) == 8234
    assert etl.parse_step_count("8234") == 8234
    for missing in (None, True, False, "", "n/a", -5, 12.5, float("nan"), float("inf"), [], {}):
        assert etl.parse_step_count(missing) is None, f"{missing!r} must be treated as missing"


def test_cycle_row_keeps_every_existing_column_and_adds_steps():
    row = etl.cycle_row(V2_CYCLE)
    assert {k: row[k] for k in EXISTING_COLUMNS} == EXISTING_COLUMNS
    assert row["step_count"] == 8234, "step_count sits at the top level of the cycle, not in score"
    assert row["raw_json"] is V2_CYCLE, "raw_json is passed as a dict, never json.dumps'd"
    assert set(row) == set(EXISTING_COLUMNS) | {"step_count", "raw_json"}


def test_cycle_row_without_steps_is_none_never_zero():
    for record in (V1_CYCLE, {**V2_CYCLE, "step_count": None}):
        row = etl.cycle_row(record)
        assert row["step_count"] is None
        assert {k: row[k] for k in EXISTING_COLUMNS} == EXISTING_COLUMNS
    # an open, unscored cycle: no end, no score
    open_cycle = {"id": 1, "start": "2026-01-02T06:00:00.000Z", "score_state": "PENDING_SCORE",
                  "score": None, "step_count": 412}
    row = etl.cycle_row(open_cycle)
    assert row["end_time"] is None and row["strain"] is None and row["step_count"] == 412


def test_sync_cycles_upserts_rows_with_steps():
    class Whoop:
        def get_cycles(self, start, end):
            return [V2_CYCLE, {**V2_CYCLE, "id": 93846, "step_count": None}]

    seen = {}

    def fake_upsert(sb, table, rows, conflict):
        seen.update(table=table, rows=rows, conflict=conflict)
        return len(rows)

    real = etl.upsert_to_supabase
    etl.upsert_to_supabase = fake_upsert
    try:
        assert etl.sync_cycles(Whoop(), object(), "a", "b") == 2
    finally:
        etl.upsert_to_supabase = real
    assert (seen["table"], seen["conflict"]) == ("whoop_cycles", "cycle_id")
    assert [r["step_count"] for r in seen["rows"]] == [8234, None]


# ---------------------------------------------------------------------------
# ETL: endpoints
# ---------------------------------------------------------------------------

def _client():
    return object.__new__(etl.WhoopClient)   # no token file, no network


def test_cycles_are_read_from_v2():
    c, calls = _client(), []
    c.get_paginated = lambda path, start=None, end=None: calls.append((path, start, end)) or []
    c.get_cycles("s", "e")
    assert calls == [("/v2/cycle", "s", "e")]
    src = Path(etl.__file__).read_text(encoding="utf-8")
    assert '"/v1/cycle"' not in src, "step_count only exists on /v2/cycle"


def _status_error(code):
    req = httpx.Request("GET", "https://example.invalid/x")
    return httpx.HTTPStatusError("boom", request=req, response=httpx.Response(code, request=req))


def test_profile_and_body_use_v2_and_fall_back_to_v1_only_when_v2_is_gone():
    c, calls = _client(), []
    c.get = lambda path, **kw: calls.append(path) or {"ok": path}
    assert c.get_profile() == {"ok": "/v2/user/profile/basic"}
    assert c.get_body_measurement() == {"ok": "/v2/user/measurement/body"}
    assert calls == ["/v2/user/profile/basic", "/v2/user/measurement/body"]

    for gone in (404, 410):
        c, calls = _client(), []

        def get(path, _gone=gone, _calls=calls, **kw):
            _calls.append(path)
            if path.startswith("/v2/"):
                raise _status_error(_gone)
            return {"ok": path}

        c.get = get
        assert c.get_profile() == {"ok": "/v1/user/profile/basic"}
        assert calls == ["/v2/user/profile/basic", "/v1/user/profile/basic"]

    # any other failure (an outage, a bad token) is not hidden behind the old path
    c, calls = _client(), []

    def failing(path, **kw):
        calls.append(path)
        raise _status_error(500)

    c.get = failing
    try:
        c.get_profile()
    except httpx.HTTPStatusError:
        pass
    else:
        raise AssertionError("a 500 from /v2 must propagate")
    assert calls == ["/v2/user/profile/basic"]


# ---------------------------------------------------------------------------
# ETL: main() in normal and --cycles-only mode
# ---------------------------------------------------------------------------

class FakeWhoop:
    def __init__(self):
        self.calls = []

    def get_profile(self):
        self.calls.append("profile")
        return {}

    def get_cycles(self, start, end):
        self.calls.append("cycles")
        return [V2_CYCLE]

    def get_recovery(self, start, end):
        self.calls.append("recovery")
        return []

    def get_sleep(self, start, end):
        self.calls.append("sleep")
        return []

    def get_workouts(self, start, end):
        self.calls.append("workouts")
        return []

    def get_body_measurement(self):
        self.calls.append("body")
        return {}


class FakeSb:
    def schema(self, _):
        return self

    def rpc(self, *_):
        return self

    def execute(self):
        return self


def _run_main(argv, whoop=None, exits=None):
    """Run whoop_etl.main with fakes. A sys.exit is recorded in `exits` (when given)."""
    whoop, beats, upserts, spawned = whoop or FakeWhoop(), [], [], []
    saved = (etl.WhoopClient, etl.get_supabase_client, etl.log_sync, etl.upsert_to_supabase,
             etl.time.sleep, subprocess.run, sys.argv)
    etl.WhoopClient = lambda: whoop
    etl.get_supabase_client = lambda: FakeSb()
    etl.log_sync = lambda sb, source, data_type, status, **kw: beats.append((source, data_type, status, kw))
    etl.upsert_to_supabase = lambda sb, table, rows, conflict: upserts.append(table) or len(rows)
    etl.time.sleep = lambda *_: None
    subprocess.run = lambda cmd, **kw: spawned.append(cmd)
    sys.argv = ["whoop_etl.py", *argv]
    try:
        etl.main()
    except SystemExit as e:
        if exits is None:
            raise
        exits.append(e.code)
    finally:
        (etl.WhoopClient, etl.get_supabase_client, etl.log_sync, etl.upsert_to_supabase,
         etl.time.sleep, subprocess.run, sys.argv) = saved
    return whoop, beats, upserts, spawned


def test_normal_run_syncs_everything_and_runs_the_tz_pass():
    whoop, beats, upserts, spawned = _run_main(["--days", "7"])
    assert whoop.calls == ["profile", "cycles", "recovery", "sleep", "workouts", "body"]
    assert upserts == ["whoop_cycles"]
    assert [(s, t, st) for s, t, st, _ in beats] == [("whoop", "full_sync", "success")]
    assert len(spawned) == 1 and "whoop_tz_backfill.py" in spawned[0]


def test_cycles_only_run_touches_cycles_alone_and_skips_the_tz_pass():
    whoop, beats, upserts, spawned = _run_main(["--days", "800", "--cycles-only"])
    assert whoop.calls == ["profile", "cycles"]
    assert upserts == ["whoop_cycles"]
    assert [(s, t, st) for s, t, st, _ in beats] == [("whoop", "cycles_backfill", "success")], \
        "its heartbeat must not stand in for the hourly whoop|full_sync"
    assert beats[0][3]["records"] == 1
    assert spawned == [], "a deep re-read must never rewrite time-zone history"


def test_cycles_only_failures_go_red_under_their_own_heartbeat():
    class CyclesDown(FakeWhoop):
        def get_cycles(self, start, end):
            raise httpx.ConnectError("synthetic outage")

    class TokenRejected(FakeWhoop):
        def get_profile(self):
            raise httpx.ConnectError("synthetic rejection")

    for fake in (CyclesDown(), TokenRejected()):
        exits = []
        _, beats, upserts, spawned = _run_main(["--days", "800", "--cycles-only"], whoop=fake, exits=exits)
        assert exits == [1], "a failed backfill must turn the Actions run red"
        assert [(s, t, st) for s, t, st, _ in beats] == [("whoop", "cycles_backfill", "failed")],             "never a green partial, and never on the hourly whoop|full_sync"
        assert upserts == [] and spawned == []
    # a normal run with one failing endpoint is unchanged: a partial full_sync, exit 0
    exits = []
    _, beats, _, _ = _run_main(["--days", "7"], whoop=CyclesDown(), exits=exits)
    assert exits == [] and [(s, t, st) for s, t, st, _ in beats] == [("whoop", "full_sync", "partial")]


def test_workflow_offers_the_cycles_only_backfill():
    yml = (ROOT / ".github" / "workflows" / "daily-etl.yml").read_text(encoding="utf-8")
    assert "whoop_cycles_only:" in yml and "--cycles-only" in yml
    assert "if: ${{ !inputs.whoop_cycles_only }}" in yml, "a cycles-only run must skip the Garmin job"
    assert "group: hourly-etl" in yml and "cancel-in-progress: false" in yml


# ---------------------------------------------------------------------------
# HRV pipeline: merge_whoop_steps_features
# ---------------------------------------------------------------------------

def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-08").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(8.0)})


def _cycle(day, steps, start_hour=6, hours=24.0, closed=True, cycle_id=None):
    """A cycle dated `day`: its opening sleep starts at `start_hour` UTC on day + 1. There is
    no timezone_offset, so the merge falls back to ET: 06:00 UTC in January = 01:00 EST, the
    small hours of day + 1."""
    start = pd.Timestamp(day, tz="UTC") + pd.Timedelta(days=1, hours=start_hour)
    return {
        "cycle_id": cycle_id or int(start.timestamp()),
        "start_time": start.isoformat(),
        "end_time": (start + pd.Timedelta(hours=hours)).isoformat() if closed else None,
        "onyx_behavioral_date": day,
        "step_count": steps,
    }


def _local_cycle(local_start, hours, steps, offset="-04:00", closed=True):
    """A cycle given by its LOCAL start ('YYYY-MM-DD HH:MM') and WHOOP timezone_offset."""
    start = pd.Timestamp(local_start + offset)
    return {
        "cycle_id": int(start.timestamp()),
        "start_time": start.tz_convert("UTC").isoformat(),
        "end_time": (start + pd.Timedelta(hours=hours)).tz_convert("UTC").isoformat() if closed else None,
        "timezone_offset": offset,
        # the -6 h rule on the local onset, as the DB trigger dates it
        "onyx_behavioral_date": (pd.Timestamp(local_start) - pd.Timedelta(hours=6)).strftime("%Y-%m-%d"),
        "step_count": steps,
    }


def _cycles():
    return pd.DataFrame([
        _cycle("2026-01-01", 5000),
        _cycle("2026-01-02", 12000),
        _cycle("2026-01-03", None),                      # strap not worn: WHOOP sends null
        _cycle("2026-01-04", 300, start_hour=0, hours=4.0),  # 19:00 EST Jan 4: counts Jan 5...
        _cycle("2026-01-04", 9000, start_hour=4),        # ...and so does the next cycle: summed
        _cycle("2026-01-05", 0),                         # a real zero
        _cycle("2026-01-06", 4321, closed=False),        # the open cycle: steps so far
        _cycle("2026-01-20", 7777),                      # outside the matrix
    ])


def test_cycle_dated_d_lands_on_row_d_plus_one():
    out = h.merge_whoop_steps_features(_matrix(), _cycles())
    by = out.set_index("calendar_date")["whoop_steps"]
    assert len(out) == 8
    assert by["2026-01-02"] == 5000, "the cycle dated Jan 1 counts the waking day Jan 2"
    assert by["2026-01-03"] == 12000
    assert np.isnan(by["2026-01-01"]), "nothing lands on the cycle's own date"
    assert by["2026-01-05"] == 9300, "two cycles on one waking day are summed, not one kept"
    assert by["2026-01-06"] == 0, "a real zero stays a zero"
    # nothing else on the matrix moved
    assert out["whoop_hrv_rmssd"].tolist() == _matrix()["whoop_hrv_rmssd"].tolist()


def test_missing_and_open_cycles_stay_nan_never_zero():
    by = h.merge_whoop_steps_features(_matrix(), _cycles()).set_index("calendar_date")["whoop_steps"]
    assert np.isnan(by["2026-01-04"]), "a null count is unknown, not zero"
    assert np.isnan(by["2026-01-07"]), "the open cycle's steps-so-far never reach the analysis"
    assert np.isnan(by["2026-01-08"]), "a day with no cycle is unknown"
    assert int((by == 0).sum()) == 1, "the only zero is the real one"


def test_merge_is_idempotent_and_coerces_types():
    cycles = _cycles()
    cycles["step_count"] = cycles["step_count"].map(lambda v: None if v is None or pd.isna(v) else str(int(v)))
    cycles["onyx_behavioral_date"] = pd.to_datetime(cycles["onyx_behavioral_date"])
    once = h.merge_whoop_steps_features(_matrix(), cycles)
    twice = h.merge_whoop_steps_features(once, cycles)
    assert len(once) == 8 and once.equals(twice)
    assert once.set_index("calendar_date").loc["2026-01-03", "whoop_steps"] == 12000


def test_daytime_onset_counts_its_own_day_not_the_next():
    """The 2026-11-14 review case: two cycles share behavioral date D because the first
    onset is after 06:00 local. The first one's waking hours are clock day D, the second's
    D + 1. Longest-wins + 1 day put the first cycle's count on D + 1 and left D empty, even
    when the first is longer by a minute."""
    first = _local_cycle("2026-01-03 06:27", 21.65, 5374)    # dated Jan 3 by the -6 h rule
    second = _local_cycle("2026-01-04 04:06", 21.6, 751)     # also dated Jan 3
    assert first["onyx_behavioral_date"] == second["onyx_behavioral_date"] == "2026-01-03"
    for order in ([first, second], [second, first]):
        by = h.merge_whoop_steps_features(_matrix(), pd.DataFrame(order)).set_index("calendar_date")["whoop_steps"]
        assert by["2026-01-03"] == 5374, "the daytime-onset cycle counts its own clock day"
        assert by["2026-01-04"] == 751, "the next cycle counts the following day"
        assert int(by.notna().sum()) == 2


def test_open_or_null_cycle_on_a_summed_day_leaves_it_nan():
    closed = _local_cycle("2026-01-02 19:30", 8.0, 800)       # counts Jan 3
    for partner in (_local_cycle("2026-01-03 03:30", 20.0, 4000, closed=False),   # still open
                    _local_cycle("2026-01-03 03:30", 20.0, None)):               # no count
        frame = pd.DataFrame([closed, partner, _local_cycle("2026-01-06 01:00", 20.0, 1234)])
        by = h.merge_whoop_steps_features(_matrix(), frame).set_index("calendar_date")["whoop_steps"]
        assert np.isnan(by["2026-01-03"]), "part of the day is unknown, so the day is unknown"
    by = h.merge_whoop_steps_features(_matrix(), pd.DataFrame([closed])).set_index("calendar_date")["whoop_steps"]
    assert by["2026-01-03"] == 800


def test_negative_counts_are_dropped():
    cycles = pd.DataFrame([_cycle("2026-01-01", -40), _cycle("2026-01-02", 800)])
    by = h.merge_whoop_steps_features(_matrix(), cycles).set_index("calendar_date")["whoop_steps"]
    assert np.isnan(by["2026-01-02"]) and by["2026-01-03"] == 800


def test_fail_open():
    m = _matrix()
    assert h.merge_whoop_steps_features(m, None) is m
    assert h.merge_whoop_steps_features(m, pd.DataFrame()) is m
    no_steps_column = _cycles().drop(columns=["step_count"])        # e.g. the column is missing
    out = h.merge_whoop_steps_features(m, no_steps_column)
    assert out.equals(m) and "whoop_steps" not in out.columns
    all_null = pd.DataFrame([_cycle("2026-01-01", None), _cycle("2026-01-02", None)])
    assert "whoop_steps" not in h.merge_whoop_steps_features(m, all_null).columns


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def test_cycle_waking_day_uses_the_local_start():
    rows = pd.DataFrame([
        _local_cycle("2026-02-28 23:10", 24, 1),            # evening onset -> next day
        _local_cycle("2026-03-01 01:40", 24, 1),            # after midnight -> same clock day
        _local_cycle("2026-03-01 06:00", 24, 1),            # 06:00 is the first daytime minute
        _local_cycle("2026-03-01 17:59", 24, 1),            # still its own day
        _local_cycle("2026-03-01 18:00", 24, 1),            # 18:00 -> next day
        _local_cycle("2026-12-31 22:00", 24, 1, offset="+01:00"),  # year end, east of UTC
    ])
    assert al.cycle_waking_day(rows).tolist() == [
        "2026-03-01", "2026-03-01", "2026-03-01", "2026-03-01", "2026-03-02", "2027-01-01"]
    # for a night-time onset the rule equals the behavioral date + 1 (the strain move)
    night = rows.iloc[[0, 1, 4, 5]]
    plus_one = (pd.to_datetime(night["onyx_behavioral_date"]) + pd.Timedelta(days=1)).dt.strftime("%Y-%m-%d")
    assert al.cycle_waking_day(night).tolist() == plus_one.tolist()


def test_cycle_waking_day_offset_and_fallback():
    # 23:30 UTC = 15:30 at -08:00 (own day) but 18:30 EST in the ET fallback (next day)
    west = {"start_time": "2026-01-10T23:30:00+00:00", "timezone_offset": "-08:00"}
    assert al.cycle_waking_day(pd.DataFrame([west])).tolist() == ["2026-01-10"]
    for missing in (None, "", "garbage", "+99:00"):
        assert al.cycle_waking_day(pd.DataFrame([{**west, "timezone_offset": missing}])).tolist() == ["2026-01-11"]
    assert al.cycle_waking_day(pd.DataFrame([{"start_time": west["start_time"]}])).tolist() == ["2026-01-11"]
    # the ET fallback follows daylight time: 22:30 UTC in July = 18:30 EDT -> next day
    assert al.cycle_waking_day(pd.DataFrame([{"start_time": "2026-07-10T22:30:00Z"}])).tolist() == ["2026-07-11"]
    assert al._offset_minutes("+0530") == 330 and al._offset_minutes("-04") == -240
    out = al.cycle_waking_day(pd.DataFrame([{"start_time": None}, {"start_time": "nope"}]))
    assert out.isna().all()
    assert al.cycle_waking_day(pd.DataFrame()).empty


def _two_device_frame(n=90):
    """A matrix with a second device's steps (clock day) and WHOOP cycles that truly count
    the waking day after the cycle date."""
    rng = np.random.default_rng(7)
    days = pd.date_range("2026-01-01", periods=n)
    walked = rng.integers(2000, 20000, size=n).astype(float)
    matrix = pd.DataFrame({
        "calendar_date": days.strftime("%Y-%m-%d"),
        "whoop_hrv_rmssd": rng.normal(60, 8, size=n),
        "total_steps": walked + rng.normal(0, 600, size=n),
    })
    cycles = pd.DataFrame([
        _cycle((d - pd.Timedelta(days=1)).strftime("%Y-%m-%d"), int(w))
        for d, w in zip(days, walked)
    ])
    return matrix, cycles


def test_runtime_guard_accepts_the_rule_and_catches_a_wrong_day():
    matrix, cycles = _two_device_frame()
    good = h.merge_whoop_steps_features(matrix, cycles)
    assert good["whoop_steps"].notna().sum() >= 80
    assert al.check_rekey_directions(good) == []

    # the same counts left on the cycle's own date: one day early
    by_cycle_date = cycles.rename(columns={"onyx_behavioral_date": "calendar_date",
                                           "step_count": "whoop_steps"})[["calendar_date", "whoop_steps"]]
    bad = matrix.merge(by_cycle_date, on="calendar_date", how="left")
    problems = al.check_rekey_directions(bad)
    assert len(problems) == 1 and "whoop_steps" in problems[0] and "adjacent row" in problems[0]

    # no second device on the frame: the check is skipped, never a false alarm
    assert al.check_rekey_directions(good.drop(columns=["total_steps"])) == []


def test_alignment_and_forecast_rules():
    col = h.WHOOP_STEPS_COL
    assert col == "whoop_steps" and col in al.CYCLE_TOTAL_FEATURES
    assert col not in al.NEXT_DAY_COLS, "re-keyed before the merge; realign_matrix must not move it again"
    assert not al.is_same_sleep(col), "walked before the outcome sleep, not measured from it"
    assert col not in al.NEEDS_SLEEP_ONSET and col not in al.OUTCOME_TWINS
    assert col.startswith(h.NOT_FORECAST_PREFIXES), "would reach the forecast with a NaN newest row"
    assert not "whoop_day_strain".startswith(h.NOT_FORECAST_PREFIXES)
    assert col in h.CONTROLLABLE_FEATURE_PREFIXES
    assert h.FEATURE_LABELS[col] == "Daily Steps (WHOOP)"
    assert h.FEATURE_LABELS["total_steps"] == "Daily Steps (Garmin)"


def test_causal_steps_treatment_is_whoop_only():
    registered = {c: (f, label) for c, f, label, _ in ci.CONTINUOUS_TREATMENTS}
    assert registered["whoop_steps"][0] == "behavior"
    assert "total_steps" not in registered, "one steps signal per FDR family (WHOOP)"
    df = pd.DataFrame({"whoop_steps": [1.0, 2.0], "hrv_lag1": [50.0, 51.0]})
    specs = {s.name: s for s in ci._enumerate_continuous_treatments(df)}
    assert specs["whoop_steps"].kind == "continuous_median_split"
    assert "whoop_steps" not in {s.name for s in ci._enumerate_continuous_treatments(pd.DataFrame({"hrv_lag1": [1.0]}))}


def test_no_negative_shift_in_new_code():
    for src in (Path(etl.__file__).read_text(encoding="utf-8"),
                inspect.getsource(h.merge_whoop_steps_features),
                inspect.getsource(al.cycle_waking_day)):
        assert ".shift(-" not in src


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
