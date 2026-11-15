"""Environment Sweet Spot, pipeline side (hrv_analysis.py Phase 2.6).

The block pre-computes the /analytics/hrv "Environment Sweet Spot" chart for every
(input, outcome) pair and stores it as pds.hrv_analysis_results
dose_response_continuous / sweet_spot, with a confounder-adjusted version.

Covers
  * the unadjusted arithmetic: a known parabola is recovered, the statuses (too few nights,
    degenerate, flat, convex, outside the range), the bucket grid. These are the same
    analytic cases frontend/tests/sweet-spot.test.cjs runs against lib/sweet-spot.ts
    (fitQuadratic / bucketSweetSpot), so the pre-baked chart and the browser fallback agree;
    that Node test also checks the thresholds and the input / outcome tables of this block
    against the TypeScript;
  * the adjusted version: equal to the unadjusted one when the confounders are noise, removes
    a pattern that comes only from a confounder, recovers a parabola hidden by one, and is the
    least-squares mean of a regression with one intercept per bucket;
  * the confounders come from causal_inference.py and are prepared the way the causal layer
    prepares them;
  * alignment: every outcome is read from the SAME row through hrv_alignment, row order and
    date gaps do not matter, nothing in the block moves a column by row;
  * fail-open: a broken frame, a failing pair, missing confounders or a failing store never
    raise, and the payload is always plain JSON.

Synthetic data only. No network, no credentials.

Run: python tests/test_dose_response_continuous.py
"""
import inspect
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402
import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def lcg(seed: int):
    """Deterministic noise in [-1, 1): the same generator the Node test uses, so the
    synthetic data does not depend on a numpy version."""
    state = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 2 ** 31 - 1
    return nxt


def noise(seed: int, n: int) -> np.ndarray:
    rnd = lcg(seed)
    return np.array([rnd() for _ in range(n)])


def close(a, b, tol, msg="value"):
    assert a is not None and b is not None, f"{msg}: {a} vs {b}"
    assert abs(a - b) <= tol, f"{msg}: {a} vs {b} (tol {tol})"


def parabola(x):
    return -0.5 * (x - 68.0) ** 2 + 60.0


def synthetic_matrix(n: int = 260) -> pd.DataFrame:
    """A made-up feature matrix: one row per day, inputs and outcomes on the SAME row, the
    causal layer's confounders present. Shapes are chosen so every panel state occurs:
    a full chart with an adjusted version (room / bed / calories / caffeine), bars without
    a curve (meal gap: 26 nights) and no chart at all (caffeine at bedtime: 14 nights)."""
    dates = pd.date_range("2031-01-01", periods=n, freq="D")
    e = {k: noise(seed, n) for k, seed in dict(
        room=11, bed=12, kcal=13, caf=14, hrv=15, rec=16, eff=17, deep=18, strain=19,
        sleep=20, load=21, meal=22, cafbed=23, drift=24).items()}
    t = np.arange(n) / n
    drift = 6 * np.sin(2 * np.pi * t) + 2 * e["drift"]            # slow HRV drift
    # Independent of the drift, so the plain chart's peak should sit near 68 F. A confounded
    # input is tested on its own below (test_adjustment_*).
    room_c = 20 + 3.5 * e["room"]                                    # 16.5 .. 23.5 C
    bed_c = 30 + 3 * e["bed"]
    room_f = room_c * 9 / 5 + 32
    hrv = 55 + drift - 0.45 * (room_f - 68) ** 2 / 4 + 3 * e["hrv"]
    kcal = 2400 + 900 * e["kcal"]
    caf = np.where(e["caf"] > -0.2, 150 + 140 * (e["caf"] + 0.2), 0.0)
    df = pd.DataFrame({
        "calendar_date": dates.strftime("%Y-%m-%d"),
        "whoop_hrv_rmssd": hrv,
        "whoop_recovery_score": np.clip(60 + 1.2 * (hrv - 55) + 6 * e["rec"], 1, 99),
        "whoop_sleep_efficiency": 90 + 4 * e["eff"],
        "whoop_deep_sleep_milli": (95 + 20 * e["deep"]) * 60000,
        "eight_sleep_room_temp": room_c,
        "eight_sleep_bed_temp": bed_c,
        "nutrition_calories": kcal,
        "caffeine_total_mg": caf,
        "meal_last_meal_to_bedtime_min": np.where(np.arange(n) >= n - 26, 150 + 120 * e["meal"], np.nan),
        "caffeine_mg_at_bedtime": np.where(np.arange(n) >= n - 14, 20 + 18 * e["cafbed"], np.nan),
        "whoop_day_strain": 10 + 5 * e["strain"],
        "whoop_sleep_duration_milli": (7.2 + 1.1 * e["sleep"]) * 3600000,
        "total_training_load": 120 + 100 * e["load"],
    })
    # A few nights without HRV (never a night of their own) and inputs missing here and there.
    df.loc[[40, 41, 120], "whoop_hrv_rmssd"] = np.nan
    df.loc[60:75, "nutrition_calories"] = np.nan
    df.loc[0:29, "eight_sleep_room_temp"] = np.nan
    df.loc[0:29, "eight_sleep_bed_temp"] = np.nan
    # The confounders, derived the way build_feature_matrix derives them (earlier days only).
    y = df["whoop_hrv_rmssd"]
    df["hrv_lag1"] = y.shift(1)
    df["hrv_7d_mean"] = y.shift(1).rolling(7, min_periods=3).mean()
    df["whoop_day_strain_lag1"] = df["whoop_day_strain"].shift(1)
    df["whoop_sleep_duration_milli_lag1"] = df["whoop_sleep_duration_milli"].shift(1)
    df["rolling_7d_training_load"] = df["total_training_load"].shift(1).rolling(7, min_periods=1).sum()
    df["sleep_debt_7d"] = (df["whoop_sleep_duration_milli"].shift(1).rolling(7, min_periods=3).mean()
                           - 8 * 3600 * 1000) / 3600000
    dt = pd.to_datetime(df["calendar_date"])
    df["day_of_week"] = dt.dt.dayofweek.astype(float)
    df["is_weekend"] = (dt.dt.dayofweek >= 5).astype(float)
    return df


