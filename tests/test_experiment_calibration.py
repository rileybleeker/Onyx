"""Experiment framework: the inference under carryover (experiment_analysis, doc 8.1) and its
seeded synthetic calibration (experiment_calibration, doc 8.2).

Covers
  * the exact algebra behind the joint sharp-null test: under H(tau, gamma) the re-drawn
    statistic read from the Draws tables equals a refit on the imputed potential outcomes,
    re-draw by re-draw, with missing nights and excluded blocks;
  * the extreme-set bookkeeping behind Berger-Boos (_sets_moving / _sets_fixed, hull, sup)
    against brute force on a dense grid, including the f = +-1, h = 0, NaN and tie cases;
  * bb_p_value is never below beta plus the joint p-value at any carryover inside its set, is 1
    at the estimate, and its interval holds every accepted value; the registered nuisance level;
  * the certified interval: _strip_bound is never below the p-value inside its strip (original
    and 1 / v coordinates), and on hand-built re-draws whose acceptance set has a rejected gap
    the interval still holds the far accepted region, or is unbounded when values far out are
    accepted, where stepping out from the estimate alone stops at the gap; p = alpha is accepted;
  * analyze_trial withholds the decision while the method review is not recorded (or does not
    cover the trial's alpha and re-draw count), when the arm causes missing nights, and when the
    registered protocol does not declare and justify the untestable parts of the model or names
    another inference method; it marks the outputs those failures leave unsupported (Fisher's
    test too when the arm causes missing nights), keeps the rule's verdict visible, and still
    refuses before the pre-registered end;
  * the sensitivity and secondary numbers state what they rest on: ln(HRV) the model on the log
    scale, the covariate fits labelled approximate (the covariate depends on earlier arms) with
    an exact Fisher p, each secondary series its own missingness check, which marks only that
    series and never withholds the decision;
  * the calibration harness: deterministic, a bounded smoke run of the audit's scenarios (zero
    same-night effect with a carryover, serial dependence and drift, missing nights and excluded
    blocks) plus one without carryover within the prespecified Monte Carlo tolerance for that many
    trials, the unsupported scenarios reported without a verdict (the missingness check withholding
    the decision when the arm causes missing nights), shards merging into the report a full run
    would give, and review_ready counting analysed trials. The full-tolerance report (1,000 trials
    per scenario at the registered re-draw count) is the CLI's job (doc 8.2), not this file's;
  * the review findings of doc 8.3: the calibration's enclosure probe flags an interval that misses
    an accepted region (the stepped-out one on the rejected-gap re-draws) and passes the certified
    one; the calibration seeds its re-draws with the deployed rule (experiment_design.redraw_seed);
    the recorded METHOD_REVIEW holds the independent review but no calibration report, so the
    decision stays withheld with a reason naming the missing report, and each half alone is named;
    the near_singular stress scenario (supported, review-ready at REVIEW_MIN_STRESS analysed);
  * the method record is bound to the code (experiment_fingerprint): the inference fingerprint
    ignores docstrings, comments, layout, the record itself and the output explanations, and
    changes with any expression of the analysis or of the allocation / re-draw code; the recorded
    review names the running code's fingerprint; a free-text record, fewer than two reviewers, a
    verdict that is not sound, another fingerprint, an unreadable source, and a calibration record
    without its revision, harness fingerprint, scheduled-suite run or review-ready flag all keep the
    decision withheld; a report is review-ready only with a revision and a fingerprint;
  * the record covers designs, not only alpha and re-draws: a trial whose block shape or number of
    scheduled blocks the calibration did not run (or whose design is not given) stays withheld, and
    the report's `covers` names the block shape and the block range of its supported scenarios;
  * missing-night checks fail closed: an A/A check without a readable Fisher p, and a treatment
    trial without a readable 10-point flag, count as failed.

Synthetic data only. No network, no credentials, no database.

Run: python tests/test_experiment_calibration.py   (the scheduled suite, never before a merge)
"""
import json
import sys
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import experiment_analysis as ea  # noqa: E402
import experiment_calibration as cal  # noqa: E402
import experiment_design as ed  # noqa: E402
import experiment_fingerprint as ef  # noqa: E402

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
    for comp in (0, 1):
        lo, hi = ea.interval(draws, comp, 0.05)
        assert lo < draws.obs[comp] < hi
        # The ends are just past the accepted values (rejected there) and every accepted value is inside.
        for end in (lo, hi):
            assert not np.isfinite(end) or ea.bb_p_value(draws, comp, end)[0] < 0.05, "an end is a rejected value"
        scale = draws.scale(comp)
        grid = float(draws.obs[comp]) + scale * np.linspace(-30, 30, 1201)
        accepted = [v for v in grid if ea.bb_p_value(draws, comp, v)[0] >= 0.05]
        assert accepted and min(accepted) >= lo and max(accepted) <= hi, "the interval holds every accepted value"


def test_randomization_analysis_reports_the_assumption_visible_outputs():
    t, y, dow, _ = _trial(322, carryover=5.0, n_blocks=40)
    fit = ea.randomization_analysis(t, y, dow, n_redraws=999, redraw_seed=4, with_carryover_ci=True)
    for key in ("p_value", "p_carryover", "p_value_no_effect", "p_carryover_no_effect", "ci_low", "ci_high",
                "carryover_ci_low", "carryover_ci_high", "nuisance_beta", "carryover_set_bounded"):
        assert key in fit, key
    assert fit["nuisance_beta"] == ea.nuisance_beta_for(999) and fit["carryover_set_bounded"] is True
    assert fit["ci_low"] < fit["estimate"] < fit["ci_high"] and fit["carryover_ci_low"] < fit["carryover"] < fit["carryover_ci_high"]
    # Only one direction is guaranteed: the interval encloses every accepted value, and the accepted
    # values need not form one piece, so it can contain 0 while the test rejects 0 (never the reverse).
    if fit["ci_low"] > 0 or fit["ci_high"] < 0:
        assert fit["p_value"] < 0.05, "an interval that leaves out 0 means the test rejects 0"
    if fit["p_value"] >= 0.05:
        assert fit["ci_low"] <= 0 <= fit["ci_high"], "an accepted 0 is inside the interval"
    quick = ea.randomization_analysis(t, y, dow, n_redraws=1, with_p=False)
    assert "p_value" not in quick and quick["estimate"] == fit["estimate"]

    semantics = ea.output_semantics(fit["nuisance_beta"])
    assert "tau = 0" in semantics["p_value"]["null"] and "one_night_carryover" in semantics["p_value"]["needs"]
    assert "one_night_carryover" not in semantics["p_value_no_effect"]["needs"]
    assert set(semantics["p_value_no_effect"]["needs"]) == {"randomized_schedule", "missing_not_caused_by_arm"}, \
        "Fisher's test still needs the schedule and missing nights not caused by the arm"
    assert set(semantics["p_value"]["needs"]) <= set(ea.ASSUMPTIONS)
    assert ea.INTERVAL_METHOD in semantics["ci_low / ci_high"]["validity"]
    assert "approximately unbiased" in semantics["estimate"]["validity"]


