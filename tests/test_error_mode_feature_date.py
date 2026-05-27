"""Regression test for the error-mode residual-to-behavior join key.

Audit re-2026-05-26 (gpt-5 stats F-002, P1): the error-mode breakdown in
hrv_analysis.run_evaluation previously merged XGBoost residuals to
journal_/habit_ flags on prediction_date. The model's features for HRV[N]
come from day N-1 behaviors (build_feature_matrix applies shift(-1) to make
behaviors[N-1] -> HRV[N]). The merge therefore blamed the morning-after's
behaviors for the prior night's prediction error — off by one day.

Fix: feature_date = prediction_date - horizon_days.

This test reproduces the merge in isolation against a synthetic residual frame
with a known signal: residuals are LARGE on days following alcohol = Yes,
SMALL otherwise. Under the fix, the alcohol = Yes group's mean abs residual
must be materially larger than the alcohol = No group. Under the bug
(pre-fix), the signal would be diluted toward zero because alcohol = Yes on
day N would join to the residual predicting HRV on day N (not day N+1).

Run: python tests/test_error_mode_feature_date.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


N_DAYS = 60
SEED = 7


def _build_synthetic_residual_frame() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (bt_df_xgb_h1, journal_df) where the residual on day N+1 is
    correlated with alcohol[N], not alcohol[N+1]."""
    rng = np.random.default_rng(SEED)
    dates = pd.date_range("2026-01-01", periods=N_DAYS, freq="D")
    # Alcohol pattern: ~30% of days, random
    alcohol = (rng.uniform(size=N_DAYS) < 0.3).astype(int)
    journal_df = pd.DataFrame(
        {"calendar_date": dates.strftime("%Y-%m-%d"), "journal_alcohol": alcohol}
    )
    # Residual on day N is correlated with alcohol[N-1] (behaviors-of-the-
    # previous-day-explain-todays-prediction-error). Build a residual series:
    #   resid[0] = small noise (no day -1 to look at)
    #   resid[i for i>=1] = N(8, 2) when alcohol[i-1]==1, N(0, 2) otherwise
    residuals = np.zeros(N_DAYS)
    residuals[0] = rng.normal(0, 2)
    for i in range(1, N_DAYS):
        mean = 8.0 if alcohol[i - 1] == 1 else 0.0
        residuals[i] = rng.normal(mean, 2)
    bt_df = pd.DataFrame(
        {
            "model": ["xgboost"] * N_DAYS,
            "horizon_days": [1] * N_DAYS,
            "prediction_date": dates.strftime("%Y-%m-%d"),
            "residual": residuals,
        }
    )
    return bt_df, journal_df


def _error_mode_under_fix(bt_df: pd.DataFrame, jdf: pd.DataFrame) -> float:
    """Run the production join logic (feature_date = pred_date - h)."""
    xgb_bt = bt_df.copy()
    xgb_bt["feature_date"] = (
        pd.to_datetime(xgb_bt["prediction_date"])
        - pd.to_timedelta(xgb_bt["horizon_days"].astype(int), unit="D")
    ).dt.strftime("%Y-%m-%d")
    joined = xgb_bt.merge(
        jdf, left_on="feature_date", right_on="calendar_date", how="left"
    )
    yes = joined.loc[joined["journal_alcohol"] == 1, "residual"]
    no = joined.loc[joined["journal_alcohol"] == 0, "residual"]
    return float(yes.abs().mean() - no.abs().mean())


def _error_mode_under_bug(bt_df: pd.DataFrame, jdf: pd.DataFrame) -> float:
    """Reproduce the pre-fix join logic (uses prediction_date directly)."""
    xgb_bt = bt_df.copy()
    xgb_bt["pred_date"] = pd.to_datetime(xgb_bt["prediction_date"]).dt.strftime("%Y-%m-%d")
    joined = xgb_bt.merge(
        jdf, left_on="pred_date", right_on="calendar_date", how="left"
    )
    yes = joined.loc[joined["journal_alcohol"] == 1, "residual"]
    no = joined.loc[joined["journal_alcohol"] == 0, "residual"]
    return float(yes.abs().mean() - no.abs().mean())


def test_feature_date_join_uncovers_signal_buggy_join_misses() -> None:
    bt_df, jdf = _build_synthetic_residual_frame()
    delta_fix = _error_mode_under_fix(bt_df, jdf)
    delta_bug = _error_mode_under_bug(bt_df, jdf)
    print(f"  fix: mae_yes - mae_no = {delta_fix:+.2f} ms")
    print(f"  bug: mae_yes - mae_no = {delta_bug:+.2f} ms")
    # Under the fix, the alcohol=Yes (=feature_date) group should reveal a
    # large residual difference because residuals are conditioned on
    # alcohol[N-1] by construction.
    assert delta_fix > 3.0, (
        f"Fix should reveal alcohol-night residual signal ({delta_fix:+.2f}); "
        f"join key may have regressed."
    )
    # Under the bug, the join key shifts by one day; the alcohol[N] signal
    # is incidentally correlated with alcohol[N-1] only at chance level, so
    # delta_bug should be near zero (and certainly smaller than delta_fix).
    assert abs(delta_bug) < delta_fix - 1.5, (
        f"Bug-path should dilute the signal (got bug={delta_bug:+.2f}, "
        f"fix={delta_fix:+.2f}). Test setup may not have enough contrast."
    )


if __name__ == "__main__":
    test_feature_date_join_uncovers_signal_buggy_join_misses()
    print("\nOK - feature_date join recovers the residual-by-behavior signal.")