def pair_of(payload: dict, x: str, y: str) -> dict:
    return next(p for p in payload["pairs"] if p["x"] == x and p["y"] == y)


def block_source() -> str:
    src = Path(h.__file__).read_text(encoding="utf-8")
    start = src.index("# PHASE 2.6 – ENVIRONMENT SWEET SPOT")
    end = src.index("# PHASE 3 – PREDICTION MODELS")
    assert start < end
    return src[start:end]


# ---------------------------------------------------------------------------
# Unadjusted arithmetic
# ---------------------------------------------------------------------------

def test_known_parabola_is_recovered():
    x = np.linspace(60, 76, 40)
    fit = h.dose_response_fit(x, parabola(x))
    assert fit["status"] == "ok" and fit["n"] == 40
    close(fit["peak"]["x"], 68, 1e-6, "vertex x")
    close(fit["peak"]["y"], 60, 1e-6, "vertex y")
    close(fit["curve"]["a"], -0.5, 1e-8, "a")
    close(fit["curve"]["b"], 68, 1e-6, "b")
    close(fit["curve"]["c"], -2252, 1e-4, "c")
    close(fit["curve"]["r2"], 1, 1e-9, "r2")
    close(h.dose_response_predict(fit["curve"], 64), 52, 1e-6, "prediction")
    assert (fit["x_min"], fit["x_max"]) == (60.0, 76.0)
    # An exact fit has an infinite t in theory; the payload needs a finite number.
    assert math.isfinite(fit["curve"]["t"]) and fit["curve"]["t"] == -h.DOSE_T_CAP


def test_noisy_parabola_lands_near_its_vertex():
    x = np.linspace(60, 76, 120)
    fit = h.dose_response_fit(x, parabola(x) + 3 * noise(7, 120))
    assert fit["status"] == "ok"
    close(fit["peak"]["x"], 68, 0.5, "vertex x")
    close(fit["peak"]["y"], 60, 1.5, "vertex y")
    assert fit["curve"]["t"] < -h.DOSE_MIN_CURVATURE_T


def test_large_inputs_stay_numerically_stable():
    x = np.linspace(1200, 4200, 60)
    fit = h.dose_response_fit(x, -0.00001 * (x - 2600) ** 2 + 55)
    assert fit["status"] == "ok"
    close(fit["peak"]["x"], 2600, 1e-3, "vertex x")
    close(fit["peak"]["y"], 55, 1e-6, "vertex y")


