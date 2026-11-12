"""Synthetic known-effect test for the causal layer's AIPW estimator + plausibility guard.

Why (2026-11-11): the live AIPW reported -130 ms for "viewed a screen in bed" (naive
+3, PSM +6) and many more +/-50-155 ms effects against a nightly HRV SD of ~33 ms.
Rebuilt read-only from the live matrix, the cause was cross-fitting: forward-only
TimeSeriesSplit gave tiny, nearly one-armed early training folds whenever a
treatment's prevalence drifted over the history, the propensity model saturated,
clipping at 0.05/0.95 still weighted those days x20, and the never-scored first
sixth of the rows entered the mean as zeros.

This frame reproduces that shape with known effects (~700 days, an HRV level drop
from ~125 to ~55 ms late in the history, confounded binary treatments at common /
rare / windowed / recently-tracked prevalence, one continuous median-split
treatment). The old estimator misses here by up to ~40 ms and by ~10 ms on average;
the fixed one stays within the tolerances below. Synthetic data only: no network,
no credentials, no live rows.

Run: python tests/test_causal_aipw_synthetic.py
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402

logging.disable(logging.WARNING)

TRUE = {"journal_common_drift": -8.0, "journal_rare": 10.0, "journal_windowed": -6.0,
        "habit_recent": 7.0, "total_steps": 6.0}
SEEDS = range(5)
MAX_ABS_ERR = 15.0    # ms; ~0.5 SD of nightly HRV in the high era. Old estimator: ~42.
MEAN_ABS_ERR = 6.0    # ms over 5 seeds x 5 treatments. Old estimator: ~10. Fixed: ~4.


def make_frame(seed: int = 0, n: int = 700, shift: float = 70.0) -> pd.DataFrame:
    """Matrix-shaped frame: outcome + the 8 common confounders derived like
    hrv_analysis.build_feature_matrix, plus treatments with known additive effects."""
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    level = 125.0 - shift / (1 + np.exp(-(t - 0.68 * n) / 20.0))
    dates = pd.date_range("2024-12-01", periods=n, freq="D")
    dow = dates.dayofweek.to_numpy()
    wknd = (dow >= 5).astype(float)
    strain = np.clip(rng.normal(12, 4, n) + 2 * wknd, 0, 21)
    sleep_h = np.clip(rng.normal(7.6, 0.8, n) - 0.4 * wknd, 4, 10)
    load = np.where(rng.random(n) < 0.6, rng.gamma(4, 45, n), np.nan)
    e = np.zeros(n)
    sd = 0.24 * level
    for i in range(n):
        e[i] = (0.4 * e[i - 1] if i else 0) + rng.normal(0, sd[i] * np.sqrt(1 - 0.16))
    sl1 = np.nan_to_num(np.r_[np.nan, strain[:-1]], nan=12.0)
    zl1 = np.nan_to_num(np.r_[np.nan, sleep_h[:-1]], nan=7.6)
    base = level + e - 0.8 * (sl1 - 12) + 4.0 * (zl1 - 7.6) - 5.0 * wknd

    def logit(x):
        return 1 / (1 + np.exp(-x))

    # Prevalence drift: logged "yes" almost every day early on, ~60% later.
    T_c = (rng.random(n) < logit(0.4 + np.where(t < 90, 3.0, 0.0)
                                 + 0.15 * (sl1 - 12) + 0.8 * wknd)).astype(float)
    T_r = (rng.random(n) < logit(-1.9 + 0.9 * wknd - 0.48 * (zl1 - 7.6))).astype(float)
    T_w = (rng.random(n) < logit(0.2 + 0.1 * (sl1 - 12)
                                 + np.where(t < 140, 2.5, 0.0))).astype(float)
    T_h = (rng.random(n) < logit(-0.6 + 0.6 * wknd + 0.1 * (sl1 - 12))).astype(float)
    dose = np.exp(rng.normal(3 + 0.05 * (sl1 - 12), 0.5))
    above = (dose > np.median(dose)).astype(float)
    y = (base + TRUE["journal_common_drift"] * T_c + TRUE["journal_rare"] * T_r
         + TRUE["journal_windowed"] * T_w + TRUE["habit_recent"] * T_h
         + TRUE["total_steps"] * above)

    df = pd.DataFrame({"calendar_date": dates.strftime("%Y-%m-%d"), "whoop_hrv_rmssd": y,
                       "whoop_day_strain": strain, "whoop_sleep_duration_milli": sleep_h * 3.6e6,
                       "total_training_load": load})
    df["journal_common_drift"] = T_c
    df["journal_rare"] = T_r
    df["journal_windowed"] = np.where(t < 450, T_w, np.nan)      # only logged in the high era
    df["habit_recent"] = np.where(t >= 0.55 * n, T_h, np.nan)     # tracked from mid-history
    df["total_steps"] = dose
    hrv = df["whoop_hrv_rmssd"]
    df["hrv_lag1"] = hrv.shift(1)
    df["hrv_7d_mean"] = hrv.shift(1).rolling(7, min_periods=3).mean()
    df["whoop_day_strain_lag1"] = df["whoop_day_strain"].shift(1)
    df["whoop_sleep_duration_milli_lag1"] = df["whoop_sleep_duration_milli"].shift(1)
    df["rolling_7d_training_load"] = (df["total_training_load"].shift(1)
                                      .rolling(7, min_periods=1).sum())
    df["sleep_debt_7d"] = (df["whoop_sleep_duration_milli"].shift(1)
                           .rolling(7, min_periods=3).mean() - 8 * 3.6e6) / 3.6e6
    df["day_of_week"] = dow.astype(float)
    df["is_weekend"] = wknd
    return df


def _arrays(df: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """(X, T, Y) per treatment through the production preparation path."""
    out = ci._build_outcome_frame(df)
    conf = tuple(ci._confounders_for("behavior", set(out.columns)))
    res = {}
    for name in TRUE:
        kind = "continuous_median_split" if name == "total_steps" else "binary"
        spec = ci.TreatmentSpec(name=name, family="behavior", label=name,
                                confounders=conf, kind=kind)
        X, T, Y, meta = ci._prepare_treatment(out, spec)
        assert not meta.get("too_few_obs"), (name, meta)
        res[name] = (X, T, Y)
    return res


def test_blocked_folds_score_every_row_once_with_gap() -> None:
    n, gap = 103, ci.AIPW_FOLD_GAP
    seen = np.zeros(n, int)
    for tr, te in ci._blocked_folds(n, ci.N_FOLDS_AIPW, gap):
        seen[te] += 1
        assert np.all(np.diff(te) == 1), "test block must be contiguous"
        # no training row within `gap` rows of the test block
        dist = np.minimum(np.abs(tr[:, None] - te[None, :]).min(axis=1), n)
        assert dist.min() > gap, f"training row {dist.min()} rows from the test block"
        assert len(np.intersect1d(tr, te)) == 0
    assert np.all(seen == 1), "every row is scored exactly once"
    print(f"  blocked folds: every row scored once, gap {gap} rows respected")


def test_unscored_rows_are_not_zeros() -> None:
    """Large clean effect: the old estimator averaged ~1/6 zero rows in (10 -> ~8.3)."""
    rng = np.random.default_rng(3)
    n = 300
    X = rng.normal(0, 1, size=(n, 4))
    T = (rng.uniform(size=n) < 0.5).astype(int)
    Y = 60.0 + 10.0 * T + 0.5 * X[:, 0] + rng.normal(0, 0.1, n)
    out = ci.estimate_aipw(X, T, Y)
    assert abs(out["ate"] - 10.0) < 0.2, f"AIPW {out['ate']:.3f} != 10 (zero-filled rows?)"
    print(f"  clean effect 10.0 recovered as {out['ate']:.3f}")


def test_known_effects_recovered_under_drift_and_level_shift() -> None:
    errs = []
    for s in SEEDS:
        for name, (X, T, Y) in _arrays(make_frame(seed=s)).items():
            res = ci.estimate_aipw(X, T, Y)
            err = res["ate"] - TRUE[name]
            errs.append(abs(err))
            assert abs(err) <= MAX_ABS_ERR, (
                f"seed {s} {name}: AIPW {res['ate']:+.1f} vs true {TRUE[name]:+.1f} "
                f"(|err| {abs(err):.1f} > {MAX_ABS_ERR})")
    mean_err = float(np.mean(errs))
    assert mean_err <= MEAN_ABS_ERR, f"mean |err| {mean_err:.1f} > {MEAN_ABS_ERR}"
    print(f"  {len(errs)} estimates: max |err| {max(errs):.1f} ms, mean {mean_err:.1f} ms")


def test_plausibility_rules() -> None:
    ok = {"aipw_ate": 6.0, "naive_ate": 3.0, "psm_ate": 5.0, "pooled_outcome_sd": 33.0,
          "aipw_fraction_trimmed": 0.1, "aipw_fold_failures": 0, "aipw_n_folds": 5}
    assert ci.plausibility_flags(ok) == {"implausible": False, "implausible_reasons": []}
    # The live shape that triggered this: -130 ms vs naive +3 / PSM +6, SD 36.
    blow = {**ok, "aipw_ate": -129.9, "naive_ate": 3.0, "psm_ate": 5.9, "pooled_outcome_sd": 35.8}
    f = ci.plausibility_flags(blow)
    # Same literals as frontend/scripts/test-causal-plausibility.mjs (the UI fallback).
    assert f == {"implausible": True, "implausible_reasons": [
        "AIPW -130 ms is larger than one SD of nightly HRV (36 ms)",
        "AIPW -130 ms is more than 18 ms from both naive (+3) and PSM (+6)",
    ]}, f
    # Within 1 SD but far from both simpler estimators.
    far = {**ok, "aipw_ate": -29.0, "naive_ate": 4.9, "psm_ate": -5.1, "pooled_outcome_sd": 38.2}
    assert ci.plausibility_flags(far)["implausible"]
    # Far from naive but agrees with PSM: confounding, not a blow-up.
    conf = {**ok, "aipw_ate": -20.0, "naive_ate": 5.0, "psm_ate": -17.0}
    assert not ci.plausibility_flags(conf)["implausible"]
    # Missing PSM: the disagreement rule needs both, the SD rule still applies.
    assert not ci.plausibility_flags({**conf, "psm_ate": None})["implausible"]
    assert ci.plausibility_flags({**ok, "aipw_ate": 40.0, "psm_ate": None})["implausible"]
    assert ci.plausibility_flags({**ok, "aipw_fraction_trimmed": 0.6})["implausible"]
    assert ci.plausibility_flags({**ok, "aipw_fold_failures": 3})["implausible"]
    print("  plausibility rules: SD bound, double disagreement, overlap, fold failures")


def test_battery_end_to_end() -> None:
    res = ci.run_causal_battery(make_frame(seed=0))
    rows = {r["treatment"]: r for r in res["binary_treatments"] + res["continuous_treatments"]}
    for name, truth in TRUE.items():
        r = rows[name]
        assert abs(r["aipw_ate"] - truth) <= MAX_ABS_ERR, (name, r["aipw_ate"], truth)
        assert r["implausible"] is False, (name, r["implausible_reasons"])
        for key in ("aipw_n_used", "aipw_n_trimmed", "aipw_fraction_trimmed", "implausible_reasons",
                    "fdr_suppressed_by_plausibility"):
            assert key in r, (name, key)
    for r in rows.values():
        assert not (r["implausible"] and r["passes_fdr"]), r["treatment"]
    assert res["meta"]["plausibility_guard"]["max_abs_ate_sd"] == ci.PLAUSIBLE_MAX_ATE_SD
    print("  battery: " + ", ".join(f"{k} {rows[k]['aipw_ate']:+.1f} (true {v:+.0f})"
                                    for k, v in TRUE.items()))


if __name__ == "__main__":
    test_blocked_folds_score_every_row_once_with_gap()
    test_unscored_rows_are_not_zeros()
    test_known_effects_recovered_under_drift_and_level_shift()
    test_plausibility_rules()
    test_battery_end_to_end()
    print("\nOK - AIPW recovers known effects on a drifting, level-shifted synthetic frame; "
          "plausibility guard verified.")
