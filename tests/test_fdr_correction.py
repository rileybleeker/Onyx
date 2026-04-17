"""Synthetic-data unit test for the BH-FDR pipeline (audit fix #40).

Constructs a dataset where 10 of 100 features are real signal and 90 are noise,
then verifies that hrv_analysis.run_statistical_analysis (a) attaches q_value /
passes_fdr columns to the correlation table and (b) keeps roughly the right
order of magnitude of survivors. This guards against the BH step regressing.

Run: python tests/test_fdr_correction.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

# Ensure repo root importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
import pandas as pd

# Stub Supabase env so import doesn't fail at module load
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import hrv_analysis as ha  # noqa: E402


def make_synthetic(n: int = 400, n_signal: int = 10, n_noise: int = 90,
                   seed: int = 42) -> pd.DataFrame:
    """Build a frame where signal_* correlates with NEXT-day target.

    `run_statistical_analysis` shifts TARGET by -1 internally (`hrv_next[i] =
    TARGET[i+1]`), so a feature at row i must be correlated with TARGET[i+1] —
    i.e., it must lead the target by one day — to be detectable.

    Construction: draw a (n+1)-long target spine. Row i in the dataframe holds
    TARGET = spine[i] and signal[i] = beta * spine[i+1] + noise.
    """
    rng = np.random.default_rng(seed)
    spine = rng.normal(120, 30, n + 1).astype(float)
    target = spine[:-1].copy()
    next_target = spine[1:]
    cols = {ha.TARGET: target,
            "calendar_date": pd.date_range("2024-01-01", periods=n).astype(str)}
    for i in range(n_signal):
        beta = rng.uniform(0.3, 0.8) * (1 if i % 2 == 0 else -1)
        cols[f"signal_{i:02d}"] = beta * next_target + rng.normal(0, 8, n)
    for i in range(n_noise):
        cols[f"noise_{i:02d}"] = rng.normal(0, 1, n)
    return pd.DataFrame(cols)


def main() -> int:
    df = make_synthetic()
    res = ha.run_statistical_analysis(df, skip=True)
    assert "correlations" in res, "no correlations returned"
    corr = res["correlations"]
    assert "q_value" in corr.columns, "q_value column missing — BH-FDR not applied"
    assert "passes_fdr" in corr.columns, "passes_fdr column missing"
    n_total = len(corr)
    n_pass = int(corr["passes_fdr"].sum())
    n_signal_pass = int(corr.loc[corr["feature"].str.startswith("signal_"), "passes_fdr"].sum())
    n_noise_pass = int(corr.loc[corr["feature"].str.startswith("noise_"), "passes_fdr"].sum())
    print(f"Total features tested:   {n_total}")
    print(f"FDR survivors (q<=0.05): {n_pass}")
    print(f"  signal survivors:      {n_signal_pass} / 10")
    print(f"  noise survivors:       {n_noise_pass} / 90  (FDR target: <= ~5)")
    # Power check: should catch most real signal
    assert n_signal_pass >= 7, f"FDR too aggressive: only {n_signal_pass}/10 signal survived"
    # Calibration check: false-discovery rate should be low.
    # With BH at q=0.05 we expect E[FDR] <= 0.05 over many runs; allow generous slack.
    if n_pass > 0:
        fdr_observed = n_noise_pass / n_pass
        assert fdr_observed <= 0.20, f"observed FDR={fdr_observed:.2f} too high"
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
