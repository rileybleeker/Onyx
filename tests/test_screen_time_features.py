"""merge_screen_time_features: same-row placement, partial days left NaN, no zero-fill, alignment rules.

Run: python tests/test_screen_time_features.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402


def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-06").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(6.0)})


def _row(day, total, synced, social=30.0):
    return {"behavioral_date": day, "total_minutes": total, "late_night_minutes": 40.0,
            "after_midnight_minutes": 10.0, "pickups": 50, "notifications": 60,
            "minutes_by_category": {"Social": social, "Other": 5.0},
            "minutes_last_hour_before_sleep_est": 20.0, "minutes_during_sleep_est": 3.0,
            "synced_at": synced}


def _screen():
    return pd.DataFrame([
        # synced the next morning (10 AM ET = 15:00Z): complete
        _row("2026-01-02", 300.0, "2026-01-03T15:00:00+00:00"),
        # synced 05:30 ET on 01-04, before day 01-03 ended at 06:00 ET: partial → NaN
        _row("2026-01-03", 120.0, "2026-01-04T10:30:00+00:00"),
        # complete, no Social category that day → 0 social minutes
        {**_row("2026-01-04", 200.0, "2026-01-06T15:00:00+00:00"),
         "minutes_by_category": {"Other": 200.0}},
    ])


def test_same_row_and_completeness():
    out = h.merge_screen_time_features(_matrix(), _screen())
    by = out.set_index("calendar_date")
    assert len(out) == 6
    assert by.loc["2026-01-02", "screen_total_min"] == 300.0
    assert by.loc["2026-01-02", "screen_social_min"] == 30.0
    assert np.isnan(by.loc["2026-01-03", "screen_total_min"]), "partial day must stay NaN"
    assert by.loc["2026-01-04", "screen_social_min"] == 0.0
    # days the app never reported are NaN, never zero
    assert np.isnan(by.loc["2026-01-01", "screen_total_min"])
    assert np.isnan(by.loc["2026-01-06", "screen_total_min"])


def test_alignment_rules():
    assert not al.forecast_can_use("screen_during_sleep_min")
    assert al.is_same_sleep("screen_during_sleep_min")
    assert not al.forecast_can_use("screen_last_hour_before_sleep_min")
    assert "screen_" in h.NOT_FORECAST_PREFIXES


def test_fail_open():
    m = _matrix()
    assert h.merge_screen_time_features(m, None) is m
    assert h.merge_screen_time_features(m, pd.DataFrame()) is m
    bad = pd.DataFrame([{"behavioral_date": "2026-01-02"}])  # missing columns
    assert h.merge_screen_time_features(m, bad).equals(m)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