# ---------------------------------------------------------------------------
# The certified interval: every accepted value, even past a rejected gap
# ---------------------------------------------------------------------------

def _gap_draws(n_far=3, n_near=2, n_redraws=199):
    """Hand-built Draws whose same-night acceptance set is not an interval (doc 8.1).

    Observed (0, 0); the nuisance plays no part (its columns are 0). n_far re-draws are extreme at
    v <= 10 and v >= 30 (|30 - 2v| >= |v|), n_near on [-120, 40] (|60 - v/2| >= |v|), the rest only
    at v = 0. With 199 re-draws, beta = 0.025 and alpha = 0.05 a value is accepted with 4 or more
    extreme re-draws, so 3 + 2 accepts [-120, 10] and [30, 40] and rejects the gap between."""
    a, g, h = np.zeros((n_redraws, 2)), np.zeros((n_redraws, 2)), np.zeros((n_redraws, 2))
    a[:n_far, 0], g[:n_far, 0] = 30.0, 2.0
    a[n_far:n_far + n_near, 0], g[n_far:n_far + n_near, 0] = 60.0, 0.5
    return ea.Draws(obs=np.zeros(2), a=a, g=g, h=h)


def test_interval_holds_an_accepted_region_past_a_rejected_gap():
    draws = _gap_draws()
    p = lambda v: ea.bb_p_value(draws, 0, v)[0]  # noqa: E731
    assert p(35.0) >= 0.05 and p(20.0) < 0.05 and p(50.0) < 0.05 and p(-50.0) >= 0.05 and p(-130.0) < 0.05
    # Stepping out from the estimate stops at the first rejection, near 10: that alone misses [30, 40].
    near_lo, near_hi = ea.invert_p_value(p, 0.0, 0.05, draws.scale(0))
    assert near_hi < 11.0
    lo, hi = ea.interval(draws, 0, 0.05)
    assert 40.0 <= hi < 40.01 and -120.01 < lo <= -120.0, (lo, hi)
    grid = np.linspace(-300.0, 300.0, 12001)
    accepted = [v for v in grid if p(v) >= 0.05]
    assert min(accepted) >= lo and max(accepted) <= hi, "every accepted grid value is inside the interval"


def test_interval_is_unbounded_when_values_far_out_are_accepted():
    # 5 re-draws extreme at v <= 10 and v >= 30: accepted on (-inf, 10] and [30, inf), rejected between.
    draws = _gap_draws(n_far=5, n_near=0)
    p = lambda v: ea.bb_p_value(draws, 0, v)[0]  # noqa: E731
    assert p(20.0) < 0.05 and p(1e6) >= 0.05
    assert ea.invert_p_value(p, 0.0, 0.05, draws.scale(0))[1] < 11.0
    assert ea.interval(draws, 0, 0.05) == (-np.inf, np.inf)


def test_accepted_boundary_value_is_accepted():
    # One boundary everywhere: p >= alpha is accepted (the decision rule adopts only on p < alpha).
    step = lambda v: 0.05 if abs(v) <= 2.0 else 0.01  # noqa: E731
    lo, hi = ea.invert_p_value(step, 0.0, 0.05, 1.0)
    assert -2.0 - 1e-6 <= lo <= -2.0 + 1e-6 and 2.0 - 1e-6 <= hi <= 2.0 + 1e-6


def test_strip_bound_is_at_least_the_p_value_everywhere_in_the_strip():
    # The certificate is sound only if _strip_bound never falls below bb_p_value inside its strip,
    # in the original coordinates and in the tail coordinates w = 1 / v.
    t, y, dow, excluded = _trial(341, carryover=6.0, n_blocks=30, excluded_blocks=2)
    draws, _ = ea.redraw_fit(t, y, dow, excluded_blocks=excluded, n_redraws=499, redraw_seed=17)
    rng = np.random.default_rng(342)
    for comp in (0, 1):
        beta = ea.nuisance_beta_for(draws.n)
        m = ea.accept_count(beta, draws.n)
        center, scale = float(draws.obs[comp]), draws.scale(comp)
        for _ in range(25):
            t1 = center + scale * rng.uniform(-40, 40)
            t2 = t1 + scale * rng.choice([1e-4, 0.01, 0.3, 2.0, 15.0])
            bound = ea._strip_bound(draws, comp, t1, t2, False, beta, m)
            worst = max(ea.bb_p_value(draws, comp, v, beta)[0] for v in np.linspace(t1, t2, 25))
            assert bound >= worst - 1e-12, (comp, t1, t2, bound, worst)
        for sign in (1.0, -1.0):
            start = sign * (abs(center) + 50 * scale)
            bound = ea._strip_bound(draws, comp, min(1 / start, 0.0), max(1 / start, 0.0), True, beta, m)
            for k in (1.0, 1.7, 10.0, 1e3, 1e6):
                assert bound >= ea.bb_p_value(draws, comp, start * k, beta)[0] - 1e-12, (comp, sign, k)
    # And with the hand-built gap: a strip inside the gap is certified, one that touches [30, 40] is not.
    gap = _gap_draws()
    beta, m = ea.nuisance_beta_for(gap.n), ea.accept_count(ea.nuisance_beta_for(gap.n), gap.n)
    assert ea._strip_bound(gap, 0, 15.0, 25.0, False, beta, m) < 0.05
    assert ea._strip_bound(gap, 0, 25.0, 31.0, False, beta, m) >= 0.05
    assert ea._strip_bound(gap, 0, 0.0, 1 / 50.0, True, beta, m) < 0.05, "past 50 only the 3 far re-draws are extreme"


