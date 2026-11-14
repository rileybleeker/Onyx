"""Which confounders each causal treatment is actually adjusted for.

Why (2026-11-13, dot review #5): `total_training_load` is the sum of ONE day's
activities, but it was listed in ROLLING_AGGREGATE_TREATMENTS, so the adjustment
dropped last night's HRV, the 7-day HRV mean and yesterday's strain for it. Those
are fixed before the day's training happens (plain pre-treatment confounders), so
"Daily training load above median" was less adjusted than every other daily row.

These tests pin the adjustment sets through the single deciding function
(`ci.adjustment_set`) and through the production preparation path, and show on a
synthetic frame with a KNOWN effect why the full set matters for a same-day
treatment. Synthetic data only: no network, no credentials, no live rows.

Run: python tests/test_causal_adjustment_sets.py
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

COMMON = tuple(ci.COMMON_CONFOUNDERS)
MEDIATORS = {"hrv_lag1", "hrv_7d_mean", "whoop_day_strain_lag1"}
TRUE_DAILY_LOAD_EFFECT = -8.0   # ms, effect of an above-median training day


def make_frame(seed: int = 0, n: int = 700) -> pd.DataFrame:
    """Matrix-shaped frame where last night's HRV drives BOTH today's training load
    (train harder when recovered) and tonight's HRV (persistence): hrv_lag1 is a
    genuine pre-treatment confounder of the same-day load treatment."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    dow = dates.dayofweek.to_numpy()
    wknd = (dow >= 5).astype(float)
    strain = np.clip(rng.normal(12, 4, n), 0, 21)
    sleep_h = np.clip(rng.normal(7.6, 0.8, n), 4, 10)
    level, sd = 90.0, 18.0

    hrv = np.zeros(n)
    load = np.zeros(n)
    z_load = rng.normal(0, 0.45, n)
    noise = rng.normal(0, sd * 0.6, n)
    # The treatment is "load above its median", and each day's load depends on the
    # previous night's HRV, which depends on the previous day's treatment. Simulate
    # with a provisional cut and repeat until the cut is the realised median.
    cut = np.exp(5.0)
    for _ in range(4):
        prev_dev = 0.0
        for i in range(n):
            load[i] = np.exp(5.0 + 0.9 * prev_dev / sd + z_load[i])
            treated = load[i] > cut
            dev = 0.7 * prev_dev + (TRUE_DAILY_LOAD_EFFECT if treated else 0.0) + noise[i]
            hrv[i] = level + dev
            prev_dev = dev
        cut = float(np.median(load))

    df = pd.DataFrame({"calendar_date": dates.strftime("%Y-%m-%d"), "whoop_hrv_rmssd": hrv,
                       "whoop_day_strain": strain,
                       "whoop_sleep_duration_milli": sleep_h * 3.6e6,
                       "total_training_load": load})
    h = df["whoop_hrv_rmssd"]
    df["hrv_lag1"] = h.shift(1)
    df["hrv_7d_mean"] = h.shift(1).rolling(7, min_periods=3).mean()
    df["whoop_day_strain_lag1"] = df["whoop_day_strain"].shift(1)
    df["whoop_sleep_duration_milli_lag1"] = df["whoop_sleep_duration_milli"].shift(1)
    df["rolling_3d_training_load"] = (df["total_training_load"].shift(1)
                                      .rolling(3, min_periods=1).sum())
    df["rolling_7d_training_load"] = (df["total_training_load"].shift(1)
                                      .rolling(7, min_periods=1).sum())
    df["sleep_debt_7d"] = (df["whoop_sleep_duration_milli"].shift(1)
                           .rolling(7, min_periods=3).mean() - 8 * 3.6e6) / 3.6e6
    df["day_of_week"] = dow.astype(float)
    df["is_weekend"] = wknd
    return df


def _spec(name: str, out: pd.DataFrame) -> ci.TreatmentSpec:
    conf = tuple(ci._confounders_for("behavior", set(out.columns)))
    return ci.TreatmentSpec(name=name, family="behavior", label=name,
                            confounders=conf, kind="continuous_median_split")


def test_total_training_load_is_a_daily_treatment() -> None:
    assert "total_training_load" not in ci.ROLLING_AGGREGATE_TREATMENTS
    used = ci.adjustment_set("total_training_load", COMMON)
    assert used == COMMON, used
    assert MEDIATORS <= set(used)
    print("  total_training_load: full pre-treatment set, incl. hrv_lag1 / hrv_7d_mean / "
          "whoop_day_strain_lag1")