def test_too_few_nights_returns_no_curve():
    assert h.DOSE_MIN_NIGHTS_FIT == 30 and h.DOSE_MIN_NIGHTS_CHART == 20
    x29 = np.linspace(60, 76, 29)
    under = h.dose_response_fit(x29, parabola(x29))
    assert (under["status"], under["curve"], under["peak"], under["n"]) == ("too_few", None, None, 29)
    x30 = np.linspace(60, 76, 30)
    assert h.dose_response_fit(x30, parabola(x30))["status"] == "ok"
    assert h.dose_response_fit([], [])["status"] == "too_few"
    # The floor of four nights holds even when a caller asks for less.
    assert h.dose_response_fit([1, 2, 3], [1, 4, 9], min_n=1)["status"] == "too_few"

    # A whole pair: under 20 nights there is no chart at all; from 20 to 29 bars without a curve.
    x19 = np.linspace(60, 76, 19)
    p19 = h.dose_response_pair(x19, parabola(x19), 2.0)
    assert (p19["n"], p19["buckets"], p19["fit"]["status"]) == (19, [], "too_few")
    assert p19["fit"]["a"] is None and p19["fit"]["peak"] is None
    x25 = np.linspace(60, 76, 25)
    p25 = h.dose_response_pair(x25, parabola(x25), 2.0)
    assert p25["n"] == 25 and len(p25["buckets"]) == 9 and p25["fit"]["status"] == "too_few"
    assert all(b["fit"] is None for b in p25["buckets"]), "no curve values without a curve"
    assert sum(b["n"] for b in p25["buckets"]) == 25


def test_statuses_without_a_peak():
    x = np.linspace(60, 76, 40)
    flat = h.dose_response_fit(x, np.full(40, 50.0))
    assert flat["status"] == "flat" and flat["peak"] is None
    close(h.dose_response_predict(flat["curve"], 70), 50, 1e-9, "flat prediction")
    line_x = np.linspace(0, 600, 40)
    line = h.dose_response_fit(line_x, 2 * line_x + 1)
    assert line["status"] == "flat" and line["peak"] is None
    close(h.dose_response_predict(line["curve"], 300), 601, 1e-6, "line prediction")
    convex = h.dose_response_fit(x, 0.5 * (x - 68) ** 2 + 40)
    assert convex["status"] == "convex" and convex["peak"] is None and convex["curve"]["a"] > 0
    rising_x = np.linspace(60, 66, 40)
    rising = h.dose_response_fit(rising_x, parabola(rising_x))
    assert rising["status"] == "outside_range" and rising["peak"] is None and rising["curve"] is not None
    falling_x = np.linspace(70, 76, 40)
    assert h.dose_response_fit(falling_x, parabola(falling_x))["status"] == "outside_range"
    two =np.array([60.0 if i % 2 else 70.0 for i in range(40)])
    assert h.dose_response_fit(two, 50 + np.arange(40) % 5)["status"] == "degenerate"
    # Pure noise: a bend that is not clear of noise never yields a peak.
    for seed in range(1, 60):
        f = h.dose_response_fit(x, 50 + 5 * noise(seed, 40))
        assert f["curve"] is not None
        if f["peak"]:
            assert abs(f["curve"]["t"]) >= h.DOSE_MIN_CURVATURE_T
        else:
            assert f["status"] != "ok"


def test_non_finite_points_are_ignored():
    x = np.linspace(60, 76, 40)
    fit = h.dose_response_fit(np.append(x, [np.nan, 1.0]), np.append(parabola(x), [1.0, np.inf]))
    assert fit["n"] == 40
    close(fit["peak"]["x"], 68, 1e-6, "vertex x")


def test_buckets():
    grid = h.dose_response_buckets([60.5, 61.9, 66, np.nan], [10, 20, 7, 1], 2)
    assert grid["size"] == 2 and grid["lo"] == 30
    assert [(b["start"], b["end"], b["n"], b["mean"]) for b in grid["buckets"]] == [
        (60, 62, 2, 15), (62, 64, 0, None), (64, 66, 0, None), (66, 68, 1, 7)]
    close(grid["buckets"][0]["sem"], math.sqrt(50) / math.sqrt(2), 1e-9, "sem")
    assert (grid["buckets"][1]["sem"], grid["buckets"][1]["sd"], grid["buckets"][3]["sem"]) == (None, None, 0)
    assert grid["buckets"][0]["mid"] == 61
    wide = h.dose_response_buckets([0, 999], [1, 2], 10, 24)
    assert wide["size"] == 80 and len(wide["buckets"]) <= 24
    assert sum(b["n"] for b in wide["buckets"]) == 2
    # Negative inputs (a meal logged after sleep onset) bucket below zero.
    neg = h.dose_response_buckets([-45, 10], [1, 3], 60)
    assert [(b["start"], b["n"]) for b in neg["buckets"]] == [(-60, 1), (0, 1)]
    assert h.dose_response_buckets([], [], 2)["buckets"] == []


