"""N-of-1 experiment framework: seeded synthetic calibration of the end-of-trial inference.

docs/experiment-framework.md 8.2. Generates synthetic trials under the registered allocation
(experiment_design.generate_schedule) with explicit noise, carryover, missing nights and excluded
blocks, runs the registered fit and re-draws on each (experiment_analysis.redraw_fit), and reports
per scenario how often each test rejects a TRUE null and how often each interval covers the TRUE
value, against Monte Carlo tolerances fixed here before any run:

  direct_type1        p_value < alpha when tau = 0                     rate <= alpha + Z_MC * se
  direct_coverage     ci_low <= tau <= ci_high                          rate >= 1 - alpha - Z_MC * se
  carryover_type1     p_carryover < alpha when gamma = 0                rate <= alpha + Z_MC * se
  carryover_coverage  carryover_ci_low <= gamma <= carryover_ci_high    rate >= 1 - alpha - Z_MC * se
  joint_type1         joint sharp-null p at the true (tau, gamma)       rate <= alpha + Z_MC * se
  enclosure           an accepted value outside its interval            rate == 0 (no Monte Carlo slack)

  se = sqrt(alpha * (1 - alpha) / n), n = trials analysed in that scenario. The joint test is exact
  up to the discreteness of the re-draws, so its rate is also reported against alpha +- Z_MC * se
  (informational: a discrete or degenerate design may reject less often, which is not invalid).
  Power at the planted effect is informational too (the planning check overstates it, doc 7.3).

  enclosure checks the defining property of the certified interval (INTERVAL_METHOD) directly, not
  only its coverage: in every trial bb_p_value is probed at ENCLOSURE_STEPS scales beyond each
  finite end of both intervals, and at the true value and 0. Any of them accepted (p >= alpha)
  outside its interval is a violation. A finite set of probes is a strong regression check, not a
  proof (the proof is the strip bound, checked in tests/test_experiment_calibration.py). The share
  of trials with an infinite interval end is reported as information.

Each trial's re-draws use the deployed seeding rule, experiment_design.redraw_seed, on a synthetic
experiment id (calibration_redraw_seed). Like a real report's, that seed is a deterministic SHA-256
hash of public values, never derived from the secret allocation seed, so the report measures the
size and coverage of the deployed rule itself: the analysis's "at most alpha" for it rests on the
pseudo-randomness assumption of doc 8.1 (the Monte Carlo randomization p-value (1 + count) / (R + 1)),
and this report is the empirical evidence for it.

The report records the configuration it calibrated (method, alpha, re-draw count, the block shape
BLOCK_LEN / N_A, and the fewest blocks a supported scenario analysed and the most one scheduled) and
the code it ran:
the inference fingerprint (experiment_fingerprint) of the analysis it calibrated, the harness
fingerprint of this file and the revision (--revision, else $GITHUB_SHA). A METHOD_REVIEW entry
covers exactly that configuration and that inference code, and a trial's decision is firm only
when its alpha, re-draw count and block design are among them and the running code has the same
inference fingerprint (experiment_analysis.method_review_problem). A report without a revision or
whose inference code cannot be fingerprinted is never review-ready.

Supported scenarios satisfy the working model of experiment_analysis (one-night carryover,
constant additive effects, missing nights and excluded blocks independent of the arm) and must
meet every tolerance. Unsupported scenarios break one assumption on purpose; they are reported
without a tolerance, to show what the assumption protects and how often the report's own checks
withhold the decision. Each scenario also carries informational rates for the previous method
(Fisher's no-effect test and the interval that assumed no carryover), so the validation phase can
see whether the old mechanism mattered, and the share of re-draws that cannot separate the arm
from the carryover (singular_redraw_share; they count as extreme).

A stress scenario (stress=True: near_singular, from the method review, doc 8.3) is a supported
scenario on a deliberately hard design: few nights per block, so many re-draws are singular and
some trials cannot be fitted at all (skipped). It must meet every tolerance like the others; a
report needs REVIEW_MIN_STRESS of its trials analysed, not REVIEW_MIN_SIMS, to be review-ready.

Skipped trials are judged too (method review, doc 8.3): the rates are measured on the trials the
model can fit, while a real trial that cannot be fitted gets a final report with no decision
(experiment_report.py, not_analysable). So a report is review-ready only when no supported
scenario skips more than REVIEW_MAX_SKIP of its trials (REVIEW_MAX_SKIP_STRESS in a stress
scenario): a scenario where the model often cannot be fitted is not evidence for the method.

Synthetic inputs only, declared in SCENARIOS (round planning values, no personal data). Nothing
reads the database, the clock or a credential; the output holds rates and counts only.

Run in the scheduled validation phase, never before a merge (AGENTS.md "Read this first"), at the
registered re-draw count (10,000 in the template). A full run is many hours in one process, more
than one Actions job allows, so it runs on the PC or as one job per scenario, merged afterwards.
Scenario j's trial i always draws from default_rng([seed, j, i]) and calibration_redraw_seed(seed, j, i),
so a shard holds exactly the rows a full run would; --merge refuses shards of different
configurations or a scenario twice, and shards that another calibration harness ran: the merged
report's `covers` and review readiness come from this file's SCENARIOS, BLOCK_LEN / N_A and review
limits, so the shards' harness fingerprint must be the running one and each scenario's stored inputs
must equal its entry in SCENARIOS; their inference fingerprint must be the running code's too (merge
at the revision the shards ran, or run them again):
    python experiment_calibration.py --sims 1000 --redraws 10000 --alpha 0.05 --seed 20261116 --revision <commit> --out calibration.json
    python experiment_calibration.py --sims 1000 --redraws 10000 --seed 20261116 --revision <commit> --scenario no_effect --out s1.json
    python experiment_calibration.py --merge s1.json s2.json ... --out calibration.json
The scheduled test (tests/test_experiment_calibration.py) runs a bounded smoke subset only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

import numpy as np

import experiment_analysis as ea
import experiment_design as design
import experiment_fingerprint as fingerprint

ALPHA = 0.05
Z_MC = 3.0                  # Monte Carlo tolerance in binomial standard errors, fixed before any run
DEFAULT_SIMS = 1000
REVIEW_MIN_SIMS = 1000      # trials per scenario a report needs before it may back METHOD_REVIEW
REVIEW_MIN_STRESS = 500     # the same for a stress scenario, where unfittable trials are expected
REVIEW_MAX_SKIP = 0.01      # largest share of a supported scenario's trials the model may fail to fit
REVIEW_MAX_SKIP_STRESS = 0.5  # the same for a stress scenario
DEFAULT_REDRAWS = 10000     # the template's registered count; a trial is covered only at a calibrated count
DEFAULT_SEED = 20261116
BASELINE = 70.0             # synthetic outcome level (ms)
# Probes of the enclosure metric, in scales (Draws.scale) beyond an interval end: dense near the end,
# where a missed accepted region would sit, then out to the far tail. Fixed before any run.
ENCLOSURE_STEPS = (1e-6, 1e-3, 0.05, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 13.0, 20.0, 50.0, 1e2, 1e4, 1e6)
CALIBRATION_AS_OF = date(2026, 11, 16)   # the synthetic report date given to the deployed seeding rule
# The block shape every scenario uses: the one experiment_design.validate_protocol registers. The report's
# `covers` names it with the range of scheduled blocks its supported scenarios ran, and a trial with
# another design is not covered (experiment_analysis.method_review_problem).
BLOCK_LEN, N_A = 4, 2


@dataclass(frozen=True)
class Scenario:
    name: str
    supported: bool
    description: str
    direct: float = 0.0          # tau, same-night effect (ms)
    carryover: float = 0.0       # gamma, next-night effect (ms)
    carryover2: float = 0.0      # effect two nights later (ms); non-zero breaks one_night_carryover
    sigma: float = 20.0          # SD of the AR(1) noise (ms)
    rho: float = 0.5             # lag-1 autocorrelation of the noise
    drift: float = 0.0           # SD of a daily random-walk step on top (slow serial dependence)
    missing: float = 0.2         # share of nights without an outcome, at random
    missing_a_extra: float = 0.0  # extra missing share on arm-A nights; non-zero breaks missing_not_caused_by_arm
    excluded_blocks: int = 0     # whole blocks left out, chosen at random before any outcome
    n_blocks: int = 58
    stress: bool = False         # a deliberately hard design (unfittable trials expected; see the module doc)


SCENARIOS: tuple[Scenario, ...] = (
    Scenario("no_effect", True, "no effect at all"),
    Scenario("carryover_only", True, "no same-night effect, a next-night carryover", carryover=8.0),
    Scenario("carryover_only_serial", True,
             "no same-night effect, a negative carryover, strong autocorrelation and slow drift",
             carryover=-12.0, rho=0.8, drift=1.0),
    Scenario("missing_and_excluded", True,
             "no same-night effect, a carryover, 35% missing nights and 6 excluded blocks",
             carryover=6.0, missing=0.35, excluded_blocks=6),
    Scenario("effect_and_carryover", True, "a same-night effect and a carryover", direct=8.0, carryover=4.0),
    Scenario("effect_only", True, "a same-night effect, no carryover", direct=8.0),
    Scenario("short_trial", True, "no effect, 7 blocks (an A/A check's length)", n_blocks=7),
    Scenario("two_night_carryover", False,
             "no same-night effect, the arm also acts two nights later (breaks one_night_carryover)",
             carryover=6.0, carryover2=6.0),
    Scenario("arm_dependent_missing", False,
             "no effect, nights after arm A are missing more often (breaks missing_not_caused_by_arm)",
             missing=0.1, missing_a_extra=0.25),
    # Doc 8.3 (method review, gpt-5.2): near-singular designs and many singular re-draws. About two of
    # four nights per block survive, so after the block and weekday terms little is left to separate the
    # arm from the carryover: many re-draws are singular (counted as extreme) and some trials are skipped.
    Scenario("near_singular", True,
             "no same-night effect, a carryover, 10 blocks with half the nights missing (a near-singular design)",
             carryover=6.0, missing=0.5, n_blocks=10, stress=True),
)


def _ar1(rng: np.random.Generator, n: int, sigma: float, rho: float) -> np.ndarray:
    e = np.empty(n)
    e[0] = rng.normal(0, sigma)
    shocks = rng.normal(0, sigma * math.sqrt(1 - rho ** 2), n)
    for i in range(1, n):
        e[i] = rho * e[i - 1] + shocks[i]
    return e


def simulate_trial(s: Scenario, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray, set[int]]:
    """One synthetic trial: (assignment 0/1, outcome with NaN for missing nights, weekday, excluded blocks)."""
    n = s.n_blocks * BLOCK_LEN
    arms = design.generate_schedule(rng.bytes(design.SEED_BYTES), s.n_blocks, BLOCK_LEN, N_A)
    t = np.array([1.0 if a == "A" else 0.0 for a in arms])
    lag1 = np.concatenate([[0.0], t[:-1]])          # the day before the trial is the control arm
    lag2 = np.concatenate([[0.0, 0.0], t[:-2]])
    noise = _ar1(rng, n, s.sigma, s.rho)
    if s.drift:
        noise = noise + np.cumsum(rng.normal(0, s.drift, n))
    y = BASELINE + noise + s.direct * t + s.carryover * lag1 + s.carryover2 * lag2
    y[rng.random(n) < s.missing + s.missing_a_extra * t] = np.nan
    excluded = set(int(b) for b in rng.choice(s.n_blocks, size=s.excluded_blocks, replace=False)) if s.excluded_blocks else set()
    dow = (np.arange(n) + int(rng.integers(7))) % 7
    return t, y, dow, excluded


def legacy_interval(draws: ea.Draws, alpha: float) -> tuple[float, float]:
    """The interval before INFERENCE_METHOD: it inverted the joint test with the carryover set to 0."""
    return ea.invert_p_value(lambda c: ea.joint_p_value(draws, 0, c, 0.0), float(draws.obs[0]), alpha, draws.scale(0))


def calibration_redraw_seed(seed: int, scenario_index: int, trial_index: int) -> int:
    """The re-draw seed of synthetic trial i of scenario j: the deployed rule (experiment_design.redraw_seed)
    on a synthetic experiment id, so the calibration samples re-draws the way a real report does."""
    return design.redraw_seed(f"CAL-{seed}-{scenario_index}-{trial_index}", CALIBRATION_AS_OF)


def enclosure_violation(draws: ea.Draws, comp: int, low: float, high: float, alpha: float, beta: float,
                        also: tuple[float, ...] = ()) -> bool:
    """True when the Berger-Boos test of coefficient `comp` accepts (p >= alpha) a value outside
    [low, high]: a probe ENCLOSURE_STEPS scales beyond a finite end, or one of `also` (the true value,
    0). The certified interval must never allow it; the stepped-out interval of the previous method can."""
    scale = draws.scale(comp)
    probes = [float(v) for v in also if not (low <= v <= high)]
    for end, direction in ((low, -1.0), (high, 1.0)):
        if math.isfinite(end):
            probes += [end + direction * scale * k for k in ENCLOSURE_STEPS]
    return any(ea.bb_p_value(draws, comp, v, beta)[0] >= alpha for v in probes)


def one_trial(s: Scenario, rng: np.random.Generator, *, n_redraws: int, alpha: float, beta: float,
              redraw_seed: int) -> dict[str, Any] | None:
    """Every quantity the metrics need for one synthetic trial; None when the model cannot be fitted."""
    t, y, dow, excluded = simulate_trial(s, rng)
    try:
        draws, _ = ea.redraw_fit(t, y, dow, block_len=BLOCK_LEN, n_a=N_A, excluded_blocks=excluded,
                                 n_redraws=n_redraws, redraw_seed=redraw_seed)
    except ValueError:
        return None
    lo, hi = ea.interval(draws, 0, alpha, beta)
    clo, chi = ea.interval(draws, 1, alpha, beta)
    llo, lhi = legacy_interval(draws, alpha)
    carry_set = ea.nuisance_set(draws, 0, 0.0, beta)
    in_scope = ~np.isin(np.arange(len(t)) // BLOCK_LEN, list(excluded))
    return {
        "p_direct": ea.bb_p_value(draws, 0, 0.0, beta)[0],
        "p_carryover": ea.bb_p_value(draws, 1, 0.0, beta)[0],
        "p_joint_truth": ea.joint_p_value(draws, 0, s.direct, s.carryover),
        "p_no_effect": ea.joint_p_value(draws, 0, 0.0, 0.0),
        "direct_covered": lo <= s.direct <= hi,
        "carryover_covered": clo <= s.carryover <= chi,
        "legacy_covered": llo <= s.direct <= lhi,
        "enclosure_violation": (enclosure_violation(draws, 0, lo, hi, alpha, beta, (s.direct, 0.0))
                                or enclosure_violation(draws, 1, clo, chi, alpha, beta, (s.carryover, 0.0))),
        "interval_unbounded": not all(math.isfinite(v) for v in (lo, hi, clo, chi)),
        "singular_redraw_share": float(np.mean(np.isnan(draws.a[:, 0]))),
        "carryover_set_unbounded": not (math.isfinite(carry_set[0]) and math.isfinite(carry_set[1])),
        "missingness_withholds": bool(ea.missingness_check(t[in_scope], np.isnan(y[in_scope]))["threat"]),
    }


def tolerances(n: int, alpha: float = ALPHA, z: float = Z_MC) -> dict[str, float]:
    se = math.sqrt(alpha * (1 - alpha) / max(n, 1))
    return {"rejection_max": alpha + z * se, "coverage_min": 1 - alpha - z * se,
            "exact_low": max(0.0, alpha - z * se), "exact_high": alpha + z * se}


def _metric(rate: float, ok: bool | None, **limits: float) -> dict[str, Any]:
    return {"rate": round(rate, 4), **{k: round(v, 4) for k, v in limits.items()}, "ok": ok}


def summarize(s: Scenario, rows: list[dict[str, Any]], skipped: int, alpha: float = ALPHA,
              z: float = Z_MC) -> dict[str, Any]:
    """Metrics of one scenario. A metric's `ok` is None when it carries no tolerance (unsupported
    scenario, or informational)."""
    n = len(rows)
    tol = tolerances(n, alpha, z)

    def rate(key: str, test=lambda v: bool(v)) -> float:
        return float(np.mean([test(r[key]) for r in rows])) if rows else float("nan")

    judged = s.supported and n > 0
    metrics: dict[str, Any] = {}
    if s.direct == 0:
        r = rate("p_direct", lambda p: p < alpha)
        metrics["direct_type1"] = _metric(r, (r <= tol["rejection_max"]) if judged else None, max=tol["rejection_max"])
    r = rate("direct_covered")
    metrics["direct_coverage"] = _metric(r, (r >= tol["coverage_min"]) if judged else None, min=tol["coverage_min"])
    if s.carryover == 0 and s.carryover2 == 0:
        r = rate("p_carryover", lambda p: p < alpha)
        metrics["carryover_type1"] = _metric(r, (r <= tol["rejection_max"]) if judged else None, max=tol["rejection_max"])
    r = rate("carryover_covered")
    metrics["carryover_coverage"] = _metric(r, (r >= tol["coverage_min"]) if judged else None, min=tol["coverage_min"])
    joint = rate("p_joint_truth", lambda p: p < alpha)
    metrics["joint_type1"] = _metric(joint, (joint <= tol["rejection_max"]) if judged else None, max=tol["rejection_max"])
    # The certificate is exact, not a Monte Carlo rate: one accepted value outside its interval fails it.
    r = rate("enclosure_violation")
    metrics["enclosure"] = _metric(r, (r == 0.0) if judged else None, max=0.0)
    informational = {
        "joint_within_exact_band": bool(tol["exact_low"] <= joint <= tol["exact_high"]) if n else None,
        "exact_band": [round(tol["exact_low"], 4), round(tol["exact_high"], 4)],
        "no_effect_test_rejects": round(rate("p_no_effect", lambda p: p < alpha), 4),
        "legacy_interval_coverage": round(rate("legacy_covered"), 4),
        "carryover_set_unbounded": round(rate("carryover_set_unbounded"), 4),
        # An interval end left infinite: the nights cannot bound it, or its certification budget ran out.
        "interval_unbounded": round(rate("interval_unbounded"), 4),
        # Mean share of re-draws that cannot separate the arm from the carryover (counted as extreme).
        "singular_redraw_share": (round(float(np.mean([r["singular_redraw_share"] for r in rows])), 4)
                                  if rows else float("nan")),
        "missingness_check_withholds": round(rate("missingness_withholds"), 4),
    }
    if s.direct != 0:
        informational["direct_power"] = round(rate("p_direct", lambda p: p < alpha), 4)
    if s.carryover != 0:
        informational["carryover_power"] = round(rate("p_carryover", lambda p: p < alpha), 4)
    verdicts = [m["ok"] for m in metrics.values() if m["ok"] is not None]
    return {
        "name": s.name, "supported": s.supported, "description": s.description,
        "inputs": asdict(s), "n_analysed": n, "n_skipped": skipped,
        "metrics": metrics, "informational": informational,
        "ok": (all(verdicts) and n > 0) if s.supported else None,
    }


def run_calibration(*, n_sims: int = DEFAULT_SIMS, n_redraws: int = DEFAULT_REDRAWS, seed: int = DEFAULT_SEED,
                    names: list[str] | None = None, alpha: float = ALPHA,
                    beta: float | None = None, revision: str | None = None) -> dict[str, Any]:
    """The calibration report. Deterministic in (seed, n_sims, n_redraws, names): trial i of scenario
    j draws its synthetic trial from numpy's default_rng([seed, j, i]) and its re-draws from
    calibration_redraw_seed(seed, j, i). beta None = the registered level for n_redraws. revision
    names the commit the run used (recorded, never read: a report without one is not review-ready)."""
    beta = ea.nuisance_beta_for(n_redraws) if beta is None else beta
    chosen = [(j, s) for j, s in enumerate(SCENARIOS) if names is None or s.name in names]
    unknown = set(names or ()) - {s.name for s in SCENARIOS}
    if unknown:
        raise ValueError("unknown scenario(s): " + ", ".join(sorted(unknown)))
    scenarios = []
    for j, s in chosen:
        rows, skipped = [], 0
        for i in range(n_sims):
            row = one_trial(s, np.random.default_rng([seed, j, i]), n_redraws=n_redraws, alpha=alpha, beta=beta,
                            redraw_seed=calibration_redraw_seed(seed, j, i))
            if row is None:
                skipped += 1
            else:
                rows.append(row)
        scenarios.append(summarize(s, rows, skipped, alpha))
    return _assemble(_config(alpha=alpha, beta=beta, n_sims=n_sims, n_redraws=n_redraws, seed=seed,
                             revision=revision), scenarios)


# The fields that must agree for shards to be merged into one report.
CONFIG_KEYS = ("method", "interval_method", "alpha", "nuisance_beta", "z_mc", "n_sims", "n_redraws", "seed",
               "generator", "fingerprint_version", "inference_fingerprint", "harness_fingerprint", "revision")


def _config(*, alpha: float, beta: float, n_sims: int, n_redraws: int, seed: int,
            revision: str | None = None) -> dict[str, Any]:
    return {"method": ea.INFERENCE_METHOD, "interval_method": ea.INTERVAL_METHOD,
            "alpha": alpha, "nuisance_beta": beta, "z_mc": Z_MC,
            "n_sims": n_sims, "n_redraws": n_redraws, "seed": seed, "generator": design.GENERATOR,
            # The code this report calibrated (METHOD_REVIEW's calibration_report copies these).
            "fingerprint_version": fingerprint.FINGERPRINT_VERSION,
            "inference_fingerprint": fingerprint.inference_fingerprint(),
            "harness_fingerprint": fingerprint.harness_fingerprint(),
            "revision": revision.strip() if isinstance(revision, str) and revision.strip() else None}


def _review_limits(name: str) -> tuple[int, float]:
    """(trials it needs analysed, largest share it may skip) before a supported scenario lets the
    report back METHOD_REVIEW."""
    stress = {s.name: s.stress for s in SCENARIOS}.get(name, False)
    return (REVIEW_MIN_STRESS, REVIEW_MAX_SKIP_STRESS) if stress else (REVIEW_MIN_SIMS, REVIEW_MAX_SKIP)


def _review_counts_ok(summary: dict[str, Any]) -> bool:
    minimum, max_skip = _review_limits(summary["name"])
    analysed, skipped = int(summary["n_analysed"]), int(summary.get("n_skipped", 0))
    return analysed >= minimum and skipped <= max_skip * (analysed + skipped)


def _assemble(config: dict[str, Any], scenarios: list[dict[str, Any]]) -> dict[str, Any]:
    """The report around per-scenario summaries, in SCENARIOS order."""
    order = {s.name: j for j, s in enumerate(SCENARIOS)}
    scenarios = sorted(scenarios, key=lambda x: order[x["name"]])
    supported = [x for x in scenarios if x["supported"]]
    every_supported = {s.name for s in SCENARIOS if s.supported} <= {x["name"] for x in scenarios}
    passed = bool(supported) and every_supported and all(x["ok"] for x in supported)
    by_name = {s.name: s for s in SCENARIOS}
    ran = [by_name[x["name"]] for x in supported]
    return {
        **config,
        # What a METHOD_REVIEW entry may cover once this report passed with every supported scenario:
        # its configuration, its block shape and n_blocks = (fewest blocks a supported scenario analysed,
        # most blocks one scheduled); excluded blocks are not analysed.
        "covers": {"method": config["method"], "n_redraws": [config["n_redraws"]], "alpha": [config["alpha"]],
                   "block_designs": [[BLOCK_LEN, N_A]],
                   "n_blocks": ([min(s.n_blocks - s.excluded_blocks for s in ran), max(s.n_blocks for s in ran)]
                                if ran else []),
                   "inference_fingerprint": config.get("inference_fingerprint")},
        "all_supported_scenarios": every_supported,
        "scenarios": scenarios,
        "passed": passed,
        # Only a full run may back a METHOD_REVIEW entry: every supported scenario, at least
        # REVIEW_MIN_SIMS trials ANALYSED in each (REVIEW_MIN_STRESS in a stress scenario; skipped,
        # unfittable trials do not count; the tolerances widen as the count falls) and at most
        # REVIEW_MAX_SKIP of them skipped (REVIEW_MAX_SKIP_STRESS), a recorded revision, an inference
        # fingerprint and a harness fingerprint, so the record can name the code it covers and the harness
        # whose scenarios and limits it was judged by.
        "review_ready": (passed and all(_review_counts_ok(x) for x in supported)
                         and bool(config.get("revision")) and bool(config.get("inference_fingerprint"))
                         and bool(config.get("harness_fingerprint"))),
    }


def merge_reports(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """One report from shards run with the same configuration (each with its own scenarios).
    Refuses shards that disagree on any CONFIG_KEYS field or that both hold a scenario, and shards
    that another calibration harness ran (review PIPE06-FOLLOWUP-R2): _assemble builds `covers` and
    review readiness from this file's SCENARIOS, BLOCK_LEN / N_A and review limits, so archived shards
    merged after a harness change would claim designs and limits they never ran. Their harness
    fingerprint must therefore be the running one (a missing or unreadable one refuses too), and each
    scenario's stored inputs must equal its entry in SCENARIOS. Their inference fingerprint must be
    the running code's as well, since only such a report can back METHOD_REVIEW."""
    if not reports:
        raise ValueError("nothing to merge")
    config = {key: reports[0].get(key) for key in CONFIG_KEYS}
    if config["method"] != ea.INFERENCE_METHOD or config["interval_method"] != ea.INTERVAL_METHOD:
        raise ValueError(f"the shards calibrated {config['method']!r} / {config['interval_method']!r}, "
                         f"not {ea.INFERENCE_METHOD} / {ea.INTERVAL_METHOD}")
    scenarios: list[dict[str, Any]] = []
    for index, report in enumerate(reports):
        other = {key: report.get(key) for key in CONFIG_KEYS}
        if other != config:
            differs = sorted(key for key in CONFIG_KEYS if other[key] != config[key])
            raise ValueError(f"shard {index + 1} has another configuration ({', '.join(differs)})")
        scenarios += report.get("scenarios") or []
    running = fingerprint.harness_fingerprint()
    recorded = config["harness_fingerprint"]
    if not running:
        raise ValueError("the running calibration harness's source cannot be read, so the shards' harness "
                         "fingerprint cannot be checked against it")
    if not (isinstance(recorded, str) and recorded.strip()):
        raise ValueError("the shards record no harness fingerprint, so the harness that ran them cannot be checked")
    if recorded != running:
        raise ValueError(f"the shards ran another calibration harness (fingerprint {recorded[:12]}; the running harness "
                         f"is {running[:12]}): the merged report would take its coverage and review readiness from "
                         "this harness's scenarios, block design and limits, so merge them at the revision that ran "
                         "them or run them again")
    # Refused here too (method review, round 6): METHOD_REVIEW would refuse such a report anyway, since its
    # inference fingerprint must be the running code's, so a merge under other inference code is never useful.
    live = fingerprint.inference_fingerprint()
    calibrated = config["inference_fingerprint"]
    if not live:
        raise ValueError("the running inference code's source cannot be read, so the shards' inference fingerprint "
                         "cannot be checked against it")
    if calibrated != live:
        shown = calibrated[:12] if isinstance(calibrated, str) and calibrated.strip() else "none"
        raise ValueError(f"the shards calibrated other inference code (fingerprint {shown}; the running code is "
                         f"{live[:12]}), so the merged report could never back METHOD_REVIEW for it: merge them at the "
                         "revision that ran them or run them again")
    names = [x["name"] for x in scenarios]
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise ValueError("a scenario is in more than one shard: " + ", ".join(repeated))
    unknown = sorted(set(names) - {s.name for s in SCENARIOS})
    if unknown:
        raise ValueError("unknown scenario(s): " + ", ".join(unknown))
    by_name = {s.name: s for s in SCENARIOS}
    for x in scenarios:
        expected = by_name[x["name"]]
        if x.get("inputs") != asdict(expected) or x.get("supported") is not expected.supported:
            raise ValueError(f"scenario {x['name']} in the shards was run with other inputs than the running harness's "
                             "SCENARIOS entry, so it cannot be merged as that scenario")
    return _assemble(config, scenarios)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seeded synthetic calibration of the N-of-1 trial inference")
    parser.add_argument("--sims", type=int, default=DEFAULT_SIMS, help="synthetic trials per scenario")
    parser.add_argument("--redraws", type=int, default=DEFAULT_REDRAWS, help="re-draws per trial")
    parser.add_argument("--alpha", type=float, default=ALPHA, help="the trials' alpha")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--scenario", action="append", help="run only this scenario (repeatable)")
    parser.add_argument("--merge", nargs="+", metavar="SHARD", help="merge shard reports instead of running")
    parser.add_argument("--out", help="also write the JSON report to this file")
    parser.add_argument("--revision", default=os.environ.get("GITHUB_SHA"),
                        help="the commit this run uses (default $GITHUB_SHA); a report without one is not review-ready")
    args = parser.parse_args(argv)
    if args.merge:
        shards = []
        for path in args.merge:
            with open(path, encoding="utf-8") as fh:
                shards.append(json.load(fh))
        report = merge_reports(shards)
    else:
        report = run_calibration(n_sims=args.sims, n_redraws=args.redraws, seed=args.seed, names=args.scenario,
                                 alpha=args.alpha, revision=args.revision)
    text = json.dumps(report, indent=2, sort_keys=False)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
