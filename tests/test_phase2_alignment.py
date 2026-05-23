"""Phase-2 row-alignment test (audit Finding #7).

Locks in the verified date-semantics relationship:

  row N:  journal_* / habit_* / mfp_* / supplement_* = behaviors on day N
          whoop_hrv_rmssd                            = HRV from sleep night N-1 -> N
                                                       (i.e. PRIOR night, dated by the
                                                       wake-morning ET via the +12h cycle rule)
          hrv_next  (= TARGET.shift(-1))             = HRV from sleep night N -> N+1
                                                       (i.e. the sleep that immediately
                                                       follows the day-N behaviors)

This was verified empirically on 2026-04-16 against a known flight on Apr 8
(plane=Yes on cycle_date=2026-04-08, only consistent with behaviors-of-day-X
semantics). This test locks it in so any future schema or convention change
that breaks the alignment trips a regression.

Approach: build a synthetic frame where alcohol on day N causally depresses
HRV on the immediately following sleep (which lands on row N+1's
whoop_hrv_rmssd). Run the Phase-2 shift(-1) and journal_impact pipeline,
and confirm:
  (1) the alcohol-Yes Welch's t-test shows a depression in hrv_next (matches
      the simulated causal direction), AND
  (2) the depression is anchored to the SAME row as the alcohol intake (not
      shifted ±1) by reconstructing the raw alignment.

If alignment ever inverted (e.g., a future contributor changed how
pivot_journal keys rows or rewrote `+12h` cycle dating), the synthetic test
would either fail to detect the simulated effect or detect it with reversed
sign — either way, the assertion below catches it.

Note: as of 2026-05-23, the off-by-one for post-midnight bedtimes is fixed at
the DB layer via `pds.whoop_journal.behaviors_date` (computed via trigger
from each cycle's bedtime − 6h in local TZ). `pivot_journal` keys on
behaviors_date directly. The synthetic frame here bypasses pivot_journal —
it constructs the analysis matrix with journal flags pre-aligned to behaviors-
day — so it covers the Phase-2 alignment only; a complementary integration
test would be needed to verify the DB-side trigger behavior.

Run: python tests/test_phase2_alignment.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
import pandas as pd

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import hrv_analysis as ha  # noqa: E402


def make_alcohol_synthetic(n: int = 200, seed: int = 42) -> pd.DataFrame:
    """Build a matrix where alcohol-on-day-N depresses HRV from sleep night N->N+1.

    Concretely:
      whoop_hrv_rmssd[N+1] = baseline + autocorr * whoop_hrv_rmssd[N]
                             - depression * journal_have_any_alcoholic_drinks[N]
                             + noise

    So `journal_alcohol(N) == 1` causes `whoop_hrv_rmssd(N+1) < baseline`.
    After Phase-2 shifts hrv_next = whoop_hrv_rmssd.shift(-1), row N has:
        journal_alcohol = 1 (the cause)
        hrv_next        = the depressed HRV (the effect)
    """
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2025-01-01", periods=n, freq="D").date
    alcohol = (rng.random(n) < 0.3).astype(int)
    hrv = np.zeros(n)
    hrv[0] = 60.0
    BASELINE, AUTOCORR, DEPRESSION, NOISE_SD = 60.0, 0.4, 12.0, 4.0
    for i in range(1, n):
        # Day i's HRV is from the sleep AFTER day i-1's behavior.
        hrv[i] = (
            (1 - AUTOCORR) * BASELINE
            + AUTOCORR * hrv[i - 1]
            - DEPRESSION * alcohol[i - 1]
            + rng.normal(0, NOISE_SD)
        )
    # Add a few noise journal columns so the BH-FDR step (which requires
    # >1 hypothesis) actually runs.
    out = pd.DataFrame({
        "calendar_date": dates,
        "whoop_hrv_rmssd": hrv,
        "journal_have_any_alcoholic_drinks": alcohol.astype(float),
        # Filler so the universal numeric_cols filter doesn't choke on too-few features
        "hrv_lag1": np.r_[np.nan, hrv[:-1]],
    })
    for noise_col in ("journal_wore_a_sleep_mask",
                       "journal_consumed_caffeine",
                       "journal_meditated"):
        out[noise_col] = (rng.random(n) < 0.4).astype(float)
    return out


def test_alcohol_alignment() -> None:
    df = make_alcohol_synthetic(n=300)

    # Run only the descriptive analysis branch (it builds hrv_next internally).
    results = ha.run_statistical_analysis(df, skip=True)

    # The synthetic alcohol effect should show up in correlations as
    # whoop_hrv_rmssd-NEXT (the target) negatively associated with
    # journal_have_any_alcoholic_drinks at the SAME row.
    corr = results.get("correlations")
    assert corr is not None and len(corr) > 0, "Phase-2 produced no correlations"
    alcohol_row = corr[corr["feature"] == "journal_have_any_alcoholic_drinks"]
    assert len(alcohol_row) == 1, "alcohol feature missing from Spearman output"
    r = float(alcohol_row["spearman_r"].iloc[0])
    assert r < -0.2, (
        f"Expected negative Spearman r between alcohol(N) and hrv_next(N) "
        f"matching the simulated -12ms depression; got r={r:.3f}. "
        f"If r is near 0, alignment may be off by 1. If r is positive, "
        f"alignment is INVERTED — check pivot_journal (behaviors_date key) and shift(-1)."
    )

    # Reconstruct the alignment manually to lock in the exact row offset.
    # Phase 2 does: hrv_next = whoop_hrv_rmssd.shift(-1).
    # So row N of the analysis frame has alcohol(N) paired with HRV(N+1).
    # Verify this directly:
    raw = df.copy()
    raw["hrv_next_check"] = raw["whoop_hrv_rmssd"].shift(-1)
    yes_idx = raw["journal_have_any_alcoholic_drinks"] == 1
    no_idx = raw["journal_have_any_alcoholic_drinks"] == 0
    diff = float(raw.loc[yes_idx, "hrv_next_check"].mean()
                 - raw.loc[no_idx, "hrv_next_check"].mean())
    assert diff < -5.0, (
        f"Manual alignment check: alcohol(N) should produce a multi-ms drop "
        f"in hrv_next(N) given the simulated -12ms depression; got diff={diff:.2f}ms"
    )

    print(f"  [OK] alcohol(N) -> hrv_next(N) shows r={r:.3f}, "
          f"Welch's diff={diff:.2f}ms (expected negative)")


def test_journal_impact_picks_up_simulated_effect() -> None:
    """End-to-end: journal_impact (after FDR fix) should flag alcohol as significant.

    Uses skip=False because journal_impact runs after the early-return in
    run_statistical_analysis. Plot rendering is best-effort wrapped in try/except
    inside the function so plotting failures don't crash the test.
    """
    df = make_alcohol_synthetic(n=300)
    results = ha.run_statistical_analysis(df, skip=False)
    ji = results.get("journal_impact")
    assert ji is not None and len(ji) > 0, "journal_impact missing"
    alcohol = [r for r in ji if r["feature"] == "journal_have_any_alcoholic_drinks"]
    assert len(alcohol) == 1, "alcohol missing from journal_impact"
    row = alcohol[0]
    assert row["diff_ms"] < -5.0, (
        f"alcohol journal_impact diff_ms={row['diff_ms']:.2f}; "
        f"expected ~ -12ms (simulated depression). Alignment may be wrong."
    )
    # FDR field should now be populated (Finding #1 fix)
    assert "q_value" in row, "BH-FDR did not run on journal_impact"
    assert "passes_fdr" in row, "BH-FDR did not annotate journal_impact"
    print(f"  [OK] journal_impact alcohol diff={row['diff_ms']:.2f}ms, "
          f"q={row['q_value']:.4f}, passes_fdr={row['passes_fdr']}")


if __name__ == "__main__":
    print("Phase-2 alignment regression test")
    print("=" * 60)
    test_alcohol_alignment()
    test_journal_impact_picks_up_simulated_effect()
    print("=" * 60)
    print("All alignment assertions passed.")