# ---------------------------------------------------------------------------
# Adjusted version
# ---------------------------------------------------------------------------

def test_adjusted_equals_unadjusted_when_confounders_are_noise():
    n = 600
    x = 60 + 16 * (noise(31, n) + 1) / 2
    y = parabola(x) + 3 * noise(32, n)
    Z = np.column_stack([noise(33, n), noise(34, n), 5 + 2 * noise(35, n)])
    pair = h.dose_response_pair(x, y, 2.0, Z, np.ones(n, dtype=bool))
    adj = pair["adj"]
    assert adj["status"] == "ok" and adj["n"] == n == pair["n"]
    assert len(adj["buckets"]) == len(pair["buckets"])
    for raw_b, adj_b in zip(pair["buckets"], adj["buckets"]):
        assert adj_b["n"] == raw_b["n"]
        # Every night has its confounders, so "the same nights, as recorded" is the plain bar.
        close(adj_b["raw"], raw_b["mean"], 1e-4, "raw mean of the same nights")
        close(adj_b["mean"], raw_b["mean"], 0.25, "adjusted vs unadjusted bucket mean")
    assert adj["fit"]["status"] == pair["fit"]["status"] == "ok"
    close(adj["fit"]["peak"]["x"], pair["fit"]["peak"]["x"], 0.05, "peak x")
    close(adj["fit"]["peak"]["y"], pair["fit"]["peak"]["y"], 0.1, "peak y")
    close(adj["fit"]["a"], pair["fit"]["a"], 0.01, "curvature")


def test_adjustment_removes_a_pattern_that_only_comes_from_a_confounder():
    """The outcome depends on the confounder only; the input merely travels with it."""
    n = 500
    z = np.linspace(-1.5, 1.5, n) + 0.3 * noise(41, n)          # e.g. a slow HRV drift
    x = 68 + 3 * z + 1.5 * noise(42, n)                          # warmer room later in the year
    y = 50 + 6 * z + 1.0 * noise(43, n)                          # no effect of x at all
    pair = h.dose_response_pair(x, y, 2.0, z.reshape(-1, 1), np.ones(n, dtype=bool))
    big = [i for i, b in enumerate(pair["buckets"]) if b["n"] >= 15]
    assert len(big) >= 4
    raw = [pair["buckets"][i]["mean"] for i in big]
    adj = [pair["adj"]["buckets"][i]["mean"] for i in big]
    assert max(raw) - min(raw) > 8, f"the unadjusted bars should trend: {raw}"
    assert max(adj) - min(adj) < 1.5, f"the adjusted bars should be flat: {adj}"
    close(float(np.mean(adj)), 50, 1.0, "adjusted level = the outcome at the average confounder")
    # No sweet spot once the confounder is accounted for: the adjusted curve is flat across
    # the well-filled buckets (it is fitted jointly with the confounder).
    curve = [pair["adj"]["buckets"][i]["fit"] for i in big]
    assert None not in curve and max(curve) - min(curve) < 1.5, f"the adjusted curve should be flat: {curve}"
    assert abs(pair["adj"]["fit"]["a"]) < 0.02, pair["adj"]["fit"]


def test_adjustment_recovers_a_parabola_hidden_by_a_confounder():
    n = 500
    z = noise(51, n)
    x = 68 + 4 * z + 2.5 * noise(52, n)
    y = parabola(x) + 12 * z + 1.0 * noise(53, n)                # z pushes the outcome up with x
    Z = np.column_stack([z, noise(54, n)])
    pair = h.dose_response_pair(x, y, 2.0, Z, np.ones(n, dtype=bool))
    raw_fit, adj_fit = pair["fit"], pair["adj"]["fit"]
    assert adj_fit["status"] == "ok"
    close(adj_fit["peak"]["x"], 68, 0.3, "adjusted vertex")
    close(adj_fit["a"], -0.5, 0.03, "adjusted curvature")
    raw_vertex = -raw_fit["b"] / (2 * raw_fit["a"])
    assert abs(raw_vertex - 68) > 1.0, f"the unadjusted curve should be pulled off the truth: {raw_vertex}"
    # Bars: the outcome expected at the average confounder value.
    groups = np.floor(x / pair["size"]).astype(int) - int(round(pair["buckets"][0]["start"] / pair["size"]))
    for j, b in enumerate(pair["adj"]["buckets"]):
        if b["n"] >= 15:
            close(b["mean"], float(np.mean(parabola(x[groups == j]))) + 12 * z.mean(), 1.0, f"bucket {j}")