def test_enclosure_probe_flags_a_missed_accepted_region():
    # Doc 8.3 (review finding): the calibration checks the enclosure property itself, not only coverage.
    draws = _gap_draws()
    beta = ea.nuisance_beta_for(draws.n)
    p = lambda v: ea.bb_p_value(draws, 0, v, beta)[0]  # noqa: E731
    stepped = ea.invert_p_value(p, 0.0, 0.05, draws.scale(0))      # stops near 10, before [30, 40]
    assert cal.enclosure_violation(draws, 0, *stepped, 0.05, beta), "the probes must reach the far region"
    certified = ea.interval(draws, 0, 0.05, beta)
    assert not cal.enclosure_violation(draws, 0, *certified, 0.05, beta, (0.0,))
    # An accepted value handed in explicitly (the true value, 0) counts when it is outside the interval.
    assert cal.enclosure_violation(draws, 0, 50.0, 60.0, 0.05, beta, (35.0,))
    assert not cal.enclosure_violation(draws, 0, -np.inf, np.inf, 0.05, beta, (35.0,)), "nothing is outside"


def test_calibration_seeds_its_redraws_with_the_deployed_rule():
    # Doc 8.3 (review finding): a real report's re-draw seed is experiment_design.redraw_seed, a hash
    # of public values; the calibration must measure that rule, not a different random seed.
    assert cal.calibration_redraw_seed(5, 0, 3) == ed.redraw_seed("CAL-5-0-3", cal.CALIBRATION_AS_OF)
    assert cal.calibration_redraw_seed(5, 0, 3) != cal.calibration_redraw_seed(5, 0, 4)
    assert cal.calibration_redraw_seed(5, 0, 3) != cal.calibration_redraw_seed(5, 1, 3)
    assert cal.calibration_redraw_seed(5, 0, 3) != cal.calibration_redraw_seed(6, 0, 3)


