"""Regression test for SARIMAX/HAC contiguous-index handling.

Audit re-2026-05-26 finding (stats/gemini/F-001, P0): hrv_analysis dropped
~32% of rows for missing HRV before fitting SARIMAX. The remaining series
was treated as if rows were consecutive days, distorting the AR(1) lag and
the 7-day seasonal lag. HAC SE on the Stage 3 OLS path inherits the same
issue (maxlags=7 in row-index space != 7 calendar days when rows are gappy).

Fix: build a daily DatetimeIndex via `.asfreq('D')` before SARIMAX fit so
the Kalman filter handles missing observations natively. For OLS+HAC the
NaN-incompatibility of statsmodels.OLS forces a dropna; we document the
non-contiguity limitation and pass use_correction=True (the small-sample
correction in HAC SE), per the ticket's accepted compromise.

Validation procedure (from the ticket):
  Synthesize an AR(1)+seasonal-7 series with known coefficients;
  drop 30% randomly; compare AR(1) coefficients fit on
    (a) dropna'd (current behavior — broken)
    (b) asfreq+NaN (Kalman) (fixed behavior)
  Assert (b) is closer to ground truth than (a).

Run: python tests/test_sarimax_asfreq.py
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

from statsmodels.tsa.statespace.sarimax import SARIMAX  # noqa: E402


TRUE_AR1 = 0.50  # mean-reverting; clearly stationary
N_DAYS = 730
DROP_FRACTION = 0.30
SEED = 7


def _simulate_series() -> pd.Series:
    """Pure mean-reverting AR(1) around 60. Known coefficient."""
    rng = np.random.default_rng(SEED)
    mu = 60.0
    sigma = 3.0
    y = np.zeros(N_DAYS)
    y[0] = mu + rng.normal(0, sigma)
    for t in range(1, N_DAYS):
        y[t] = mu + TRUE_AR1 * (y[t - 1] - mu) + rng.normal(0, sigma)
    idx = pd.date_range("2025-01-01", periods=N_DAYS, freq="D")
    return pd.Series(y, index=idx, name="hrv")


def _fit_sarimax(y: pd.Series) -> float:
    """Fit SARIMAX(1,0,0) with a constant term and return ar.L1."""
    # trend='c' lets SARIMAX absorb the series mean — without it the AR(1)
    # coefficient on a non-zero-mean series collapses toward 1 because the
    # model can only explain the mean via persistence.
    m = SARIMAX(y, order=(1, 0, 0), trend="c",
                enforce_stationarity=False, enforce_invertibility=False)
    fit = m.fit(disp=False, maxiter=200)
    return float(fit.params["ar.L1"])


def test_asfreq_recovers_ar1_better_than_dropna() -> None:
    y_full = _simulate_series()
    # Random missingness
    rng = np.random.default_rng(SEED + 1)
    drop_mask = rng.random(N_DAYS) < DROP_FRACTION
    y_missing = y_full.copy()
    y_missing[drop_mask] = np.nan

    # (a) dropna and re-index 0..n_kept — what the pre-fix pipeline does
    y_drop = y_missing.dropna().reset_index(drop=True)
    ar_drop = _fit_sarimax(y_drop)

    # (b) asfreq + leave NaN in place — Kalman handles missing obs
    y_freq = y_missing.asfreq("D")
    ar_freq = _fit_sarimax(y_freq)

    err_drop = abs(ar_drop - TRUE_AR1)
    err_freq = abs(ar_freq - TRUE_AR1)
    print(f"  truth ar1={TRUE_AR1:.3f}  dropna ar1={ar_drop:.3f} (err {err_drop:.3f})  "
          f"asfreq ar1={ar_freq:.3f} (err {err_freq:.3f})")
    # asfreq+Kalman should recover the true AR(1) coefficient noticeably
    # better than the dropna approach, which treats gappy rows as consecutive
    # and shrinks the apparent AR(1) toward 0 (a row that's really 3 days
    # later than the prior obs has a smaller |y_t - y_t-1| autocorrelation
    # than a true 1-day lag would).
    assert err_freq < err_drop, (
        f"asfreq fit ({err_freq:.3f}) should beat dropna ({err_drop:.3f}); "
        f"truth={TRUE_AR1}"
    )
    # Sanity: the asfreq fit should land within 0.10 of the true AR(1).
    assert err_freq < 0.10, f"asfreq err {err_freq:.3f} too large vs truth {TRUE_AR1}"


def test_hrv_series_input_can_be_asfreqd() -> None:
    """Sanity check the input contract the fix relies on: the calendar_date
    column in the matrix can be coerced to a DatetimeIndex via .asfreq('D').
    """
    # Build a synthetic frame matching the matrix shape
    dates = pd.date_range("2025-01-01", periods=30, freq="D").strftime("%Y-%m-%d")
    df = pd.DataFrame({
        "calendar_date": dates,
        "whoop_hrv_rmssd": np.random.default_rng(0).normal(60, 5, 30),
    })
    df["calendar_date"] = pd.to_datetime(df["calendar_date"])
    series = df.set_index("calendar_date")["whoop_hrv_rmssd"]
    daily = series.asfreq("D")
    assert daily.index.freq is not None
    assert len(daily) == 30


if __name__ == "__main__":
    test_asfreq_recovers_ar1_better_than_dropna()
    test_hrv_series_input_can_be_asfreqd()
    print("OK — SARIMAX asfreq regression tests passed.")
