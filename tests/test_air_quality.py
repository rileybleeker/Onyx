"""Air quality (PM2.5): ETL aggregation + heartbeat, and the HRV-pipeline merge.

Covers
  * air_quality_etl.aggregate_daily: ET day grouping, forecast hours dropped, nulls skipped,
    no row for a day without PM2.5, malformed payloads rejected;
  * air_quality_etl.run_etl with a fake Supabase client: success / empty answer / failure all
    write exactly one sync_log heartbeat, an empty table bootstraps, a missing table says how
    to fix it;
  * hrv_analysis.merge_air_quality_features: day D lands on row D (same row, never shifted),
    partial and uncovered days stay NaN (never zero), fail-open, idempotent;
  * the wiring: forecast exclusion, controllable prefix, causal treatment, labels.

Synthetic data only. No network, no credentials.

Run: python tests/test_air_quality.py
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import air_quality_etl as etl  # noqa: E402
import causal_inference as ci  # noqa: E402
import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402

LAT, LON = 33.75, -84.39
NOW = datetime(2026, 11, 11, 14, 30, tzinfo=etl.ET)   # 14:30 ET: hours up to 14:00 exist


def _payload(hours):
    """hours: list of (UTC 'YYYY-MM-DDTHH:00', pm2_5, us_aqi), as the API returns them with timezone=GMT."""
    return {"hourly": {"time": [t for t, _, _ in hours],
                       "pm2_5": [p for _, p, _ in hours],
                       "us_aqi": [a for _, _, a in hours]}}


def _utc(day, hr):
    """The UTC API timestamp of ET wall-clock hour `hr` on ET day `day`."""
    local = datetime.fromisoformat(f"{day}T{hr:02d}:00").replace(tzinfo=etl.ET)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _day(day, pm_values, aqi_values=None):
    """Hours 00:00, 01:00, ... of ET day `day`, stamped in UTC."""
    aqi_values = aqi_values or [None] * len(pm_values)
    return [(_utc(day, hr), p, a) for hr, (p, a) in enumerate(zip(pm_values, aqi_values))]


# ---------------------------------------------------------------------------
# ETL: aggregate_daily
# ---------------------------------------------------------------------------

def test_aggregate_groups_by_et_day_and_drops_future_hours():
    full = _day("2026-11-10", [4.0] * 12 + [8.0] * 12, [40] * 12 + [60] * 12)
    today = _day("2026-11-11", [10.0] * 24, [50] * 24)       # hours 15..23 are forecasts
    rows = etl.aggregate_daily(_payload(full + today), NOW, LAT, LON)
    assert [r["calendar_date"] for r in rows] == ["2026-11-10", "2026-11-11"]
    yesterday, now_row = rows
    assert yesterday["n_hours"] == 24
    assert yesterday["pm25_mean"] == 6.0 and yesterday["pm25_max"] == 8.0
    assert yesterday["us_aqi_mean"] == 50.0 and yesterday["us_aqi_max"] == 60.0
    assert now_row["n_hours"] == 15, "hours 00..14 only; the forecast hours are never stored"
    assert (yesterday["latitude"], yesterday["longitude"], yesterday["source"]) == (LAT, LON, "open-meteo-cams")


def test_et_day_is_built_from_utc_not_from_the_api_offset():
    # July: ET is UTC-4. 03:00Z on July 1 is 23:00 ET on June 30; 04:00Z is midnight ET July 1.
    july = [("2026-07-01T03:00", 30.0, None), ("2026-07-01T04:00", 2.0, None),
            ("2026-07-02T03:00", 4.0, None), ("2026-07-02T04:00", 40.0, None)]
    by = {r["calendar_date"]: r for r in etl.aggregate_daily(_payload(july), NOW, LAT, LON)}
    assert set(by) == {"2026-06-30", "2026-07-01", "2026-07-02"}
    assert by["2026-06-30"]["pm25_max"] == 30.0
    assert (by["2026-07-01"]["n_hours"], by["2026-07-01"]["pm25_mean"], by["2026-07-01"]["pm25_max"]) == (2, 3.0, 4.0)
    assert by["2026-07-02"]["pm25_max"] == 40.0
    # January: ET is UTC-5. 04:00Z on Jan 15 is 23:00 ET on Jan 14; 05:00Z is midnight ET Jan 15.
    january = [("2026-01-15T04:00", 30.0, None), ("2026-01-15T05:00", 2.0, None),
               ("2026-01-16T04:00", 4.0, None), ("2026-01-16T05:00", 40.0, None)]
    by = {r["calendar_date"]: r for r in etl.aggregate_daily(_payload(january), NOW, LAT, LON)}
    assert set(by) == {"2026-01-14", "2026-01-15", "2026-01-16"}
    assert (by["2026-01-15"]["n_hours"], by["2026-01-15"]["pm25_mean"], by["2026-01-15"]["pm25_max"]) == (2, 3.0, 4.0)


def test_dst_days_have_23_and_25_hours():
    def utc_range(start, n):
        t0 = datetime.fromisoformat(start)
        return [((t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M"), 5.0, None) for i in range(n)]
    spring = {r["calendar_date"]: r for r in etl.aggregate_daily(_payload(utc_range("2026-03-07T05:00", 71)), NOW, LAT, LON)}
    assert [spring[d]["n_hours"] for d in ("2026-03-07", "2026-03-08", "2026-03-09")] == [24, 23, 24]
    fall = {r["calendar_date"]: r for r in etl.aggregate_daily(_payload(utc_range("2026-10-31T04:00", 73)), NOW, LAT, LON)}
    assert [fall[d]["n_hours"] for d in ("2026-10-31", "2026-11-01", "2026-11-02")] == [24, 25, 24]


def test_fetch_asks_for_utc_hours_and_covers_the_last_et_day():
    seen = {}

    class Client:
        def get(self, url, params):
            seen.update(params)

            class R:
                def raise_for_status(self):
                    return None

                def json(self):
                    return {"hourly": {"time": [], "pm2_5": []}}
            return R()

    etl.fetch_hourly(Client(), LAT, LON, date(2026, 7, 1), date(2026, 7, 2))
    assert seen["timezone"] == "GMT"
    now_utc = datetime(2026, 11, 12, 2, 0, tzinfo=timezone.utc)   # 21:00 ET on Nov 11
    assert etl.api_range(date(2026, 11, 1), date(2026, 11, 11), now_utc) == (date(2026, 11, 1), date(2026, 11, 12))
    assert etl.api_range(date(2026, 7, 1), date(2026, 9, 28), now_utc) == (date(2026, 7, 1), date(2026, 9, 29))
    early = datetime(2026, 11, 11, 15, 0, tzinfo=timezone.utc)
    assert etl.api_range(date(2026, 11, 1), date(2026, 11, 11), early)[1] == date(2026, 11, 11)


def test_aggregate_skips_nulls_and_empty_days():
    hours = _day("2026-11-09", [None] * 24) + _day("2026-11-10", [5.0, None, 7.0, float("nan"), -1.0, True])
    rows = etl.aggregate_daily(_payload(hours), NOW, LAT, LON)
    assert [r["calendar_date"] for r in rows] == ["2026-11-10"], "an all-null day must produce no row"
    assert rows[0]["n_hours"] == 2 and rows[0]["pm25_mean"] == 6.0
    assert rows[0]["us_aqi_mean"] is None and rows[0]["us_aqi_max"] is None


def test_aggregate_rejects_malformed_payloads():
    for bad in ({}, {"hourly": {"time": ["2026-11-10T00:00"]}}, {"error": True, "reason": "x"},
                {"hourly": {"time": ["2026-11-10T00:00"], "pm2_5": [1.0, 2.0]}}):
        try:
            etl.aggregate_daily(bad, NOW, LAT, LON)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_windows_cover_the_range_without_gaps():
    ws = etl.windows(date(2024, 1, 1), date(2024, 7, 1), 90)
    assert ws[0][0] == date(2024, 1, 1) and ws[-1][1] == date(2024, 7, 1)
    for (_, prev_end), (nxt_start, _) in zip(ws, ws[1:]):
        assert (nxt_start - prev_end).days == 1
    assert all((e - s).days + 1 <= 90 for s, e in ws)
    assert etl.windows(date(2026, 11, 11), date(2026, 11, 11)) == [(date(2026, 11, 11),) * 2]


def test_resolve_location():
    saved = {k: os.environ.pop(k, None) for k in ("AIR_QUALITY_LAT", "AIR_QUALITY_LON")}
    try:
        assert etl.resolve_location(None, None) == (etl.DEFAULT_LAT, etl.DEFAULT_LON) == (33.75, -84.39)
        os.environ["AIR_QUALITY_LAT"], os.environ["AIR_QUALITY_LON"] = "40.72", "-73.99"
        assert etl.resolve_location(None, None) == (40.72, -73.99)
        assert etl.resolve_location(1.0, 2.0) == (1.0, 2.0), "a CLI flag beats the environment"
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    for lat, lon in ((91, 0), (0, 181)):
        try:
            etl.resolve_location(lat, lon)
        except ValueError:
            continue
        raise AssertionError("accepted an out-of-range location")


# ---------------------------------------------------------------------------
# ETL: run_etl with a fake Supabase client
# ---------------------------------------------------------------------------

class FakeSupabase:
    """Records upserts and sync_log inserts; `existing` is what the empty-table probe sees."""

    def __init__(self, existing=True, upsert_error=None):
        self.existing, self.upsert_error = existing, upsert_error
        self.upserts, self.heartbeats = [], []
        self._table = None

    def schema(self, _):
        return self

    def table(self, name):
        self._table = name
        return self

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def insert(self, row):
        self.heartbeats.append(row)
        return self

    def upsert(self, rows, on_conflict=None):
        if self.upsert_error:
            raise RuntimeError(self.upsert_error)
        assert self._table == "air_quality_daily" and on_conflict == "calendar_date"
        self.upserts.append(rows)
        return self

    def execute(self):
        class R:
            pass
        r = R()
        r.data = [{"calendar_date": "2026-11-01"}] if self.existing else []
        return r


def _run(sb, payload=None, fetch_error=None, days=None):
    calls = []

    def fake_fetch(_client, _lat, _lon, start, end):
        calls.append((start, end))
        if fetch_error:
            raise fetch_error
        return payload

    real = etl.fetch_hourly
    etl.fetch_hourly = fake_fetch
    try:
        return etl.run_etl(days, LAT, LON, sb=sb), calls
    finally:
        etl.fetch_hourly = real


def test_run_success_writes_rows_and_one_success_heartbeat():
    sb = FakeSupabase()
    payload = _payload(_day(datetime.now(etl.ET).date().isoformat(), [3.0], [30]))
    written, _ = _run(sb, payload)
    assert written == 1 and len(sb.upserts) == 1
    row = sb.upserts[0][0]
    assert {"calendar_date", "pm25_mean", "pm25_max", "n_hours", "latitude", "longitude", "synced_at"} <= set(row)
    assert len(sb.heartbeats) == 1
    beat = sb.heartbeats[0]
    assert (beat["source"], beat["data_type"], beat["status"], beat["records_synced"]) == ("air_quality", "daily", "success", 1)
    assert beat["sync_start"] and beat["sync_end"] and beat["duration_seconds"] >= 0


def test_run_with_no_pm25_values_is_a_partial_heartbeat():
    sb = FakeSupabase()
    written, _ = _run(sb, _payload(_day("2026-11-10", [None] * 24)))
    assert written == 0 and not sb.upserts
    assert [b["status"] for b in sb.heartbeats] == ["partial"]
    assert "no PM2.5" in sb.heartbeats[0]["error_message"]


def test_run_failure_writes_a_failed_heartbeat_and_exits_nonzero():
    sb = FakeSupabase()
    try:
        _run(sb, fetch_error=RuntimeError("Open-Meteo HTTP 500: boom"))
    except SystemExit as exc:
        assert exc.code == 1
    else:
        raise AssertionError("a failed run must fail the Actions job")
    assert [b["status"] for b in sb.heartbeats] == ["failed"]
    assert "boom" in sb.heartbeats[0]["error_message"]


def test_missing_table_error_names_the_sql_file():
    sb = FakeSupabase(upsert_error="Could not find the table 'pds.air_quality_daily' in the schema cache (PGRST205)")
    payload = _payload(_day(datetime.now(etl.ET).date().isoformat(), [3.0]))
    try:
        _run(sb, payload)
    except SystemExit:
        pass
    assert len(sb.heartbeats) == 1 and sb.heartbeats[0]["status"] == "failed"
    assert "sql/air_quality_schema.sql" in sb.heartbeats[0]["error_message"]


def test_routine_run_window_and_empty_table_bootstrap():
    today = datetime.now(etl.ET).date()
    empty_payload = _payload(_day("2026-11-10", [None]))
    # The API is asked for UTC dates: one extra date at the end completes the last ET day (never past UTC today).
    last = min(today + timedelta(days=1), datetime.now(timezone.utc).date())
    _, calls = _run(FakeSupabase(existing=True), empty_payload)
    assert calls == [(today - timedelta(days=etl.DEFAULT_DAYS), last)]
    _, calls = _run(FakeSupabase(existing=False), empty_payload)
    assert calls[0][0] == etl.BOOTSTRAP_START and calls[-1][1] == last and len(calls) > 5
    _, calls = _run(FakeSupabase(existing=False), empty_payload, days=30)
    assert calls == [(today - timedelta(days=30), last)], "an explicit window never bootstraps"


# ---------------------------------------------------------------------------
# HRV pipeline: merge_air_quality_features
# ---------------------------------------------------------------------------

def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-07").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(7.0)})


def _air():
    def row(day, pm, hours=24):
        return {"calendar_date": day, "pm25_mean": pm, "pm25_max": pm * 2, "us_aqi_max": pm * 5, "n_hours": hours}
    return pd.DataFrame([
        row("2026-01-02", 8.0),
        row("2026-01-03", 12.0),
        row("2026-01-04", 99.0, hours=9),      # partial day: must stay NaN
        row("2026-01-05", 4.0, hours=20),      # exactly the minimum: counts
        row("2026-01-09", 50.0),               # outside the matrix: ignored
    ])


def test_same_row_placement_and_completeness():
    out = h.merge_air_quality_features(_matrix(), _air())
    by = out.set_index("calendar_date")
    assert len(out) == 7
    # the value of clock day D is on row D, not D-1 or D+1
    assert by.loc["2026-01-02", "aqi_pm25"] == 8.0
    assert by.loc["2026-01-03", "aqi_pm25"] == 12.0
    assert by.loc["2026-01-02", "aqi_pm25_max"] == 16.0 and by.loc["2026-01-02", "aqi_us_max"] == 40.0
    assert by.loc["2026-01-05", "aqi_pm25"] == 4.0
    # partial and uncovered days are unknown, never zero
    assert np.isnan(by.loc["2026-01-04", "aqi_pm25"])
    for day in ("2026-01-01", "2026-01-06", "2026-01-07"):
        assert np.isnan(by.loc[day, "aqi_pm25"])
    assert not (out[list(h.AQI_COLS)].fillna(-1) == 0).any().any()
    # nothing else on the matrix moved
    assert out["whoop_hrv_rmssd"].tolist() == _matrix()["whoop_hrv_rmssd"].tolist()


def test_merge_is_idempotent_and_handles_duplicates_and_date_types():
    air = _air()
    air = pd.concat([air, air.iloc[[0]]], ignore_index=True)           # duplicate day
    air["calendar_date"] = pd.to_datetime(air["calendar_date"])         # datetime instead of text
    once = h.merge_air_quality_features(_matrix(), air)
    twice = h.merge_air_quality_features(once, air)
    assert len(once) == 7 and once.equals(twice)
    assert once.loc[once["calendar_date"] == "2026-01-02", "aqi_pm25"].iloc[0] == 8.0


def test_numeric_strings_from_postgrest_are_coerced():
    air = _air().astype({"pm25_mean": str, "pm25_max": str, "us_aqi_max": str, "n_hours": str})
    out = h.merge_air_quality_features(_matrix(), air)
    assert out.set_index("calendar_date").loc["2026-01-03", "aqi_pm25"] == 12.0


def test_fail_open():
    m = _matrix()
    assert h.merge_air_quality_features(m, None) is m
    assert h.merge_air_quality_features(m, pd.DataFrame()) is m
    bad = pd.DataFrame([{"calendar_date": "2026-01-02"}])               # columns missing
    assert h.merge_air_quality_features(m, bad).equals(m)
    assert not any(c.startswith("aqi_") for c in h.merge_air_quality_features(m, bad).columns)


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def test_alignment_and_forecast_rules():
    for col in h.AQI_COLS:
        assert not al.is_same_sleep(col), "pre-sleep exposure, not measured from the outcome sleep"
        assert col not in al.NEEDS_SLEEP_ONSET
        assert col.startswith(h.NOT_FORECAST_PREFIXES), f"{col} would reach the forecast with a NaN newest row"
    assert "aqi_" in h.NOT_FORECAST_PREFIXES
    assert "aqi_" in h.CONTROLLABLE_FEATURE_PREFIXES
    for col in h.AQI_COLS:
        assert col in h.FEATURE_LABELS


def test_causal_treatment_registered():
    assert ("aqi_pm25", "behavior") == next((c, f) for c, f, *_ in ci.CONTINUOUS_TREATMENTS if c == "aqi_pm25")
    df = pd.DataFrame({"aqi_pm25": [1.0, 2.0], "hrv_lag1": [50.0, 51.0]})
    specs = {s.name: s for s in ci._enumerate_continuous_treatments(df)}
    assert specs["aqi_pm25"].kind == "continuous_median_split" and specs["aqi_pm25"].unit == "µg/m³"
    assert "aqi_pm25" not in {s.name for s in ci._enumerate_continuous_treatments(pd.DataFrame({"hrv_lag1": [1.0]}))}


def test_no_target_shift_in_new_code():
    src = Path(etl.__file__).read_text(encoding="utf-8")
    assert ".shift(-" not in src


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