def test_adjusted_bars_are_least_squares_means():
    """y - Zs @ beta averaged inside a bucket equals the bucket's intercept in a regression
    of y on bucket dummies + centered confounders (the outcome at average confounders)."""
    n = 240
    x = 60 + 16 * (noise(61, n) + 1) / 2
    Z = np.column_stack([noise(62, n) + 0.05 * x, 3 * noise(63, n)])
    y = parabola(x) + 4 * Z[:, 0] - 2 * Z[:, 1] + noise(64, n)
    groups = np.floor(x / 2.0).astype(int)
    groups -= groups.min()
    y_adj = h.dose_response_adjusted_values(y, Z, groups)
    close(float(y_adj.mean()), float(y.mean()), 1e-9, "the overall mean is unchanged")
    Zs = (Z - Z.mean(axis=0)) / Z.std(axis=0)
    dummies = (groups[:, None] == np.unique(groups)[None, :]).astype(float)
    coef, *_ = np.linalg.lstsq(np.column_stack([dummies, Zs]), y, rcond=None)
    for col, g in enumerate(np.unique(groups)):
        close(float(y_adj[groups == g].mean()), float(coef[col]), 1e-8, f"bucket {g}")
    # Too little left over to estimate the slopes: no adjusted values rather than a bad fit.
    assert h.dose_response_adjusted_values(y[:14], Z[:14], groups[:14]) is None
    assert h.dose_response_adjusted_values(y, np.ones((n, 2)), groups) is None, "constant confounders"


def test_adjusted_needs_enough_complete_nights():
    assert h.DOSE_MIN_NIGHTS_ADJUSTED == ci.MIN_CONTINUOUS_N == 50
    n = 80
    x = 60 + 16 * (noise(71, n) + 1) / 2
    y = parabola(x) + noise(72, n)
    Z = np.column_stack([noise(73, n)])
    complete = np.zeros(n, dtype=bool)
    complete[:49] = True
    few = h.dose_response_pair(x, y, 2.0, Z, complete)
    assert few["adj"] == {"status": "too_few", "n": 49} and len(few["buckets"]) > 0
    complete[:50] = True
    assert h.dose_response_pair(x, y, 2.0, Z, complete)["adj"]["status"] == "ok"
    none = h.dose_response_pair(x, y, 2.0)
    assert none["adj"] == {"status": "unavailable", "n": 0}
    # Nights missing a confounder are left out of the adjusted version only.
    part = h.dose_response_pair(x, y, 2.0, Z, np.arange(n) >= 10)
    assert part["n"] == 80 and part["adj"]["n"] == 70
    assert sum(b["n"] for b in part["adj"]["buckets"]) == 70
    # Enough nights but no usable confounder (constant): "unavailable", not "too few nights".
    flat_z = h.dose_response_pair(x, y, 2.0, np.ones((n, 1)), np.ones(n, dtype=bool))
    assert flat_z["adj"] == {"status": "unavailable", "n": 80}


def test_confounders_come_from_the_causal_layer():
    df = synthetic_matrix()
    Z, complete, used = h.dose_response_confounders(df, "nutrition_calories")
    assert used == [c for c in ci.COMMON_CONFOUNDERS if c in df.columns] == list(ci.COMMON_CONFOUNDERS)
    # day_of_week goes in as cyclic sin / cos, exactly as in the causal layer.
    assert "day_of_week" not in Z.columns and {"day_of_week_sin", "day_of_week_cos"} <= set(Z.columns)
    assert len(Z) == len(complete) == len(df)
    # A treatment that is itself in the set is never its own confounder, and a rolling
    # treatment drops its mediators (ci.adjustment_set decides).
    _, _, rolling = h.dose_response_confounders(df, "rolling_7d_training_load")
    assert rolling == list(ci.adjustment_set("rolling_7d_training_load",
                                             ci._confounders_for("behavior", set(df.columns))))
    assert "rolling_7d_training_load" not in rolling and "hrv_lag1" not in rolling
    # Missing confounder columns are dropped, not invented.
    _, _, slim = h.dose_response_confounders(df.drop(columns=["sleep_debt_7d"]), "nutrition_calories")
    assert "sleep_debt_7d" not in slim and len(slim) == len(used) - 1
    assert h.dose_response_confounders(df[["calendar_date", "nutrition_calories"]], "nutrition_calories") == (None, None, [])