def test_recorded_method_review_still_withholds_until_the_calibration_report():
    # Doc 8.3: the independent review is recorded, the calibration report is not, so no trial's
    # decision is firm yet and the register step still refuses a treatment trial.
    assert ea.METHOD_REVIEW["method"] == ea.INFERENCE_METHOD
    assert ea.METHOD_REVIEW["interval_method"] == ea.INTERVAL_METHOD
    record = ea.METHOD_REVIEW["independent_review"]
    assert isinstance(record, dict) and "8.3" in record["reference"] and len(record["reviewers"]) >= 2
    assert all(v == "sound" for v in record["verdicts"]) and record["reviewed_revision"]
    # The review names the code that is running: the analysis changes after the reviewed revision left
    # the inference fingerprint unchanged (doc 8.3), and any later change withholds every decision.
    assert record["inference_fingerprint"] == ef.inference_fingerprint()
    assert not ea.METHOD_REVIEW["calibration_report"]
    assert not ea.METHOD_REVIEW["n_redraws"] and not ea.METHOD_REVIEW["alpha"]
    assert not ea.METHOD_REVIEW["block_designs"] and not ea.METHOD_REVIEW["n_blocks"]
    problem = ea.method_review_problem(0.05, 10000, **DESIGN)
    assert problem and "calibration report" in problem and "independent statistical review is recorded" in problem
    spec, data = _spec_and_data()
    report = ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))
    assert report["decision"] == "inconclusive" and report["decision_firm"] is False
    assert report["decision_withheld"] == [ea.method_review_problem(spec.alpha, spec.n_redraws, block_len=spec.block_len,
                                                                    n_a=spec.n_a, n_blocks=spec.n_days // spec.block_len)]
    assert report["inference"]["review"]["independent_review"] == ea.METHOD_REVIEW["independent_review"]
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(calibration_report="synthetic-report-ref", independent_review=None)
        only_report = ea.method_review_problem(0.05, 10000)
        assert "independent statistical review" in only_report and "calibration report is recorded" in only_report
        ea.METHOD_REVIEW.update(calibration_report=None, independent_review=None)
        neither = ea.method_review_problem(0.05, 10000)
        assert "calibration report and the independent statistical review" in neither
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


def test_inference_fingerprint_covers_the_code_not_the_text():
    analysis = (ROOT / "experiment_analysis.py").read_text(encoding="utf-8")
    design_src = (ROOT / "experiment_design.py").read_text(encoding="utf-8")
    base = ef.fingerprint_sources(analysis, design_src)
    assert base == ef.inference_fingerprint() and len(base) == 64

    def edited(old, new, in_design=False):
        source = design_src if in_design else analysis
        assert old in source, old
        changed = source.replace(old, new, 1)
        return ef.fingerprint_sources(analysis, changed) if in_design else ef.fingerprint_sources(changed, design_src)

    # Text, layout and the record itself never count.
    assert edited('"""The end-of-trial report. Raises', '"""The final report. Raises') == base
    assert edited("REDRAW_CHUNK = 2000", "REDRAW_CHUNK = 2000  # a comment") == base
    assert edited("Not read by the decision rule", "Never read by the decision rule") == base
    assert edited('"calibration_report": None,', '"calibration_report": "synthetic",') == base
    assert edited("def method_review_problem(alpha: float, n_redraws: int, *,",
                  "def method_review_problem(alpha: float, n_redraws: int, _unused: int = 0, *,") == base
    assert edited('"block_designs": (),', '"block_designs": ((4, 2),),') == base
    assert edited("def validate_protocol(", "def validate_protocol(_unused, ", in_design=True) == base
    # Code does: an analysis constant, the decision rule, the re-draw seed and the uniform draws.
    assert edited("TIE_TOL = 1e-12", "TIE_TOL = 1e-11") != base
    assert edited("if p_value < alpha and estimate > 0:", "if p_value <= alpha and estimate > 0:") != base
    assert edited("randomization-test", "randomization-test-2", in_design=True) != base
    assert edited("excess = (1 << 64) % n_choices", "excess = 0", in_design=True) != base
    # An import the re-draw code relies on is part of it; one nothing reaches is not.
    assert edited("import hashlib", "import hashlib as hashlib", in_design=True) != base
    assert edited("import re\n", "import re as re\n", in_design=True) == base
    # Statement order counts: a later definition replaces an earlier one.
    first_then_second = "\n".join(["x = 1", "x = 2", ""])
    second_then_first = "\n".join(["x = 2", "x = 1", ""])
    assert ef.fingerprint_sources(first_then_second, design_src) != ef.fingerprint_sources(second_then_first, design_src)
    # A design name the analysis starts to read joins the closure, and so does the code it uses.
    reads_new = analysis + "\nSYNTHETIC_READ = design.synthetic_new_name\n"
    absent = ef.fingerprint_sources(reads_new, design_src)
    defined = ef.fingerprint_sources(reads_new, design_src + "\ndef synthetic_new_name():\n    return _SYNTHETIC_HELPER\n"
                                     "\n_SYNTHETIC_HELPER = 1\n")
    helper_changed = ef.fingerprint_sources(reads_new, design_src + "\ndef synthetic_new_name():\n    return _SYNTHETIC_HELPER\n"
                                            "\n_SYNTHETIC_HELPER = 2\n")
    assert len({absent, defined, helper_changed}) == 3
    unread = design_src + "\n_SYNTHETIC_UNREAD = 3\n"            # design code nothing reaches stays out
    assert ef.fingerprint_sources(analysis, unread) == base
    # The calibration harness has its own fingerprint, recorded by the report.
    assert ef.harness_fingerprint() == ef.module_fingerprint((ROOT / "experiment_calibration.py").read_text(encoding="utf-8"))


def test_method_review_records_are_bound_to_the_inference_code():
    saved = dict(ea.METHOD_REVIEW)
    live = ef.inference_fingerprint()
    try:
        ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)))
        assert ea.method_review_problem(0.05, 10000, **DESIGN) is None, "a complete record for this code covers the trial"

        def problem_with(review_changes=None, report_changes=None, **top):
            ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)))
            if review_changes is not None:
                ea.METHOD_REVIEW["independent_review"] = (review_changes if not isinstance(review_changes, dict)
                                                          else {**ea.METHOD_REVIEW["independent_review"], **review_changes})
            if report_changes is not None:
                ea.METHOD_REVIEW["calibration_report"] = (report_changes if not isinstance(report_changes, dict)
                                                          else {**ea.METHOD_REVIEW["calibration_report"], **report_changes})
            ea.METHOD_REVIEW.update(top)
            return ea.method_review_problem(0.05, 10000, **DESIGN) or ""

        # The reviewer's finding: a non-empty free text must not satisfy the gate.
        assert "not a structured record" in problem_with(review_changes="synthetic free text review")
        assert "two distinct reviewers" in problem_with({"reviewers": ("synthetic-reviewer-a",), "verdicts": ("sound",)})
        assert "two distinct reviewers" in problem_with({"reviewers": ("synthetic-reviewer-a", "synthetic-reviewer-a")})
        assert "sound verdict" in problem_with({"verdicts": ("sound", "concerns")})
        assert "sound verdict" in problem_with({"verdicts": ("sound",)})
        assert "reviewed revision" in problem_with({"reviewed_revision": " "})
        other = "0" * 64
        assert "covers other inference code" in problem_with({"inference_fingerprint": other})
        assert "covers other inference code" in problem_with({"inference_fingerprint": None})
        # The calibration half: structured, review-ready, its revision, harness and the suite run that
        # passed the strip-bound proofs, for this code.
        assert "not a structured record" in problem_with(report_changes="synthetic-report-ref")
        for key in ("reference", "revision", "harness_fingerprint", "suite_run"):
            assert "scheduled-suite run" in problem_with(report_changes={key: ""}), key
        assert "not review-ready" in problem_with(report_changes={"review_ready": False})
        assert "not review-ready" in problem_with(report_changes={"review_ready": "yes"})
        assert "calibration report covers other inference code" in problem_with(report_changes={"inference_fingerprint": other})
        assert "interval" in problem_with(interval_method="synthetic_other_interval_v9")
        # A changed code base withholds every decision until both halves are recorded again.
        ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,), fingerprint=other))
        assert "covers other inference code" in (ea.method_review_problem(0.05, 10000, **DESIGN) or "")
        # An unreadable source cannot be checked, so the decision is withheld.
        ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)))
        original = ef.inference_fingerprint
        try:
            ef.inference_fingerprint = lambda: None
            assert "cannot be read" in (ea.method_review_problem(0.05, 10000, **DESIGN) or "")
        finally:
            ef.inference_fingerprint = original
        assert ea.method_review_problem(0.05, 10000, **DESIGN) is None and ef.inference_fingerprint() == live
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


