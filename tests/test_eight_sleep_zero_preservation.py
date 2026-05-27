"""Regression test for eight_sleep_etl.py trend/interval merge.

Audit re-2026-05-26 finding (etl/deepseek/F-001, P0): the merge step used
`trend.get(X) or interval.get(X)` to prefer trend over interval. Python's
falsy `or` treats 0 / 0.0 / False / "" as missing, so a legitimate trend
value of 0 (e.g. awake_seconds=0 on a perfect sleep, deep_sleep_seconds=0
on a degraded reading, toss_and_turns=0) would silently fall through to
the interval value — corrupting the row.

The fix introduces `_prefer_trend(trend, interval, key)` which checks `is
not None`. This test feeds a trend row with awake_seconds=0 + a non-zero
interval row for the same date, simulates the merge as the ETL does, and
asserts the 0 from trend survives.

Run: python tests/test_eight_sleep_zero_preservation.py
"""
from __future__ import annotations
import os
import sys
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


def test_zero_trend_value_not_overwritten_by_interval() -> None:
    """Trend awake_seconds=0 must persist; interval's 1800 must not displace it."""
    trend = {
        "calendar_date": "2026-05-25",
        "bed_side": "left",
        "awake_seconds": 0,
        "deep_sleep_seconds": 0,
        "rem_sleep_seconds": 5400,
        "light_sleep_seconds": 10800,
        "toss_and_turns": 0,
        "avg_heart_rate": 62.0,
        "avg_breath_rate": 14.0,
        "median_bed_temp": 24.5,
        "median_room_temp": 19.0,
    }
    interval = {
        "calendar_date": "2026-05-25",
        "bed_side": "left",
        "awake_seconds": 1800,        # stale / different sensor
        "deep_sleep_seconds": 3600,   # stale
        "rem_sleep_seconds": 5400,
        "light_sleep_seconds": 10800,
        "toss_and_turns": 15,
        "avg_heart_rate": 65.0,
        "avg_breath_rate": 15.0,
        "median_bed_temp": 25.0,
        "median_room_temp": 20.0,
    }

    assert es._prefer_trend(trend, interval, "awake_seconds") == 0
    assert es._prefer_trend(trend, interval, "deep_sleep_seconds") == 0
    assert es._prefer_trend(trend, interval, "toss_and_turns") == 0
    # Non-zero values from trend should also win.
    assert es._prefer_trend(trend, interval, "avg_heart_rate") == 62.0
    assert es._prefer_trend(trend, interval, "median_bed_temp") == 24.5


def test_missing_trend_falls_through_to_interval() -> None:
    """When trend is silent on a key, interval should fill the gap."""
    trend: dict = {}
    interval = {"awake_seconds": 1800, "median_bed_temp": 24.0}
    assert es._prefer_trend(trend, interval, "awake_seconds") == 1800
    assert es._prefer_trend(trend, interval, "median_bed_temp") == 24.0


def test_none_trend_value_falls_through() -> None:
    """An explicit None in trend (vs missing key) should also fall through."""
    trend = {"awake_seconds": None}
    interval = {"awake_seconds": 1800}
    assert es._prefer_trend(trend, interval, "awake_seconds") == 1800


def test_both_missing_returns_none() -> None:
    assert es._prefer_trend({}, {}, "awake_seconds") is None


if __name__ == "__main__":
    test_zero_trend_value_not_overwritten_by_interval()
    test_missing_trend_falls_through_to_interval()
    test_none_trend_value_falls_through()
    test_both_missing_returns_none()
    print("OK — eight_sleep zero-preservation tests passed.")