def test_confounder_gaps_are_filled_like_the_causal_layer():
    df = synthetic_matrix()
    df.loc[100:104, "whoop_day_strain_lag1"] = np.nan      # daily confounder: 2-day carry-forward
    df.loc[150:154, "sleep_debt_7d"] = np.nan              # weekly aggregate: 7-day carry-forward
    Z, complete, _ = h.dose_response_confounders(df, "nutrition_calories")
    assert ci._confounder_ffill_limit("whoop_day_strain_lag1") == 2
    assert list(complete[100:105]) == [True, True, False, False, False]
    assert complete[150:155].all()
    assert Z.loc[101, "whoop_day_strain_lag1"] == df.loc[99, "whoop_day_strain_lag1"]


# ---------------------------------------------------------------------------
# The whole payload
# ---------------------------------------------------------------------------

def test_payload_shape_and_states():
    df = synthetic_matrix()
    out = h.compute_dose_response_continuous(df)
    assert out["version"] == h.DOSE_RESPONSE_VERSION == 1 and out["status"] == "ok"
    assert out["alignment"] == al.ALIGNMENT_VERSION
    assert out["nights"] == 257 and out["through"] == "2031-09-17"
    assert out["thresholds"] == {"chart": 20, "fit": 30, "curvature_t": 2.0, "max_buckets": 24, "adjusted": 50}
    assert "not a causal estimate" in out["adjusted_method"]
    assert [(p["x"], p["y"]) for p in out["pairs"]] == [
        (x, y) for x, *_ in h.DOSE_RESPONSE_INPUTS for y, *_ in h.DOSE_RESPONSE_OUTCOMES]
    assert len(out["pairs"]) == 24

    room = pair_of(out, "room", "hrv")
    assert room["n"] == 227 and room["size"] == 2.0 and room["fit"]["status"] == "ok"
    # Stored Celsius, charted in Fahrenheit: the synthetic peak sits at 68 F (20 C). The
    # tolerance allows for the noise; a unit mix-up would land near 20 or 36.
    close(room["fit"]["peak"]["x"], 68, 2.5, "room peak (F)")
    assert all(b["start"] % 2 == 0 and 55 < b["start"] < 80 for b in room["buckets"])
    assert room["adj"]["status"] == "ok" and 200 < room["adj"]["n"] <= room["n"]
    assert room["adj"]["fit"]["status"] == "ok"
    close(room["adj"]["fit"]["peak"]["x"], 68, 2.5, "adjusted room peak (F)")

    deep = pair_of(out, "kcal", "deep")
    assert 60 < deep["buckets"][3]["mean"] < 130, "deep sleep is charted in minutes"
    assert deep["n"] == 241 and deep["size"] == 250.0

    meal = pair_of(out, "mealGap", "hrv")
    assert meal["n"] == 26 and len(meal["buckets"]) > 0 and meal["fit"]["status"] == "too_few"
    assert meal["adj"]["status"] == "too_few"
    bed = pair_of(out, "cafBed", "hrv")
    assert bed["n"] == 14 and bed["buckets"] == [] and bed["fit"]["status"] == "too_few"

    inp = out["inputs"]
    assert list(inp) == [k for k, *_ in h.DOSE_RESPONSE_INPUTS]
    assert inp["room"] == {
        "column": "eight_sleep_room_temp", "transform": "c_to_f", "bucket_size": 2.0, "in_matrix": True,
        "zero_nights": 0, "confounders": list(ci.COMMON_CONFOUNDERS),
        "confounder_labels": [h.FEATURE_LABELS.get(c, c) for c in ci.COMMON_CONFOUNDERS]}
    assert inp["caf"]["zero_nights"] == int(((df["caffeine_total_mg"] == 0) & df["whoop_hrv_rmssd"].notna()).sum()) > 0
    # The page lists the adjustment variables by name: every one has a readable label.
    for c in inp["room"]["confounders"]:
        assert c in h.FEATURE_LABELS, f"{c} has no FEATURE_LABELS entry"
    # Plain JSON, no NaN / Infinity, no numpy scalars.
    assert json.loads(json.dumps(out, allow_nan=False)) == out


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def test_outcome_is_the_same_rows_sleep():
    """Each input is paired with the outcome on its OWN row. If the block read the previous
    or the next row, an exact same-row relationship would not come back exact."""
    n = 120
    x_c = 20 + 3.5 * noise(81, n)
    x_f = np.round(x_c, 2) * 9 / 5 + 32
    df = pd.DataFrame({
        "calendar_date": pd.date_range("2032-03-01", periods=n, freq="D").strftime("%Y-%m-%d"),
        "eight_sleep_room_temp": x_c,
        "whoop_hrv_rmssd": parabola(x_f),
    })
    out = h.compute_dose_response_continuous(df)
    fit = pair_of(out, "room", "hrv")["fit"]
    assert fit["status"] == "ok" and fit["r2"] > 0.9999, fit
    close(fit["peak"]["x"], 68, 0.01, "vertex")

    # Row order does not matter (the block sorts by date) and neither do missing days.
    gappy = df.drop(index=[10, 11, 50]).sample(frac=1.0, random_state=3).reset_index(drop=True)
    again = pair_of(h.compute_dose_response_continuous(gappy), "room", "hrv")
    assert again["n"] == n - 3 and again["fit"]["r2"] > 0.9999
    assert out["through"] == "2032-06-28"


