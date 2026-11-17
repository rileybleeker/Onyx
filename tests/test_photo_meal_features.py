"""merge_photo_meal_features: row placement, Cronometer-primary gating, no zero-fill, fail-open.

A photo meal eaten on behavioral day D sits on matrix row D (the row whose HRV is the sleep
that closes day D — hrv_alignment.py). Cronometer-gold meal timing stays primary: a day whose
matrix meal_last_meal_to_bedtime_min is non-NaN gets no photo columns. Unlogged days stay NaN
(photo logging is manual, so "no row" cannot be told apart from "not logged").

Run: python tests/test_photo_meal_features.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_analysis as h  # noqa: E402


def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-10").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(10.0)})


def _cycles():
    # One cycle per behavioral day: sleep onset 22:00 UTC on the day, i.e. the sleep that
    # CLOSES that behavioral day. Two cycles on 01-05 → the longest one is the main sleep.
    return pd.DataFrame([
        {"start_time": "2026-01-03T22:00:00Z", "end_time": "2026-01-04T06:00:00Z",
         "onyx_behavioral_date": "2026-01-03"},
        {"start_time": "2026-01-04T13:00:00Z", "end_time": "2026-01-04T13:40:00Z",  # nap, shorter
         "onyx_behavioral_date": "2026-01-05"},
        {"start_time": "2026-01-05T22:30:00Z", "end_time": "2026-01-06T07:00:00Z",
         "onyx_behavioral_date": "2026-01-05"},
        {"start_time": "2026-01-06T22:00:00Z", "end_time": "2026-01-07T06:00:00Z",
         "onyx_behavioral_date": "2026-01-06"},
    ])


def _photo():
    # Meals with their UTC eaten_at instants (synthetic).
    return pd.DataFrame([
        {"eaten_date": "2026-01-02", "eaten_at": "2026-01-02T20:00:00Z", "kcal": 500.0,
         "capture_kind": "photo", "deleted_at": None},
        # two meals on day 01-03; the later one is 1.5 h before the cycle's 22:00 onset
        {"eaten_date": "2026-01-03", "eaten_at": "2026-01-03T12:00:00Z", "kcal": 600.0,
         "capture_kind": "photo", "deleted_at": None},
        {"eaten_date": "2026-01-03", "eaten_at": "2026-01-03T20:30:00Z", "kcal": 800.0,
         "capture_kind": "photo", "deleted_at": None},
        # drink capture and a removed meal on day 01-04: neither counts
        {"eaten_date": "2026-01-04", "eaten_at": "2026-01-04T19:00:00Z", "kcal": 150.0,
         "capture_kind": "drink", "deleted_at": None},
        {"eaten_date": "2026-01-04", "eaten_at": "2026-01-04T19:30:00Z", "kcal": 700.0,
         "capture_kind": "photo", "deleted_at": "2026-11-02T00:00:00Z"},
        # day 01-06: one meal 90 min before the 22:00 onset
        {"eaten_date": "2026-01-06", "eaten_at": "2026-01-06T20:30:00Z", "kcal": 650.0,
         "capture_kind": "photo", "deleted_at": None},
    ])


def _merged(cycles=None, matrix=None):
    m = matrix if matrix is not None else _matrix()
    return h.merge_photo_meal_features(m, _photo(), cycles if cycles is not None else _cycles()
                                       ).set_index("calendar_date")


def test_photo_meals_land_on_their_own_row():
    out = _merged()
    assert len(out) == 10
    assert out.loc["2026-01-02", "photo_meal_count"] == 1
    assert out.loc["2026-01-03", "photo_meal_count"] == 2
    assert out.loc["2026-01-03", "photo_last_meal_to_sleep_min"] == 90.0
    # row order and the other columns are untouched
    assert list(out.index) == list(_matrix()["calendar_date"])
    assert list(out["whoop_hrv_rmssd"]) == list(np.arange(10.0))


def test_gap_to_sleep_uses_the_main_cycle_onset():
    out = _merged()
    # day 01-03: last meal 20:30, sleep onset 22:00 → 90 min
    assert out.loc["2026-01-03", "photo_last_meal_to_sleep_min"] == 90.0
    # day 01-06: meal 20:30, onset 22:00 → 90 min
    assert out.loc["2026-01-06", "photo_last_meal_to_sleep_min"] == 90.0
    # day 01-02: a meal but no cycle that day → no gap
    assert np.isnan(out.loc["2026-01-02", "photo_last_meal_to_sleep_min"])


def test_drink_and_deleted_rows_are_excluded():
    out = _merged()
    # day 01-04: the drink capture and the deleted meal are both excluded → no photo day
    assert np.isnan(out.loc["2026-01-04", "photo_meal_count"])
    assert np.isnan(out.loc["2026-01-04", "photo_last_meal_to_sleep_min"])


def test_cronometer_days_get_no_photo_columns():
    m = _matrix()
    m["meal_last_meal_to_bedtime_min"] = np.where(
        m["calendar_date"] == "2026-01-03", 120.0, np.nan)
    out = h.merge_photo_meal_features(m, _photo(), _cycles()).set_index("calendar_date")
    # Cronometer gold covers day 01-03 → photo columns stay NaN even though meals exist
    assert np.isnan(out.loc["2026-01-03", "photo_meal_count"])
    assert np.isnan(out.loc["2026-01-03", "photo_last_meal_to_sleep_min"])
    # a day Cronometer does NOT cover keeps its photo values
    assert out.loc["2026-01-06", "photo_meal_count"] == 1
    assert out.loc["2026-01-06", "photo_last_meal_to_sleep_min"] == 90.0


def test_unlogged_days_stay_nan_never_zero():
    out = _merged()
    # days with no photo meals and no Cronometer row: unknown, never a fake zero
    for row in ("2026-01-01", "2026-01-05", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"):
        assert np.isnan(out.loc[row, "photo_meal_count"])
        assert np.isnan(out.loc[row, "photo_last_meal_to_sleep_min"])


def test_fail_open():
    m = _matrix()
    assert h.merge_photo_meal_features(m, None) is m
    assert h.merge_photo_meal_features(m, pd.DataFrame()) is m
    # a frame missing the expected columns must not raise
    bad = pd.DataFrame({"eaten_date": ["2026-01-03"]})
    assert h.merge_photo_meal_features(m, bad) is m
    # a frame of only drink/deleted rows is a no-op
    only_drinks = _photo()
    only_drinks["capture_kind"] = "drink"
    assert h.merge_photo_meal_features(m, only_drinks) is m


def test_photo_columns_stay_out_of_the_forecast_features():
    out = h.merge_photo_meal_features(_matrix(), _photo(), _cycles())
    out["hrv_lag1"] = out["whoop_hrv_rmssd"].shift(1)   # prepare_ml_data requires it
    out["some_other_feature"] = 1.0
    _, feat_cols, _, _ = h.prepare_ml_data(out)
    assert "some_other_feature" in feat_cols
    assert not [c for c in feat_cols if c.startswith("photo_")]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS: {name}")