def test_method_review_covers_only_the_calibrated_designs():
    # Review finding (round 3): the record checked alpha and re-draws only, so a trial with a block shape
    # or a number of blocks the calibration never ran would be covered once a report is recorded.
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)))
        assert ea.method_review_problem(0.05, 10000, **DESIGN) is None
        for n_blocks in (7, 58):
            assert ea.method_review_problem(0.05, 10000, **{**DESIGN, "n_blocks": n_blocks}) is None, n_blocks
        # A design not given cannot be checked, so it is not covered (fail closed).
        assert "block design" in (ea.method_review_problem(0.05, 10000) or "")
        assert "block design" in (ea.method_review_problem(0.05, 10000, **{**DESIGN, "n_blocks": None}) or "")
        assert "block design" in (ea.method_review_problem(0.05, 10000, **{**DESIGN, "n_a": True}) or "")
        # Another block shape, or a block count outside the calibrated range.
        assert "not this trial's 5 days with 2 on arm A" in (
            ea.method_review_problem(0.05, 10000, **{**DESIGN, "block_len": 5}) or "")
        assert "not this trial's 4 days with 1 on arm A" in (
            ea.method_review_problem(0.05, 10000, **{**DESIGN, "n_a": 1}) or "")
        for n_blocks in (6, 59):
            assert f"covers 7 to 58 scheduled blocks, not this trial's {n_blocks}" in (
                ea.method_review_problem(0.05, 10000, **{**DESIGN, "n_blocks": n_blocks}) or ""), n_blocks
        # A record without designs, or with a malformed range, covers none.
        for changes in (dict(block_designs=()), dict(block_designs=((4,),)), dict(block_designs=(("4", "2"),))):
            ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)), **changes)
            assert "covers no blocks" in (ea.method_review_problem(0.05, 10000, **DESIGN) or ""), changes
        for changes in (dict(n_blocks=()), dict(n_blocks=(58, 7)), dict(n_blocks=(7,)), dict(n_blocks=("7", "58"))):
            ea.METHOD_REVIEW.update(synthetic_method_review(n_redraws=(10000,)), **changes)
            assert "covers no scheduled blocks" in (ea.method_review_problem(0.05, 10000, **DESIGN) or ""), changes
        # The final report reads the trial's own design: a 40-block trial outside a 50-58 calibration stays pending.
        ea.METHOD_REVIEW.update(synthetic_method_review(), n_blocks=(50, 58))
        spec, data = _spec_and_data()
        report = ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))
        assert report["decision_firm"] is False and report["decision"] == "inconclusive"
        assert report["decision_withheld"] == ["the calibration report covers 50 to 58 scheduled blocks, not this trial's 40"]
        assert report["decision_if_supported"] == "adopt_A"
        ea.METHOD_REVIEW.update(synthetic_method_review())
        assert ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))["decision_firm"] is True
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


# ---------------------------------------------------------------------------
# The report: firm decisions only when nothing withholds them
# ---------------------------------------------------------------------------

DECLARED = dict(carryover_nights=1, model_justification="synthetic: acts on its own night only, the same every night",
                inference_method=ea.INFERENCE_METHOD)


def _spec_and_data(effect=25.0, n_blocks=40, missing_a_extra=0.0, seed=331, **spec_kw):
    rng = np.random.default_rng(seed)
    start = date(2030, 1, 7)
    arms = ed.generate_schedule(rng.bytes(32), n_blocks)
    t = np.array([1.0 if a == "A" else 0.0 for a in arms])
    y = 70 + rng.normal(0, 10, len(t)) + effect * t
    y[rng.random(len(t)) < missing_a_extra * t] = np.nan     # only arm-A nights go missing, and only when asked
    spec = ea.TrialSpec("EXP-901", start, start + timedelta(days=len(t) - 1), mid_ms=8.0, n_redraws=999,
                        **{**DECLARED, **spec_kw})
    return spec, ea.TrialData(arms=arms, outcome=y)


def synthetic_method_review(n_redraws=(999,), alpha=(0.05,), fingerprint=None):
    """A complete synthetic METHOD_REVIEW for the running code (both halves structured)."""
    fingerprint = ef.inference_fingerprint() if fingerprint is None else fingerprint
    return dict(method=ea.INFERENCE_METHOD, interval_method=ea.INTERVAL_METHOD,
                independent_review={"reference": "synthetic-review-ref", "date": "2030-01-01",
                                    "reviewers": ("synthetic-reviewer-a", "synthetic-reviewer-b"),
                                    "verdicts": ("sound", "sound"), "reviewed_revision": "synthetic-revision",
                                    "inference_fingerprint": fingerprint},
                calibration_report={"reference": "synthetic-report-ref", "revision": "synthetic-revision",
                                    "inference_fingerprint": fingerprint, "harness_fingerprint": "synthetic-harness",
                                    "review_ready": True, "suite_run": "synthetic-suite-run"},
                n_redraws=n_redraws, alpha=alpha, block_designs=((4, 2),), n_blocks=(7, 58))


DESIGN = dict(block_len=4, n_a=2, n_blocks=58)     # the template's design, inside the synthetic record's range


REVIEWED = synthetic_method_review()


def _without(report, *keys):
    return {k: v for k, v in report.items() if k not in keys}


def test_decision_is_withheld_until_the_method_review_is_recorded():
    spec, data = _spec_and_data()
    for as_of in (spec.start, spec.planned_end):
        try:
            ea.analyze_trial(spec, data, as_of)
        except ea.AnalysisNotAllowed:
            continue
        raise AssertionError("the inference change must not open an early look")
    as_of = spec.planned_end + timedelta(days=1)
    status_keys = ("decision", "decision_firm", "decision_withheld", "inference")
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(calibration_report=None, independent_review=None)
        pending = ea.analyze_trial(spec, data, as_of)
        assert pending["decision_if_supported"] == "adopt_A" and pending["decision"] == "inconclusive"
        assert pending["decision_firm"] is False and len(pending["decision_withheld"]) == 1
        assert "independent statistical review" in pending["decision_withheld"][0]
        checks = {c["id"]: c for c in pending["inference"]["checks"]}
        assert checks["method_reviewed"]["status"] == "pending" and checks["missing_not_caused_by_arm"]["status"] == "ok"
        assert checks["model_justified"]["status"] == "ok" and checks["registered_method"]["status"] == "ok"
        assert pending["inference"]["method"] == ea.INFERENCE_METHOD and set(pending["inference"]["assumptions"]) == set(ea.ASSUMPTIONS)
        assert pending["inference"]["unsupported_outputs"] == [], "a pending review leaves every output supported"

        ea.METHOD_REVIEW.update(REVIEWED)
        firm = ea.analyze_trial(spec, data, as_of)
        assert firm["decision"] == "adopt_A" and firm["decision_firm"] is True and firm["decision_withheld"] == []
        assert _without(firm, *status_keys) == _without(pending, *status_keys), \
            "the review changes the verdict's status, never a number"

        # The review covers a configuration: another re-draw count or alpha stays pending.
        ea.METHOD_REVIEW.update(n_redraws=(10000,))
        other = ea.analyze_trial(spec, data, as_of)
        assert other["decision_firm"] is False and any("not this trial's 999" in r for r in other["decision_withheld"])
        ea.METHOD_REVIEW.update(REVIEWED)

        skewed_spec, skewed = _spec_and_data(missing_a_extra=0.35, seed=332)
        threat = ea.analyze_trial(skewed_spec, skewed, skewed_spec.planned_end + timedelta(days=1))
        assert threat["missingness"]["threat"] is True and threat["decision"] == "inconclusive"
        assert threat["decision_firm"] is False and any("missing nights" in r for r in threat["decision_withheld"])
        # Fisher's test needs missing nights not caused by the arm too: it is marked unsupported with the rest.
        outputs = threat["inference"]["outputs"]
        assert outputs["p_value_no_effect"]["supported"] is False and outputs["p_value"]["supported"] is False
        assert {"p_value", "p_value_no_effect", "ci_low / ci_high"} <= set(threat["inference"]["unsupported_outputs"])
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