def test_a_night_needs_hrv_whatever_the_outcome():
    df = synthetic_matrix()
    out = h.compute_dose_response_continuous(df)
    has_hrv = df["whoop_hrv_rmssd"].notna()
    for y_key, col, _ in h.DOSE_RESPONSE_OUTCOMES:
        want = int((has_hrv & df["nutrition_calories"].notna() & df[col].notna()).sum())
        assert pair_of(out, "kcal", y_key)["n"] == want, y_key
    # A matrix without one of the columns: that input has no nights, the rest are untouched.
    slim = h.compute_dose_response_continuous(df.drop(columns=["eight_sleep_bed_temp"]))
    assert slim["status"] == "ok" and slim["inputs"]["bed"]["in_matrix"] is False
    assert pair_of(slim, "bed", "hrv")["n"] == 0
    assert pair_of(slim, "room", "hrv") == pair_of(out, "room", "hrv")


def test_block_follows_the_alignment_rule():
    src = block_source()
    assert "al.outcome_series(frame, 1)" in src, "the HRV outcome must come from hrv_alignment"
    assert ".shift(" not in src, "nothing in this block may move a column by row"
    for clock in ("date.today(", "datetime.now(", "utcnow(", "et_today("):
        assert clock not in src, f"the block does no clock arithmetic ({clock})"
    # Every charted outcome is measured from the sleep on the row itself.
    for _, col, _ in h.DOSE_RESPONSE_OUTCOMES:
        assert al.is_same_sleep(col), col
    assert h.DOSE_RESPONSE_OUTCOMES[0][1] == al.TARGET == h.TARGET
    # The confounder set is the causal module's own (imported, not copied).
    assert "ci.adjustment_set(" in src and "ci._confounders_for(" in src
    assert "hrv_lag1" not in src, "confounder names belong to causal_inference.py"


# ---------------------------------------------------------------------------
# Fail-open
# ---------------------------------------------------------------------------

def test_a_broken_frame_cannot_fail_the_retrain():
    for bad in (pd.DataFrame({"x": [1.0]}), pd.DataFrame(), None,
                pd.DataFrame({"calendar_date": ["not a date"], "whoop_hrv_rmssd": [50.0]})):
        out = h.run_dose_response_continuous(bad)
        assert out["version"] == 1 and out["status"] == "failed" and out["pairs"] == []
        assert isinstance(out["error"], str) and 0 < len(out["error"]) <= 300
        json.dumps(out, allow_nan=False)
    # Text where numbers belong is treated as missing, not as an error.
    df = synthetic_matrix()
    df["nutrition_calories"] = df["nutrition_calories"].astype(object)
    df.loc[5, "nutrition_calories"] = "n/a"
    ok = h.run_dose_response_continuous(df)
    assert ok["status"] == "ok" and pair_of(ok, "kcal", "hrv")["n"] == 240


