"""Regression test for confounder-ffill ordering in the causal layer.

Audit re-2026-05-26 (deepseek stats F-003 + F-005, gemini stats F-006, P1):
`_prepare_treatment` previously dropped rows for missing outcome FIRST and
then ffilled confounders. The ffill window therefore counted "rows since the
last surviving row" rather than "actual calendar days back" — when HRV was
missing for 2 nights, a limit=2 ffill spanned 4 real days. Worse, no row-
count was logged for the rows that ultimately dropped because confounders
could not be filled.

This test:
  1. Builds a small synthetic daily-spine frame with a known pattern of
     missing HRV (outcome) and one rolling-7d confounder that has a single
     NaN gap.
  2. Verifies that under the fix, ffill is applied to the full daily spine,
     so a row whose HRV is observed but whose confounder is at most 2 real
     calendar days past the last confounder observation is retained.
  3. Verifies the returned meta dict carries the new diagnostic fields
     n_after_outcome_drop / n_dropped_for_confounder_missing /
     fraction_dropped_confounder.

Run: python tests/test_causal_confounder_ffill.py
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

from causal_inference import _prepare_treatment, TreatmentSpec, OUTCOME_COL  # noqa: E402


def _build_frame() -> pd.DataFrame:
    """Five-day window where HRV is missing on day 2 and the rolling confounder
    is observed on days 0, 3, 4. Under the fix, days 3 and 4 should be kept
    (confounder filled from day 0 spans only 2 days within day 3, requiring
    one ffill step — within limit=2). Day 1's missing confounder should also
    fill from day 0 (1 step). Day 2 drops for missing HRV (outcome).
    """
    n = 5
    idx = pd.date_range("2026-01-01", periods=n, freq="D")
    df = pd.DataFrame(
        {
            "calendar_date": idx,
            "treat": [0, 1, 1, 0, 1],  # binary treatment, fully observed
            OUTCOME_COL: [60.0, 58.0, np.nan, 62.0, 61.0],  # day 2 missing
            "hrv_lag1": [55.0, np.nan, np.nan, 60.0, 61.0],  # gaps days 1, 2
            "hrv_7d_mean": [55.0, 56.0, 57.0, 58.0, 59.0],  # fully observed
        }
    )
    return df


def test_ffill_applied_before_outcome_drop() -> None:
    df = _build_frame()
    spec = TreatmentSpec(
        name="treat",
        family="journal",
        label="treat",
        kind="binary",
        confounders=("hrv_lag1", "hrv_7d_mean"),
        unit=None,
    )
    prep = _prepare_treatment(df, spec)
    assert prep is not None, "Expected _prepare_treatment to return data"
    X, T, Y, meta = prep
    # Day 2 must be dropped (outcome missing). Day 1's hrv_lag1 was NaN but
    # ffills from day 0 (1 step). Day 3 ffills from day 0 (2 steps, but day 2
    # is included in the limit window since it's a real calendar day under
    # the fix — limit=2 from day 0 reaches day 2 only).
    #
    # Under the fix: ffill on full daily spine BEFORE dropping outcome means
    # day 1's NaN fills from day 0 (1 step). Day 2's NaN fills from day 0
    # (2 steps — at limit). Day 3 has an observed hrv_lag1 (60.0) so no fill
    # needed. Day 4 has an observed hrv_lag1 (61.0).
    #
    # After dropping outcome NaN (day 2), kept rows are days 0, 1, 3, 4 = 4.
    assert meta["n_total"] == 4, (
        f"Expected 4 rows after fix (days 0,1,3,4 kept), got {meta['n_total']}. "
        f"meta={meta}"
    )
    # Days 0 and 3 are control (T=0), days 1 and 4 are treated (T=1).
    assert meta["n_treated"] == 2 and meta["n_control"] == 2, meta
    print("  ffill-before-outcome-drop kept 4 rows (days 0,1,3,4) — OK")


def test_meta_carries_diagnostic_fields() -> None:
    df = _build_frame()
    spec = TreatmentSpec(
        name="treat",
        family="journal",
        label="treat",
        kind="binary",
        confounders=("hrv_lag1", "hrv_7d_mean"),
        unit=None,
    )
    prep = _prepare_treatment(df, spec)
    assert prep is not None
    _, _, _, meta = prep
    for key in (
        "n_pre_drop",
        "n_after_outcome_drop",
        "n_dropped_for_confounder_missing",
        "fraction_dropped_confounder",
    ):
        assert key in meta, f"Expected diagnostic field {key!r} in meta, got {sorted(meta.keys())}"
    assert meta["n_pre_drop"] == 5, f"n_pre_drop should be 5, got {meta['n_pre_drop']}"
    assert meta["n_after_outcome_drop"] == 4, (
        f"n_after_outcome_drop should be 4 (day 2 dropped for outcome NaN), "
        f"got {meta['n_after_outcome_drop']}"
    )
    print(f"  diagnostic fields present + correct: {meta}")


def test_drop_when_ffill_limit_exceeded() -> None:
    """A confounder NaN run longer than the 2-day ffill limit should leave a
    row that still drops for confounder-missing. The diagnostic field should
    record it.
    """
    n = 7
    idx = pd.date_range("2026-01-01", periods=n, freq="D")
    df = pd.DataFrame(
        {
            "calendar_date": idx,
            "treat": [0, 1, 0, 1, 0, 1, 0],
            OUTCOME_COL: [60.0, 58.0, 59.0, 62.0, 61.0, 63.0, 60.0],
            "hrv_lag1": [55.0, np.nan, np.nan, np.nan, np.nan, 65.0, 61.0],
            "hrv_7d_mean": [55.0, 56.0, 57.0, 58.0, 59.0, 60.0, 61.0],
        }
    )
    spec = TreatmentSpec(
        name="treat",
        family="journal",
        label="treat",
        kind="binary",
        confounders=("hrv_lag1", "hrv_7d_mean"),
        unit=None,
    )
    prep = _prepare_treatment(df, spec)
    assert prep is not None
    _, _, _, meta = prep
    # Day 0 hrv_lag1=55; days 1-2 fill from day 0 (1, 2 steps); days 3-4 are
    # 3, 4 steps from day 0 — past limit=2; they drop. Day 5 observed. Day 6
    # observed. So days 3,4 drop, kept = {0,1,2,5,6} = 5 rows.
    assert meta["n_total"] == 5, f"Expected 5 rows kept, got meta={meta}"
    assert meta["n_dropped_for_confounder_missing"] == 2, (
        f"Expected 2 rows dropped for confounder-missing (days 3,4), "
        f"got {meta['n_dropped_for_confounder_missing']}"
    )
    assert meta["fraction_dropped_confounder"] > 0.10, (
        "fraction_dropped should trip the >10% logging gate "
        f"(got {meta['fraction_dropped_confounder']:.3f})"
    )
    print(f"  ffill limit=2 exceeded for days 3-4; meta={meta}")


if __name__ == "__main__":
    test_ffill_applied_before_outcome_drop()
    test_meta_carries_diagnostic_fields()
    test_drop_when_ffill_limit_exceeded()
    print("\nOK - confounder ffill ordering + diagnostics verified")