def test_a_trial_without_a_declared_model_never_gets_a_firm_decision():
    # With the method globally reviewed, the per-trial support for the untestable assumptions still decides.
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(REVIEWED)
        for changes, check_id in ((dict(model_justification=None), "model_justified"),
                                  (dict(model_justification="   "), "model_justified"),
                                  (dict(carryover_nights=2), "model_justified"),
                                  (dict(carryover_nights=None), "model_justified"),
                                  (dict(inference_method=None), "registered_method"),
                                  (dict(inference_method="synthetic_other_v9"), "registered_method")):
            spec, data = _spec_and_data(**changes)
            report = ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))
            checks = {c["id"]: c for c in report["inference"]["checks"]}
            assert checks[check_id]["status"] == "failed" and report["decision_firm"] is False, changes
            assert report["decision"] == "inconclusive" and report["decision_if_supported"] == "adopt_A", changes
            assert checks[check_id]["reason"] in report["decision_withheld"], changes
            if check_id == "model_justified":
                outputs = report["inference"]["outputs"]
                assert outputs["p_value"]["supported"] is False and outputs["ci_low / ci_high"]["supported"] is False
                assert outputs["p_value_no_effect"]["supported"] is True, "Fisher's test does not need the effect model"
        # An A/A check needs no justification: identical arms satisfy the model with no effect.
        spec, data = _spec_and_data(effect=0.0, kind=ed.KIND_AA, model_justification=None)
        checks = {c["id"]: c for c in ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))["inference"]["checks"]}
        assert checks["model_justified"]["status"] == "ok"
        # Missing nights in an A/A check are judged by Fisher's exact test at alpha, not the 10-point
        # rule, which with a fifth of nights missing fires by chance on about half of 4-week checks; a
        # treatment trial keeps the rule.
        bounded = {"carryover_set_bounded": True}
        chance = {"threat": True, "fisher_p": 0.4}
        tied = {"threat": True, "fisher_p": 0.01}
        for missing, kind, status in ((chance, ed.KIND_AA, "ok"), (tied, ed.KIND_AA, "failed"),
                                      (chance, ed.KIND_TREATMENT, "failed"),
                                      ({"threat": False, "fisher_p": 0.01}, ed.KIND_TREATMENT, "ok")):
            judged = {c["id"]: c for c in ea.assumption_checks(bounded, missing, replace(spec, kind=kind))}
            assert judged["missing_not_caused_by_arm"]["status"] == status, (missing, kind)
        aa_reason = {c["id"]: c for c in ea.assumption_checks(bounded, tied, spec)}["missing_not_caused_by_arm"]["reason"]
        assert "Fisher exact p < 0.05" in aa_reason and "same instruction" in aa_reason
        # A check without a readable result fails closed (review round 3: the A/A branch failed open on a
        # missing fisher_p). Each also marks Fisher's test unsupported, like a failed check.
        for missing, kind in (({"threat": False}, ed.KIND_AA), ({"threat": False, "fisher_p": None}, ed.KIND_AA),
                              ({"threat": False, "fisher_p": float("nan")}, ed.KIND_AA),
                              ({"threat": False, "fisher_p": True}, ed.KIND_AA),
                              ({"threat": False, "fisher_p": "0.4"}, ed.KIND_AA), (None, ed.KIND_AA),
                              ({}, ed.KIND_TREATMENT), ({"threat": None}, ed.KIND_TREATMENT),
                              ({"threat": "no"}, ed.KIND_TREATMENT), (None, ed.KIND_TREATMENT)):
            judged = ea.assumption_checks(bounded, missing, replace(spec, kind=kind))
            assert {c["id"]: c for c in judged}["missing_not_caused_by_arm"]["status"] == "failed", (missing, kind)
            outputs = ea.output_semantics(0.001, 0.05)
            ea.unsupported_outputs(outputs, judged)
            assert outputs["p_value_no_effect"]["supported"] is False, (missing, kind)
        numpy_false = {"threat": np.False_, "fisher_p": 0.4}
        for kind in (ed.KIND_AA, ed.KIND_TREATMENT):
            judged = {c["id"]: c for c in ea.assumption_checks(bounded, numpy_false, replace(spec, kind=kind))}
            assert judged["missing_not_caused_by_arm"]["status"] == "ok", ("a readable result passes", kind)
        # Without a spec nothing is declared, so the protocol checks fail closed.
        closed = {c["id"]: c["status"] for c in ea.assumption_checks({"carryover_set_bounded": True}, {"threat": False})}
        assert closed["model_justified"] == "failed" and closed["registered_method"] == "failed"
    finally:
        ea.METHOD_REVIEW.clear()
        ea.METHOD_REVIEW.update(saved)


