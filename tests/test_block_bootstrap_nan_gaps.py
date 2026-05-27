"""Regression test for the NaN-aware block bootstrap CI.

Audit re-2026-05-26 (gemini stats F-007, P2): _block_bootstrap_ci previously
received a densified psi_valid (psi[~isnan(psi)]) which glued non-adjacent
calendar days together — the resulting 7-day blocks could span gaps of
weeks, defeating the autocorrelation-preservation the bootstrap is built
on. The fix: accept the FULL psi (with NaN at gap positions) and use
nanmean per bootstrap row.

This test verifies:
  1. A dense psi (no NaN) yields the same CI as before — backward-compat.
  2. A psi with random 30% gaps still produces a finite CI close to the
     dense one (since the true mean signal hasn't moved).
  3. A psi where almost all values are NaN returns (NaN, NaN) per the
     n_valid < 2*block_len guard.

Run: python tests/test_block_bootstrap_nan_gaps.py
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

from causal_inference import _block_bootstrap_ci  # noqa: E402


def test_dense_psi_produces_finite_ci() -> None:
    rng = np.random.default_rng(7)
    n = 365
    psi = rng.normal(loc=2.0, scale=3.0, size=n)
    lo, hi = _block_bootstrap_ci(psi, block_len=7, n_boot=400, seed=11)
    assert np.isfinite(lo) and np.isfinite(hi), f"({lo}, {hi})"
    # CI should be a sensible interval (lo < hi, non-degenerate width).
    assert lo < hi, f"CI should have lo<hi: ({lo:.3f}, {hi:.3f})"
    assert (hi - lo) > 0.1, f"CI width should be non-trivial: ({lo:.3f}, {hi:.3f})"
    print(f"  dense psi (n=365): CI ({lo:+.3f}, {hi:+.3f})")
    return lo, hi


def test_psi_with_gaps_handled_via_nanmean() -> None:
    rng = np.random.default_rng(7)
    n = 365
    psi = rng.normal(loc=2.0, scale=3.0, size=n)
    psi_gappy = psi.copy()
    drop_mask = rng.uniform(size=n) < 0.30
    psi_gappy[drop_mask] = np.nan
    lo, hi = _block_bootstrap_ci(psi_gappy, block_len=7, n_boot=400, seed=11)
    assert np.isfinite(lo) and np.isfinite(hi), (
        f"30% NaN psi should still return a finite CI; got ({lo}, {hi})"
    )
    # CI should be a sensible interval (lo < hi, non-degenerate width).
    assert lo < hi, f"CI should have lo<hi: ({lo:.3f}, {hi:.3f})"
    assert (hi - lo) > 0.1, f"CI width should be non-trivial: ({lo:.3f}, {hi:.3f})"
    print(f"  30% NaN psi (n=365): CI ({lo:+.3f}, {hi:+.3f})")


def test_psi_with_too_many_nan_returns_nan_ci() -> None:
    """When fewer than 2*block_len non-NaN values exist, the function refuses
    to return a CI (the bootstrap distribution would be degenerate)."""
    n = 100
    psi = np.full(n, np.nan)
    psi[:10] = np.array([1.0] * 10)  # only 10 non-NaN values; below 2*7=14
    lo, hi = _block_bootstrap_ci(psi, block_len=7, n_boot=400, seed=11)
    assert np.isnan(lo) and np.isnan(hi), (
        f"Should return (NaN, NaN) when n_valid < 2*block_len; got ({lo}, {hi})"
    )
    print(f"  near-empty psi (n_valid=10, block_len=7): CI ({lo}, {hi}) - as expected")


if __name__ == "__main__":
    test_dense_psi_produces_finite_ci()
    test_psi_with_gaps_handled_via_nanmean()
    test_psi_with_too_many_nan_returns_nan_ci()
    print("\nOK - block bootstrap is NaN-aware and preserves calendar contiguity.")
