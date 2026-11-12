"""Why the AIPW blow-ups happened, and proof the guards still catch the bad shapes.

Context (2026-11-11): the live causal layer stored AIPW effects of -130 ms (naive +3,
PSM +6) against a nightly HRV SD of ~35 ms. PR #63 replaced the forward-only
TimeSeriesSplit cross-fit with blocked folds, trimmed (not clipped) poor-overlap days and
added the `implausible` flag. tests/test_causal_aipw_synthetic.py shows the fixed
estimator recovers known effects. This file adds the two things that test does not:

  1. ATTRIBUTION. A reference copy of the pre-#63 estimator (below) with each of the four
     changes switchable on its own, run on the same synthetic frame. It reproduces the
     blow-up (forward-only folds, clipping, zero-filled rows) and shows which change
     matters: the fold scheme. Trimming alone, a bigger minimum arm alone, or scoring
     unscored rows as NaN alone each leave a 20-50 ms miss; blocked folds alone cut it to
     ~10 ms. If someone later "simplifies" the folds back to TimeSeriesSplit this fails.
  2. PATHOLOGICAL FRAMES THROUGH THE REAL BATTERY. Treatments that cannot be estimated
     honestly (propensity almost deterministic, or one arm confined to a short stretch of
     the history) with a large TRUE effect, so that the row would pass BH-FDR if nothing
     intervened. The row must come out `implausible`, with `passes_fdr` forced False and
     `fdr_suppressed_by_plausibility` set. Existing result fields must keep their names.

Synthetic data only: no network, no credentials, no live rows.

Run: python tests/test_causal_aipw_blowup_guard.py
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LogisticRegression, Ridge  # noqa: E402
from sklearn.model_selection import TimeSeriesSplit  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

import causal_inference as ci  # noqa: E402
from test_causal_aipw_synthetic import TRUE, _arrays, make_frame  # noqa: E402

logging.disable(logging.WARNING)

SEEDS = range(5)

# Fields the frontend and the stored payload already rely on: they keep their names.
LEGACY_ROW_FIELDS = (
    "treatment", "family", "label", "kind", "naive_ate", "naive_ci_low", "naive_ci_high",
    "psm_ate", "psm_ci_low", "psm_ci_high", "aipw_ate", "aipw_ci_low", "aipw_ci_high",
    "aipw_se", "aipw_ci_low_bb", "aipw_ci_high_bb", "aipw_bb_width_ratio", "aipw_p_bb",
    "aipw_fold_failures", "aipw_n_folds", "aipw_unreliable", "e_value", "e_value_ci",
    "n_treated", "n_control", "n_total", "treatment_prevalence", "low_n", "significant",
    "direction", "pooled_outcome_sd", "p_raw", "p_fdr_adjusted", "passes_fdr",
)


# ---------------------------------------------------------------------------
# 1. Attribution: the pre-#63 estimator with each change switchable
# ---------------------------------------------------------------------------

def reference_aipw(X, T, Y, *, folds: str, min_arm: int, overlap: str, unscored: str,
                   n_folds: int = 5) -> float:
    """Pre-#63 AIPW point estimate. folds: 'forward' (TimeSeriesSplit) | 'blocked';
    overlap: 'clip' (weights up to 20) | 'trim' (drop days outside [0.05, 0.95]);
    unscored: 'zero' (rows no fold scored count as 0) | 'nan' (left out of the mean)."""
    n = len(T)
    splits = (TimeSeriesSplit(n_splits=n_folds).split(X) if folds == "forward"
              else ci._blocked_folds(n, n_folds))
    psi = np.zeros(n) if unscored == "zero" else np.full(n, np.nan)
    for tr, te in splits:
        sc = StandardScaler().fit(X[tr])
        Xt, Xv = sc.transform(X[tr]), sc.transform(X[te])
        Tt, Yt = T[tr], Y[tr]
        if Tt.sum() < min_arm or (Tt == 0).sum() < min_arm:
            continue
        e = LogisticRegression(C=1.0, max_iter=200).fit(Xt, Tt).predict_proba(Xv)[:, 1]
        m1 = Ridge(alpha=1.0).fit(Xt[Tt == 1], Yt[Tt == 1]).predict(Xv)
        m0 = Ridge(alpha=1.0).fit(Xt[Tt == 0], Yt[Tt == 0]).predict(Xv)
        ec = np.clip(e, ci.PROPENSITY_TRIM_LOW, ci.PROPENSITY_TRIM_HIGH)
        Tv, Yv = T[te], Y[te]
        p = m1 - m0 + Tv * (Yv - m1) / ec - (1 - Tv) * (Yv - m0) / (1 - ec)
        if overlap == "trim":
            keep = (e >= ci.PROPENSITY_TRIM_LOW) & (e <= ci.PROPENSITY_TRIM_HIGH)
            psi[te[keep]] = p[keep]
        else:
            psi[te] = p
    valid = psi[~np.isnan(psi)]
    return float(valid.mean()) if len(valid) else float("nan")


VARIANTS = {
    "pre-#63": dict(folds="forward", min_arm=2, overlap="clip", unscored="zero"),
    "only min_arm 10": dict(folds="forward", min_arm=10, overlap="clip", unscored="zero"),
    "only NaN unscored": dict(folds="forward", min_arm=2, overlap="clip", unscored="nan"),
    "only trimming": dict(folds="forward", min_arm=2, overlap="trim", unscored="zero"),
    "only blocked folds": dict(folds="blocked", min_arm=2, overlap="clip", unscored="zero"),
    "current": dict(folds="blocked", min_arm=ci.MIN_FOLD_ARM, overlap="trim", unscored="nan"),
}


def _errors_by_variant() -> dict[str, list[float]]:
    errs: dict[str, list[float]] = {k: [] for k in VARIANTS}
    for s in SEEDS:
        for name, (X, T, Y) in _arrays(make_frame(seed=s)).items():
            for label, kw in VARIANTS.items():
                errs[label].append(abs(reference_aipw(X, T, Y, **kw) - TRUE[name]))
    return errs


def test_blowup_reproduced_and_blocked_folds_are_what_fixes_it() -> None:
    errs = _errors_by_variant()
    mean = {k: float(np.mean(v)) for k, v in errs.items()}
    worst = {k: float(np.max(v)) for k, v in errs.items()}

    # The synthetic frame is a real reproduction: the old estimator misses by ~half an
    # HRV SD or more somewhere, and is several times worse on average than the fix.
    assert worst["pre-#63"] > 25.0, f"frame no longer reproduces the blow-up: {worst['pre-#63']:.1f}"
    assert mean["pre-#63"] > 2.0 * mean["current"], (mean["pre-#63"], mean["current"])
    assert worst["current"] <= 15.0, f"current estimator missed by {worst['current']:.1f} ms"

    # Blocked folds are the dominant cause: on their own they get almost all the way
    # there, and none of the other three changes does that on its own.
    assert worst["only blocked folds"] <= 15.0, worst["only blocked folds"]
    for other in ("only min_arm 10", "only NaN unscored", "only trimming"):
        assert worst[other] > 20.0, (other, worst[other])
        assert mean[other] > 1.3 * mean["only blocked folds"], (other, mean[other])
    print("  max |err| ms / mean |err| ms over "
          f"{len(errs['current'])} estimates:\n    " + "\n    ".join(
              f"{k:20s} {worst[k]:5.1f} / {mean[k]:5.1f}" for k in VARIANTS))


# ---------------------------------------------------------------------------
# 2. Pathological frames through the real battery
# ---------------------------------------------------------------------------

def make_pathological_frame(kind: str, seed: int = 0, n: int = 700, true_effect: float = 25.0
                            ) -> pd.DataFrame:
    """Matrix-shaped frame with ONE treatment, `journal_pathological`, that no estimator
    can read honestly, and a large true effect so the row would be significant.

      positivity : the treatment is almost deterministic in yesterday's strain
                   (propensity ~0 or ~1 for most days: nothing to compare against).
      one_armed  : ~98% of days are treated until 80% of the way through the history, so
                   the control arm exists only in the last stretch (the old early-fold shape).
    """
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    level = 125.0 - 70.0 / (1 + np.exp(-(t - 0.6 * n) / 10.0))      # HRV level drop
    dates = pd.date_range("2024-12-01", periods=n, freq="D")
    dow = dates.dayofweek.to_numpy()
    wknd = (dow >= 5).astype(float)
    strain = np.clip(rng.normal(12, 4, n) + 2 * wknd, 0, 21)
    sleep_h = np.clip(rng.normal(7.6, 0.8, n) - 0.4 * wknd, 4, 10)
    e = np.zeros(n)
    sd = 0.24 * level
    for i in range(n):
        e[i] = (0.4 * e[i - 1] if i else 0) + rng.normal(0, sd[i] * np.sqrt(1 - 0.16))
    sl1 = np.nan_to_num(np.r_[np.nan, strain[:-1]], nan=12.0)
    if kind == "positivity":
        p = 1 / (1 + np.exp(-2.5 * (sl1 - 12)))
    elif kind == "one_armed":
        p = np.where(t < 0.8 * n, 0.98, 0.5)
    else:
        raise ValueError(kind)
    treated = (rng.random(n) < p).astype(float)
    y = level + e - 0.8 * (sl1 - 12) - 5.0 * wknd + true_effect * treated

    df = pd.DataFrame({"calendar_date": dates.strftime("%Y-%m-%d"), "whoop_hrv_rmssd": y,
                       "whoop_day_strain": strain, "whoop_sleep_duration_milli": sleep_h * 3.6e6,
                       "total_training_load": np.nan})
    df["journal_pathological"] = treated
    hrv = df["whoop_hrv_rmssd"]
    df["hrv_lag1"] = hrv.shift(1)
    df["hrv_7d_mean"] = hrv.shift(1).rolling(7, min_periods=3).mean()
    df["whoop_day_strain_lag1"] = df["whoop_day_strain"].shift(1)
    df["whoop_sleep_duration_milli_lag1"] = df["whoop_sleep_duration_milli"].shift(1)
    df["rolling_7d_training_load"] = 0.0
    df["sleep_debt_7d"] = (df["whoop_sleep_duration_milli"].shift(1)
                           .rolling(7, min_periods=3).mean() - 8 * 3.6e6) / 3.6e6
    df["day_of_week"] = dow.astype(float)
    df["is_weekend"] = wknd
    return df


def _row(res: dict, name: str) -> dict:
    rows = [r for r in res["binary_treatments"] if r["treatment"] == name]
    assert len(rows) == 1, (name, [d["treatment"] for d in res.get("dropped_low_n", [])])
    return rows[0]


def test_pathological_frames_are_flagged_and_never_pass_fdr() -> None:
    seen_suppressed = 0
    for kind in ("positivity", "one_armed"):
        for seed in (0, 1):
            res = ci.run_causal_battery(make_pathological_frame(kind, seed=seed))
            r = _row(res, "journal_pathological")
            tag = f"{kind} seed {seed}"
            assert r["implausible"] is True, (tag, r["aipw_fraction_trimmed"], r["implausible_reasons"])
            assert r["implausible_reasons"], tag
            assert r["aipw_fraction_trimmed"] > ci.MAX_TRIMMED_FRACTION, tag
            assert r["passes_fdr"] is False, tag
            seen_suppressed += int(r["fdr_suppressed_by_plausibility"])
            for key in LEGACY_ROW_FIELDS:
                assert key in r, (tag, f"existing field {key!r} disappeared")
    # At least the positivity frames carry a real, significant effect (+25 ms, p ~0.002):
    # without the guard they would be reported as discoveries, and the guard says so.
    assert seen_suppressed >= 2, f"guard suppressed only {seen_suppressed} would-be discoveries"
    print(f"  4 pathological battery rows flagged implausible; {seen_suppressed} would have "
          "passed BH-FDR and were suppressed by the guard")


def test_stored_payload_is_json_safe() -> None:
    """Every field the guard adds must survive json.dumps (it is written to jsonb)."""
    import json
    res = ci.run_causal_battery(make_pathological_frame("positivity", seed=0))
    r = _row(res, "journal_pathological")
    json.dumps({k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in r.items()},
               default=str)
    assert isinstance(r["implausible"], bool) and isinstance(r["implausible_reasons"], list)
    assert all(isinstance(s, str) for s in r["implausible_reasons"])
    print("  implausible / implausible_reasons serialise as bool / list[str]")


if __name__ == "__main__":
    test_blowup_reproduced_and_blocked_folds_are_what_fixes_it()
    test_pathological_frames_are_flagged_and_never_pass_fdr()
    test_stored_payload_is_json_safe()
    print("\nOK - blow-up reproduced by the pre-#63 estimator, blocked folds identified as the "
          "dominant fix, pathological frames flagged and kept out of FDR.")