def test_sensitivity_and_secondary_outputs_state_their_assumptions():
    saved = dict(ea.METHOD_REVIEW)
    try:
        ea.METHOD_REVIEW.update(REVIEWED)
        spec, data = _spec_and_data(n_blocks=30, seed=333)
        rng = np.random.default_rng(334)
        t = np.array([1.0 if a == "A" else 0.0 for a in data.arms])
        n = len(t)
        # Built from earlier trial nights, like hrv_lag1: it depends on earlier arms.
        lag = np.concatenate([[70.0], data.outcome[:-1]])
        steady = 55 + rng.normal(0, 3, n)
        skewed = 55 + rng.normal(0, 3, n)
        skewed[(rng.random(n) < 0.45) & (t == 1)] = np.nan      # this series loses arm-A nights only
        data.covariates = {"lag": lag}
        data.secondary_outcomes = {"steady": steady, "skewed": skewed}
        report = ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))
        inference = report["inference"]
        outputs = inference["outputs"]
        expected = {"sensitivity.ln_outcome", "sensitivity.covariate_lag", "sensitivity.covariate_lag.p_value_no_effect",
                    "secondary_outcomes.steady", "secondary_outcomes.skewed"}
        assert expected <= set(outputs), sorted(outputs)
        assert "sensitivity.per_protocol" not in outputs, "only the fits the report carries get an entry"
        for name, entry in outputs.items():
            assert set(entry.get("needs", [])) <= set(inference["assumptions"]), name

        # ln(HRV): the model on the log scale, which cannot hold with the additive one unless nothing acts.
        ln_needs = outputs["sensitivity.ln_outcome"]["needs"]
        assert "constant_multiplicative_effects" in ln_needs and "constant_additive_effects" not in ln_needs
        # The covariate fit: its p-value and interval are labelled approximate; its Fisher p is the exact one.
        covariate = outputs["sensitivity.covariate_lag"]
        assert covariate["approximate"] is True and "not certified" in covariate["validity"]
        assert outputs["sensitivity.covariate_lag.p_value_no_effect"]["needs"] == ["randomized_schedule",
                                                                                     "missing_not_caused_by_arm"]
        assert 0 < report["sensitivity"]["covariate_lag"]["p_value_no_effect"] <= 1
        assert "approximate" not in outputs["p_value"], "the primary numbers are not approximate"

        # Each secondary series has its own missingness check: it marks only that series, never the decision.
        checks = {c["id"]: c for c in inference["checks"]}
        assert checks["missing_not_caused_by_arm:skewed"]["status"] == "failed"
        assert checks["missing_not_caused_by_arm:skewed"]["blocks_decision"] is False
        assert checks["missing_not_caused_by_arm:steady"]["status"] == "ok"
        assert report["secondary_outcomes"]["skewed"]["missingness"]["threat"] is True
        assert outputs["secondary_outcomes.skewed"]["supported"] is False
        assert outputs["secondary_outcomes.steady"]["supported"] is True
        assert inference["unsupported_outputs"] == ["secondary_outcomes.skewed"]
        assert report["decision_firm"] is True and report["decision"] == "adopt_A", \
            "a secondary outcome's missing nights never withhold the decision"

        # Without a declared model the sensitivity and secondary numbers go unsupported with the primary
        # ones; the covariate fit's Fisher p, which needs no effect model, stays supported.
        undeclared = replace(spec, model_justification=None)
        missing = {name: fit["missingness"] for name, fit in report["secondary_outcomes"].items()}
        checks = ea.assumption_checks(report, report["missingness"], undeclared, missing)
        again = ea.output_semantics(report["nuisance_beta"], 0.05, sensitivity=list(report["sensitivity"]),
                                    secondary=list(report["secondary_outcomes"]))
        unsupported = set(ea.unsupported_outputs(again, checks))
        assert {"p_value", "sensitivity.ln_outcome", "sensitivity.covariate_lag", "secondary_outcomes.steady",
                "secondary_outcomes.skewed"} <= unsupported
        assert again["sensitivity.covariate_lag.p_value_no_effect"]["supported"] is True
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
    # Doc 8.3 (method review): the near-singular stress scenario is supported and judged like the others.
    stress = [s for s in cal.SCENARIOS if s.stress]
    assert [s.name for s in stress] == ["near_singular"] and stress[0].supported and stress[0].direct == 0
    assert cal.REVIEW_MIN_STRESS < cal.REVIEW_MIN_SIMS
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
    assert first["passed"] is False and first["all_supported_scenarios"] is False, "a subset run never passes"
    assert cal.DEFAULT_REDRAWS == 10000, "the default calibrates the template's registered re-draw count"
    try:
        cal.run_calibration(n_sims=1, names=["not_a_scenario"])
    except ValueError as exc:
        assert "not_a_scenario" in str(exc)
    else:
        raise AssertionError("an unknown scenario must be refused")


# A bounded smoke run: the scheduled suite stops a test file after 10 minutes, and a full run is
# hours. The scenarios the audit named (no same-night effect with a carryover, with serial
# dependence, with missing nights and excluded blocks) plus one without carryover, 40 trials each
# at 499 re-draws, judged at the prespecified tolerance for 40 trials.
SMOKE = ["carryover_only", "carryover_only_serial", "missing_and_excluded", "effect_only"]
SMOKE_SIMS, SMOKE_REDRAWS = 40, 499


