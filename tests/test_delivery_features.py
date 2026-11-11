"""merge_delivery_features: row placement, zero-fill only inside coverage, unknown times, fail-open.

A delivery on behavioral day D sits on matrix row D: row D's HRV is the sleep that closes
day D, the sleep the meal preceded (hrv_alignment.py). Until 2026-11-10 it was written to
row D - 1 to offset the pipeline's old next-row outcome.

Run: python tests/test_delivery_features.py
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


def _delivery():
    return pd.DataFrame([
        # delivery days 01-03 .. 01-08  →  matrix rows 01-03 .. 01-08 (same row)
        {"behavioral_date": "2026-01-03", "meal_order_count": 1, "untimed_meal_order_count": 0,
         "late_meal_delivery": True, "last_meal_delivery_to_sleep_minutes": 45.0},
        {"behavioral_date": "2026-01-05", "meal_order_count": 2, "untimed_meal_order_count": 0,
         "late_meal_delivery": False, "last_meal_delivery_to_sleep_minutes": 300.5},
        # only a date-only receipt: counted, but the time is unknown
        {"behavioral_date": "2026-01-06", "meal_order_count": 1, "untimed_meal_order_count": 1,
         "late_meal_delivery": None, "last_meal_delivery_to_sleep_minutes": None},
        # one timed early meal plus one untimed meal: the untimed one could have been late
        {"behavioral_date": "2026-01-07", "meal_order_count": 2, "untimed_meal_order_count": 1,
         "late_meal_delivery": False, "last_meal_delivery_to_sleep_minutes": 400.0},
        # a package-store run only: an order, but not a meal
        {"behavioral_date": "2026-01-08", "meal_order_count": 0, "untimed_meal_order_count": 0,
         "late_meal_delivery": None, "last_meal_delivery_to_sleep_minutes": None},
    ])


def _merged(covered_through=None):
    return h.merge_delivery_features(_matrix(), _delivery(), covered_through).set_index("calendar_date")


def test_delivery_lands_on_its_own_row():
    out = _merged()
    assert len(out) == 10
    # day 01-03's late meal is on row 01-03, whose outcome is the sleep closing 01-03
    assert out.loc["2026-01-03", "delivery_late_meal"] == 1
    assert out.loc["2026-01-03", "delivery_last_meal_to_sleep_min"] == 45.0
    assert out.loc["2026-01-05", "delivery_meal_count"] == 2
    assert out.loc["2026-01-05", "delivery_late_meal"] == 0
    # row order and the other columns are untouched
    assert list(out.index) == list(_matrix()["calendar_date"])
    assert list(out["whoop_hrv_rmssd"]) == list(np.arange(10.0))


def test_zero_fill_only_inside_coverage():
    out = _merged()
    # 01-01..01-02 are before the first delivery day, 01-09.. after the last one:
    # unknown, never a fake zero
    for row in ("2026-01-01", "2026-01-02", "2026-01-09", "2026-01-10"):
        assert np.isnan(out.loc[row, "delivery_meal_count"])
        assert np.isnan(out.loc[row, "delivery_late_meal"])
        assert np.isnan(out.loc[row, "delivery_any_meal"])
    # 01-04: inside coverage with no order → a true zero
    assert out.loc["2026-01-04", "delivery_meal_count"] == 0
    assert out.loc["2026-01-04", "delivery_late_meal"] == 0
    assert out.loc["2026-01-04", "delivery_any_meal"] == 0
    assert np.isnan(out.loc["2026-01-04", "delivery_last_meal_to_sleep_min"])


def test_etl_heartbeat_extends_coverage():
    # the ETL verifiably covered through day 01-09 → rows 01-09 becomes a true zero
    out = _merged("2026-01-09")
    assert out.loc["2026-01-09", "delivery_meal_count"] == 0
    assert out.loc["2026-01-09", "delivery_late_meal"] == 0
    assert out.loc["2026-01-09", "delivery_any_meal"] == 0
    # 01-10 is past the covered day
    assert np.isnan(out.loc["2026-01-10", "delivery_meal_count"])
    # a covered-through date before the last order changes nothing
    assert _merged("2026-01-04").equals(_merged())


def test_unread_receipt_days_are_never_zero_filled():
    # A receipt the ETL could not read may hide a delivery on day 01-04: that row must stay
    # unknown instead of reading as a no-delivery day, even inside coverage.
    out = h.merge_delivery_features(_matrix(), _delivery(), "2026-01-10",
                                    [pd.Timestamp("2026-01-04")]).set_index("calendar_date")
    for col in ("delivery_meal_count", "delivery_late_meal", "delivery_any_meal"):
        assert np.isnan(out.loc["2026-01-04", col])
    # a day WITH a parsed order keeps its values even if it is on the unread list
    out2 = h.merge_delivery_features(_matrix(), _delivery(), None,
                                     [pd.Timestamp("2026-01-03")]).set_index("calendar_date")
    assert out2.loc["2026-01-03", "delivery_late_meal"] == 1
    # other in-coverage days are unaffected
    assert out.loc["2026-01-09", "delivery_meal_count"] == 0


def test_unknown_times():
    out = _merged()
    # day 01-06: date-only meal → counted, late flag unknown
    assert out.loc["2026-01-06", "delivery_any_meal"] == 1
    assert np.isnan(out.loc["2026-01-06", "delivery_late_meal"])
    # day 01-07: a timed early meal and an untimed one → late flag unknown, not 0
    assert out.loc["2026-01-07", "delivery_meal_count"] == 2
    assert np.isnan(out.loc["2026-01-07", "delivery_late_meal"])
    # day 01-08: store-only day → no meal, so no late meal
    assert out.loc["2026-01-08", "delivery_any_meal"] == 0
    assert out.loc["2026-01-08", "delivery_late_meal"] == 0


def test_fail_open():
    m = _matrix()
    assert h.merge_delivery_features(m, None) is m
    assert h.merge_delivery_features(m, pd.DataFrame()) is m
    # a frame missing the expected columns must not raise
    bad = pd.DataFrame({"behavioral_date": ["2026-01-03"]})
    assert h.merge_delivery_features(m, bad) is m


def test_delivery_columns_stay_out_of_the_forecast_features():
    out = h.merge_delivery_features(_matrix(), _delivery())
    out["hrv_lag1"] = out["whoop_hrv_rmssd"].shift(1)   # prepare_ml_data requires it
    out["some_other_feature"] = 1.0
    _, feat_cols, _, _ = h.prepare_ml_data(out)
    assert "some_other_feature" in feat_cols
    assert not [c for c in feat_cols if c.startswith("delivery_")]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS: {name}")
