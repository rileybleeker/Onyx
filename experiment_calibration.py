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
  joint_exact         joint sharp-null p at the true (tau, gamma)       |rate - alpha| <= Z_MC * se

  se = sqrt(alpha * (1 - alpha) / n), n = trials analysed in that scenario.

Supported scenarios satisfy the working model of experiment_analysis (one-night carryover,
constant additive effects, missing nights and excluded blocks independent of the arm) and must
meet every tolerance. Unsupported scenarios break one assumption on purpose; they are reported
without a tolerance, to show what the assumption protects and how often the report's own checks
withhold the decision. Each scenario also carries informational rates for the previous method
(Fisher's no-effect test and the interval that assumed no carryover), so the validation phase can
see whether the old mechanism mattered.

Synthetic inputs only, declared in SCENARIOS (round planning values, no personal data). Nothing
reads the database, the clock or a credential; the output holds rates and counts only.

Run in the scheduled validation phase, never before a merge (AGENTS.md "Read this first"):
    python experiment_calibration.py --sims 1000 --redraws 999 --seed 20261116 --out calibration.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

import experiment_analysis as ea
import experiment_design as design

ALPHA = 0.05
Z_MC = 3.0                  # Monte Carlo tolerance in binomial standard errors, fixed before any run
DEFAULT_SIMS = 1000
DEFAULT_REDRAWS = 999       # the protocol minimum (experiment_design.validate_protocol); validity holds at any count
DEFAULT_SEED = 20261116
BASELINE = 70.0             # synthetic outcome level (ms)


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
    n = s.n_blocks * 4
    arms = design.generate_schedule(rng.bytes(design.SEED_BYTES), s.n_blocks)
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


def one_trial(s: Scenario, rng: np.random.Generator, *, n_redraws: int, alpha: float, beta: float) -> dict[str, Any] | None:
    """Every quantity the metrics need for one synthetic trial; None when the model cannot be fitted."""
    t, y, dow, excluded = simulate_trial(s, rng)
    try:
        draws, _ = ea.redraw_fit(t, y, dow, excluded_blocks=excluded, n_redraws=n_redraws,
                                 redraw_seed=int(rng.integers(0, 2 ** 62)))
    except ValueError:
        return None
    lo, hi = ea.interval(draws, 0, alpha, beta)
    clo, chi = ea.interval(draws, 1, alpha, beta)
    llo, lhi = legacy_interval(draws, alpha)
    carry_set = ea.nuisance_set(draws, 0, 0.0, beta)
    in_scope = ~np.isin(np.arange(len(t)) // 4, list(excluded))
    return {
        "p_direct": ea.bb_p_value(draws, 0, 0.0, beta)[0],
        "p_carryover": ea.bb_p_value(draws, 1, 0.0, beta)[0],
        "p_joint_truth": ea.joint_p_value(draws, 0, s.direct, s.carryover),
        "p_no_effect": ea.joint_p_value(draws, 0, 0.0, 0.0),
        "direct_covered": lo <= s.direct <= hi,
        "carryover_covered": clo <= s.carryover <= chi,
        "legacy_covered": llo <= s.direct <= lhi,
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
    r = rate("p_joint_truth", lambda p: p < alpha)
    metrics["joint_exact"] = _metric(r, (tol["exact_low"] <= r <= tol["exact_high"]) if judged else None,
                                     low=tol["exact_low"], high=tol["exact_high"])
    informational = {
        "no_effect_test_rejects": round(rate("p_no_effect", lambda p: p < alpha), 4),
        "legacy_interval_coverage": round(rate("legacy_covered"), 4),
        "carryover_set_unbounded": round(rate("carryover_set_unbounded"), 4),
        "missingness_check_withholds": round(rate("missingness_withholds"), 4),
    }
    verdicts = [m["ok"] for m in metrics.values() if m["ok"] is not None]
    return {
        "name": s.name, "supported": s.supported, "description": s.description,
        "inputs": asdict(s), "n_analysed": n, "n_skipped": skipped,
        "metrics": metrics, "informational": informational,
        "ok": (all(verdicts) and n > 0) if s.supported else None,
    }


def run_calibration(*, n_sims: int = DEFAULT_SIMS, n_redraws: int = DEFAULT_REDRAWS, seed: int = DEFAULT_SEED,
                    names: list[str] | None = None, alpha: float = ALPHA,
                    beta: float | None = None) -> dict[str, Any]:
    """The calibration report. Deterministic in (seed, n_sims, n_redraws, names): trial i of scenario
    j draws from numpy's default_rng([seed, j, i]). beta None = the registered level for n_redraws."""
    beta = ea.nuisance_beta_for(n_redraws) if beta is None else beta
    chosen = [(j, s) for j, s in enumerate(SCENARIOS) if names is None or s.name in names]
    unknown = set(names or ()) - {s.name for s in SCENARIOS}
    if unknown:
        raise ValueError("unknown scenario(s): " + ", ".join(sorted(unknown)))
    scenarios = []
    for j, s in chosen:
        rows, skipped = [], 0
        for i in range(n_sims):
            row = one_trial(s, np.random.default_rng([seed, j, i]), n_redraws=n_redraws, alpha=alpha, beta=beta)
            if row is None:
                skipped += 1
            else:
                rows.append(row)
        scenarios.append(summarize(s, rows, skipped, alpha))
    supported = [x for x in scenarios if x["supported"]]
    return {
        "method": ea.INFERENCE_METHOD,
        "alpha": alpha, "nuisance_beta": beta, "z_mc": Z_MC,
        "n_sims": n_sims, "n_redraws": n_redraws, "seed": seed,
        "generator": design.GENERATOR,
        "scenarios": scenarios,
        "passed": bool(supported) and all(x["ok"] for x in supported),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seeded synthetic calibration of the N-of-1 trial inference")
    parser.add_argument("--sims", type=int, default=DEFAULT_SIMS, help="synthetic trials per scenario")
    parser.add_argument("--redraws", type=int, default=DEFAULT_REDRAWS, help="re-draws per trial")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--scenario", action="append", help="run only this scenario (repeatable)")
    parser.add_argument("--out", help="also write the JSON report to this file")
    args = parser.parse_args(argv)
    report = run_calibration(n_sims=args.sims, n_redraws=args.redraws, seed=args.seed, names=args.scenario)
    text = json.dumps(report, indent=2, sort_keys=False)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
