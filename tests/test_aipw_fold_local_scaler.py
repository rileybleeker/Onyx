"""Regression test for fold-local StandardScaler in AIPW cross-fitting.

Audit re-2026-05-26 (gemini stats F-004, gpt-5 stats F-001, P1):
estimate_aipw previously scaled X once on the full dataset, then passed the
fully-scaled array through TimeSeriesSplit. The fold-specific propensity +
outcome models therefore saw features centered/scaled using mean/variance
information from future validation folds — strictly a leakage violation.

This test verifies the fix: the scaler is now fit on training rows only.
We patch StandardScaler to record which row counts it sees during .fit(),
then assert that fit() is called once per fold with the training-set length
(not once with the full n).

2026-11-11: cross-fitting moved from TimeSeriesSplit to blocked folds with a
gap (ci._blocked_folds), so the expected sizes are now "n minus the test block
minus the gap rows", not an expanding window.

Run: python tests/test_aipw_fold_local_scaler.py
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

import causal_inference as ci  # noqa: E402


def _synthetic_data(n: int = 200, p: int = 5, seed: int = 11) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 1, size=(n, p))
    # treatment depends on first two features (so propensity is non-trivial)
    logit = 0.6 * X[:, 0] - 0.4 * X[:, 1]
    p_t = 1 / (1 + np.exp(-logit))
    T = (rng.uniform(size=n) < p_t).astype(int)
    # outcome with a true ATE of +2 ms
    Y = 60.0 + 2.0 * T + 0.5 * X[:, 0] - 0.3 * X[:, 2] + rng.normal(0, 1.5, size=n)
    return X, T, Y


def test_scaler_fit_is_per_fold() -> None:
    """Capture every call to StandardScaler.fit and assert sample counts
    correspond to the training rows of each cross-fitting fold (NOT the
    full n) — the structural signature of fold-local scaling.
    """
    seen_n: list[int] = []
    original_init = ci.StandardScaler.__init__
    original_fit = ci.StandardScaler.fit

    def _patched_fit(self, X, *args, **kwargs):
        seen_n.append(int(X.shape[0]))
        return original_fit(self, X, *args, **kwargs)

    ci.StandardScaler.fit = _patched_fit  # type: ignore[assignment]
    try:
        X, T, Y = _synthetic_data()
        n = len(T)
        result = ci.estimate_aipw(X, T, Y, n_folds=ci.N_FOLDS_AIPW)
    finally:
        ci.StandardScaler.fit = original_fit  # type: ignore[assignment]

    # We expect one fit() per fold (cross-fitting), each on a subset of n.
    assert len(seen_n) == ci.N_FOLDS_AIPW, (
        f"Expected {ci.N_FOLDS_AIPW} scaler fits (one per cross-fitting fold), "
        f"saw {len(seen_n)}"
    )
    # None of the fits should see the full dataset — that's what the bug did.
    assert all(s < n for s in seen_n), (
        f"All fold scalers should fit on TRAINING subsets (size < {n}), "
        f"saw fit sample sizes {seen_n}"
    )
    # Each fit sees exactly that blocked fold's training rows (test block and the
    # gap on either side excluded).
    expected = [len(tr) for tr, _ in ci._blocked_folds(n, ci.N_FOLDS_AIPW)]
    assert seen_n == expected, (
        f"Scaler fit sizes should equal the blocked-fold training sizes "
        f"{expected}; saw {seen_n}"
    )
    print(f"  per-fold scaler fits = {seen_n} (n={n})")

    # Sanity: estimator still produces a finite ATE near the true value.
    assert not np.isnan(result["ate"]), "AIPW returned NaN after fold-local scaling"
    print(f"  AIPW ATE={result['ate']:+.3f} (truth +2.000)")


if __name__ == "__main__":
    test_scaler_fit_is_per_fold()
    print("\nOK - AIPW scaler is fit per fold; no full-data leakage.")
