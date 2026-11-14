"""N-of-1 experiment framework: the pre-registered end-of-trial analysis (pure numpy / scipy).

Design: docs/experiment-framework.md section 8. No database access, no clock; the caller passes
the as-of date. Nothing here is imported by hrv_analysis.py or causal_inference.py, and the arm
never enters the behavioral matrix (doc 8, "Relation to the observational pipeline").

Model (daily permuted-block design), on nights that have the outcome:

    Y_D = block_D + b0 * T_D + b1 * T_(D-1) + day_of_week_D + e_D

  T_D     1 on arm-A days, 0 on arm-B days (the assignment, not what was done: intention to treat)
  T_(D-1) yesterday's assignment; the day before the trial counts as the control arm
  b0      same-night effect (primary estimand), b1 carryover into the next night

Inference is a randomization test: the block orderings are re-drawn by the registered procedure
(experiment_design.redraw_blocks), the model is refitted on the same nights, and the p-value is
the share of re-draws whose |b0| is at least the observed one. It uses only the random
assignment, so autocorrelated HRV does not break it. The interval inverts that test.

analyze_trial() REFUSES to run before the pre-registered end (Riley's decision 1, doc section 13:
analyse only at the pre-registered end). A trial stopped early is reported as such.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np

import experiment_design as design

REDRAW_CHUNK = 2000


class AnalysisNotAllowed(RuntimeError):
    """The trial has not reached its pre-registered end; no effect estimate may be computed."""


@dataclass
class TrialSpec:
    experiment_id: str
    start: date
    planned_end: date
    mid_ms: float
    block_len: int = 4
    n_a: int = 2
    alpha: float = 0.05
    n_redraws: int = 10000
    control_arm: str = "B"
    stopped_on: date | None = None        # set when Riley stopped the trial early

    @property
    def n_days(self) -> int:
        return (self.planned_end - self.start).days + 1


@dataclass
class TrialData:
    """One entry per scheduled behavioral day, in order from the first day."""
    arms: list[str]                                   # 'A' / 'B' as scheduled
    outcome: np.ndarray                               # HRV of the sleep closing the day; NaN = no outcome
    excluded_blocks: set[int] = field(default_factory=set)   # whole blocks left out (flight / declared pause)
    adherent: np.ndarray | None = None                # optional bool per day, for the per-protocol estimate


def assert_reportable(spec: TrialSpec, as_of: date) -> date:
    """Return the last behavioral day the analysis may use, or raise AnalysisNotAllowed.

    The outcome of day D is the HRV Riley wakes up to on clock day D + 1, so the trial is
    complete when as_of is after the planned end. A trial stopped early is analysable once the
    stop day has passed (and is labelled stopped_early in the report).
    """
    if spec.stopped_on is not None:
        if as_of <= spec.stopped_on:
            raise AnalysisNotAllowed(
                f"{spec.experiment_id} was stopped on {spec.stopped_on}; its last night is not in until the day after")
        return min(spec.stopped_on, spec.planned_end)
    if as_of <= spec.planned_end:
        days_left = (spec.planned_end - as_of).days + 1
        raise AnalysisNotAllowed(
            f"{spec.experiment_id} ends on {spec.planned_end} ({days_left} day(s) left as of {as_of}). "
            "The effect is analysed only at the pre-registered end; progress counts are the only output before it.")
    return spec.planned_end


# ---------------------------------------------------------------------------
# Linear algebra
# ---------------------------------------------------------------------------

def _nuisance_basis(block_ids: np.ndarray, dow: np.ndarray, extra: np.ndarray | None = None) -> np.ndarray:
    """Orthonormal basis of the nuisance columns (block dummies, weekday dummies, extra covariates)."""
    blocks = np.unique(block_ids)
    cols = [(block_ids == b).astype(float) for b in blocks]
    cols += [(dow == d).astype(float) for d in range(7)]
    z = np.column_stack(cols)
    if extra is not None:
        z = np.column_stack([z, np.asarray(extra, dtype=float).reshape(len(block_ids), -1)])
    u, s, _ = np.linalg.svd(z, full_matrices=False)
    return u[:, s > s.max() * 1e-10]


def _resid(q: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Rows of m (or the vector m) with the nuisance space projected out."""
    return m - (m @ q) @ q.T


