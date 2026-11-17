"""merge_screen_time_features: same-row placement, partial days left NaN, no zero-fill, alignment rules,
and the export completeness contract (PIPE-11): a day or a sleep-anchored estimate counts only when the
view's completeness flags are literally True. Synthetic rows only.

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


def _row(day, total, synced, social=30.0, **over):
    # Sleep onset 01:00 ET (06:00Z in January) the night that closes the day; a complete export
    # backs the day and both sleep windows unless a test says otherwise.
    onset = (pd.Timestamp(day) + pd.Timedelta(days=1, hours=6)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    row = {"behavioral_date": day, "total_minutes": total, "late_night_minutes": 40.0,
           "after_midnight_minutes": 10.0, "pickups": 50, "notifications": 60,
           "minutes_by_category": {"Social": social, "Other": 5.0},
           "minutes_last_hour_before_sleep_est": 20.0, "minutes_during_sleep_est": 3.0,
           "synced_at": synced, "sleep_start": onset,
           "export_complete": True, "pre_sleep_complete": True, "during_sleep_complete": True}
    row.update(over)
    return row


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


def test_completeness_flags_decide_not_the_upload_time():
    """PIPE-11: every row below was synced the next morning, so the old time rule alone passes them."""
    synced = "2026-01-03T15:00:00+00:00"
    screen = pd.DataFrame([
        _row("2026-01-02", 300.0, synced),                                   # complete
        _row("2026-01-03", 120.0, "2026-01-04T15:00:00+00:00",               # older app build
             export_complete=False, pre_sleep_complete=False, during_sleep_complete=False),
        _row("2026-01-04", 200.0, "2026-01-05T15:00:00+00:00", export_complete=None),  # NULL in the view
        _row("2026-01-05", 210.0, "2026-01-06T15:00:00+00:00", export_complete="true"),  # not a literal True
    ])
    by = h.merge_screen_time_features(_matrix(), screen).set_index("calendar_date")
    assert by.loc["2026-01-02", "screen_total_min"] == 300.0
    for day in ("2026-01-03", "2026-01-04", "2026-01-05"):
        for col in (*h.SCREEN_COLS, "screen_social_min"):
            assert np.isnan(by.loc[day, col]), f"{day} {col} must stay NaN"


def test_missing_flag_column_means_nothing_is_complete():
    screen = pd.DataFrame([_row("2026-01-02", 300.0, "2026-01-03T15:00:00+00:00")]).drop(
        columns=["export_complete", "pre_sleep_complete", "during_sleep_complete"])
    out = h.merge_screen_time_features(_matrix(), screen)
    assert out["screen_total_min"].isna().all()


def test_sleep_windows_are_gated_separately_and_never_zero_filled():
    synced = "2026-01-03T15:00:00+00:00"
    no_pre = pd.DataFrame([_row("2026-01-02", 300.0, synced, pre_sleep_complete=False,
                                minutes_last_hour_before_sleep_est=0.0)])
    by = h.merge_screen_time_features(_matrix(), no_pre).set_index("calendar_date")
    assert by.loc["2026-01-02", "screen_total_min"] == 300.0, "the day itself is complete"
    assert np.isnan(by.loc["2026-01-02", "screen_last_hour_before_sleep_min"]), "unknown, not 0"
    assert by.loc["2026-01-02", "screen_during_sleep_min"] == 3.0

    no_during = pd.DataFrame([_row("2026-01-02", 300.0, synced, during_sleep_complete=False)])
    by = h.merge_screen_time_features(_matrix(), no_during).set_index("calendar_date")
    assert by.loc["2026-01-02", "screen_last_hour_before_sleep_min"] == 20.0
    assert np.isnan(by.loc["2026-01-02", "screen_during_sleep_min"])

    # Synced less than an hour after sleep onset (onset 06:00Z, sync 06:30Z is before the day ended anyway,
    # so use a late onset): the hour straddling onset may not have been sent.
    late = pd.DataFrame([_row("2026-01-02", 300.0, "2026-01-03T15:00:00+00:00",
                              sleep_start="2026-01-03T14:30:00+00:00")])
    by = h.merge_screen_time_features(_matrix(), late).set_index("calendar_date")
    assert np.isnan(by.loc["2026-01-02", "screen_last_hour_before_sleep_min"])
    assert np.isnan(by.loc["2026-01-02", "screen_during_sleep_min"])

    no_sleep = pd.DataFrame([_row("2026-01-02", 300.0, synced, sleep_start=None)])
    by = h.merge_screen_time_features(_matrix(), no_sleep).set_index("calendar_date")
    assert np.isnan(by.loc["2026-01-02", "screen_last_hour_before_sleep_min"])
    assert by.loc["2026-01-02", "screen_total_min"] == 300.0


def test_loader_selects_the_completeness_columns():
    src = (Path(__file__).resolve().parent.parent / "hrv_analysis.py").read_text(encoding="utf-8")
    block = src[src.index('"phone_usage_daily",'):src.index("phone_usage_daily load failed")]
    for col in ("export_complete", "pre_sleep_complete", "during_sleep_complete", "sleep_start", "synced_at"):
        assert col in block, col


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
