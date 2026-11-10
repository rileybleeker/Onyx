"""merge_delivery_features: zero-fill only inside coverage, NaN outside, fail-open.

Run: python -m pytest tests/test_delivery_features.py -q
"""
import os

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_analysis as h  # noqa: E402


def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-10").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(10.0)})


def _delivery():
    return pd.DataFrame([
        # coverage runs 01-03 → 01-08
        {"behavioral_date": "2026-01-03", "meal_order_count": 1, "late_meal_delivery": True,
         "last_meal_delivery_to_sleep_minutes": 45.0},
        {"behavioral_date": "2026-01-05", "meal_order_count": 2, "late_meal_delivery": False,
         "last_meal_delivery_to_sleep_minutes": 300.5},
        # only a date-only receipt: counted, but the time is unknown
        {"behavioral_date": "2026-01-06", "meal_order_count": 1, "late_meal_delivery": None,
         "last_meal_delivery_to_sleep_minutes": None},
        # a package-store run only: an order, but not a meal
        {"behavioral_date": "2026-01-08", "meal_order_count": 0, "late_meal_delivery": None,
         "last_meal_delivery_to_sleep_minutes": None},
    ])


def test_zero_fill_only_inside_coverage():
    out = h.merge_delivery_features(_matrix(), _delivery()).set_index("calendar_date")
    assert len(out) == 10
    # before / after coverage: unknown, never a fake zero
    for day in ("2026-01-01", "2026-01-02", "2026-01-09", "2026-01-10"):
        assert np.isnan(out.loc[day, "delivery_meal_count"])
        assert np.isnan(out.loc[day, "delivery_late_meal"])
        assert np.isnan(out.loc[day, "delivery_any_meal"])
    # inside coverage, no row → a true zero
    assert out.loc["2026-01-04", "delivery_meal_count"] == 0
    assert out.loc["2026-01-04", "delivery_late_meal"] == 0
    assert out.loc["2026-01-04", "delivery_any_meal"] == 0
    assert np.isnan(out.loc["2026-01-04", "delivery_last_meal_to_sleep_min"])


def test_values_and_unknown_times():
    out = h.merge_delivery_features(_matrix(), _delivery()).set_index("calendar_date")
    assert out.loc["2026-01-03", "delivery_late_meal"] == 1
    assert out.loc["2026-01-03", "delivery_last_meal_to_sleep_min"] == 45.0
    assert out.loc["2026-01-05", "delivery_meal_count"] == 2
    assert out.loc["2026-01-05", "delivery_late_meal"] == 0
    # date-only meal: counted, late flag unknown
    assert out.loc["2026-01-06", "delivery_any_meal"] == 1
    assert np.isnan(out.loc["2026-01-06", "delivery_late_meal"])
    # store-only day: no meal, so no late meal
    assert out.loc["2026-01-08", "delivery_any_meal"] == 0
    assert out.loc["2026-01-08", "delivery_late_meal"] == 0


def test_fail_open():
    m = _matrix()
    assert h.merge_delivery_features(m, None) is m
    assert h.merge_delivery_features(m, pd.DataFrame()) is m
    # a frame missing the expected columns must not raise
    bad = pd.DataFrame({"behavioral_date": ["2026-01-03"]})
    assert h.merge_delivery_features(m, bad) is m
