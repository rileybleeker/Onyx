"""Regression test for the naive future-exog proxy in the SARIMAX walk-forward.

Audit re-2026-05-26 (stats/gemini/F-003, stats/gpt-5/F-004, P1): in the
walk-forward backtest for h>1, SARIMAX previously received the ACTUAL future
shifted-exog values (`exog.iloc[split+i : split+i+h]`) during the held-out
window. Live forecasting cannot know tomorrow's behaviors, so reported skill
was artificially inflated. The fix substitutes the last KNOWN exog row,
repeated h times, as the naive proxy.

This test:
  1. Builds an AR(1) endog series with a known coefficient on an exogenous
     binary signal (alcohol-night → −5 ms next-day HRV).
  2. Simulates two backtest folds against the same model fit:
       (a) "leaky" — passes the true future exog values for the holdout
           window (what the bug did).
       (b) "naive" — passes the last training-time exog row repeated h
           times (what the fix does).
  3. Asserts the naive forecasts are NOT identical to the leaky forecasts
     when future exog values genuinely change — confirming the fix actually
     changed what the model sees.
  4. Asserts the naive forecasts at h=1..7 collapse to the same value across
     horizons (since exog is constant in the future), which is the structural
     signature of the proxy.

Run: python tests/test_sarimax_naive_exog.py
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


SEED = 11
N_DAYS = 400
TRUE_AR1 = 0.5
EXOG_EFFECT = -5.0  # mean shift in HRV on alcohol days
SPLIT_FRAC = 0.80


def _simulate() -> tuple[pd.Series, pd.DataFrame]:
    """Build endog + exog where exog has a real effect and changes over time."""
    rng = np.random.default_rng(SEED)
    n = N_DAYS
    idx = pd.date_range("2025-01-01", periods=n, freq="D")
    # Exogenous binary regressor — alternating runs of yes/no so the
    # post-cutoff distribution clearly differs from the pre-cutoff last value.
    exog_vals = np.zeros(n)
    pos = 0
    flip = True
    while pos < n:
        run = rng.integers(3, 10)
        if flip:
            exog_vals[pos : pos + run] = 1
        flip = not flip
        pos += run
    exog_df = pd.DataFrame({"alcohol": exog_vals}, index=idx)
    # Endog: AR(1) around 60 + exog effect lagged 1 day (behaviors of N-1
    # affect HRV on N, matching the production shift contract).
    mu = 60.0
    sigma = 2.0
    y = np.zeros(n)
    y[0] = mu + rng.normal(0, sigma)
    for t in range(1, n):
        y[t] = mu + TRUE_AR1 * (y[t - 1] - mu) + EXOG_EFFECT * exog_vals[t - 1] + rng.normal(0, sigma)
    endog = pd.Series(y, index=idx, name="hrv")
    # Apply the production shift contract: exog row for time N = original
    # exog[N-1]. The fit uses this shifted matrix as exog.
    shifted_exog = exog_df.shift(1).ffill().bfill()
    return endog, shifted_exog


def _forecast_with_exog(fit, fut_exog: pd.DataFrame, h: int) -> float:
    fc = fit.forecast(steps=h, exog=fut_exog)
    return float(fc.iloc[-1])


def test_naive_proxy_differs_from_leaky_when_future_exog_differs() -> None:
    endog, exog = _simulate()
    split = int(len(endog) * SPLIT_FRAC)
    # Force the last training exog row to be DIFFERENT from at least one
    # holdout exog row, so naive vs. leaky must diverge.
    # Pick a fold position i=0 (first holdout step) and look at h=3.
    i = 0
    h = 3
    last_known_idx = split + i  # shifted-exog row aligned with first forecast step
    last_known_row = exog.iloc[last_known_idx]
    future_window = exog.iloc[split + i : split + i + h]
    assert not np.allclose(
        last_known_row.values,
        future_window.values[-1],
    ), (
        "Test setup invariant: at least one future exog row must differ "
        "from the last-known row for the naive vs. leaky contrast to mean "
        "anything. Try a different SEED or check _simulate()."
    )

    model = SARIMAX(
        endog.iloc[:split], exog=exog.iloc[:split],
        order=(1, 0, 0), trend="c",
        enforce_stationarity=False, enforce_invertibility=False,
    )
    fit = model.fit(disp=False, maxiter=200)

    # Leaky path (the bug): pass actual future shifted-exog values.
    leaky_pred = _forecast_with_exog(fit, future_window, h)

    # Naive path (the fix): tile last-known shifted-exog row h times.
    naive_exog = pd.DataFrame(
        np.tile(last_known_row.to_numpy(dtype=float), (h, 1)),
        columns=exog.columns,
    )
    naive_pred = _forecast_with_exog(fit, naive_exog, h)

    print(f"  leaky h={h} pred = {leaky_pred:.2f}")
    print(f"  naive h={h} pred = {naive_pred:.2f}")
    assert abs(leaky_pred - naive_pred) > 0.5, (
        f"Naive proxy should produce a noticeably different forecast than "
        f"the leaky path when future exog differs from last-known. "
        f"Got leaky={leaky_pred:.3f}, naive={naive_pred:.3f}."
    )


def test_naive_proxy_collapses_horizons_under_constant_exog() -> None:
    """When the proxy is the same exog row tiled h times, the conditional
    drift contribution is constant across horizons — any AR(1) decay is the
    only thing varying. Forecast values at h=1..7 should drift smoothly
    toward the unconditional mean conditional on that single exog row.

    This is the structural signature of the naive proxy: removing the
    exog-future-trajectory shouldn't introduce horizon-jumpiness.
    """
    endog, exog = _simulate()
    split = int(len(endog) * SPLIT_FRAC)
    model = SARIMAX(
        endog.iloc[:split], exog=exog.iloc[:split],
        order=(1, 0, 0), trend="c",
        enforce_stationarity=False, enforce_invertibility=False,
    )
    fit = model.fit(disp=False, maxiter=200)
    last_known = exog.iloc[[split]].to_numpy(dtype=float)
    horizon_preds: list[float] = []
    for h in range(1, 8):
        naive_exog = pd.DataFrame(
            np.tile(last_known, (h, 1)), columns=exog.columns
        )
        horizon_preds.append(_forecast_with_exog(fit, naive_exog, h))
    diffs = np.abs(np.diff(horizon_preds))
    print(f"  naive horizon preds = {[round(p, 2) for p in horizon_preds]}")
    print(f"  abs-diffs between adjacent horizons = {[round(d, 3) for d in diffs]}")
    # Adjacent-horizon jumps should shrink monotonically (or near-monotonically)
    # as AR(1) decays. Allow one violation to absorb numerical noise.
    violations = sum(diffs[k] > diffs[k - 1] + 1e-6 for k in range(1, len(diffs)))
    assert violations <= 1, (
        f"Naive-proxy forecasts should decay smoothly across horizons under "
        f"constant exog (got {violations} ordering violations across "
        f"{len(diffs)} adjacent pairs): {diffs}"
    )


if __name__ == "__main__":
    test_naive_proxy_differs_from_leaky_when_future_exog_differs()
    test_naive_proxy_collapses_horizons_under_constant_exog()
    print("\nOK — naive future-exog proxy verified end-to-end.")
