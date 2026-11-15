"""Garmin training load: acute / chronic load are stored, and rest days count as load 0.

Roadmap rows (2026-11-13):
  A  "Garmin acute / chronic training load are never stored, so 3 causal treatments have no data"
  B  "Training-load treatments leave out rest days (load is NaN, not 0, without a Garmin activity)"

Covers
  * garmin_etl.training_load_from_status: reads acuteTrainingLoadDTO for the requested day only
    (for an unsynced day Garmin can answer with an EARLIER day's record, which must read as
    "no data"), primary device first, junk values rejected, a missing value left out (never None);
  * garmin_etl.sync_training_status: readiness and load land in one row; when one endpoint has
    nothing its columns are left out of the upsert (an earlier value is never blanked); when
    neither has anything nothing is written;
  * garmin_etl.main --backfill-training-status: calls only the two training endpoints and
    writes one garmin|training_status_backfill heartbeat;
  * hrv_analysis.garmin_worn_days: the same rule as garmin_etl.daily_summary_has_wearable_values,
    checked by sending each payload through sync_daily_summary and the matrix view's aliases;
  * hrv_analysis.fill_rest_day_training_load / add_rolling_training_load: a worn day with no
    activity is 0, an unworn day stays NaN, activity days are untouched; a rolling window of
    worn rest days is 0 and a window without a single worn day stays NaN;
  * the wiring in build_feature_matrix, and one copy of acute / chronic load in the matrix.

Synthetic data only: key names follow Garmin's training-status / readiness / daily-summary
responses, values are invented. No network, no credentials, no database.

Run: python tests/test_garmin_training_load.py
"""
from __future__ import annotations

import inspect
import logging
import os
import re
import sys
import types
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for _key, _value in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_ROLE_KEY", "test"),
                     ("GARMIN_EMAIL", "stub@example.invalid"), ("GARMIN_PASSWORD", "stub")):
    os.environ.setdefault(_key, _value)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402
import garmin_etl as g  # noqa: E402
import hrv_analysis as h  # noqa: E402

logging.disable(logging.CRITICAL)

DAY = date(2026, 6, 10)  # any past day (the sync_* functions skip future ET dates)
DS = DAY.isoformat()
MATRIX_SQL = ROOT / "sql" / "daily_health_matrix_behavioral_main_session.sql"


def status_payload(records: dict) -> dict:
    """A training-status response (get_training_status) with the given device records."""
    return {"userId": 1, "mostRecentVO2Max": None, "mostRecentTrainingLoadBalance": None,
            "mostRecentTrainingStatus": {"userId": 1, "latestTrainingStatusData": records,
                                         "recordedDevices": [], "showSelector": False}}


def device_record(ds: str, acute=512, chronic=480.5, primary=True) -> dict:
    return {"calendarDate": ds, "sinceDate": "2026-05-01", "trainingStatus": 7,
            "trainingStatusFeedbackPhrase": "PRODUCTIVE_1", "deviceId": 111,
            "primaryTrainingDevice": primary, "fitnessTrend": 2,
            "acuteTrainingLoadDTO": {"acwrPercent": 45, "acwrStatus": "OPTIMAL",
                                     "dailyTrainingLoadAcute": acute,
                                     "dailyTrainingLoadChronic": chronic,
                                     "maxTrainingLoadChronic": 720.0, "minTrainingLoadChronic": 384.0,
                                     "dailyAcuteChronicWorkloadRatio": 1.1}}


READINESS = [{"calendarDate": DS, "level": "MODERATE", "score": 61, "acuteLoad": 498,
              "sleepScore": 80, "inputContext": "AFTER_WAKEUP_RESET"}]


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeQuery:
    def __init__(self, sb, table):
        self.sb, self.table, self.payload = sb, table, None

    def upsert(self, rows, on_conflict=None):
        self.payload = rows
        self.sb.upserts.setdefault(self.table, []).extend(rows)
        return self

    def insert(self, row):
        self.payload = [row]
        self.sb.inserts.setdefault(self.table, []).append(row)
        return self

    def execute(self):
        return types.SimpleNamespace(data=self.payload or [])


class FakeSupabase:
    def __init__(self):
        self.upserts: dict[str, list] = {}
        self.inserts: dict[str, list] = {}

    def schema(self, _name):
        return self

    def table(self, name):
        return FakeQuery(self, name)


class FakeTrainingGarmin:
    """Answers only the two training endpoints; any other Garmin call fails the test."""

    def __init__(self, readiness=None, status=None, status_error=None):
        self.readiness = readiness or {}
        self.status = status or {}
        self.status_error = status_error
        self.calls: list[str] = []

    def get_training_readiness(self, ds):
        self.calls.append("get_training_readiness")
        return self.readiness.get(ds, [])

    def get_training_status(self, ds):
        self.calls.append("get_training_status")
        if self.status_error:
            raise self.status_error
        return self.status.get(ds)

    def __getattr__(self, name):
        raise AssertionError(f"unexpected Garmin call {name}")


