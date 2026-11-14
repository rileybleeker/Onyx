"""Which confounders each causal treatment is actually adjusted for.

Why (2026-11-13, dot review #5): `total_training_load` is the sum of ONE day's
activities, but it was listed in ROLLING_AGGREGATE_TREATMENTS, so the adjustment
dropped last night's HRV, the 7-day HRV mean and yesterday's strain for it. Those
are fixed before the day's training happens (plain pre-treatment confounders), so
"Daily training load above median" was less adjusted than every other daily row.

Why (2026-11-13, dot review #6): the 3-day load treatment (days D-3..D-1) kept
`rolling_7d_training_load` (days D-7..D-1) as a confounder. The 7-day total contains
the whole 3-day window, so holding it fixed absorbs part of the treatment: the
estimate becomes "recent instead of older load at the same weekly total", not "a
high-load last three days". The intended estimand is written in
`ci.ROLLING_TREATMENT_ESTIMAND` and stored in the DAG payload.

These tests pin the adjustment sets through the single deciding function
(`ci.adjustment_set`) and through the production preparation path, and show on
synthetic frames with KNOWN effects what each rule changes. Synthetic data only:
no network, no credentials, no live rows.

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
LOAD_EFFECT_PER_UNIT = -0.03    # ms per unit of training load, any day of the last 7
BASELINE_FOR_ROLLING = ("whoop_sleep_duration_milli_lag1", "sleep_debt_7d",
                        "day_of_week", "is_weekend")


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


def make_rolling_frame(seed: int = 0, n: int = 700) -> pd.DataFrame:
    """Frame where every unit of training load in the last 7 days lowers tonight's
    HRV by the same amount ("load is load"), activities happen on ~60% of days
    independently of everything else (so nothing confounds the 3-day load), and
    rest days are NaN like the live matrix."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    dow = dates.dayofweek.to_numpy()
    load = pd.Series(np.where(rng.random(n) < 0.6, rng.gamma(4, 45, n), np.nan))
    l3 = load.shift(1).rolling(3, min_periods=1).sum()
    l7 = load.shift(1).rolling(7, min_periods=1).sum()
    e = np.zeros(n)
    for i in range(n):
        e[i] = (0.4 * e[i - 1] if i else 0.0) + rng.normal(0, 14)
    hrv = 90.0 + e + LOAD_EFFECT_PER_UNIT * l7.fillna(0).to_numpy()
    sleep_ms = np.clip(rng.normal(7.6, 0.8, n), 4, 10) * 3.6e6

    df = pd.DataFrame({"calendar_date": dates.strftime("%Y-%m-%d"), "whoop_hrv_rmssd": hrv,
                       "whoop_day_strain": np.clip(rng.normal(12, 4, n), 0, 21),
                       "whoop_sleep_duration_milli": sleep_ms,
                       "total_training_load": load})
    h = df["whoop_hrv_rmssd"]
    df["hrv_lag1"] = h.shift(1)
    df["hrv_7d_mean"] = h.shift(1).rolling(7, min_periods=3).mean()
    df["whoop_day_strain_lag1"] = df["whoop_day_strain"].shift(1)
    df["whoop_sleep_duration_milli_lag1"] = df["whoop_sleep_duration_milli"].shift(1)
    df["rolling_3d_training_load"] = l3
    df["rolling_7d_training_load"] = l7
    df["sleep_debt_7d"] = (df["whoop_sleep_duration_milli"].shift(1)
                           .rolling(7, min_periods=3).mean() - 8 * 3.6e6) / 3.6e6
    df["day_of_week"] = dow.astype(float)
    df["is_weekend"] = (dow >= 5).astype(float)
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
        assert set(BASELINE_FOR_ROLLING) <= used, (name, used)
    print("  rolling treatments: lagged HRV / strain mediators dropped, baseline set kept")


def test_three_day_load_drops_the_seven_day_total() -> None:
    used = ci.adjustment_set("rolling_3d_training_load", COMMON)
    assert used == BASELINE_FOR_ROLLING, used
    print(f"  rolling_3d_training_load: {list(used)}")


def test_seven_day_total_stays_where_it_does_not_contain_the_treatment() -> None:
    r7 = "rolling_7d_training_load"
    # same-day and other daily treatments: the 7-day total (D-7..D-1) is pre-treatment
    for name in ("total_training_load", "whoop_day_strain", "total_steps",
                 "journal_anything", "had_evening_workout"):
        assert r7 in ci.adjustment_set(name, COMMON), name
    # device-computed aggregates that end on day D are not contained in D-7..D-1
    for name in ("acute_training_load", "chronic_training_load", "atl_ctl_ratio"):
        assert r7 in ci.adjustment_set(name, COMMON), name
    # as its own treatment it is dropped (rule 1), leaving the same baseline set
    assert ci.adjustment_set(r7, COMMON) == BASELINE_FOR_ROLLING
    print("  rolling_7d_training_load kept for daily + device-computed treatments")