def _solve(tr: np.ndarray, lr: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """OLS of each column of ys (n, k) on [tr, lr] per draw. tr, lr: (R, n). Returns (R, k, 2):
    [..., 0] = b0, [..., 1] = b1. A singular draw returns NaN."""
    a = np.einsum("rn,rn->r", tr, tr)
    b = np.einsum("rn,rn->r", tr, lr)
    c = np.einsum("rn,rn->r", lr, lr)
    u = tr @ ys
    v = lr @ ys
    det = a * c - b * b
    ok = det > 1e-9 * np.maximum(a * c, 1e-300)
    det = np.where(ok, det, np.nan)[:, None]
    b0 = (c[:, None] * u - b[:, None] * v) / det
    b1 = (a[:, None] * v - b[:, None] * u) / det
    return np.stack([b0, b1], axis=-1)


def _lagged(t: np.ndarray, pre_trial: int) -> np.ndarray:
    """Yesterday's assignment for each day (rows = schedules)."""
    lag = np.empty_like(t)
    lag[..., 0] = pre_trial
    lag[..., 1:] = t[..., :-1]
    return lag


def _hac_se(x: np.ndarray, resid: np.ndarray, n_params: int, maxlags: int = 7) -> np.ndarray:
    """Newey-West standard errors of the two coefficients (quick cross-check only; lags count
    observed rows, not calendar days, the same compromise as hrv_analysis.py's Stage 3)."""
    n = len(resid)
    bread = np.linalg.pinv(x.T @ x)
    s = x * resid[:, None]
    meat = s.T @ s
    for lag in range(1, min(maxlags, n - 1) + 1):
        w = 1.0 - lag / (maxlags + 1.0)
        g = s[lag:].T @ s[:-lag]
        meat += w * (g + g.T)
    cov = bread @ meat @ bread
    if n > n_params:
        cov *= n / (n - n_params)
    return np.sqrt(np.clip(np.diag(cov), 0, None))


# ---------------------------------------------------------------------------
# The randomization analysis
# ---------------------------------------------------------------------------

def randomization_analysis(
    t_obs: np.ndarray,
    y: np.ndarray,
    dow: np.ndarray,
    *,
    block_len: int = 4,
    n_a: int = 2,
    pre_trial: int = 0,
    excluded_blocks: set[int] | frozenset[int] = frozenset(),
    n_redraws: int = 10000,
    redraw_seed: int = 0,
    alpha: float = 0.05,
    covariates: np.ndarray | None = None,
    with_ci: bool = True,
) -> dict[str, Any]:
    """Fit the model and run the randomization test.

    t_obs   0/1 per scheduled day (1 = arm A), length n_blocks * block_len
    y       outcome per day, NaN where there is none (those nights are left out, never imputed)
    dow     weekday 0..6 per day
    covariates  optional (n_days, k) pre-treatment covariates for the sensitivity analysis; a day
                with a NaN covariate is left out
    """
    t_obs = np.asarray(t_obs).astype(float)
    y = np.asarray(y, dtype=float)
    n_days = len(t_obs)
    if n_days % block_len or len(y) != n_days or len(dow) != n_days:
        raise ValueError("t_obs, y and dow must cover whole blocks of the same days")
    n_blocks = n_days // block_len
    block_ids = np.arange(n_days) // block_len
    if np.any(t_obs.reshape(n_blocks, block_len).sum(axis=1) != n_a):
        raise ValueError("the observed schedule is not a permuted-block schedule")

    keep = ~np.isnan(y) & ~np.isin(block_ids, list(excluded_blocks))
    if covariates is not None:
        covariates = np.asarray(covariates, dtype=float).reshape(n_days, -1)
        keep &= ~np.isnan(covariates).any(axis=1)
    n_obs = int(keep.sum())
    if n_obs < 12:
        raise ValueError(f"only {n_obs} nights with an outcome; too few to fit the model")

    q = _nuisance_basis(block_ids[keep], np.asarray(dow)[keep], None if covariates is None else covariates[keep])
    lag_obs = _lagged(t_obs, pre_trial)
    tr_obs = _resid(q, t_obs[keep][None, :])
    lr_obs = _resid(q, lag_obs[keep][None, :])
    y_r = y[keep] - q @ (q.T @ y[keep])
    # Second "outcome": the observed assignment itself, for the interval (see below).
    ys = np.column_stack([y_r, tr_obs[0]])

    obs = _solve(tr_obs, lr_obs, ys)[0]           # (2 outcomes, 2 coefs)
    b0, b1 = float(obs[0, 0]), float(obs[0, 1])
    if not np.isfinite(b0):
        raise ValueError("the arm and the carryover term cannot be separated on these nights")
    x = np.column_stack([tr_obs[0], lr_obs[0]])
    resid = y_r - x @ np.array([b0, b1])
    se = _hac_se(x, resid, n_params=q.shape[1] + 2)

    a_draws = np.empty(n_redraws)                 # b0 of Y under each re-drawn schedule
    g_draws = np.empty(n_redraws)                 # b0 of the observed assignment under each re-draw
    c_draws = np.empty(n_redraws)                 # b1 of Y under each re-drawn schedule
    done = 0
    all_t = design.redraw_blocks(redraw_seed, n_redraws, n_blocks, block_len, n_a)
    while done < n_redraws:
        t = all_t[done:done + REDRAW_CHUNK].astype(float)
        lag = _lagged(t, pre_trial)
        coefs = _solve(_resid(q, t[:, keep]), _resid(q, lag[:, keep]), ys)
        a_draws[done:done + len(t)] = coefs[:, 0, 0]
        g_draws[done:done + len(t)] = coefs[:, 1, 0]
        c_draws[done:done + len(t)] = coefs[:, 0, 1]
        done += len(t)

    def p_two_sided(draws: np.ndarray, observed: float) -> float:
        # A singular re-draw counts as extreme (conservative).
        extreme = np.isnan(draws) | (np.abs(draws) >= abs(observed) - 1e-12)
        return float((1 + extreme.sum()) / (len(draws) + 1))

    out: dict[str, Any] = {
        "estimate": b0,
        "carryover": b1,
        "two_night_total": b0 + b1,
        "p_value": p_two_sided(a_draws, b0),
        "p_carryover": p_two_sided(c_draws, b1),
        "hac_se": float(se[0]),
        "hac_se_carryover": float(se[1]),
        "n_nights": n_obs,
        "n_nights_a": int(t_obs[keep].sum()),
        "n_nights_b": int(n_obs - t_obs[keep].sum()),
        "n_redraws": int(n_redraws),
        "redraw_sd": float(np.nanstd(a_draws)),
    }
    if with_ci:
        out["ci_low"], out["ci_high"] = _invert(a_draws, g_draws, b0, alpha, scale=out["redraw_sd"] or 1.0)
    return out


def _invert(a: np.ndarray, g: np.ndarray, b0: float, alpha: float, scale: float) -> tuple[float, float]:
    """Interval by inverting the randomization test (doc 8).

    Null "the same-night effect is c": take c off the outcome on the observed A nights and test
    again. The fit is linear in the outcome, so under re-draw r the statistic is a_r - c * g_r
    (g_r = the coefficient the observed assignment gets under re-draw r), against the observed
    b0 - c. The interval is the set of c that the test does not reject.
    """
    ok = ~(np.isnan(a) | np.isnan(g))
    a, g, n = a[ok], g[ok], len(a)

    def p(c: float) -> float:
        return (1 + (n - len(a)) + np.sum(np.abs(a - c * g) >= abs(b0 - c) - 1e-12)) / (n + 1)

    def bound(direction: float) -> float:
        inside, step = b0, scale
        outside = b0 + direction * step
        for _ in range(60):
            if p(outside) <= alpha:
                break
            inside, step = outside, step * 2
            outside = b0 + direction * step
        else:
            return float("inf") * direction
        for _ in range(40):
            mid = (inside + outside) / 2
            if p(mid) <= alpha:
                outside = mid
            else:
                inside = mid
        return float(inside)

    return bound(-1.0), bound(1.0)


# ---------------------------------------------------------------------------
# Planning: how noisy is the estimate on recent history? (doc 7.6)
# ---------------------------------------------------------------------------

Z_POWER_80 = 2.8016          # z(0.975) + z(0.80)


def placebo_noise(y: np.ndarray, dow: np.ndarray, *, n_trials: int = 500, seed: int = 0,
                  block_len: int = 4, n_a: int = 2) -> float:
    """SD of the same-night estimate when the arms are placebo: fresh random schedules laid over
    a real (or synthetic) outcome series that no treatment touched. It is what the planned
    analysis would report by chance alone on nights like these."""
    n_days = (len(y) // block_len) * block_len
    y, dow = np.asarray(y, dtype=float)[-n_days:], np.asarray(dow)[-n_days:]
    schedules = design.redraw_blocks(seed, n_trials, n_days // block_len, block_len, n_a)
    estimates = [randomization_analysis(t, y, dow, block_len=block_len, n_a=n_a, n_redraws=1, with_ci=False)["estimate"]
                 for t in schedules]
    return float(np.std(estimates))


def days_for_power(noise_sd: float, n_days: int, effect_ms: float) -> int:
    """Days for 80% power (two-sided 5%) at effect_ms, given the placebo SD seen over n_days.
    The SD of the estimate shrinks with the square root of the number of days."""
    blocks = np.ceil(n_days * (noise_sd * Z_POWER_80 / effect_ms) ** 2 / 4)
    return int(blocks * 4)


# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------

def missingness_check(t: np.ndarray, missing: np.ndarray) -> dict[str, Any]:
    """Share of nights without an outcome per arm (Fisher exact). More than 10 points apart is a
    threat to the result (doc 8): e.g. the strap left off after one arm's evenings."""
    from scipy.stats import fisher_exact

    t = np.asarray(t).astype(bool)
    missing = np.asarray(missing).astype(bool)
    table = [[int((t & missing).sum()), int((t & ~missing).sum())],
             [int((~t & missing).sum()), int((~t & ~missing).sum())]]
    share_a = table[0][0] / max(1, sum(table[0]))
    share_b = table[1][0] / max(1, sum(table[1]))
    return {
        "missing_share_a": share_a,
        "missing_share_b": share_b,
        "difference": share_a - share_b,
        "fisher_p": float(fisher_exact(table)[1]),
        "threat": abs(share_a - share_b) > 0.10,
    }


def decide(estimate: float, ci_low: float, ci_high: float, p_value: float, mid_ms: float, alpha: float) -> str:
    """The pre-registered decision rule (doc 6.1)."""
    if p_value < alpha and estimate > 0:
        return "adopt_A"
    if ci_low > -mid_ms and ci_high < mid_ms:
        return "no_meaningful_effect"
    return "inconclusive"


def analyze_trial(spec: TrialSpec, data: TrialData, as_of: date) -> dict[str, Any]:
    """The end-of-trial report. Raises AnalysisNotAllowed before the pre-registered end."""
    last_day = assert_reportable(spec, as_of)

    n_sched = len(data.arms)
    if n_sched != spec.n_days or len(data.outcome) != n_sched:
        raise ValueError("arms and outcome must have one entry per scheduled day")
    t = np.array([1.0 if arm == "A" else 0.0 for arm in data.arms])
    y = np.asarray(data.outcome, dtype=float).copy()
    used_days = (last_day - spec.start).days + 1
    excluded = set(data.excluded_blocks)
    if used_days < n_sched:                       # stopped early: later days carry no information
        y[used_days:] = np.nan
        excluded |= {b for b in range(n_sched // spec.block_len) if b * spec.block_len >= used_days}
    dow = np.array([(spec.start + timedelta(days=i)).weekday() for i in range(n_sched)])
    pre_trial = 0 if spec.control_arm == "B" else 1
    seed = design.redraw_seed(spec.experiment_id, as_of)
    common = dict(block_len=spec.block_len, n_a=spec.n_a, pre_trial=pre_trial, excluded_blocks=excluded,
                  n_redraws=spec.n_redraws, redraw_seed=seed, alpha=spec.alpha)

    primary = randomization_analysis(t, y, dow, **common)

    in_scope = ~np.isin(np.arange(n_sched) // spec.block_len, list(excluded)) & (np.arange(n_sched) < used_days)
    sensitivity: dict[str, Any] = {}
    positive = np.where(y > 0, y, np.nan)
    log_fit = randomization_analysis(t, np.log(positive), dow, **common)
    sensitivity["ln_outcome"] = {
        "estimate_ln": log_fit["estimate"], "estimate_pct": float(np.expm1(log_fit["estimate"]) * 100),
        "ci_low_ln": log_fit["ci_low"], "ci_high_ln": log_fit["ci_high"], "p_value": log_fit["p_value"],
    }
    if data.adherent is not None:
        adherent = np.asarray(data.adherent).astype(bool)
        y_pp = np.where(adherent, y, np.nan)
        try:
            pp = randomization_analysis(t, y_pp, dow, **{**common, "n_redraws": 1}, with_ci=False)
            sensitivity["per_protocol"] = {
                "estimate": pp["estimate"], "n_nights": pp["n_nights"],
                "note": "adherent days only: no longer a randomized comparison, so no p-value",
            }
        except ValueError as exc:
            sensitivity["per_protocol"] = {"estimate": None, "note": str(exc)}

    report = {
        "experiment_id": spec.experiment_id,
        "as_of": as_of.isoformat(),
        "stopped_early": spec.stopped_on is not None,
        "last_day_analysed": last_day.isoformat(),
        "days_scheduled": n_sched,
        "days_in_scope": int(in_scope.sum()),
        "excluded_blocks": sorted(int(b) for b in excluded),
        **primary,
        "mid_ms": spec.mid_ms,
        "alpha": spec.alpha,
        "decision": decide(primary["estimate"], primary["ci_low"], primary["ci_high"],
                           primary["p_value"], spec.mid_ms, spec.alpha),
        # Doc 5.3: a carryover above half the MID means the next trial of this treatment needs periods.
        "carryover_exceeds_half_mid": abs(primary["carryover"]) > spec.mid_ms / 2,
        "missingness": missingness_check(t[in_scope], np.isnan(y[in_scope])),
        "sensitivity": sensitivity,
        "redraw_seed": str(seed),
        "generator": design.GENERATOR,
    }
    return report
