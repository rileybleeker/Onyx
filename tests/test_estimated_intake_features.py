"""merge_estimated_intake_features: row placement, no double count, no zero-fill, fail-open.

Estimated kcal (Uber Eats dish estimates + photo-logged meals) on behavioral day D sits on
matrix row D, whose HRV is the sleep that closes day D (hrv_alignment.py). The value is
written only on days with no Cronometer/MFP nutrition_calories, so it never sums with the
primary nutrition source, and it is never zero-filled (no estimate = unknown, not 0).

Synthetic data only (public repo): no real dates, merchants, dishes or amounts.
The loader (load_all_data) is replaced by the frames passed straight to the merge.

Run: python tests/test_estimated_intake_features.py
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
    """Matrix spine with a Cronometer/MFP log on 01-02 and 01-07 (the mask column)."""
    days = pd.date_range("2026-01-01", "2026-01-08").strftime("%Y-%m-%d")
    calories = [np.nan, 2400.0, np.nan, np.nan, np.nan, np.nan, 1900.0, np.nan]
    return pd.DataFrame({
        "calendar_date": days,
        "whoop_hrv_rmssd": np.arange(8.0),
        "nutrition_calories": calories,
    })


def _delivery():
    return pd.DataFrame([
        {"behavioral_date": "2026-01-02", "est_kcal": 2100.0},   # logged day: masked
        {"behavioral_date": "2026-01-03", "est_kcal": 1800.0},
    ])


def _photo():
    return pd.DataFrame([
        {"behavioral_date": "2026-01-03", "est_kcal": 400.0},    # same day: sums
        {"behavioral_date": "2026-01-05", "est_kcal": 650.0},
    ])


def _merged(delivery=None, photo=None, matrix=None):
    return h.merge_estimated_intake_features(matrix if matrix is not None else _matrix(), delivery, photo) \
            .set_index("calendar_date")


def test_estimates_land_on_their_own_row_and_sum():
    out = _merged(_delivery(), _photo())
    assert len(out) == 8
    # day 01-03: delivery + photo on matrix row 01-03, summed
    assert out.loc["2026-01-03", "est_intake_kcal"] == 2200.0
    # row order and the other columns are untouched
    assert list(out.index) == list(_matrix()["calendar_date"])
    assert list(out["whoop_hrv_rmssd"]) == list(np.arange(8.0))


def test_days_logged_in_cronometer_are_never_double_counted():
    out = _merged(_delivery(), _photo())
    # 01-02 has a Cronometer log → the estimate is masked, not added
    assert np.isnan(out.loc["2026-01-02", "est_intake_kcal"])
    assert out.loc["2026-01-02", "nutrition_calories"] == 2400.0
    # a delivery-only estimate on a day with no log survives
    assert out.loc["2026-01-05", "est_intake_kcal"] == 650.0
    # a matrix with no nutrition_calories column keeps every estimate
    bare = _matrix().drop(columns=["nutrition_calories"])
    out2 = _merged(_delivery(), _photo(), matrix=bare)
    assert out2.loc["2026-01-02", "est_intake_kcal"] == 2100.0


def test_days_without_estimates_stay_nan_never_zero():
    out = _merged(_delivery(), _photo())
    # 01-01, 01-04, 01-06, 01-08: no estimate rows → unknown, never a fake 0
    for row in ("2026-01-01", "2026-01-04", "2026-01-06", "2026-01-08"):
        assert np.isnan(out.loc[row, "est_intake_kcal"])


def test_unreadable_kcal_values_are_dropped_not_zeroed():
    # an estimate that cannot be read (None / text) is unknown, not 0, and does not
    # zero out the other source's value for the same day
    delivery = pd.DataFrame([
        {"behavioral_date": "2026-01-03", "est_kcal": None},
        {"behavioral_date": "2026-01-04", "est_kcal": "n/a"},
    ])
    out = _merged(delivery, _photo())
    assert out.loc["2026-01-03", "est_intake_kcal"] == 400.0   # photo value survives
    assert np.isnan(out.loc["2026-01-04", "est_intake_kcal"])


def test_fail_open():
    m = _matrix()
    assert h.merge_estimated_intake_features(m, None, None) is m
    assert h.merge_estimated_intake_features(m, pd.DataFrame(), pd.DataFrame()) is m
    # frames missing the expected columns must not raise and must not change the matrix
    bad = pd.DataFrame({"behavioral_date": ["2026-01-03"]})
    assert h.merge_estimated_intake_features(m, bad, None) is m
    # an undated row is skipped, not fatal
    undated = pd.DataFrame([{"behavioral_date": None, "est_kcal": 100.0}])
    assert h.merge_estimated_intake_features(m, undated, None) is m


def test_est_columns_stay_out_of_the_forecast_features():
    out = h.merge_estimated_intake_features(_matrix(), _delivery(), _photo())
    out["hrv_lag1"] = out["whoop_hrv_rmssd"].shift(1)   # prepare_ml_data requires it
    out["some_other_feature"] = 1.0
    _, feat_cols, _, _ = h.prepare_ml_data(out)
    assert "some_other_feature" in feat_cols
    assert "est_intake_kcal" not in feat_cols
    assert "est_intake_kcal" in out.columns          # but the column itself survives
    # est_ sits in NOT_FORECAST_PREFIXES (the prefix rule, not a column list)
    assert "est_" in h.NOT_FORECAST_PREFIXES


def test_est_intake_is_not_a_causal_treatment():
    # Decision: exploratory Spearman only — a median split would add a second calories
    # signal next to nutrition_calories in the nutrition FDR family. Guard both files.
    import causal_inference as ci
    assert "est_intake_kcal" not in ci.CONTINUOUS_TREATMENTS
    assert "est_intake_kcal" not in ci.EXPLICIT_BINARY_TREATMENTS


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS: {name}")