def test_every_daily_treatment_keeps_the_declared_set() -> None:
    """A treatment outside ROLLING_AGGREGATE_TREATMENTS loses nothing but itself."""
    names = [c[0] for c in ci.CONTINUOUS_TREATMENTS] + [c[0] for c in ci.EXPLICIT_BINARY_TREATMENTS]
    names += ["journal_anything", "habit_anything", "supplement_x_amount"]
    checked = 0
    for name in names:
        if name in ci.ROLLING_AGGREGATE_TREATMENTS:
            continue
        declared = COMMON + tuple(ci.SUPPLEMENT_EXTRA_CONFOUNDERS)
        assert ci.adjustment_set(name, declared) == tuple(c for c in declared if c != name), name
        checked += 1
    assert checked > 50
    print(f"  {checked} daily treatments keep their declared set")


def test_rolling_set_is_only_multi_day_aggregates() -> None:
    assert ci.ROLLING_AGGREGATE_TREATMENTS == frozenset({
        "rolling_3d_training_load", "rolling_7d_training_load",
        "acute_training_load", "chronic_training_load", "atl_ctl_ratio",
    })
    for name in ci.ROLLING_AGGREGATE_TREATMENTS:
        used = set(ci.adjustment_set(name, COMMON))
        assert not (used & MEDIATORS), (name, used)
        assert name not in used
        assert {"whoop_sleep_duration_milli_lag1", "sleep_debt_7d",
                "day_of_week", "is_weekend"} <= used, (name, used)
    print("  rolling treatments: lagged HRV / strain mediators dropped, baseline set kept")


def test_prepare_treatment_builds_x_from_the_adjustment_set() -> None:
    out = ci._build_outcome_frame(make_frame(0))
    for name in ("total_training_load", "rolling_7d_training_load"):
        spec = _spec(name, out)
        X, T, Y, meta = ci._prepare_treatment(out, spec)
        want = list(ci.adjustment_set(name, spec.confounders))
        assert meta["confounders_used"] == want, (name, meta["confounders_used"])
        # day_of_week is expanded into two cyclic columns
        assert X.shape[1] == len(want) + 1, (name, X.shape)
    print("  _prepare_treatment: X columns == adjustment_set (+1 for cyclic weekday)")


def test_battery_rows_report_the_set_actually_used() -> None:
    res = ci.run_causal_battery(make_frame(1))
    rows = {r["treatment"]: r for r in res["continuous_treatments"]}
    assert set(rows["total_training_load"]["confounders_used"]) == set(COMMON)
    assert not (set(rows["rolling_7d_training_load"]["confounders_used"]) & MEDIATORS)
    for r in rows.values():
        assert r["confounders_used"] == list(ci.adjustment_set(r["treatment"], r["confounders"]))
    assert "total_training_load" not in res["dag"]["rolling_aggregate_treatments"]
    print("  battery rows: confounders_used matches adjustment_set; DAG lists the rolling set")


def _aipw(out: pd.DataFrame, name: str) -> float:
    X, T, Y, meta = ci._prepare_treatment(out, _spec(name, out))
    assert not meta.get("too_few_obs"), meta
    return float(ci.estimate_aipw(X, T, Y)["ate"])


def test_known_effect_needs_last_nights_hrv() -> None:
    """Recovered days get harder training AND better HRV the next night. Without
    hrv_lag1 the harmful effect of a hard day is hidden; with it, it is recovered."""
    errs_full, errs_reduced = [], []
    saved = ci.ROLLING_AGGREGATE_TREATMENTS
    for seed in range(4):
        out = ci._build_outcome_frame(make_frame(seed))
        full = _aipw(out, "total_training_load")
        try:   # the pre-fix behaviour: treat the daily load as a rolling aggregate
            ci.ROLLING_AGGREGATE_TREATMENTS = saved | {"total_training_load"}
            reduced = _aipw(out, "total_training_load")
        finally:
            ci.ROLLING_AGGREGATE_TREATMENTS = saved
        errs_full.append(abs(full - TRUE_DAILY_LOAD_EFFECT))
        errs_reduced.append(abs(reduced - TRUE_DAILY_LOAD_EFFECT))
    mf, mr = float(np.mean(errs_full)), float(np.mean(errs_reduced))
    assert mf < 4.0, f"full set misses the known effect by {mf:.1f} ms on average"
    assert mr > mf + 3.0, f"reduced set should be clearly worse (full {mf:.1f}, reduced {mr:.1f})"
    print(f"  known effect {TRUE_DAILY_LOAD_EFFECT:+.0f} ms: mean abs error {mf:.1f} ms with the "
          f"full set vs {mr:.1f} ms without the lagged HRV / strain controls")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            print(f"{t.__name__}")
            t()
        except AssertionError as e:
            failed += 1
            print(f"  FAIL: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