# ---------------------------------------------------------------------------
# A. ETL: parsing the training-status payload
# ---------------------------------------------------------------------------

def test_reads_acute_and_chronic_for_the_day():
    out = g.training_load_from_status(status_payload({"111": device_record(DS)}), DS)
    assert out == {"acute_training_load": 512.0, "chronic_training_load": 480.5}


def test_a_record_from_an_earlier_day_is_no_data():
    # The watch did not sync on DS, so the "most recent" status is an earlier day's.
    stale = status_payload({"111": device_record("2026-06-07")})
    assert g.training_load_from_status(stale, DS) == {}


def test_primary_training_device_wins():
    records = {"222": device_record(DS, acute=100, chronic=90, primary=False),
               "111": device_record(DS, acute=512, chronic=480.5, primary=True)}
    assert g.training_load_from_status(status_payload(records), DS)["acute_training_load"] == 512.0


def test_falls_back_to_another_device_with_values():
    empty_primary = device_record(DS, acute=None, chronic=None, primary=True)
    records = {"111": empty_primary, "222": device_record(DS, acute=300, chronic=250, primary=False)}
    assert g.training_load_from_status(status_payload(records), DS) == {
        "acute_training_load": 300.0, "chronic_training_load": 250.0}


def test_zero_is_a_real_load():
    out = g.training_load_from_status(status_payload({"111": device_record(DS, acute=0, chronic=0)}), DS)
    assert out == {"acute_training_load": 0.0, "chronic_training_load": 0.0}


def test_missing_value_is_left_out_never_none():
    out = g.training_load_from_status(status_payload({"111": device_record(DS, chronic=None)}), DS)
    assert out == {"acute_training_load": 512.0}


def test_junk_values_and_shapes_are_no_data():
    for bad in (None, "512", True, -4, float("nan"), float("inf"), [512]):
        payload = status_payload({"111": device_record(DS, acute=bad, chronic=bad)})
        assert g.training_load_from_status(payload, DS) == {}, bad
    for payload in (None, {}, [], "x", {"mostRecentTrainingStatus": None},
                    status_payload(None), status_payload({"111": None}),
                    status_payload({"111": {**device_record(DS), "acuteTrainingLoadDTO": None}})):
        assert g.training_load_from_status(payload, DS) == {}, payload


def test_calendar_date_with_a_time_part_still_matches():
    rec = {**device_record(DS), "calendarDate": f"{DS}T00:00:00.0"}
    assert g.training_load_from_status(status_payload({"111": rec}), DS)["acute_training_load"] == 512.0


# ---------------------------------------------------------------------------
# A. ETL: the row written to pds.garmin_training_status
# ---------------------------------------------------------------------------

def test_readiness_and_load_share_one_row():
    sb = FakeSupabase()
    garmin = FakeTrainingGarmin({DS: READINESS}, {DS: status_payload({"111": device_record(DS)})})
    assert g.sync_training_status(garmin, sb, DAY) == 1
    (row,) = sb.upserts["garmin_training_status"]
    assert row["calendar_date"] == DS and row["ts"] == g.date_to_ts(DAY)
    assert row["training_readiness_score"] == 61 and row["training_readiness_level"] == "MODERATE"
    assert row["raw_json"] == READINESS[0], "raw_json stays the readiness payload"
    assert row["acute_training_load"] == 512.0 and row["chronic_training_load"] == 480.5


def test_load_without_readiness_writes_only_the_load_columns():
    sb = FakeSupabase()
    garmin = FakeTrainingGarmin({}, {DS: status_payload({"111": device_record(DS)})})
    assert g.sync_training_status(garmin, sb, DAY) == 1
    (row,) = sb.upserts["garmin_training_status"]
    assert set(row) == {"ts", "calendar_date", "acute_training_load", "chronic_training_load"}, \
        "readiness columns must not be sent as NULL"


def test_readiness_without_load_leaves_load_columns_out():
    for status in ({DS: status_payload({"111": device_record("2026-06-01")})}, {}):
        sb = FakeSupabase()
        assert g.sync_training_status(FakeTrainingGarmin({DS: READINESS}, status), sb, DAY) == 1
        (row,) = sb.upserts["garmin_training_status"]
        assert "acute_training_load" not in row and "chronic_training_load" not in row, \
            "a stale or missing status must not blank a stored value"
        assert row["training_readiness_score"] == 61


