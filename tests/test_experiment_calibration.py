"""Experiment framework: the inference under carryover (experiment_analysis, doc 8.1) and its
seeded synthetic calibration (experiment_calibration, doc 8.2).

Covers
  * the exact algebra behind the joint sharp-null test: under H(tau, gamma) the re-drawn
    statistic read from the Draws tables equals a refit on the imputed potential outcomes,
    re-draw by re-draw, with missing nights and excluded blocks;
  * the extreme-set bookkeeping behind Berger-Boos (_sets_moving / _sets_fixed, hull, sup)
    against brute force on a dense grid, including the f = +-1, h = 0, NaN and tie cases;
  * bb_p_value is never below beta plus the joint p-value at any carryover inside its set, is 1
    at the estimate, and its interval holds the estimate; the registered nuisance level;
  * analyze_trial withholds the decision while the method review is not recorded and when the
    arm causes missing nights, keeps the rule's verdict visible, and still refuses before the
    pre-registered end;
  * the calibration harness: deterministic, every supported scenario (zero same-night effect with
    a carryover, serial dependence and drift, missing nights and excluded blocks, a short trial,
    effects with and without carryover) within its prespecified Monte Carlo tolerance, and the
    unsupported scenarios reported without a verdict, the missingness check withholding the
    decision when the arm causes missing nights.

Synthetic data only. No network, no credentials, no database.

Run: python tests/test_experiment_calibration.py   (the scheduled suite, never before a merge)
"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import experiment_analysis as ea  # noqa: E402
import experiment_calibration as cal  # noqa: E402
import experiment_design as ed  # noqa: E402

SUPPORTED = [s.name for s in cal.SCENARIOS if s.supported]
UNSUPPORTED = [s.name for s in cal.SCENARIOS if not s.supported]


def _lag(t):
    return np.concatenate([[0.0], t[:-1]])


def _trial(seed, **kw):
    scenario = cal.Scenario("synthetic", True, "", **kw)
    return cal.simulate_trial(scenario, np.random.default_rng(seed))


# ---------------------------------------------------------------------------
# The joint sharp null
# ---------------------------------------------------------------------------

def test_draws_reproduce_a_refit_on_the_imputed_potential_outcomes():
    t, y, dow, excluded = _trial(301, direct=5.0, carryover=3.0, excluded_blocks=2, n_blocks=20)
    n_redraws, seed = 60, 7
    draws, info = ea.redraw_fit(t, y, dow, excluded_blocks=excluded, n_redraws=n_redraws, redraw_seed=seed)
    assert draws.a.shape == draws.g.shape == draws.h.shape == (n_redraws, 2)
    assert np.allclose(draws.obs, [info["estimate"], info["carryover"]])
    for tau, gamma in ((0.0, 0.0), (2.5, -1.5), (-4.0, 6.0)):
        y0 = y - tau * t - gamma * _lag(t)                       # Y_D(0) under H(tau, gamma); NaN stays NaN
        _, own = ea.redraw_fit(t, y0, dow, excluded_blocks=excluded, n_redraws=1)
        assert np.allclose([own["estimate"], own["carryover"]], draws.obs - [tau, gamma], atol=1e-8), \
            "the observed statistic under H(tau, gamma) is the estimate minus (tau, gamma)"
        redrawn = ed.redraw_blocks(seed, n_redraws, len(t) // 4).astype(float)
        for r in range(0, n_redraws, 7):
            t_r = redrawn[r]
            y_r = y0 + tau * t_r + gamma * _lag(t_r)             # what schedule r would have produced
            _, fit_r = ea.redraw_fit(t_r, y_r, dow, excluded_blocks=excluded, n_redraws=1)
            expected = np.array([fit_r["estimate"], fit_r["carryover"]]) - [tau, gamma]
            got = draws.a[r] - tau * draws.g[r] - gamma * draws.h[r]
            assert np.allclose(got, expected, atol=1e-7), f"re-draw {r} under H({tau}, {gamma})"
        # So the joint p-value is a count over exactly those refits.
        stats = np.array([draws.a[r, 0] - tau * draws.g[r, 0] - gamma * draws.h[r, 0] for r in range(n_redraws)])
        brute = (1 + np.sum(np.abs(stats) >= abs(draws.obs[0] - tau) - 1e-12)) / (n_redraws + 1)
        assert ea.joint_p_value(draws, 0, tau, gamma) == brute


def test_no_effect_p_value_is_the_previous_randomization_test():
    t, y, dow, _ = _trial(302, n_blocks=30)
    fit = ea.randomization_analysis(t, y, dow, n_redraws=499, redraw_seed=3, with_ci=False)
    draws, _ = ea.redraw_fit(t, y, dow, n_redraws=499, redraw_seed=3)
    extreme = np.isnan(draws.a[:, 0]) | (np.abs(draws.a[:, 0]) >= abs(draws.obs[0]) - 1e-12)
    assert fit["p_value_no_effect"] == (1 + extreme.sum()) / 500, "Fisher's no-effect test: Y held fixed"


# ---------------------------------------------------------------------------
# The extreme sets behind Berger-Boos, against brute force
# ---------------------------------------------------------------------------

GRID = np.linspace(-40.0, 40.0, 8001)


def _away_from(events, x, gap=1e-6):
    if not len(events):
        return np.ones(len(x), dtype=bool)
    idx = np.clip(np.searchsorted(events, x), 1, len(events) - 1)
    near = np.minimum(np.abs(x - events[idx - 1]), np.abs(x - events[idx]))
    return near > gap


def _moving_inputs(rng, n=400):
    e = rng.normal(0, 4, n)
    f = rng.normal(0, 0.6, n)                    # some |f| > 1
    obs = 2.5
    f[:5], e[:5] = 1.0, rng.normal(0, 4, 5)      # exactly f = 1
    f[5:10], e[5:10] = -1.0, rng.normal(0, 4, 5)  # exactly f = -1
    f[10], e[10] = 1.0, obs                      # a re-draw equal to the observed one: extreme everywhere
    f[11], e[11] = -1.0, -obs
    e[12], f[12] = np.nan, 0.3                   # a singular re-draw: extreme everywhere
    return e, f, obs


def _brute_moving(e, f, obs, x):
    hit = np.abs(e[None, :] - x[:, None] * f[None, :]) >= np.abs(obs - x)[:, None]
    return (hit | np.isnan(e)[None, :]).sum(axis=1)


def test_moving_sets_count_like_brute_force():
    e, f, obs = _moving_inputs(np.random.default_rng(311))
    sets = ea._sets_moving(e, f, obs)
    ok = _away_from(sets.events(), GRID)
    counted, brute = sets.count(GRID), _brute_moving(e, f, obs, GRID)
    assert (counted[ok] == brute[ok]).all(), "away from the endpoints the count is exact"
    assert (counted >= brute).all(), "at an endpoint a tie counts as extreme, never the other way"
    assert sets.count(np.array([obs]))[0] == len(e), "every re-draw is extreme at the observed value"
    far = np.array([-1e9, 1e9])                  # the limits are what a far-away value counts
    assert sets.at_minus_inf() == _brute_moving(e, f, obs, far)[0]
    assert sets.at_plus_inf() == _brute_moving(e, f, obs, far)[1]


def _fixed_inputs(rng, n=400):
    d = rng.normal(0, 3, n)
    h = rng.normal(0, 0.2, n)
    h[:20] = 0.0                                 # constant in the nuisance
    d[20] = np.nan
    return d, h, 4.0


def _brute_fixed(d, h, k, x):
    hit = np.abs(d[None, :] - x[:, None] * h[None, :]) >= k
    return (hit | np.isnan(d)[None, :]).sum(axis=1)


def test_fixed_sets_count_like_brute_force():
    d, h, k = _fixed_inputs(np.random.default_rng(312))
    sets = ea._sets_fixed(d, h, k)
    ok = _away_from(sets.events(), GRID)
    counted, brute = sets.count(GRID), _brute_fixed(d, h, k, GRID)
    assert (counted[ok] == brute[ok]).all() and (counted >= brute).all()
    assert ea._sets_fixed(d, h, 0.0).count(GRID[:3]).tolist() == [len(d)] * 3, "k <= 0: every re-draw is extreme"
    assert ea._sets_fixed(d, h, -1.0).at_plus_inf() == len(d)


def test_hull_and_sup_agree_with_the_grid():
    e, f, obs = _moving_inputs(np.random.default_rng(313))
    keep = (np.abs(f) < 1) & np.isfinite(e)       # a bounded acceptance set for this check
    e, f = e[keep], f[keep]
    sets = ea._sets_moving(e, f, obs)
    for m in (1, 5, 20, 60):
        low, high = sets.hull(m, center=obs)
        accepted = GRID[_brute_moving(e, f, obs, GRID) >= m]
        assert low <= obs <= high
        assert accepted.size == 0 or (low <= accepted.min() and accepted.max() <= high), "the hull holds every accepted value"
        for end in (low, high):
            if np.isfinite(end):
                assert sets.count(np.array([end]))[0] >= m, "the hull ends are accepted values"
    assert sets.hull(0, center=obs) == (-np.inf, np.inf)
    everything = ea._sets_moving(np.array([0.0, 1.0]), np.array([2.0, 3.0]), 0.0)
    assert everything.hull(1, center=0.0) == (-np.inf, np.inf), "|f| > 1 re-draws stay extreme far out"

    d, h, k = _fixed_inputs(np.random.default_rng(314))
    fixed = ea._sets_fixed(d, h, k)
    for low, high in ((-3.0, 2.0), (0.5, 0.5), (-30.0, 30.0)):
        inside = GRID[(GRID >= low) & (GRID <= high)]
        best = fixed.sup(low, high)
        if inside.size:
            assert best >= _brute_fixed(d, h, k, inside).max(), "sup is at least the grid's best"
        ev = fixed.events()
        cand = np.concatenate([ev[(ev >= low) & (ev <= high)], [low, high]])
        loose = (np.abs(d[None, :] - cand[:, None] * h[None, :]) >= k - 1e-6 * (1 + np.abs(cand))[:, None]) | np.isnan(d)[None, :]
        assert best <= loose.sum(axis=1).max(), "and is reached at an endpoint or an end of the range"
    assert fixed.sup(-np.inf, np.inf) == fixed.at_plus_inf() == fixed.at_minus_inf()


# ---------------------------------------------------------------------------
# Berger-Boos p-values and intervals
# ---------------------------------------------------------------------------

def test_registered_nuisance_level():
    assert ea.nuisance_beta_for(10000) == 0.001 and ea.accept_count(0.001, 10000) == 10
    assert ea.nuisance_beta_for(999) == 5 / 1000 and ea.accept_count(ea.nuisance_beta_for(999), 999) == 5
    for n in (999, 4999, 10000, 20000):
        beta = ea.nuisance_beta_for(n)
        m = ea.accept_count(beta, n)
        assert (1 + m) / (n + 1) > beta >= m / (n + 1), "m is the smallest count whose p-value is above beta"
    assert ea.accept_count(0.001, 1) == 0, "one re-draw: the nuisance set is the whole line"


def test_bb_p_value_bounds_the_joint_p_values_inside_its_set():
    t, y, dow, excluded = _trial(321, carryover=8.0, n_blocks=40, excluded_blocks=2)
    draws, _ = ea.redraw_fit(t, y, dow, excluded_blocks=excluded, n_redraws=999, redraw_seed=11)
    beta = ea.nuisance_beta_for(999)
    for comp in (0, 1):
        assert ea.bb_p_value(draws, comp, float(draws.obs[comp]))[0] == 1.0, "p is 1 at the estimate"
        for value in (0.0, 3.0, -5.0, float(draws.obs[comp]) + 2 * draws.scale(comp)):
            p, (low, high) = ea.bb_p_value(draws, comp, value)
            assert beta <= p <= 1.0
            other = 1 - comp
            assert low <= draws.obs[other] <= high, "the nuisance set holds the other estimate"
            grid = np.linspace(low if np.isfinite(low) else -60, high if np.isfinite(high) else 60, 301)
            for x in grid:
                theta = (value, x) if comp == 0 else (x, value)
                assert p >= min(1.0, beta + ea.joint_p_value(draws, comp, *theta)) - 1e-12, (comp, value, x)
    lo, hi = ea.interval(draws, 0, 0.05)
    assert lo < draws.obs[0] < hi
    assert ea.bb_p_value(draws, 0, lo)[0] > 0.05 and ea.bb_p_value(draws, 0, hi)[0] > 0.05, "the ends are not rejected"
    clo, chi = ea.interval(draws, 1, 0.05)
    assert clo < draws.obs[1] < chi


def test_randomization_analysis_reports_the_assumption_visible_outputs():
    t, y, dow, _ = _trial(322, carryover=5.0, n_blocks=40)
    fit = ea.randomization_analysis(t, y, dow, n_redraws=999, redraw_seed=4, with_carryover_ci=True)
    for key in ("p_value", "p_carryover", "p_value_no_effect", "p_carryover_no_effect", "ci_low", "ci_high",
                "carryover_ci_low", "carryover_ci_high", "nuisance_beta", "carryover_set_bounded"):
        assert key in fit, key
    assert fit["nuisance_beta"] == ea.nuisance_beta_for(999) and fit["carryover_set_bounded"] is True
    assert fit["ci_low"] < fit["estimate"] < fit["ci_high"] and fit["carryover_ci_low"] < fit["carryover"] < fit["carryover_ci_high"]
    assert (fit["p_value"] <= 0.05) == (fit["ci_low"] > 0 or fit["ci_high"] < 0), "the interval and the p-value agree"
    quick = ea.randomization_analysis(t, y, dow, n_redraws=1, with_p=False)
    assert "p_value" not in quick and quick["estimate"] == fit["estimate"]

    semantics = ea.output_semantics(fit["nuisance_beta"])
    assert "tau = 0" in semantics["p_value"]["null"] and "one_night_carryover" in semantics["p_value"]["needs"]
    assert "one_night_carryover" not in semantics["p_value_no_effect"]["needs"]
    assert set(semantics["p_value"]["needs"]) <= set(ea.ASSUMPTIONS)


# ---------------------------------------------------------------------------
# The report: firm decisions only when nothing withholds them
# ---------------------------------------------------------------------------

def _spec_and_data(effect=25.0, n_blocks=40, missing_a_extra=0.0, seed=331):
    rng = np.random.default_rng(seed)
    start = date(2030, 1, 7)
    arms = ed.generate_schedule(rng.bytes(32), n_blocks)
    t = np.array([1.0 if a == "A" else 0.0 for a in arms])
    y = 70 + rng.normal(0, 10, len(t)) + effect * t
    y[rng.random(len(t)) < missing_a_extra * t] = np.nan     # only arm-A nights go missing, and only when asked
    spec = ea.TrialSpec("EXP-901", start, start + timedelta(days=len(t) - 1), mid_ms=8.0, n_redraws=999)
    return spec, ea.TrialData(arms=arms, outcome=y)


def test_decision_is_withheld_until_the_method_review_is_recorded():
    spec, data = _spec_and_data()
    for as_of in (spec.start, spec.planned_end):
        try:
            ea.analyze_trial(spec, data, as_of)
        except ea.AnalysisNotAllowed:
            continue
        raise AssertionError("the inference change must not open an early look")
    as_of = spec.planned_end + timedelta(days=1)
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(calibration_report=None, independent_review=None)
        pending = ea.analyze_trial(spec, data, as_of)
        assert pending["decision_if_supported"] == "adopt_A" and pending["decision"] == "inconclusive"
        assert pending["decision_firm"] is False and len(pending["decision_withheld"]) == 1
        assert "independent statistical review" in pending["decision_withheld"][0]
        checks = {c["id"]: c for c in pending["inference"]["checks"]}
        assert checks["method_reviewed"]["status"] == "pending" and checks["missing_not_caused_by_arm"]["status"] == "ok"
        assert pending["inference"]["method"] == ea.INFERENCE_METHOD and set(pending["inference"]["assumptions"]) == set(ea.ASSUMPTIONS)

        ea.METHOD_REVIEW.update(calibration_report="synthetic-report-ref", independent_review="synthetic-review-ref")
        firm = ea.analyze_trial(spec, data, as_of)
        assert firm["decision"] == "adopt_A" and firm["decision_firm"] is True and firm["decision_withheld"] == []
        assert {k: v for k, v in firm.items() if k not in ("decision", "decision_firm", "decision_withheld", "inference")} == \
            {k: v for k, v in pending.items() if k not in ("decision", "decision_firm", "decision_withheld", "inference")}, \
            "the review changes the verdict's status, never a number"

        skewed_spec, skewed = _spec_and_data(missing_a_extra=0.35, seed=332)
        threat = ea.analyze_trial(skewed_spec, skewed, skewed_spec.planned_end + timedelta(days=1))
        assert threat["missingness"]["threat"] is True and threat["decision"] == "inconclusive"
        assert threat["decision_firm"] is False and any("missing nights" in r for r in threat["decision_withheld"])
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


# ---------------------------------------------------------------------------
# The calibration harness
# ---------------------------------------------------------------------------

def test_tolerances_are_prespecified():
    tol = cal.tolerances(1000)
    se = np.sqrt(0.05 * 0.95 / 1000)
    assert cal.Z_MC == 3.0 and cal.ALPHA == 0.05
    assert abs(tol["rejection_max"] - (0.05 + 3 * se)) < 1e-12 and abs(tol["coverage_min"] - (0.95 - 3 * se)) < 1e-12
    assert tol["exact_low"] < 0.05 < tol["exact_high"]
    names = [s.name for s in cal.SCENARIOS]
    assert len(names) == len(set(names))
    assert {"carryover_only", "carryover_only_serial", "missing_and_excluded", "short_trial"} <= set(SUPPORTED)
    assert set(UNSUPPORTED) == {"two_night_carryover", "arm_dependent_missing"}
    for s in cal.SCENARIOS:
        breaks = s.carryover2 != 0 or s.missing_a_extra != 0
        assert s.supported == (not breaks), f"{s.name}: supported must mean the working model holds"


def test_calibration_is_deterministic_and_json():
    first = cal.run_calibration(n_sims=4, n_redraws=199, seed=5, names=["no_effect", "two_night_carryover"])
    second = cal.run_calibration(n_sims=4, n_redraws=199, seed=5, names=["no_effect", "two_night_carryover"])
    assert first == second
    text = json.dumps(first)
    assert '"method": "%s"' % ea.INFERENCE_METHOD in text
    assert [s["name"] for s in first["scenarios"]] == ["no_effect", "two_night_carryover"]
    assert first["nuisance_beta"] == ea.nuisance_beta_for(199)
    try:
        cal.run_calibration(n_sims=1, names=["not_a_scenario"])
    except ValueError as exc:
        assert "not_a_scenario" in str(exc)
    else:
        raise AssertionError("an unknown scenario must be refused")


def test_supported_scenarios_meet_their_prespecified_tolerances():
    report = cal.run_calibration(n_sims=100, n_redraws=999, seed=20261117, names=SUPPORTED)
    assert report["passed"] is True, json.dumps(report["scenarios"], indent=1)
    by_name = {s["name"]: s for s in report["scenarios"]}
    for name in SUPPORTED:
        scenario = by_name[name]
        assert scenario["ok"] is True and scenario["n_analysed"] >= 90, name
        metrics = scenario["metrics"]
        assert {"direct_coverage", "carryover_coverage", "joint_exact"} <= set(metrics), name
        assert all(m["ok"] is True for m in metrics.values()), (name, metrics)
    # The scenario the audit named: no same-night effect, a non-zero carryover.
    assert "direct_type1" in by_name["carryover_only"]["metrics"]
    assert "direct_type1" in by_name["carryover_only_serial"]["metrics"]
    assert "carryover_type1" in by_name["effect_only"]["metrics"]


def test_unsupported_scenarios_are_reported_without_a_verdict():
    report = cal.run_calibration(n_sims=40, n_redraws=999, seed=20261118, names=UNSUPPORTED)
    by_name = {s["name"]: s for s in report["scenarios"]}
    for name in UNSUPPORTED:
        assert by_name[name]["supported"] is False and by_name[name]["ok"] is None
        assert all(m["ok"] is None for m in by_name[name]["metrics"].values())
    assert report["passed"] is False, "a report with no supported scenario does not pass"
    assert by_name["arm_dependent_missing"]["informational"]["missingness_check_withholds"] >= 0.8, \
        "missing nights caused by the arm are caught by the report's own check"


def test_cli_writes_the_report():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "calibration.json"
        code = cal.main(["--sims", "3", "--redraws", "199", "--seed", "9", "--scenario", "no_effect", "--out", str(out)])
        saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["n_sims"] == 3 and saved["scenarios"][0]["name"] == "no_effect"
    assert code == (0 if saved["passed"] else 1)


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    sys.exit(1 if failures else 0)
