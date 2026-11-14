"""Daily weather: ETL aggregation + heartbeat, and the HRV-pipeline merge.

Covers
  * weather_etl.aggregate_daily: UTC hours grouped into ET clock days (also across both DST
    changes), forecast hours dropped, nulls skipped, negative temperatures kept, no row for a
    day without temperature, the night window, malformed payloads rejected;
  * weather_etl.uv_daily_max / with_uv: best-effort UV, all-or-nothing keys;
  * weather_etl.run_etl with a fake Supabase client: success / empty answer / UV failure /
    failure each write exactly one sync_log heartbeat, an empty table bootstraps, a missing
    table says how to fix it;
  * hrv_analysis.merge_weather_features: daytime columns of clock day D land on row D, the
    night columns of clock day D + 1 land on row D, the clock-day minimum is not a feature,
    a day counts only once it is over AND has all its hours (today stays NaN however many
    hours it has), uncovered days stay NaN (never zero-filled), fail-open, idempotent;
  * the wiring: forecast exclusion, labels, causal treatments, one home location for both
    Open-Meteo sources.

Synthetic data only. No network, no credentials.

Run: python tests/test_weather.py
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

import air_quality_etl as aq  # noqa: E402
import causal_inference as ci  # noqa: E402
import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402
import weather_etl as etl  # noqa: E402

LAT, LON = 33.75, -84.39
NOW = datetime(2026, 11, 11, 14, 30, tzinfo=etl.ET)   # 14:30 ET (EST): hours up to 14:00 exist


def _utc(local_day: str, hour: int) -> str:
    """The UTC stamp the API would send for an ET wall-clock hour of a non-DST-change day."""
    local = datetime.fromisoformat(f"{local_day}T{hour:02d}:00").replace(tzinfo=etl.ET)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _payload(hours, daylight=None):
    """hours: list of (utc stamp, {variable: value}); a missing variable is null."""
    out = {"hourly": {"time": [t for t, _ in hours]}}
    for name in etl.HOURLY_VARS:
        out["hourly"][name] = [vals.get(name) for _, vals in hours]
    if daylight:
        out["daily"] = {"time": list(daylight), "daylight_duration": list(daylight.values())}
    return out


def _day(day, temps, **extra):
    """24 (or fewer) ET hours of `day`; extra maps a variable to a per-hour list or a constant."""
    hours = []
    for hr, t in enumerate(temps):
        vals = {"temperature_2m": t}
        for name, v in extra.items():
            vals[name] = v[hr] if isinstance(v, list) else v
        hours.append((_utc(day, hr), vals))
    return hours


# ---------------------------------------------------------------------------
# ETL: aggregate_daily
# ---------------------------------------------------------------------------

def test_aggregate_groups_by_et_day_and_drops_future_hours():
    full = _day("2026-11-10", [10.0] * 12 + [20.0] * 12,
                apparent_temperature=[8.0] * 12 + [22.0] * 12, relative_humidity_2m=60,
                dew_point_2m=-2.0, surface_pressure=980.0, precipitation=[0.5] * 4 + [0.0] * 20,
                wind_speed_10m=[5.0] * 23 + [30.0], cloud_cover=50, sunshine_duration=[0.0] * 8 + [1800.0] * 10 + [0.0] * 6)
    today = _day("2026-11-11", [5.0] * 24)                      # hours 15..23 are forecasts
    rows = etl.aggregate_daily(_payload(full + today, {"2026-11-10": 36000.0}), NOW, LAT, LON)
    assert [r["calendar_date"] for r in rows] == ["2026-11-10", "2026-11-11"]
    y, t = rows
    assert y["n_hours"] == 24
    assert (y["temperature_max"], y["temperature_min"], y["temperature_mean"]) == (20.0, 10.0, 15.0)
    assert (y["apparent_temp_mean"], y["apparent_temp_max"]) == (15.0, 22.0)
    assert (y["humidity_mean"], y["dew_point_mean"], y["pressure_mean"]) == (60.0, -2.0, 980.0)
    assert (y["precipitation_sum"], y["wind_speed_max"], y["cloud_cover_mean"]) == (2.0, 30.0, 50.0)
    assert (y["daylight_hours"], y["sunshine_hours"]) == (10.0, 5.0)
    assert (y["latitude"], y["longitude"], y["source"]) == (LAT, LON, "open-meteo-archive")
    assert t["n_hours"] == 15, "hours 00..14 only; the forecast hours are never stored"
    assert t["daylight_hours"] is None, "no daily value sent for that date"


def test_et_day_is_built_from_utc_not_from_the_api_offset():
    # A July day: ET is UTC-4. 2026-07-01T03:00Z is 23:00 ET on June 30, 04:00Z is midnight July 1.
    hours = [("2026-07-01T03:00", {"temperature_2m": 30.0}), ("2026-07-01T04:00", {"temperature_2m": 20.0}),
             ("2026-07-02T03:00", {"temperature_2m": 22.0}), ("2026-07-02T04:00", {"temperature_2m": 40.0})]
    rows = etl.aggregate_daily(_payload(hours), NOW, LAT, LON)
    by = {r["calendar_date"]: r for r in rows}
    assert set(by) == {"2026-06-30", "2026-07-01", "2026-07-02"}
    assert by["2026-06-30"]["temperature_max"] == 30.0
    assert (by["2026-07-01"]["temperature_min"], by["2026-07-01"]["temperature_max"]) == (20.0, 22.0)
    assert by["2026-07-02"]["temperature_max"] == 40.0


def test_dst_days_have_23_and_25_hours():
    def utc_range(start, n):
        t0 = datetime.fromisoformat(start)
        return [((t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M"), {"temperature_2m": 10.0}) for i in range(n)]
    # 2026-03-08 (spring forward) and 2026-11-01 (fall back), each with a day either side
    spring = etl.aggregate_daily(_payload(utc_range("2026-03-07T05:00", 80)), NOW, LAT, LON)
    by = {r["calendar_date"]: r for r in spring}
    assert (by["2026-03-07"]["n_hours"], by["2026-03-08"]["n_hours"], by["2026-03-09"]["n_hours"]) == (24, 23, 24)
    assert by["2026-03-08"]["night_hours"] == 7 and by["2026-03-08"]["night_temp_mean"] == 10.0
    fall = etl.aggregate_daily(_payload(utc_range("2026-10-31T04:00", 80)), NOW, LAT, LON)
    by = {r["calendar_date"]: r for r in fall}
    assert (by["2026-10-31"]["n_hours"], by["2026-11-01"]["n_hours"], by["2026-11-02"]["n_hours"]) == (24, 25, 24)
    assert by["2026-11-01"]["night_hours"] == 9


def test_night_window_is_0100_to_0800_et_and_waits_for_its_last_hour():
    temps = [50.0] + [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0] + [40.0] * 15   # 00:00 and 09:00+ are outside
    rows = etl.aggregate_daily(_payload(_day("2026-11-10", temps)), NOW, LAT, LON)
    assert (rows[0]["night_hours"], rows[0]["night_temp_mean"], rows[0]["night_temp_min"]) == (8, 4.5, 1.0)
    assert rows[0]["temperature_min"] == 1.0
    # 07:30 on the day itself: seven night hours exist, the eighth has not happened yet
    early = datetime(2026, 11, 10, 7, 30, tzinfo=etl.ET)
    rows = etl.aggregate_daily(_payload(_day("2026-11-10", temps)), early, LAT, LON)
    assert rows[0]["night_hours"] == 7 and rows[0]["n_hours"] == 8
    assert rows[0]["night_temp_mean"] is None and rows[0]["night_temp_min"] is None
    # a cold front: the day's lowest hour is 23:00, not the night
    front = [12.0] * 23 + [-3.0]
    rows = etl.aggregate_daily(_payload(_day("2026-11-10", front)), NOW, LAT, LON)
    assert rows[0]["temperature_min"] == -3.0 and rows[0]["night_temp_min"] == 12.0


def test_aggregate_skips_nulls_and_empty_days():
    hours = (_day("2026-11-09", [None] * 24, relative_humidity_2m=50)
             + _day("2026-11-10", [5.0, None, -7.0, float("nan"), True, "x"],
                    relative_humidity_2m=[-1.0, 40.0, 80.0, None, None, None]))
    rows = etl.aggregate_daily(_payload(hours), NOW, LAT, LON)
    assert [r["calendar_date"] for r in rows] == ["2026-11-10"], "a day with no temperature must produce no row"
    r = rows[0]
    assert r["n_hours"] == 2 and r["temperature_mean"] == -1.0 and r["temperature_min"] == -7.0
    assert r["humidity_mean"] == 60.0, "a negative humidity is not a value; null hours are skipped"
    assert r["pressure_mean"] is None and r["precipitation_sum"] is None and r["sunshine_hours"] is None
    assert r["night_temp_mean"] is None and r["night_hours"] == 1


def test_aggregate_rejects_malformed_payloads():
    ok_time = ["2026-11-10T05:00"]
    for bad in ({}, None, {"hourly": {"time": ok_time}}, {"error": True, "reason": "x"},
                {"hourly": {"time": ok_time, "temperature_2m": [1.0, 2.0]}},
                {"hourly": {"time": ok_time, "temperature_2m": [1.0], "cloud_cover": []}}):
        try:
            etl.aggregate_daily(bad, NOW, LAT, LON)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_api_range_covers_the_last_et_evening_without_asking_for_the_future():
    evening_utc = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)      # 22:00 ET on Nov 11
    assert etl.api_range(date(2026, 11, 1), date(2026, 11, 11), evening_utc) == (date(2026, 11, 1), date(2026, 11, 12))
    morning_utc = datetime(2026, 11, 11, 15, 0, tzinfo=timezone.utc)     # 10:00 ET on Nov 11
    assert etl.api_range(date(2026, 11, 1), date(2026, 11, 11), morning_utc)[1] == date(2026, 11, 11)
    assert etl.api_range(date(2026, 1, 1), date(2026, 3, 31), morning_utc) == (date(2026, 1, 1), date(2026, 4, 1))


def test_uv_daily_max_and_all_or_nothing_keys():
    uv = {"hourly": {"time": [_utc("2026-11-10", 11), _utc("2026-11-10", 13), _utc("2026-11-11", 12), _utc("2026-11-11", 16)],
                     "uv_index": [2.0, 4.457, None, 9.0]}}
    got = etl.uv_daily_max(uv, NOW)
    assert got == {"2026-11-10": 4.46}, "nulls are skipped and the 16:00 hour is still a forecast"
    rows = [{"calendar_date": "2026-11-09"}, {"calendar_date": "2026-11-10"}]
    with_values = etl.with_uv(rows, got)
    assert with_values[1]["uv_index_max"] == 4.46 and with_values[1]["uv_source"] == etl.UV_SOURCE
    assert with_values[0]["uv_index_max"] is None and with_values[0]["uv_source"] is None
    assert all(set(r) == set(with_values[0]) for r in with_values), "every row of an upsert batch needs the same keys"
    assert etl.with_uv(rows, None) == rows, "a failed UV request must not touch the UV columns at all"
    for bad in ({}, {"hourly": {"time": ["2026-11-10T12:00"]}}, {"hourly": {"time": ["a", "b"], "uv_index": [1.0]}}):
        try:
            etl.uv_daily_max(bad, NOW)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_one_home_location_for_both_open_meteo_sources():
    assert etl.resolve_location is aq.resolve_location
    assert (etl.DEFAULT_LAT, etl.DEFAULT_LON) == (aq.DEFAULT_LAT, aq.DEFAULT_LON)
    saved = {k: os.environ.pop(k, None) for k in ("AIR_QUALITY_LAT", "AIR_QUALITY_LON")}
    try:
        os.environ["AIR_QUALITY_LAT"], os.environ["AIR_QUALITY_LON"] = "40.72", "-73.99"
        assert etl.resolve_location(None, None) == (40.72, -73.99), "the air-quality variables move the weather too"
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    src = Path(etl.__file__).read_text(encoding="utf-8")
    assert "WEATHER_LAT" not in src and "WEATHER_LON" not in src, "no second pair of location variables"


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
        assert self._table == "weather_daily" and on_conflict == "calendar_date"
        self.upserts.append(rows)
        return self

    def execute(self):
        class R:
            pass
        r = R()
        r.data = [{"calendar_date": "2026-11-01"}] if self.existing else []
        return r


def _run(sb, payload=None, fetch_error=None, days=None, uv_payload=None, uv_error=None):
    calls, uv_calls = [], []

    def fake_fetch(_client, _lat, _lon, start, end):
        calls.append((start, end))
        if fetch_error:
            raise fetch_error
        return payload

    def fake_uv(_client, _lat, _lon, start, end):
        uv_calls.append((start, end))
        if uv_error:
            raise uv_error
        return uv_payload if uv_payload is not None else {"hourly": {"time": [], "uv_index": []}}

    real, real_uv = etl.fetch_hourly, etl.fetch_uv
    etl.fetch_hourly, etl.fetch_uv = fake_fetch, fake_uv
    try:
        return etl.run_etl(days, LAT, LON, sb=sb), calls, uv_calls
    finally:
        etl.fetch_hourly, etl.fetch_uv = real, real_uv


def _today_payload(temp=3.0):
    """One hourly value at 00:00 ET today (always in the past)."""
    today = datetime.now(etl.ET).date().isoformat()
    return _payload([(_utc(today, 0), {"temperature_2m": temp})]), today


def test_run_success_writes_rows_and_one_success_heartbeat():
    sb = FakeSupabase()
    payload, today = _today_payload()
    uv = {"hourly": {"time": [_utc(today, 0)], "uv_index": [0.0]}}
    written, _, uv_calls = _run(sb, payload, uv_payload=uv)
    assert written == 1 and len(sb.upserts) == 1 and len(uv_calls) == 1
    row = sb.upserts[0][0]
    assert {"calendar_date", "temperature_max", "temperature_mean", "n_hours", "night_hours", "latitude", "longitude",
            "uv_index_max", "uv_source", "synced_at"} <= set(row)
    assert row["uv_index_max"] == 0.0 and row["uv_source"] == etl.UV_SOURCE
    assert len(sb.heartbeats) == 1
    beat = sb.heartbeats[0]
    assert (beat["source"], beat["data_type"], beat["status"], beat["records_synced"]) == ("weather", "daily", "success", 1)
    assert beat["sync_start"] and beat["sync_end"] and beat["duration_seconds"] >= 0


def test_run_with_no_temperature_values_is_a_partial_heartbeat():
    sb = FakeSupabase()
    written, _, uv_calls = _run(sb, _payload(_day("2026-11-10", [None] * 24)))
    assert written == 0 and not sb.upserts and not uv_calls
    assert [b["status"] for b in sb.heartbeats] == ["partial"]
    assert "no temperature" in sb.heartbeats[0]["error_message"]


def test_uv_failure_still_writes_weather_and_reports_partial():
    sb = FakeSupabase()
    payload, _ = _today_payload()
    written, _, _ = _run(sb, payload, uv_error=RuntimeError("Open-Meteo HTTP 503: uv down"))
    assert written == 1 and len(sb.upserts) == 1
    assert "uv_index_max" not in sb.upserts[0][0] and "uv_source" not in sb.upserts[0][0], \
        "a failed UV request must leave stored UV values alone"
    assert [b["status"] for b in sb.heartbeats] == ["partial"]
    assert "uv down" in sb.heartbeats[0]["error_message"] and sb.heartbeats[0]["records_synced"] == 1


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
    sb = FakeSupabase(upsert_error="Could not find the table 'pds.weather_daily' in the schema cache (PGRST205)")
    payload, _ = _today_payload()
    try:
        _run(sb, payload)
    except SystemExit:
        pass
    assert len(sb.heartbeats) == 1 and sb.heartbeats[0]["status"] == "failed"
    assert "sql/weather_schema.sql" in sb.heartbeats[0]["error_message"]


def test_routine_run_window_and_empty_table_bootstrap():
    now_et = datetime.now(etl.ET)
    today = now_et.date()
    api_end = min(today + timedelta(days=1), now_et.astimezone(timezone.utc).date())
    empty_payload = _payload(_day("2026-11-10", [None]))
    assert etl.DEFAULT_DAYS == 10, "recent archive days are revised for ~5 days; 10 is the researched window"
    _, calls, _ = _run(FakeSupabase(existing=True), empty_payload)
    assert calls == [(today - timedelta(days=etl.DEFAULT_DAYS), api_end)]
    _, calls, _ = _run(FakeSupabase(existing=False), empty_payload)
    assert calls[0][0] == etl.BOOTSTRAP_START == date(2024, 1, 1) and calls[-1][1] == api_end and len(calls) > 5
    for (_, prev_end), (nxt_start, _) in zip(calls, calls[1:]):
        assert prev_end == nxt_start, "each window asks one extra UTC date, the start of the next window"
    _, calls, _ = _run(FakeSupabase(existing=False), empty_payload, days=30)
    assert calls == [(today - timedelta(days=30), api_end)], "an explicit window never bootstraps"


def test_window_rows_do_not_leak_the_padding_day():
    # The API answer for one window includes the first ET hours of the day after it; that
    # partial day belongs to the next window and must not be written (or overwrite anything).
    real_windows = etl.windows
    etl.windows = lambda start, end, chunk=90: [(date(2026, 11, 9), date(2026, 11, 9))]
    try:
        sb = FakeSupabase()
        payload = _payload(_day("2026-11-09", [7.0] * 24) + _day("2026-11-10", [9.0] * 5))
        written, _, _ = _run(sb, payload, days=3)
    finally:
        etl.windows = real_windows
    assert written == 1 and [r["calendar_date"] for r in sb.upserts[0]] == ["2026-11-09"]


# ---------------------------------------------------------------------------
# HRV pipeline: merge_weather_features
# ---------------------------------------------------------------------------

def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-07").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(7.0)})


def _weather():
    def row(day, temp, hours=24, night=8, precip=0.0):
        r = {"calendar_date": day, "n_hours": hours, "night_hours": night}
        for src in h.WX_DAY_COLS.values():
            r[src] = temp
        r["precipitation_sum"] = precip
        r["temperature_min"] = temp - 100        # must never reach the matrix
        r["night_temp_mean"] = temp + 0.5
        r["night_temp_min"] = temp + 0.25
        return r
    return pd.DataFrame([
        row("2026-01-02", 8.0, precip=0.0),
        row("2026-01-03", 12.0, precip=3.0),
        row("2026-01-04", 99.0, hours=9, night=8),     # partial day, but its night is complete
        row("2026-01-05", 4.0, hours=23, night=6),     # just enough hours (a spring-forward day has 23); night incomplete
        row("2026-01-09", 50.0),                       # outside the matrix: ignored
    ])


def test_daytime_columns_sit_on_the_same_row():
    out = h.merge_weather_features(_matrix(), _weather())
    by = out.set_index("calendar_date")
    assert len(out) == 7
    for feat in h.WX_DAY_COLS:
        if feat == "wx_precip_mm":
            continue
        assert by.loc["2026-01-02", feat] == 8.0 and by.loc["2026-01-03", feat] == 12.0, feat
        assert by.loc["2026-01-05", feat] == 4.0, "exactly the minimum hour count: counts"
        assert np.isnan(by.loc["2026-01-04", feat]), "a partial day is unknown"
        for day in ("2026-01-01", "2026-01-06", "2026-01-07"):
            assert np.isnan(by.loc[day, feat]), "an uncovered day is unknown, never 0"
    # nothing else on the matrix moved
    assert out["whoop_hrv_rmssd"].tolist() == _matrix()["whoop_hrv_rmssd"].tolist()


def test_today_is_never_a_complete_day_however_many_hours_it_has():
    # From ~19:00 ET today's row has 20+ hourly values, and from 22:00 it has 23, while its
    # rain sum, wind maximum and means are still growing. The hour count alone must not
    # make it count: a day is complete only once it is over.
    w = _weather()
    w.loc[w["calendar_date"] == "2026-01-03", "n_hours"] = 23           # "today" at 22:xx ET
    by = h.merge_weather_features(_matrix(), w, today=date(2026, 1, 3)).set_index("calendar_date")
    for feat in h.WX_DAY_COLS:
        assert np.isnan(by.loc["2026-01-03", feat]), f"{feat}: today's partial aggregate reached the matrix"
    assert by.loc["2026-01-02", "wx_temp_mean"] == 8.0, "yesterday is over and complete"
    # today's early-morning night is already final (the ETL waits for its last hour) and
    # belongs to the sleep that closed yesterday
    assert by.loc["2026-01-02", "wx_night_temp_mean"] == 12.5
    # even a full 24 values before midnight does not make today count
    w.loc[w["calendar_date"] == "2026-01-03", "n_hours"] = 24
    by = h.merge_weather_features(_matrix(), w, today=date(2026, 1, 3)).set_index("calendar_date")
    assert np.isnan(by.loc["2026-01-03", "wx_precip_mm"]) and np.isnan(by.loc["2026-01-03", "wx_wind_max"])
    # the day after, the same row counts
    by = h.merge_weather_features(_matrix(), w, today=date(2026, 1, 4)).set_index("calendar_date")
    assert by.loc["2026-01-03", "wx_temp_mean"] == 12.0 and by.loc["2026-01-03", "wx_precip_mm"] == 3.0
    # a future-dated row (clock skew, a bad write) never counts either
    by = h.merge_weather_features(_matrix(), w, today=date(2026, 1, 2)).set_index("calendar_date")
    assert np.isnan(by.loc["2026-01-02", "wx_temp_mean"]) and np.isnan(by.loc["2026-01-03", "wx_temp_mean"])


def test_a_past_day_short_of_hours_stays_unknown():
    # A day the ETL left half-written (an outage that outlasted the re-upsert window) or
    # an API gap: 20-22 hours is not a full day, on any date. 23 is (spring-forward).
    assert h.WX_MIN_HOURS == 23
    for hours, counts in ((20, False), (22, False), (23, True), (24, True), (25, True)):
        w = _weather()
        w.loc[w["calendar_date"] == "2026-01-02", "n_hours"] = hours
        by = h.merge_weather_features(_matrix(), w).set_index("calendar_date")
        assert bool(np.isfinite(by.loc["2026-01-02", "wx_temp_mean"])) is counts, hours
        assert bool(np.isfinite(by.loc["2026-01-02", "wx_precip_mm"])) is counts, hours


def test_default_today_is_the_et_clock_date():
    # Without an explicit `today` the merge uses et_today(): a row dated ET today is left out.
    today = h.et_today()
    days = [(today - timedelta(days=1)).isoformat(), today.isoformat()]
    m = pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": [50.0, np.nan]})
    w = pd.DataFrame([{"calendar_date": d, "n_hours": 24, "night_hours": 8,
                       **{src: 5.0 for src in h.WX_DAY_COLS.values()},
                       "night_temp_mean": 1.0, "night_temp_min": 0.0} for d in days])
    by = h.merge_weather_features(m, w).set_index("calendar_date")
    assert by.loc[days[0], "wx_temp_mean"] == 5.0 and np.isnan(by.loc[days[1], "wx_temp_mean"])
    assert by.loc[days[0], "wx_night_temp_mean"] == 1.0, "today's finished night sits on yesterday's row"


def test_night_columns_sit_on_the_row_whose_sleep_they_overlap():
    # The 01:00-08:00 ET hours stored on clock day D + 1 fall inside the sleep that closes
    # behavioral day D, so they belong on matrix row D (one row earlier than the daytime values).
    by = h.merge_weather_features(_matrix(), _weather()).set_index("calendar_date")
    assert by.loc["2026-01-01", "wx_night_temp_mean"] == 8.5, "Jan 2's early morning is row Jan 1's sleep"
    assert by.loc["2026-01-02", "wx_night_temp_mean"] == 12.5 and by.loc["2026-01-02", "wx_night_temp_min"] == 12.25
    assert by.loc["2026-01-03", "wx_night_temp_mean"] == 99.5, "a complete night counts even if its clock day is partial"
    assert np.isnan(by.loc["2026-01-04", "wx_night_temp_mean"]), "Jan 5's night has too few hours"
    for day in ("2026-01-05", "2026-01-06", "2026-01-07"):
        assert np.isnan(by.loc[day, "wx_night_temp_mean"]) and np.isnan(by.loc[day, "wx_night_temp_min"])
    # same-row placement would have put 8.5 on Jan 2: it must not be there
    assert by.loc["2026-01-02", "wx_night_temp_mean"] != 8.5
    # row D pairs the day-D afternoon with the night that follows it
    assert (by.loc["2026-01-02", "wx_temp_max"], by.loc["2026-01-02", "wx_night_temp_mean"]) == (8.0, 12.5)


def test_night_rekey_is_by_date_not_by_row_position():
    m = _matrix()
    m = m[m["calendar_date"] != "2026-01-02"].reset_index(drop=True)      # a gap in the spine
    by = h.merge_weather_features(m, _weather()).set_index("calendar_date")
    assert by.loc["2026-01-01", "wx_night_temp_mean"] == 8.5
    assert by.loc["2026-01-03", "wx_night_temp_mean"] == 99.5
    src = Path(h.__file__).read_text(encoding="utf-8")
    body = src[src.index("def merge_weather_features"):src.index("def build_feature_matrix")]
    assert ".shift(" not in body, "re-key by date (hrv_alignment rule), never by position"


def test_clock_day_minimum_is_not_a_feature_and_nothing_is_zero_filled():
    out = h.merge_weather_features(_matrix(), _weather())
    assert "wx_temp_min" not in out.columns and "temperature_min" not in out.columns
    assert "temperature_min" not in h.WX_DAY_COLS.values() and "temperature_min" not in h.WX_NIGHT_COLS.values()
    assert not (out[list(h.WX_COLS)] < -50).any().any(), "the clock-day minimum leaked into a feature"
    by = out.set_index("calendar_date")
    # a real 0 from the source survives; a missing day is NaN, not 0
    assert by.loc["2026-01-02", "wx_precip_mm"] == 0.0 and by.loc["2026-01-03", "wx_precip_mm"] == 3.0
    assert np.isnan(by.loc["2026-01-01", "wx_precip_mm"]) and np.isnan(by.loc["2026-01-04", "wx_precip_mm"])
    covered = {"2026-01-02", "2026-01-03", "2026-01-05"}
    for day, r in by.iterrows():
        if day not in covered:
            assert r[list(h.WX_DAY_COLS)].isna().all(), f"{day} was filled"


def test_merge_is_idempotent_and_handles_duplicates_and_date_types():
    w = _weather()
    w = pd.concat([w, w.iloc[[0]]], ignore_index=True)                  # duplicate day
    w["calendar_date"] = pd.to_datetime(w["calendar_date"])              # datetime instead of text
    once = h.merge_weather_features(_matrix(), w)
    twice = h.merge_weather_features(once, w)
    assert len(once) == 7 and once.equals(twice)
    assert once.loc[once["calendar_date"] == "2026-01-02", "wx_temp_mean"].iloc[0] == 8.0


def test_numeric_strings_from_postgrest_are_coerced():
    w = _weather().astype({c: str for c in ("temperature_mean", "night_temp_mean", "n_hours", "night_hours")})
    by = h.merge_weather_features(_matrix(), w).set_index("calendar_date")
    assert by.loc["2026-01-03", "wx_temp_mean"] == 12.0 and by.loc["2026-01-02", "wx_night_temp_mean"] == 12.5


def test_missing_uv_stays_nan():
    w = _weather()
    w["uv_index_max"] = None
    by = h.merge_weather_features(_matrix(), w).set_index("calendar_date")
    assert by["wx_uv_max"].isna().all() and by.loc["2026-01-02", "wx_temp_mean"] == 8.0


def test_fail_open():
    m = _matrix()
    assert h.merge_weather_features(m, None) is m
    assert h.merge_weather_features(m, pd.DataFrame()) is m
    bad = pd.DataFrame([{"calendar_date": "2026-01-02"}])               # columns missing
    assert h.merge_weather_features(m, bad).equals(m)
    assert not any(c.startswith("wx_") for c in h.merge_weather_features(m, bad).columns)


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def test_alignment_and_forecast_rules():
    assert "wx_" in h.NOT_FORECAST_PREFIXES
    assert len(h.WX_COLS) == len(set(h.WX_COLS)) == len(h.WX_DAY_COLS) + len(h.WX_NIGHT_COLS)
    for col in h.WX_COLS:
        assert col.startswith("wx_"), "one prefix for the whole family"
        assert col.startswith(h.NOT_FORECAST_PREFIXES), f"{col} would reach the forecast with a NaN newest row"
        assert not al.is_same_sleep(col), "exogenous weather is not measured from the outcome sleep"
        assert col not in al.NEEDS_SLEEP_ONSET
        assert col in h.FEATURE_LABELS
    assert set(h.WX_NIGHT_COLS) == {"wx_night_temp_mean", "wx_night_temp_min"}
    assert "wx_" not in h.CONTROLLABLE_FEATURE_PREFIXES, "the weather is not something Riley controls"


def test_loader_selects_every_column_the_merge_reads():
    src = Path(h.__file__).read_text(encoding="utf-8")
    start = src.index('"weather_daily",')
    block = src[start:start + 400]
    assert "calendar_date,n_hours,night_hours," in block and "WX_DAY_COLS.values()" in block and "WX_NIGHT_COLS.values()" in block
    sql = (Path(h.__file__).parent / "sql" / "weather_schema.sql").read_text(encoding="utf-8")
    for col in ["n_hours", "night_hours", *h.WX_DAY_COLS.values(), *h.WX_NIGHT_COLS.values()]:
        assert f"\n    {col} " in sql, f"{col} is read by the pipeline but is not a column of pds.weather_daily"
    assert "drop" not in sql.lower(), "additive-only schema file"


def test_causal_treatments_registered_and_marked_exploratory():
    wx = {c: (f, rest[-1]) for c, f, *rest in ci.CONTINUOUS_TREATMENTS if c.startswith("wx_")}
    assert wx == {"wx_apparent_temp_max": ("behavior", "°C"), "wx_sunshine_hours": ("behavior", "h"),
                  "wx_night_temp_mean": ("behavior", "°C")}, "a small, fixed set of weather treatments"
    df = pd.DataFrame({"wx_night_temp_mean": [1.0, 2.0], "hrv_lag1": [50.0, 51.0]})
    specs = {s.name: s for s in ci._enumerate_continuous_treatments(df)}
    assert specs["wx_night_temp_mean"].kind == "continuous_median_split"
    assert "wx_sunshine_hours" not in specs, "a column that is not in the matrix is not a treatment"
    src = Path(ci.__file__).read_text(encoding="utf-8")
    note = src[src.index("# Outdoor weather (pds.weather_daily"):src.index('("wx_apparent_temp_max"')]
    assert "NO seasonal adjustment" in note and "EXPLORATORY" in note


def test_no_target_shift_in_new_code():
    assert ".shift(-" not in Path(etl.__file__).read_text(encoding="utf-8")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