def test_status_endpoint_failure_keeps_readiness():
    sb = FakeSupabase()
    garmin = FakeTrainingGarmin({DS: READINESS}, status_error=RuntimeError("HTTP 500"))
    assert g.sync_training_status(garmin, sb, DAY) == 1
    assert sb.upserts["garmin_training_status"][0]["training_readiness_score"] == 61


def test_nothing_from_either_endpoint_writes_nothing():
    sb = FakeSupabase()
    stale = {DS: status_payload({"111": device_record("2026-06-01")})}
    assert g.sync_training_status(FakeTrainingGarmin({}, stale), sb, DAY) == 0
    assert sb.upserts == {}


def test_future_day_is_skipped_before_any_call():
    future = g._et_local_today() + timedelta(days=3)
    garmin = FakeTrainingGarmin()
    assert g.sync_training_status(garmin, FakeSupabase(), future) == 0
    assert garmin.calls == []


def test_backfill_mode_reads_only_training_endpoints():
    today = g._et_local_today()
    days = [today - timedelta(days=i) for i in range(3, -1, -1)]
    status = {d.isoformat(): status_payload({"111": device_record(d.isoformat())}) for d in days[:2]}
    garmin = FakeTrainingGarmin({}, status)
    sb = FakeSupabase()
    with patch.object(g, "get_garmin_client", return_value=garmin), \
         patch.object(g, "get_supabase_client", return_value=sb), \
         patch.object(g.time, "sleep", lambda *_: None), \
         patch("subprocess.run", side_effect=AssertionError("no time-zone pass in this mode")), \
         patch.object(sys, "argv", ["garmin_etl.py", "--backfill-training-status", "3"]):
        g.main()
    assert set(garmin.calls) == {"get_training_readiness", "get_training_status"}
    assert len(garmin.calls) == 8, "two calls per day, four days"
    written = sorted(r["calendar_date"] for r in sb.upserts["garmin_training_status"])
    assert written == [d.isoformat() for d in days[:2]]
    (beat,) = sb.inserts["sync_log"]
    assert (beat["source"], beat["data_type"], beat["status"]) == ("garmin", "training_status_backfill", "success")
    assert beat["records_synced"] == 2
    assert (beat["date_range_start"], beat["date_range_end"]) == (days[0].isoformat(), days[-1].isoformat())


# ---------------------------------------------------------------------------
# B. Worn-day rule: hrv_analysis must agree with the ETL
# ---------------------------------------------------------------------------

def _view_aliases() -> dict[str, str]:
    """garmin_daily_summary column -> matrix column, read from the view SQL."""
    sql = MATRIX_SQL.read_text(encoding="utf-8")
    return {col: (alias or col) for col, alias in
            re.findall(r"\bgds\.([a-z0-9_]+)(?:\s+AS\s+([a-z0-9_]+))?", sql, re.IGNORECASE)}


def _matrix_row(payload: dict) -> pd.DataFrame:
    """Send a daily-summary payload through the ETL row and the view's aliases."""
    sb = FakeSupabase()
    garmin = types.SimpleNamespace(get_stats=lambda ds: payload)
    g.sync_daily_summary(garmin, sb, DAY)
    (db_row,) = sb.upserts["garmin_daily_summary"]
    aliases = _view_aliases()
    return pd.DataFrame([{aliases[c]: v for c, v in db_row.items() if c in aliases}]).apply(
        pd.to_numeric, errors="coerce")


def test_worn_rule_matches_the_etl():
    unworn = {"calendarDate": DS, "totalSteps": None, "totalKilocalories": 2000.0,
              "bmrKilocalories": 2000.0, "sedentarySeconds": 86400, "averageStressLevel": -1}
    payloads = [unworn, {**unworn, "totalSteps": 0}, {**unworn, "totalSteps": 12}]
    payloads += [{**unworn, field: 50} for field in g.WEARABLE_SUMMARY_FIELDS]
    for payload in payloads:
        expected = g.daily_summary_has_wearable_values(payload)
        got = bool(h.garmin_worn_days(_matrix_row(payload)).iloc[0])
        assert got == expected, (payload, got, expected)


def test_worn_columns_are_in_the_matrix_view():
    matrix_cols = set(_view_aliases().values())
    for col in (h.GARMIN_WORN_STEPS_COL, *h.GARMIN_WORN_VALUE_COLS):
        assert col in matrix_cols, f"{col} is not selected by the matrix view"


# ---------------------------------------------------------------------------
# B. Rest days count as load 0; unworn days stay unknown
# ---------------------------------------------------------------------------

def _frame(rows):
    cols = ["calendar_date", "total_training_load", "total_steps", "garmin_rhr", "body_battery_highest"]
    return pd.DataFrame(rows, columns=cols)