def test_one_failing_pair_does_not_lose_the_others():
    df = synthetic_matrix()
    real = h.dose_response_pair
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise ZeroDivisionError("synthetic")
        return real(*args, **kwargs)

    h.dose_response_pair = flaky
    try:
        out = h.run_dose_response_continuous(df)
    finally:
        h.dose_response_pair = real
    assert out["status"] == "partial" and len(out["pairs"]) == 24
    broken = [p for p in out["pairs"] if "error" in p]
    assert [(p["x"], p["y"]) for p in broken] == [("room", "efficiency")]
    assert broken[0]["error"] == "ZeroDivisionError: synthetic" and "buckets" not in broken[0]
    assert pair_of(out, "room", "hrv")["fit"]["status"] == "ok"


def test_confounder_trouble_only_costs_the_adjusted_version():
    df = synthetic_matrix()
    base = h.run_dose_response_continuous(df)
    real = h.dose_response_confounders

    def boom(frame, x_col):
        raise KeyError("synthetic")

    h.dose_response_confounders = boom
    try:
        out = h.run_dose_response_continuous(df)
    finally:
        h.dose_response_confounders = real
    assert out["status"] == "ok"
    for p, q in zip(out["pairs"], base["pairs"]):
        assert p["adj"] == {"status": "unavailable", "n": 0}
        assert (p["n"], p["buckets"], p["fit"]) == (q["n"], q["buckets"], q["fit"])
    assert out["inputs"]["room"]["confounders"] == []

    # No causal module at all: same outcome.
    had = h.HAS_CAUSAL
    h.HAS_CAUSAL = False
    try:
        out = h.run_dose_response_continuous(df)
    finally:
        h.HAS_CAUSAL = had
    assert out["status"] == "ok" and all(p["adj"]["status"] == "unavailable" for p in out["pairs"])


class _FakeSupa:
    """Records upserts into pds.hrv_analysis_results; can refuse one result_type."""
    def __init__(self, refuse: str | None = None):
        self.rows: list[dict] = []
        self.refuse = refuse

    def schema(self, name):
        assert name == "pds"
        return self

    def from_(self, table):
        assert table == "hrv_analysis_results"
        return self

    def upsert(self, row, on_conflict=None):
        assert on_conflict == "result_type,result_key"
        self._pending = row
        return self

    def execute(self):
        if self._pending["result_type"] == self.refuse:
            raise RuntimeError("synthetic store failure")
        self.rows.append(self._pending)
        return self


def test_store_writes_the_row_last_and_survives_its_failure():
    payload = h.run_dose_response_continuous(synthetic_matrix())
    real = h.supa
    try:
        h.supa = _FakeSupa()
        h.store_analysis_results({}, {}, dose_response=payload)
        keys = [(r["result_type"], r["result_key"]) for r in h.supa.rows]
        assert keys == [("feature_labels", "all"), ("dose_response_continuous", "sweet_spot")]
        stored = h.supa.rows[-1]
        assert stored["result_json"] == payload and stored["computed_at"]
        json.dumps(stored, allow_nan=False)

        # A failed block is stored too, so the page stops using an older result.
        h.supa = _FakeSupa()
        h.store_analysis_results({}, {}, dose_response=h.run_dose_response_continuous(pd.DataFrame()))
        assert h.supa.rows[-1]["result_json"]["status"] == "failed"

        # Without a payload nothing is written for it.
        h.supa = _FakeSupa()
        h.store_analysis_results({}, {})
        assert [(r["result_type"]) for r in h.supa.rows] == ["feature_labels"]

        # The row itself cannot be stored: the other rows are, and nothing is raised.
        h.supa = _FakeSupa(refuse="dose_response_continuous")
        h.store_analysis_results({}, {}, dose_response=payload)
        assert [(r["result_type"]) for r in h.supa.rows] == ["feature_labels"]
    finally:
        h.supa = real


def test_main_runs_the_block_on_every_retrain():
    main_src = inspect.getsource(h.main)
    call = main_src.index("dose_response = run_dose_response_continuous(df)")
    # Before the --skip-models return and outside the --skip-analysis branch: it is cheap
    # and must exist for the page whichever way the retrain was started.
    assert call < main_src.index("if args.skip_models:")
    assert main_src.index("if HAS_CAUSAL and not args.skip_analysis:") < call
    assert "dose_response=dose_response," in main_src
    line = next(ln for ln in main_src.splitlines() if "run_dose_response_continuous(df)" in ln)
    assert line.startswith("    dose_response"), "top level of main(), not inside the causal try block"
    assert (h.DOSE_RESPONSE_RESULT_TYPE, h.DOSE_RESPONSE_RESULT_KEY) == ("dose_response_continuous", "sweet_spot")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