def test_smoke_scenarios_meet_their_prespecified_tolerances():
    report = cal.run_calibration(n_sims=SMOKE_SIMS, n_redraws=SMOKE_REDRAWS, seed=20261117, names=SMOKE)
    by_name = {s["name"]: s for s in report["scenarios"]}
    assert list(by_name) == SMOKE
    for name in SMOKE:
        scenario = by_name[name]
        assert scenario["supported"] is True and scenario["n_analysed"] >= SMOKE_SIMS - 4, name
        metrics = scenario["metrics"]
        assert {"direct_coverage", "carryover_coverage", "joint_type1", "enclosure"} <= set(metrics), name
        assert metrics["enclosure"]["rate"] == 0.0, (name, "an accepted value outside its interval")
        assert 0.0 <= scenario["informational"]["interval_unbounded"] <= 1.0, name
        assert all(m["ok"] is True for m in metrics.values()), (name, json.dumps(metrics))
        assert scenario["ok"] is True, name
        assert scenario["informational"]["joint_within_exact_band"] in (True, False)
    # The scenario the audit named: no same-night effect, a non-zero carryover.
    assert "direct_type1" in by_name["carryover_only"]["metrics"]
    assert "direct_type1" in by_name["carryover_only_serial"]["metrics"]
    assert "direct_type1" in by_name["missing_and_excluded"]["metrics"]
    assert "carryover_type1" in by_name["effect_only"]["metrics"]
    # Power at the planted effect is reported, never judged (the planning check overstates it).
    assert 0.0 <= by_name["effect_only"]["informational"]["direct_power"] <= 1.0
    assert "direct_power" not in by_name["carryover_only"]["informational"]
    # What the report may back: its own configuration, and a subset run never passes.
    assert report["covers"] == {"method": ea.INFERENCE_METHOD, "n_redraws": [SMOKE_REDRAWS], "alpha": [0.05],
                                "block_designs": [[cal.BLOCK_LEN, cal.N_A]], "n_blocks": [58, 58],
                                "inference_fingerprint": ef.inference_fingerprint()}
    assert report["harness_fingerprint"] == ef.harness_fingerprint() and report["revision"] is None
    assert report["all_supported_scenarios"] is False
    assert report["passed"] is False and report["review_ready"] is False


def test_review_ready_counts_analysed_trials_and_shards_merge():
    config = cal._config(alpha=0.05, beta=ea.nuisance_beta_for(10000), n_sims=1000, n_redraws=10000, seed=1,
                         revision="synthetic-revision")
    fake = [{"name": s.name, "supported": s.supported, "ok": True if s.supported else None, "n_analysed": 1000}
            for s in cal.SCENARIOS]
    assert cal._assemble(config, fake)["review_ready"] is True
    # A stress scenario expects unfittable trials: REVIEW_MIN_STRESS analysed is enough there.
    stressed = [{**x, "n_analysed": cal.REVIEW_MIN_STRESS} if x["name"] == "near_singular" else x for x in fake]
    assert cal._assemble(config, stressed)["review_ready"] is True
    stressed = [{**x, "n_analysed": cal.REVIEW_MIN_STRESS - 1} if x["name"] == "near_singular" else x for x in fake]
    assert cal._assemble(config, stressed)["review_ready"] is False
    # Skipped (unfittable) trials are bounded too: the rates hold only for the trials the model can fit.
    stressed = [{**x, "n_analysed": 500, "n_skipped": 400} if x["name"] == "near_singular" else x for x in fake]
    assert cal._assemble(config, stressed)["review_ready"] is True
    stressed = [{**x, "n_analysed": 500, "n_skipped": 600} if x["name"] == "near_singular" else x for x in fake]
    assert cal._assemble(config, stressed)["review_ready"] is False, "a stress scenario may skip at most half"
    skipping = [{**x, "n_skipped": 20} if x["name"] == "no_effect" else x for x in fake]
    assert cal._assemble(config, skipping)["review_ready"] is False, "an ordinary scenario may skip at most 1%"
    skipping = [{**x, "n_skipped": 10} if x["name"] == "no_effect" else x for x in fake]
    assert cal._assemble(config, skipping)["review_ready"] is True
    # Without a revision, or without a fingerprint of the code it ran, a report cannot back the record.
    assert cal._assemble({**config, "revision": None}, fake)["review_ready"] is False
    assert cal._assemble({**config, "inference_fingerprint": None}, fake)["review_ready"] is False
    assert config["inference_fingerprint"] == ef.inference_fingerprint() and config["revision"] == "synthetic-revision"
    fake[0] = {**fake[0], "n_analysed": 990}            # ten of the 1,000 trials could not be fitted
    short = cal._assemble(config, fake)
    assert short["passed"] is True and short["review_ready"] is False, "skipped trials do not count"

    # Shards run with one configuration give exactly the report one run would.
    names = ["no_effect", "carryover_only"]
    whole = json.loads(json.dumps(cal.run_calibration(n_sims=3, n_redraws=199, seed=8, names=names)))
    shards = [json.loads(json.dumps(cal.run_calibration(n_sims=3, n_redraws=199, seed=8, names=[name])))
              for name in reversed(names)]
    assert cal.merge_reports(shards) == whole
    for bad, words in ((shards + [shards[0]], "more than one shard"),
                       ([shards[0], {**shards[1], "seed": 9}], "seed"),
                       ([shards[0], {**shards[1], "n_redraws": 999}], "n_redraws"),
                       ([shards[0], {**shards[1], "inference_fingerprint": "0" * 64}], "inference_fingerprint"),
                       ([shards[0], {**shards[1], "revision": "synthetic-other-revision"}], "revision"),
                       ([{**shards[0], "method": "synthetic_other_v9"}], "synthetic_other_v9"),
                       ([], "nothing to merge")):
        try:
            cal.merge_reports(bad)
        except ValueError as exc:
            assert words in str(exc), (words, str(exc))
        else:
            raise AssertionError(f"merge must refuse: {words}")


def test_unsupported_scenarios_are_reported_without_a_verdict():
    report = cal.run_calibration(n_sims=20, n_redraws=SMOKE_REDRAWS, seed=20261118, names=UNSUPPORTED)
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
        cal.main(["--sims", "3", "--redraws", "199", "--seed", "9", "--scenario", "carryover_only",
                  "--out", str(Path(tmp) / "b.json")])
        merged_out = Path(tmp) / "merged.json"
        cal.main(["--merge", str(out), str(Path(tmp) / "b.json"), "--out", str(merged_out)])
        merged = json.loads(merged_out.read_text(encoding="utf-8"))
    assert saved["n_sims"] == 3 and saved["scenarios"][0]["name"] == "no_effect"
    assert saved["inference_fingerprint"] == ef.inference_fingerprint()
    assert code == (0 if saved["passed"] else 1)
    assert [s["name"] for s in merged["scenarios"]] == ["no_effect", "carryover_only"]


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