def test_rest_day_zero_fill():
    nan = np.nan
    df = _frame([
        ("2026-06-01", 150.0, 9000, 50, 80),   # activity day
        ("2026-06-02", nan, 5000, 52, 75),     # worn, no activity -> 0
        ("2026-06-03", nan, nan, 51, nan),     # worn (heart rate only), no activity -> 0
        ("2026-06-04", nan, nan, nan, nan),    # watch not worn -> NaN
        ("2026-06-05", nan, 0, nan, nan),      # steps 0 and nothing else = not worn -> NaN
        ("2026-06-06", 0.0, 7000, 50, 70),     # activity without a load figure (sum = 0), untouched
    ])
    no_activity = pd.Series([False, True, True, True, True, False])
    out = h.fill_rest_day_training_load(df, no_activity)
    got = out["total_training_load"].tolist()
    assert got[:3] == [150.0, 0.0, 0.0] and got[5] == 0.0
    assert np.isnan(got[3]) and np.isnan(got[4]), "no sync must stay NaN, not become a rest day"


def test_activity_day_is_never_overwritten():
    df = _frame([("2026-06-01", 220.0, 9000, 50, 80)])
    out = h.fill_rest_day_training_load(df, pd.Series([False]))
    assert out["total_training_load"].tolist() == [220.0]


def test_rolling_windows_of_rest_days_are_zero_and_unworn_windows_nan():
    nan = np.nan
    # day 0 trains; days 1-3 worn rest days; days 4-9 watch off
    load = [100.0, 0.0, 0.0, 0.0, nan, nan, nan, nan, nan, nan]
    df = pd.DataFrame({"calendar_date": [f"2026-06-{i + 1:02d}" for i in range(10)],
                       "total_training_load": load,
                       "total_activity_duration_min": [45.0] + [nan] * 9})
    out = h.add_rolling_training_load(df)
    r3 = out["rolling_3d_training_load"].tolist()
    assert np.isnan(r3[0]), "no earlier day"
    assert r3[1:4] == [100.0, 100.0, 100.0]
    assert r3[4] == 0.0, "D-3..D-1 were all worn rest days: load 0 (was NaN before the fix)"
    assert r3[5:7] == [0.0, 0.0]
    assert all(np.isnan(v) for v in r3[7:]), "D-3..D-1 without the watch: unknown"
    r7 = out["rolling_7d_training_load"].tolist()
    assert r7[7] == 100.0, "D-7..D-1 holds the training day"
    assert r7[8:] == [0.0, 0.0], "D-7..D-1 = worn rest days, then days without the watch"
    assert out["rolling_7d_activity_duration"].tolist()[1] == 45.0


def test_rolling_window_days_match_the_causal_declaration():
    assert ci.ROLLING_WINDOW_DAYS["rolling_3d_training_load"] == (-3, -1)
    assert ci.ROLLING_WINDOW_DAYS["rolling_7d_training_load"] == (-7, -1)
    src = inspect.getsource(h.add_rolling_training_load)
    assert "shift(1)" in src and "rolling(3" in src and "rolling(7" in src


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def test_build_feature_matrix_uses_the_helpers():
    src = inspect.getsource(h.build_feature_matrix)
    fill_at = src.index("fill_rest_day_training_load(df, no_activity)")
    assert src.index('no_activity = df["activity_count"].isna()') < src.index(
        'df["activity_count"] = df["activity_count"].fillna(0)') < fill_at, \
        "the no-activity mask must be taken before activity_count is zero-filled"
    assert "add_rolling_training_load(df)" in src
    assert ".rolling(3, min_periods=1)" not in src, "one copy of the rolling-load formula"


def test_one_copy_of_acute_and_chronic_load():
    src = inspect.getsource(h.build_feature_matrix)
    assert 'f"garmin_{c}" for c in ("acute_training_load", "chronic_training_load")' in src
    assert {"acute_training_load", "chronic_training_load"} <= h.HIGH_VALUE_SPARSE_FEATURES
    assert not {"garmin_acute_training_load", "garmin_chronic_training_load"} & h.HIGH_VALUE_SPARSE_FEATURES
    assert "acute_training_load,chronic_training_load" in inspect.getsource(h.load_all_data)


def test_the_three_load_treatments_are_still_declared():
    registered = {c for c, *_ in ci.CONTINUOUS_TREATMENTS}
    for col in ("acute_training_load", "chronic_training_load", "atl_ctl_ratio",
                "total_training_load", "rolling_3d_training_load", "rolling_7d_training_load"):
        assert col in registered, col
    assert {"acute_training_load", "chronic_training_load", "atl_ctl_ratio"} <= ci.ROLLING_AGGREGATE_TREATMENTS


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