def test_window_containment_rule() -> None:
    saved = dict(ci.ROLLING_WINDOW_DAYS)
    try:
        ci.ROLLING_WINDOW_DAYS.update({"w_14d": (-14, -1), "w_2d": (-2, -1),
                                       "w_incl_today": (-6, 0)})
        assert ci._window_contains("rolling_7d_training_load", "rolling_3d_training_load")
        assert not ci._window_contains("rolling_3d_training_load", "rolling_7d_training_load")
        assert not ci._window_contains("rolling_7d_training_load", "rolling_7d_training_load")
        assert ci._window_contains("w_14d", "rolling_7d_training_load")
        assert ci._window_contains("rolling_3d_training_load", "w_2d")
        # overlapping but not containing: day D is outside D-7..D-1
        assert not ci._window_contains("rolling_7d_training_load", "w_incl_today")
        # undeclared columns never match
        assert not ci._window_contains("sleep_debt_7d", "rolling_3d_training_load")
        assert not ci._window_contains("rolling_7d_training_load", "total_training_load")
    finally:
        ci.ROLLING_WINDOW_DAYS.clear()
        ci.ROLLING_WINDOW_DAYS.update(saved)
    print("  containment: superset windows only; overlap alone or undeclared columns do not count")


def test_declared_windows_match_the_feature_builder() -> None:
    """ROLLING_WINDOW_DAYS restates hrv_analysis.build_feature_matrix; fail if they drift.
    Reads the source text only (importing hrv_analysis needs credentials)."""
    src = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
    for col, (first, last) in ci.ROLLING_WINDOW_DAYS.items():
        assert last == -1, (col, last)
        line = (f'df["{col}"] = df["total_training_load"].shift(1)'
                f'.rolling({-first}, min_periods=1).sum()')
        assert line in src, f"hrv_analysis.py no longer builds {col} as {line}"
    print("  declared windows match hrv_analysis.build_feature_matrix")


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
    assert rows["rolling_3d_training_load"]["confounders_used"] == list(BASELINE_FOR_ROLLING)
    dag = res["dag"]
    assert "total_training_load" not in dag["rolling_aggregate_treatments"]
    assert dag["rolling_treatment_estimand"] == ci.ROLLING_TREATMENT_ESTIMAND
    assert "total effect" in dag["rolling_treatment_estimand"]
    assert dag["rolling_window_days"] == {"rolling_3d_training_load": [-3, -1],
                                          "rolling_7d_training_load": [-7, -1]}
    assert any("rolling_7d_training_load" in m for m in dag["mediator_exclusions"])
    print("  battery rows: confounders_used matches adjustment_set; DAG states the rolling "
          "estimand and windows")


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


def test_known_effect_three_day_load_is_not_absorbed_by_the_weekly_total() -> None:
    """Every unit of load in the last week costs the same HRV. The total effect of a
    high-load last three days is then (per-unit effect) x (gap in 3-day load between
    the arms). Holding the 7-day total fixed trades recent load against older load
    and the estimate collapses toward zero; without it the effect is recovered."""
    errs_new, errs_old, shrink = [], [], []
    saved = dict(ci.ROLLING_WINDOW_DAYS)
    for seed in range(5):
        out = ci._build_outcome_frame(make_rolling_frame(seed))
        l3 = out["rolling_3d_training_load"].dropna()
        truth = LOAD_EFFECT_PER_UNIT * (l3[l3 > l3.median()].mean() - l3[l3 <= l3.median()].mean())
        new = _aipw(out, "rolling_3d_training_load")
        try:   # the pre-change behaviour: no containing-window rule
            ci.ROLLING_WINDOW_DAYS.clear()
            old = _aipw(out, "rolling_3d_training_load")
        finally:
            ci.ROLLING_WINDOW_DAYS.update(saved)
        errs_new.append(abs(new - truth))
        errs_old.append(abs(old - truth))
        shrink.append(abs(old) / abs(truth))
    mn, mo = float(np.mean(errs_new)), float(np.mean(errs_old))
    assert mn < 4.0, f"without the 7-day total the known effect is missed by {mn:.1f} ms"
    assert mo > mn + 3.0, f"with the 7-day total: {mo:.1f} ms error vs {mn:.1f} ms"
    assert float(np.mean(shrink)) < 0.5, "holding the weekly total fixed should absorb the effect"
    print(f"  known 3-day effect ~-8 ms: mean abs error {mn:.1f} ms without the 7-day total, "
          f"{mo:.1f} ms with it (estimate shrinks to {np.mean(shrink):.0%} of the truth)")


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
