"""merge_pc_activity_features: same-row placement, the synced-after-day-end+1h completeness rule,
no zero-fill, no per-program columns, and the causal/forecast registration. Synthetic rows only.

Run: python tests/test_pc_activity_features.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402
import hrv_analysis as h  # noqa: E402


def _matrix():
    days = pd.date_range("2026-01-01", "2026-01-06").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(6.0)})


def _row(day, active, late, synced):
    return {"behavioral_date": day, "active_minutes": active,
            "late_active_minutes": late, "synced_at": synced}


def _pc():
    return pd.DataFrame([
        # synced the next morning (10 AM ET = 15:00Z, past the 07:00 ET bar): complete
        _row("2026-01-02", 300.0, 45.0, "2026-01-03T15:00:00+00:00"),
        # synced 06:30 ET on 01-04, an hour before day 01-03's 07:00 ET bar: NaN
        _row("2026-01-03", 120.0, 10.0, "2026-01-04T11:30:00+00:00"),
        # complete, no late use at all → a real 0
        _row("2026-01-04", 200.0, 0.0, "2026-01-06T15:00:00+00:00"),
    ])


def test_same_row_and_completeness():
    out = h.merge_pc_activity_features(_matrix(), _pc())
    by = out.set_index("calendar_date")
    assert len(out) == 6
    assert by.loc["2026-01-02", "pc_active_min"] == 300.0
    assert by.loc["2026-01-02", "pc_late_min"] == 45.0
    assert np.isnan(by.loc["2026-01-03", "pc_active_min"]), "unsynced day must stay NaN"
    assert by.loc["2026-01-04", "pc_late_min"] == 0.0, "a real 0 stays 0"
    # days the logger never ran are NaN, never zero
    assert np.isnan(by.loc["2026-01-01", "pc_active_min"])
    assert np.isnan(by.loc["2026-01-06", "pc_late_min"])


def test_one_hour_past_day_end():
    """The bar is day end (06:00 ET next morning) + 1 h: 06:30 ET fails, 07:00 ET passes."""
    rows = pd.DataFrame([
        _row("2026-01-02", 100.0, 5.0, "2026-01-03T11:30:00+00:00"),  # 06:30 ET: too early
        _row("2026-01-03", 110.0, 6.0, "2026-01-04T12:00:00+00:00"),  # 07:00 ET: passes
    ])
    by = h.merge_pc_activity_features(_matrix(), rows).set_index("calendar_date")
    assert np.isnan(by.loc["2026-01-02", "pc_active_min"])
    assert by.loc["2026-01-03", "pc_active_min"] == 110.0


def test_no_per_program_columns():
    out = h.merge_pc_activity_features(_matrix(), _pc())
    assert set(h.PC_ACTIVITY_COLS) == {"pc_active_min", "pc_late_min"}
    assert not [c for c in out.columns if c.startswith("pc_") and c not in h.PC_ACTIVITY_COLS]
    src = (Path(__file__).resolve().parent.parent / "hrv_analysis.py").read_text(encoding="utf-8")
    block = src[src.index("PC_ACTIVITY_COLS = {"):src.index("AQI_COLS = {")]
    assert "minutes_by_app" not in block, "per-program columns must not reach the pipeline"
    # the loader never requests the per-program maps either
    loader = src[src.index('"pc_activity_daily",'):src.index("pc_activity_daily load failed")]
    assert "minutes_by_app" not in loader


def test_registration():
    assert "pc_" in h.NOT_FORECAST_PREFIXES
    cont = [t[0] for t in ci.CONTINUOUS_TREATMENTS]
    assert "pc_late_min" in cont
    assert "pc_active_min" not in cont, "only the late total is a treatment"
    families = {t[0]: t[1] for t in ci.CONTINUOUS_TREATMENTS}
    assert families["pc_late_min"] == "behavior"


def test_fail_open():
    m = _matrix()
    assert h.merge_pc_activity_features(m, None) is m
    assert h.merge_pc_activity_features(m, pd.DataFrame()) is m
    bad = pd.DataFrame([{"behavioral_date": "2026-01-02"}])  # missing columns
    assert h.merge_pc_activity_features(m, bad).equals(m)


def test_duplicate_days_keep_one_row():
    rows = pd.DataFrame([
        _row("2026-01-02", 100.0, 5.0, "2026-01-03T15:00:00+00:00"),
        _row("2026-01-02", 140.0, 7.0, "2026-01-03T16:00:00+00:00"),  # later re-upload
    ])
    out = h.merge_pc_activity_features(_matrix(), rows)
    assert len(out) == 6, "the merge must never change the row count"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
