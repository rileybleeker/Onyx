"""N-of-1 experiment framework: the pre-registered end-of-trial analysis (pure numpy / scipy).

Design: docs/experiment-framework.md section 8. No database access, no clock; the caller passes
the as-of date. Nothing here is imported by hrv_analysis.py or causal_inference.py, and the arm
never enters the behavioral matrix (doc 8, "Relation to the observational pipeline").

Model (daily permuted-block design), on nights that have the outcome:

    Y_D = block_D + b0 * T_D + b1 * T_(D-1) + day_of_week_D + e_D

  T_D     1 on arm-A days, 0 on arm-B days (the assignment, not what was done: intention to treat)
  T_(D-1) yesterday's assignment; the day before the trial counts as the control arm
  b0      same-night effect (primary estimand), b1 carryover into the next night

Inference (doc 8.1). The working model M says every potential outcome is

    Y_D(t) = Y_D(0) + tau * t_D + gamma * t_(D-1)        for every schedule t

(the arm acts on the same night and the next night only, by the same amount every night), and
whether a night has an outcome does not depend on the schedule. Under the joint sharp null
H(tau, gamma) every potential outcome is known, and because OLS is linear in the outcome and both
regressors are in the model, the statistic of a re-drawn schedule r is exactly

    a_r - tau * g_r - gamma * h_r        against the observed  (b0 - tau, b1 - gamma)

where a_r, g_r, h_r are the coefficients re-draw r gives the outcome, the observed assignment and
the observed yesterday's assignment. So the joint test needs one pass of re-draws for every
(tau, gamma). The reported same-night p-value tests tau = 0 with gamma unknown (a nuisance) by
Berger & Boos (1994): the largest joint p-value over a 1 - beta randomization confidence set for
gamma, plus beta (nuisance_beta_for(R): 0.001, or 5 / (R + 1) with fewer re-draws). Its type I
error is at most alpha whatever gamma is, whenever M holds (a Monte Carlo test's guarantee, qualified
below). The interval is a certified enclosure
of every value that test does not reject (interval(), INTERVAL_METHOD: the accepted values need
not form an interval, so nothing beyond its ends is accepted, by a bound proved strip by strip);
the carryover p-value and interval are the same construction with the roles swapped. A value is
rejected when p < alpha, the same boundary as the decision rule. Fisher's sharp null of no effect
on any night is reported too (p_value_no_effect): exact without the effect model, but it still
needs the randomized schedule and missing nights not caused by the arm, and rejecting it does not
say which night. The re-drawing never assumes anything about the HRV series, so autocorrelation
does not break it.

The re-draws are a Monte Carlo sample of R schedules from the registered design, and every p-value
is (1 + extreme re-draws) / (R + 1): the standard Monte Carlo randomization test (Dwass 1957,
Phipson and Smyth 2010). With re-draws drawn at random, independently of the observed schedule,
its size is at most alpha. The deployed re-draws are not random: experiment_design.redraw_seed is a
deterministic SHA-256 hash of the experiment id and the report date, public values that never touch
the secret allocation seed (os.urandom, committed before the trial), and the final report is
computed once, so the re-draws cannot be re-chosen after a p-value is seen. Every "at most alpha"
and "at least 1 - alpha" in this module therefore rests on a pseudo-randomness assumption, the same
one every seeded Monte Carlo test makes: the hash is treated as a random draw independent of the
allocation. For the one fixed re-draw set a report uses, the size is alpha only up to Monte Carlo
error, about sqrt(alpha (1 - alpha) / R) (0.002 at R = 10,000, alpha 0.05). The calibration report
seeds its re-draws with the same deterministic rule, so it is the empirical evidence for the size
and coverage that rule gives.

analyze_trial() REFUSES to run before the pre-registered end (Riley's decision 1, doc section 13:
analyse only at the pre-registered end). A trial stopped early is reported as such. It reports the
decision rule's verdict as a firm decision only when every blocking check in assumption_checks()
passes: missing nights not tied to the arm, the registered protocol's declaration and
justification of the untestable parts of M (one-night carryover, constant effects, pre-trial day
as control), the registered inference method, and a METHOD_REVIEW (calibration report plus
independent review) covering the trial's alpha and re-draw count. Otherwise the decision is
withheld ("inconclusive"), the reasons are in the report, and every output whose assumptions a
failed check leaves unsupported is marked so.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

import numpy as np

import experiment_design as design

REDRAW_CHUNK = 2000
TIE_TOL = 1e-12            # a re-draw this close to the observed statistic counts as extreme
_WIDEN = 1e-9              # relative widening of every extreme set: a floating-point tie counts as extreme
# Berger & Boos (1994): level of the confidence set for the other coefficient. It is 0.001, raised
# to 5 / (R + 1) when there are fewer than 4,999 re-draws, so the set always rests on at least the
# 5 most extreme re-draws (with 999, the protocol minimum, a single re-draw would decide it).
# Defined in experiment_design so the protocol rules can check that alpha leaves room above it.
NUISANCE_BETA = design.NUISANCE_BETA
MIN_NUISANCE_TAIL = design.MIN_NUISANCE_TAIL
nuisance_beta_for = design.nuisance_beta_for
INFERENCE_METHOD = "joint_sharp_null_berger_boos_v1"
INTERVAL_METHOD = "certified_enclosure_v1"
# The method record a firm decision needs (docs/experiment-framework.md 8.1 and 8.3): the independent
# statistical review of INFERENCE_METHOD and the seeded calibration report (experiment_calibration.py,
# run in the scheduled validation phase), with the configuration the report calibrated. A trial's
# decision is firm only when both are recorded and its alpha and re-draw count are among those;
# until then it is withheld. The review is recorded (doc 8.3). The calibration report is not: the PR
# that records a review-ready report fills in calibration_report, n_redraws and alpha.
METHOD_REVIEW: dict[str, Any] = {
    "method": INFERENCE_METHOD,   # the INFERENCE_METHOD the report and the review cover
    "calibration_report": None,   # reference to the passing, review-ready seeded report (experiment_calibration.py)
    # Reference to the independent statistical review (doc 8.3). It reviews the method; it is not an
    # approval of any trial's outcome.
    "independent_review": (
        "docs/experiment-framework.md 8.3: independent statistical challenge of joint_sharp_null_berger_boos_v1 / "
        "certified_enclosure_v1 by two non-Anthropic models (openai/gpt-5.2, google/gemini-2.5-pro) on "
        "2026-11-16, of the analysis at ce76f720, the synthetic calibration design and the changes recorded in "
        "doc 8.3; final verdicts SOUND (both). Adopted: the enclosure metric and the deployed re-draw seeding rule "
        "in the calibration, the Monte Carlo qualification of every guarantee. Rejected with reasons: "
        "float-tolerance snapping in _sets_moving / _piece (it would narrow the sets), a fresh random re-draw "
        "seed at analysis time (once drawn it is as fixed as the public-hash seed)"),
    "n_redraws": (),              # re-draw counts the report calibrated
    "alpha": (),                  # alpha levels it calibrated
}


def method_review_problem(alpha: float, n_redraws: int) -> str | None:
    """Why a trial with this alpha and re-draw count has no recorded review of INFERENCE_METHOD
    that covers it, or None when it has one."""
    review = METHOD_REVIEW
    has_report, has_review = bool(review.get("calibration_report")), bool(review.get("independent_review"))
    if not (has_report or has_review):
        return (f"the calibration report and the independent statistical review of {INFERENCE_METHOD} are not "
                "recorded yet (experiment_analysis.METHOD_REVIEW)")
    if not has_report:
        return (f"the seeded calibration report of {INFERENCE_METHOD} is not recorded yet "
                "(experiment_analysis.METHOD_REVIEW): the independent statistical review is recorded, and a firm "
                "decision needs both")
    if not has_review:
        return (f"the independent statistical review of {INFERENCE_METHOD} is not recorded yet "
                "(experiment_analysis.METHOD_REVIEW): the calibration report is recorded, and a firm decision "
                "needs both")
    if review.get("method") != INFERENCE_METHOD:
        return f"the recorded review covers {review.get('method')!r}, not {INFERENCE_METHOD}"
    counts = sorted({int(x) for x in review.get("n_redraws") or ()})
    if int(n_redraws) not in counts:
        return f"the calibration report covers {counts or 'no'} re-draw counts, not this trial's {int(n_redraws)}"
    levels = [float(x) for x in review.get("alpha") or ()]
    if not any(abs(float(alpha) - level) < 1e-12 for level in levels):
        return f"the calibration report covers alpha {levels or 'none'}, not this trial's {float(alpha):g}"
    return None


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
    # From the registered protocol (experiment_design.validate_protocol). They decide whether the
    # untestable parts of the model are supported for THIS trial (assumption_checks).
    kind: str = design.KIND_TREATMENT
    carryover_nights: int | None = None   # analysis.carryover_nights; the model needs 1
    model_justification: str | None = None   # analysis.model_justification
    inference_method: str | None = None   # analysis.inference_method, fixed at registration

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
    # Optional pre-registered extras, one array per scheduled day each (NaN = not available):
    # covariates, one sensitivity fit each. Not pre-treatment when built from earlier trial nights
    # (hrv_lag1, hrv_7d_mean): those depend on earlier arms under the model, so the fits' p-value
    # and interval are approximate (output_semantics), and only their no-effect p is exact.
    covariates: dict[str, np.ndarray] | None = None
    secondary_outcomes: dict[str, np.ndarray] | None = None  # other outcomes, same model, never part of the decision


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
# Re-draws and the exact joint test
# ---------------------------------------------------------------------------

@dataclass
class Draws:
    """The observed fit and what every re-drawn schedule gives three fixed outcome vectors.

    Rows are re-draws; column 0 is the same-night coefficient, column 1 the next-night one.
      a   coefficients of the outcome Y
      g   coefficients of the observed assignment T_obs, used as if it were the outcome
      h   coefficients of the observed yesterday's assignment, the same way
    Under H(tau, gamma) re-draw r's statistic is a[r] - tau * g[r] - gamma * h[r] exactly, and the
    observed one is obs - (tau, gamma) (see the module docstring)."""
    obs: np.ndarray          # (2,) b0, b1
    a: np.ndarray            # (R, 2)
    g: np.ndarray            # (R, 2)
    h: np.ndarray            # (R, 2)

    @property
    def n(self) -> int:
        return len(self.a)

    def basis(self, comp: int) -> np.ndarray:
        """The coefficient table of the outcome vector that carries parameter `comp`."""
        return self.g if comp == 0 else self.h

    def scale(self, comp: int) -> float:
        sd = float(np.nanstd(self.a[:, comp])) if np.isfinite(self.a[:, comp]).any() else float("nan")
        return sd if np.isfinite(sd) and sd > 0 else 1.0


def redraw_fit(
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
    covariates: np.ndarray | None = None,
) -> tuple[Draws, dict[str, Any]]:
    """Fit the model on the observed schedule and on n_redraws schedules re-drawn by the
    registered procedure. Returns the Draws and the point estimates / counts."""
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
    # Three "outcomes" per re-draw: Y, the observed assignment and the observed yesterday's assignment.
    ys = np.column_stack([y_r, tr_obs[0], lr_obs[0]])

    obs = _solve(tr_obs, lr_obs, ys)[0]           # (3 outcomes, 2 coefs)
    b0, b1 = float(obs[0, 0]), float(obs[0, 1])
    if not (np.isfinite(b0) and np.isfinite(b1)):
        raise ValueError("the arm and the carryover term cannot be separated on these nights")
    x = np.column_stack([tr_obs[0], lr_obs[0]])
    resid = y_r - x @ np.array([b0, b1])
    se = _hac_se(x, resid, n_params=q.shape[1] + 2)

    coefs = np.empty((n_redraws, 3, 2))
    all_t = design.redraw_blocks(redraw_seed, n_redraws, n_blocks, block_len, n_a)
    for start in range(0, n_redraws, REDRAW_CHUNK):
        t = all_t[start:start + REDRAW_CHUNK].astype(float)
        lag = _lagged(t, pre_trial)
        coefs[start:start + len(t)] = _solve(_resid(q, t[:, keep]), _resid(q, lag[:, keep]), ys)

    draws = Draws(obs=np.array([b0, b1]), a=coefs[:, 0, :], g=coefs[:, 1, :], h=coefs[:, 2, :])
    info = {
        "estimate": b0,
        "carryover": b1,
        "two_night_total": b0 + b1,
        "hac_se": float(se[0]),
        "hac_se_carryover": float(se[1]),
        "n_nights": n_obs,
        "n_nights_a": int(t_obs[keep].sum()),
        "n_nights_b": int(n_obs - t_obs[keep].sum()),
        "n_redraws": int(n_redraws),
        "redraw_sd": float(np.nanstd(draws.a[:, 0])) if np.isfinite(draws.a[:, 0]).any() else float("nan"),
    }
    return draws, info


def joint_p_value(draws: Draws, comp: int, tau: float, gamma: float) -> float:
    """Monte Carlo randomization p-value of component `comp` (0 = same night, 1 = next night) under
    the joint sharp null H(tau, gamma) of model M, on this re-draw sample: its size is at most alpha
    as a Monte Carlo test, under the pseudo-randomness assumption of the module docstring and up to
    Monte Carlo error for a fixed sample. A singular re-draw counts as extreme (conservative)."""
    stat = draws.a[:, comp] - tau * draws.g[:, comp] - gamma * draws.h[:, comp]
    observed = draws.obs[comp] - (tau if comp == 0 else gamma)
    extreme = np.isnan(stat) | (np.abs(stat) >= abs(observed) - TIE_TOL)
    return float((1 + extreme.sum()) / (draws.n + 1))


# ---------------------------------------------------------------------------
# Berger-Boos: the other coefficient as a nuisance
# ---------------------------------------------------------------------------

def _widen(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    return _WIDEN * (1.0 + np.abs(np.where(np.isfinite(v), v, 0.0)))


_EMPTY = np.empty(0)


class _ExtremeSets:
    """For every re-draw r, the closed set of parameter values x at which re-draw r is at least as
    extreme as the observed statistic. Each set is one of: everywhere (counted in n_all), nowhere
    (left out), [a, b], (-inf, a] U [b, inf) with a < b, (-inf, a], or [a, inf). The builders
    widen every set slightly, so a floating-point tie counts as extreme (the conservative side)."""

    def __init__(self, n_all: int, bounded: tuple[np.ndarray, np.ndarray] = (_EMPTY, _EMPTY),
                 outside: tuple[np.ndarray, np.ndarray] = (_EMPTY, _EMPTY),
                 left: np.ndarray = _EMPTY, right: np.ndarray = _EMPTY):
        self.n_all = int(n_all)
        self.ba, self.bb = np.sort(bounded[0]), np.sort(bounded[1])
        self.oa, self.ob = np.sort(outside[0]), np.sort(outside[1])
        self.la, self.ra = np.sort(left), np.sort(right)

    def count(self, x: np.ndarray) -> np.ndarray:
        """Number of re-draws extreme at each x."""
        x = np.asarray(x, dtype=float)
        n = self.n_all + (np.searchsorted(self.ba, x, "right") - np.searchsorted(self.bb, x, "left"))  # a <= x <= b
        n = n + (len(self.oa) - np.searchsorted(self.oa, x, "left")) + np.searchsorted(self.ob, x, "right")  # x <= a or x >= b
        n = n + (len(self.la) - np.searchsorted(self.la, x, "left"))       # x <= a
        n = n + np.searchsorted(self.ra, x, "right")                       # x >= a
        return n

    def at_minus_inf(self) -> int:
        return self.n_all + len(self.oa) + len(self.la)

    def at_plus_inf(self) -> int:
        return self.n_all + len(self.oa) + len(self.ra)

    def events(self) -> np.ndarray:
        ev = np.concatenate([self.ba, self.bb, self.oa, self.ob, self.la, self.ra])
        return np.unique(ev[np.isfinite(ev)])

    def hull(self, m: int, center: float) -> tuple[float, float]:
        """Smallest interval holding every x with count(x) >= m (may be infinite). The count only
        changes at the set endpoints and never drops at one, so the ends are endpoints."""
        if m <= 0:
            return -math.inf, math.inf
        lo_inf, hi_inf = self.at_minus_inf() >= m, self.at_plus_inf() >= m
        if lo_inf and hi_inf:
            return -math.inf, math.inf
        ev = self.events()
        good = ev[self.count(ev) >= m] if ev.size else ev
        low = -math.inf if lo_inf else (min(float(good[0]), center) if good.size else center)
        high = math.inf if hi_inf else (max(float(good[-1]), center) if good.size else center)
        return low, high

    def sup(self, low: float, high: float) -> int:
        """Largest count over x in [low, high]: reached at an endpoint inside it, or at low / high."""
        best = 0
        if low == -math.inf:
            best = self.at_minus_inf()
        if high == math.inf:
            best = max(best, self.at_plus_inf())
        ev = self.events()
        points = ev[(ev >= low) & (ev <= high)]
        ends = [v for v in (low, high) if math.isfinite(v)]
        if ends:
            points = np.concatenate([points, np.asarray(ends, dtype=float)])
        if points.size:
            best = max(best, int(self.count(points).max()))
        return int(best)


def _sets_moving(e: np.ndarray, f: np.ndarray, obs: float) -> _ExtremeSets:
    """Re-draw r is extreme at x when |e_r - x * f_r| >= |obs - x|: the nuisance test at value x.

    (e - x f)^2 - (obs - x)^2 = [(e - obs) - x (f - 1)] * [(e + obs) - x (f + 1)], so the set is
    between the two roots when |f| < 1, outside them when |f| > 1, and a half-line when f = +-1."""
    e = np.asarray(e, dtype=float)
    f = np.asarray(f, dtype=float)
    finite = np.isfinite(e) & np.isfinite(f)
    e, f = np.where(finite, e, 0.0), np.where(finite, f, 0.0)
    c1, c2 = e - obs, e + obs
    tie = 1e-9 * (1.0 + np.abs(e) + abs(obs))
    # A re-draw that reproduces the observed schedule is extreme everywhere (both factors vanish).
    everywhere = (~finite
                  | ((np.abs(f - 1.0) <= 1e-9) & (np.abs(c1) <= tie))
                  | ((np.abs(f + 1.0) <= 1e-9) & (np.abs(c2) <= tie)))
    with np.errstate(divide="ignore", invalid="ignore"):
        x1 = c1 / (f - 1.0)
        x2 = c2 / (f + 1.0)
    lo, hi = np.minimum(x1, x2), np.maximum(x1, x2)
    live = ~everywhere
    absf = np.abs(f)
    inner, outer = live & (absf < 1.0), live & (absf > 1.0)
    plus, minus = live & (f == 1.0), live & (f == -1.0)

    b_a, b_b = lo[inner] - _widen(lo[inner]), hi[inner] + _widen(hi[inner])
    o_a, o_b = lo[outer] + _widen(lo[outer]), hi[outer] - _widen(hi[outer])
    closed = o_a >= o_b                       # the gap closed by the widening: extreme everywhere
    # f = 1: the first factor is the constant c1, the second (c2 - 2x) has its sign at x <= x2 / x >= x2.
    # f = -1: the second factor is the constant c2, the first (c1 + 2x) is >= 0 at x >= x1.
    left = np.concatenate([x2[plus & (c1 > 0)], x1[minus & (c2 < 0)]])
    right = np.concatenate([x2[plus & (c1 < 0)], x1[minus & (c2 > 0)]])
    return _ExtremeSets(
        n_all=int(everywhere.sum() + closed.sum()),
        bounded=(b_a, b_b),
        outside=(o_a[~closed], o_b[~closed]),
        left=left + _widen(left),
        right=right - _widen(right),
    )


def _sets_fixed(d: np.ndarray, h: np.ndarray, k: float) -> _ExtremeSets:
    """Re-draw r is extreme at x when |d_r - x * h_r| >= k: the tested coefficient, with the
    nuisance at x. The set is (-inf, a] U [b, inf) when h_r != 0, everywhere or nowhere when h_r = 0."""
    d = np.asarray(d, dtype=float)
    h = np.asarray(h, dtype=float)
    if not k > 0:
        return _ExtremeSets(n_all=len(d))
    finite = np.isfinite(d) & np.isfinite(h)
    constant = finite & (h == 0.0)
    moving = finite & (h != 0.0)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        p = (d[moving] - k) / h[moving]
        q = (d[moving] + k) / h[moving]
    a, b = np.minimum(p, q), np.maximum(p, q)
    a, b = a + _widen(a), b - _widen(b)
    closed = a >= b
    n_all = int((~finite).sum() + (constant & (np.abs(d) >= k)).sum() + closed.sum())
    return _ExtremeSets(n_all=n_all, outside=(a[~closed], b[~closed]))


def accept_count(beta: float, n_redraws: int) -> int:
    """Smallest number of extreme re-draws whose p-value (1 + count) / (R + 1) is above beta."""
    return max(0, math.floor(beta * (n_redraws + 1) - 1) + 1)


def nuisance_set(draws: Draws, comp: int, value: float, beta: float | None = None) -> tuple[float, float]:
    """Hull of the 1 - beta randomization confidence set for the OTHER coefficient, when
    coefficient `comp` equals `value` (a superset of the set: wider only makes the test safer)."""
    beta = nuisance_beta_for(draws.n) if beta is None else beta
    other = 1 - comp
    e = draws.a[:, other] - value * draws.basis(comp)[:, other]
    f = draws.basis(other)[:, other]
    return _sets_moving(e, f, float(draws.obs[other])).hull(accept_count(beta, draws.n), center=float(draws.obs[other]))


def bb_p_value(draws: Draws, comp: int, value: float, beta: float | None = None) -> tuple[float, tuple[float, float]]:
    """Berger-Boos p-value of "coefficient `comp` equals `value`", the other coefficient unknown:
    beta plus the largest joint sharp-null p-value over the other's 1 - beta confidence set.
    Returns (p, the nuisance set used)."""
    beta = nuisance_beta_for(draws.n) if beta is None else beta
    other = 1 - comp
    low, high = nuisance_set(draws, comp, value, beta)
    d = draws.a[:, comp] - value * draws.basis(comp)[:, comp]
    h = draws.basis(other)[:, comp]
    k = abs(float(draws.obs[comp]) - value) - TIE_TOL
    worst = _sets_fixed(d, h, k).sup(low, high)
    return min(1.0, beta + (1 + worst) / (draws.n + 1)), (low, high)


def _step_out(p: Callable[[float], float], start: float, direction: float, step: float, alpha: float,
              scale: float) -> tuple[float, float]:
    """From an accepted value `start`, double the step until the test rejects, then bisect.
    Returns (accepted, rejected) values at most 1e-7 scales apart (relative to the distance from
    `start` when that is larger); rejected is +-inf when 64 doublings never reject. A value is
    accepted when p(v) >= alpha, the same boundary as the decision rule's p < alpha."""
    inside, dist = start, step
    outside = None
    for _ in range(64):
        x = start + direction * dist
        if p(x) >= alpha:
            inside, dist = x, dist * 2
            continue
        outside = x
        break
    if outside is None:
        return inside, math.inf * direction
    lo, hi = inside, outside
    for _ in range(60):
        if abs(hi - lo) <= 1e-7 * max(scale, 1e-3 * abs(lo - start)):
            break
        mid = (lo + hi) / 2
        if p(mid) >= alpha:
            lo = mid
        else:
            hi = mid
    return float(lo), float(hi)


def invert_p_value(p: Callable[[float], float], center: float, alpha: float, scale: float) -> tuple[float, float]:
    """Numerical inversion of p around `center` (where p is 1): step out until the test rejects,
    then bisect. It finds only the boundary of the accepted values next to the center, so it is
    NOT an enclosure of every accepted value; interval() adds the certificate that is. Used as is
    only for the calibration's informational interval of the previous method."""
    return (_step_out(p, center, -1.0, scale, alpha, scale)[0], _step_out(p, center, 1.0, scale, alpha, scale)[0])


# ---------------------------------------------------------------------------
# The certified interval (doc 8.1): an enclosure of EVERY accepted value
# ---------------------------------------------------------------------------
#
# The Berger-Boos acceptance set {v : p(v) >= alpha} need not be an interval, and a search that
# steps out from the estimate can miss an accepted region further out. interval() therefore
# certifies that nothing beyond its ends is accepted. For a strip of parameter values [t1, t2],
# _strip_bound() computes an upper bound on p(v) for EVERY v in the strip:
#
#   re-draw r is extreme at (v, x) when |P_r| >= |Q_r| with P_r, Q_r affine in (v, x), i.e. when
#   P - Q and P + Q have the same sign: the union of two convex pieces of the (v, x) plane. Over a
#   strip each piece projects onto x as one interval (computed exactly up to an outer rounding), so
#   "extreme at x for SOME v in the strip" is a count over intervals. Counting the nuisance test
#   that way gives a superset of every nuisance set in the strip, and counting the tested
#   statistic that way, maximised over that superset, gives at least the count p() maximises.
#
# Far from the estimate the strip [V, inf) is certified in the coordinates w = 1 / v, z = x / v
# (multiplying |P| >= |Q| by |w| keeps the form affine), so the whole half-line is covered with
# finitely many strips. A strip that cannot be certified is split; a piece that stays uncertain
# at the smallest width is either accepted (the search steps out past it) or kept inside the
# interval. When the budget runs out that end is infinite. Every way out errs on the wide side,
# so the interval holds every value the test does not reject (up to floating-point ties).

CERT_FIRST = 0.25       # the first strip beyond an end, in scales; strips double outward
CERT_FAR = 1e4          # past the center +- this many scales the rest of the half-line is one strip in w = 1 / v
CERT_MIN = 1e-6         # smallest strip, relative to its distance from the center (or to the tail's length)
CERT_BUDGET = 4000      # strip bounds per side; when spent, that side of the interval is left unbounded


def _piece(constraints: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]], t1: float,
           t2: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One convex piece of each re-draw's extreme region: the (t, z) where every constraint
    c + a t + b z >= 0 holds (tolerance tol). Returns (lo, hi, ok): for t in [t1, t2] every such z
    lies in [lo, hi]; ok is False where there is none. An outer bound: a constraint that cannot be
    turned into a bound on z (b = 0, or a tie that holds everywhere) is dropped unless it fails
    on the whole strip."""
    n = constraints[0][0].shape[0]
    ok = np.ones(n, dtype=bool)
    bounds = []                                    # (is_lower, is_upper, intercept, slope): z >= / <= intercept + slope t
    for c, a, b, tol in constraints:
        at1, at2 = c + a * t1, c + a * t2
        tie = (np.abs(b) <= 1e-9) & (np.maximum(np.abs(at1), np.abs(at2)) <= tol)
        flat = ~tie & (b == 0.0)
        ok &= ~(flat & (np.maximum(at1, at2) < -tol))
        live = ~tie & ~flat
        safe_b = np.where(live, b, 1.0)
        bounds.append((live & (b > 0), live & (b < 0), np.where(live, -c / safe_b, 0.0),
                       np.where(live, -a / safe_b, 0.0)))
    # The lower end of the z-slice is the max of the lower bounds (convex in t), the upper end the
    # min of the upper bounds (concave), so their extremes over the strip, and the ends of the t
    # where the slice is non-empty, are at t1, t2 or where the two bounds cross.
    (l1, u1, i1, s1), (l2, u2, i2, s2) = bounds
    both = (l1 | u1) & (l2 | u2) & (s1 != s2)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        tc = np.where(both, (i2 - i1) / np.where(both, s1 - s2, 1.0), t1)
    tc = np.where((tc >= min(t1, t2)) & (tc <= max(t1, t2)), tc, t1)
    los, his = [], []
    with np.errstate(invalid="ignore", over="ignore"):
        for t in (np.full(n, float(t1)), np.full(n, float(t2)), tc):
            lo, hi = np.full(n, -np.inf), np.full(n, np.inf)
            for is_lower, is_upper, icpt, slope in bounds:
                value = icpt + slope * t
                lo = np.where(is_lower, np.maximum(lo, value), lo)
                hi = np.where(is_upper, np.minimum(hi, value), hi)
            los.append(lo)
            his.append(hi)
    lo_all, hi_all = np.array(los), np.array(his)
    slack = 1e-9 * (1.0 + np.abs(np.where(np.isfinite(lo_all), lo_all, 0.0))
                    + np.abs(np.where(np.isfinite(hi_all), hi_all, 0.0)))
    feasible = ~(lo_all > hi_all + slack)          # a NaN compares False: kept (the wide side)
    ok &= feasible.any(axis=0)
    zlo = np.where(feasible, lo_all, np.inf).min(axis=0)
    zhi = np.where(feasible, hi_all, -np.inf).max(axis=0)
    zlo = np.where(np.isnan(zlo), -np.inf, zlo)
    zhi = np.where(np.isnan(zhi), np.inf, zhi)
    zhi = np.maximum(zhi, zlo)
    return zlo - _widen(zlo), zhi + _widen(zhi), ok


def _affine_sets(p: tuple, q: tuple, t1: float, t2: float) -> _ExtremeSets:
    """For each re-draw, the z at which |P| >= |Q| for SOME t in [t1, t2], where
    P = p[0] + p[1] t + p[2] z and Q = q[0] + q[1] t + q[2] z (arrays over re-draws or scalars),
    as an _ExtremeSets of outer intervals. A non-finite re-draw is extreme everywhere."""
    p0, pt, pz, q0, qt, qz = (np.asarray(v, dtype=float) for v in np.broadcast_arrays(*p, *q))
    p0, pt, pz, q0, qt, qz = (np.atleast_1d(v) for v in (p0, pt, pz, q0, qt, qz))
    finite = np.isfinite(p0) & np.isfinite(pt) & np.isfinite(pz) & np.isfinite(q0) & np.isfinite(qt) & np.isfinite(qz)
    p0, pt, pz, q0, qt, qz = (np.where(finite, v, 0.0) for v in (p0, pt, pz, q0, qt, qz))
    tlim = max(abs(t1), abs(t2))
    tol = 1e-9 * (1.0 + np.abs(p0) + np.abs(q0) + (np.abs(pt) + np.abs(qt)) * tlim) + TIE_TOL
    # |P| >= |Q| - TIE_TOL lies inside {P - Q >= -TIE_TOL, P + Q >= -TIE_TOL} U {both <= TIE_TOL}.
    d0, dt, dz = p0 - q0, pt - qt, pz - qz
    s0, st, sz = p0 + q0, pt + qt, pz + qz
    lo1, hi1, ok1 = _piece([(d0 + TIE_TOL, dt, dz, tol), (s0 + TIE_TOL, st, sz, tol)], t1, t2)
    lo2, hi2, ok2 = _piece([(-d0 + TIE_TOL, -dt, -dz, tol), (-s0 + TIE_TOL, -st, -sz, tol)], t1, t2)
    ok1, ok2 = ok1 & finite, ok2 & finite
    touching = ok1 & ok2 & (lo1 <= hi2) & (lo2 <= hi1)
    first_ok = ok1 | ok2
    first_lo = np.where(touching, np.minimum(lo1, lo2), np.where(ok1, lo1, lo2))[first_ok]
    first_hi = np.where(touching, np.maximum(hi1, hi2), np.where(ok1, hi1, hi2))[first_ok]
    second = ok1 & ok2 & ~touching
    lo = np.concatenate([first_lo, lo2[second]])
    hi = np.concatenate([first_hi, hi2[second]])
    whole = np.isneginf(lo) & np.isposinf(hi)
    left = np.isneginf(lo) & ~np.isposinf(hi)
    right = ~np.isneginf(lo) & np.isposinf(hi)
    bounded = ~np.isneginf(lo) & ~np.isposinf(hi)
    return _ExtremeSets(n_all=int((~finite).sum() + whole.sum()), bounded=(lo[bounded], hi[bounded]),
                        left=hi[left], right=lo[right])


def _strip_bound(draws: Draws, comp: int, t1: float, t2: float, tail: bool, beta: float, m: int) -> float:
    """An upper bound on bb_p_value(draws, comp, v) for every v in a strip: v in [t1, t2], or,
    with tail, every v whose 1 / v is in [t1, t2] (both of one sign or 0)."""
    other = 1 - comp
    basis_c, basis_o = draws.basis(comp), draws.basis(other)
    obs_c, obs_o = float(draws.obs[comp]), float(draws.obs[other])
    # Tested statistic with the nuisance at x: |a_c - v g - x h| against |obs_c - v| (bb_p_value).
    fixed = ((draws.a[:, comp], -basis_c[:, comp], -basis_o[:, comp]), (obs_c, -1.0, 0.0))
    # The nuisance test at x: |a_o - v g - x h| against |obs_o - x| (nuisance_set).
    moving = ((draws.a[:, other], -basis_c[:, other], -basis_o[:, other]), (obs_o, 0.0, -1.0))
    centers = [obs_o]
    if tail:                                        # t = 1 / v, z = x / v: (const, v, x) -> (v, const, x)
        fixed = tuple((f[1], f[0], f[2]) for f in fixed)
        moving = tuple((f[1], f[0], f[2]) for f in moving)
        centers = [obs_o * t1, obs_o * t2]
    low, high = _affine_sets(*moving, t1, t2).hull(m, center=centers[0])
    low, high = min([low, *centers]), max([high, *centers])
    worst = _affine_sets(*fixed, t1, t2).sup(low, high)
    return beta + (1 + worst) / (draws.n + 1)


class _Certifier:
    """One side of the certified interval for coefficient `comp`."""

    def __init__(self, draws: Draws, comp: int, alpha: float, beta: float):
        self.draws, self.comp, self.alpha, self.beta = draws, comp, alpha, beta
        self.m = accept_count(beta, draws.n)
        self.center, self.scale = float(draws.obs[comp]), draws.scale(comp)
        self.used = 0

    def p(self, v: float) -> float:
        return bb_p_value(self.draws, self.comp, v, self.beta)[0]

    def _segments(self, edge: float, d: float) -> list[tuple[bool, float, float]]:
        """Strips from `edge` outward, near to far: doubling widths, then the rest of the half-line in 1 / v."""
        segs, start, width = [], edge, CERT_FIRST * self.scale
        while d * start < CERT_FAR * self.scale + abs(self.center):
            segs.append((False, start, start + d * width))
            start, width = start + d * width, width * 2
        segs.append((True, 1.0 / start, 0.0))
        return segs

    def first_uncertain(self, edge: float, d: float) -> tuple[bool, float, float] | None | str:
        """The nearest strip beyond `edge` that cannot be certified at the smallest width, None when
        every v beyond `edge` is certified rejected, "budget" when the budget ran out."""
        for tail, a, b in self._segments(edge, d):
            unit = CERT_MIN * (abs(a) if tail else max(self.scale, abs(a - self.center)))
            stack = [(a, b)]
            while stack:
                near, far = stack.pop()
                if self.used >= CERT_BUDGET:
                    return "budget"
                self.used += 1
                if _strip_bound(self.draws, self.comp, min(near, far), max(near, far), tail, self.beta,
                                self.m) < self.alpha:
                    continue
                if abs(far - near) <= unit:
                    return tail, near, far
                mid = 0.5 * (near + far)
                stack.append((mid, far))
                stack.append((near, mid))           # the near half first
        return None

    def end(self, d: float) -> float:
        """The interval's end in direction d: a value beyond which no value is accepted, or +-inf."""
        _, edge = _step_out(self.p, self.center, d, self.scale, self.alpha, self.scale)
        while math.isfinite(edge):
            found = self.first_uncertain(edge, d)
            if found is None:
                return float(edge)
            if found == "budget":
                break
            tail, near, far = found
            if tail and far == 0.0:
                break                                  # uncertain up to the limit: unbounded
            v_mid = 1.0 / (0.5 * (near + far)) if tail else 0.5 * (near + far)
            v_far = 1.0 / far if tail else far
            if self.p(v_mid) >= self.alpha:            # really accepted out there: step out past it
                _, edge = _step_out(self.p, v_mid, d, max(self.scale, abs(v_far - v_mid)), self.alpha, self.scale)
            else:                                      # not certified: keep the strip inside the interval
                edge = v_far
        return math.inf * d


def interval(draws: Draws, comp: int, alpha: float, beta: float | None = None) -> tuple[float, float]:
    """Interval for coefficient `comp`: a certified enclosure of every value its Berger-Boos test
    does not reject (p >= alpha), so it covers the true value with probability at least 1 - alpha
    under model M, as the Monte Carlo test's interval (the pseudo-randomness assumption of the module
    docstring, up to Monte Carlo error for the report's fixed re-draw sample). An end is infinite when
    the data cannot bound it or it could not be certified."""
    beta = nuisance_beta_for(draws.n) if beta is None else beta
    side = _Certifier(draws, comp, alpha, beta)
    low = side.end(-1.0)
    side.used = 0
    return low, side.end(1.0)


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
    with_carryover_ci: bool = False,
    with_p: bool = True,
    nuisance_beta: float | None = None,
) -> dict[str, Any]:
    """Fit the model and run the randomization tests.

    t_obs   0/1 per scheduled day (1 = arm A), length n_blocks * block_len
    y       outcome per day, NaN where there is none (those nights are left out, never imputed)
    dow     weekday 0..6 per day
    covariates  optional (n_days, k) covariates for the sensitivity analysis, added to the nuisance
                columns and held fixed across the re-draws; a day with a NaN covariate is left out.
                The joint-null identity needs them not to depend on the schedule: a covariate built
                from earlier trial outcomes does, so with one only p_value_no_effect stays exact
    with_p  False: estimates and counts only (per-protocol fit, planning)
    nuisance_beta  None = nuisance_beta_for(n_redraws), the registered level
    """
    draws, out = redraw_fit(t_obs, y, dow, block_len=block_len, n_a=n_a, pre_trial=pre_trial,
                            excluded_blocks=excluded_blocks, n_redraws=n_redraws, redraw_seed=redraw_seed,
                            covariates=covariates)
    if not with_p:
        return out
    if nuisance_beta is None:
        nuisance_beta = nuisance_beta_for(n_redraws)
    p_direct, carry_set = bb_p_value(draws, 0, 0.0, nuisance_beta)
    p_carry, _ = bb_p_value(draws, 1, 0.0, nuisance_beta)
    out.update({
        "p_value": p_direct,                                  # tau = 0, gamma unknown (doc 8.1)
        "p_carryover": p_carry,                               # gamma = 0, tau unknown
        "p_value_no_effect": joint_p_value(draws, 0, 0.0, 0.0),      # Fisher: no effect on any night
        "p_carryover_no_effect": joint_p_value(draws, 1, 0.0, 0.0),
        "nuisance_beta": float(nuisance_beta),
        # False when the data cannot bound the carryover at tau = 0: the same-night test is then
        # close to 1 (valid, but it cannot find anything); a longer trial or the period design helps.
        "carryover_set_bounded": bool(math.isfinite(carry_set[0]) and math.isfinite(carry_set[1])),
    })
    if with_ci:
        out["ci_low"], out["ci_high"] = interval(draws, 0, alpha, nuisance_beta)
    if with_carryover_ci:
        out["carryover_ci_low"], out["carryover_ci_high"] = interval(draws, 1, alpha, nuisance_beta)
    return out


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
    estimates = [randomization_analysis(t, y, dow, block_len=block_len, n_a=n_a, n_redraws=1, with_ci=False,
                                        with_p=False)["estimate"]
                 for t in schedules]
    return float(np.std(estimates))


def days_for_power(noise_sd: float, n_days: int, effect_ms: float) -> int:
    """Days for 80% power (two-sided 5%) at effect_ms, given the placebo SD seen over n_days.
    The SD of the estimate shrinks with the square root of the number of days."""
    blocks = np.ceil(n_days * (noise_sd * Z_POWER_80 / effect_ms) ** 2 / 4)
    return int(blocks * 4)


# ---------------------------------------------------------------------------
# What each output means, and what it needs (doc 8.1)
# ---------------------------------------------------------------------------

ASSUMPTIONS: dict[str, str] = {
    "randomized_schedule": (
        "The arms followed the registered permuted-block schedule drawn from the committed seed. The report "
        "job checks the stored schedule against the seed before analysing (GUARD experiment_schedule). The "
        "re-draws are a Monte Carlo sample from the same design, seeded deterministically by a hash of public "
        "values (the experiment id and the report date) that never touches the allocation seed, and the final "
        "report is computed once. The p-values' 'at most alpha' (and the intervals' 'at least 1 - alpha') is "
        "the Monte Carlo randomization test's guarantee for random re-draws, so here it rests on a "
        "pseudo-randomness assumption: the hash is treated as a random draw independent of the allocation. For "
        "the one fixed re-draw set of a report the size is alpha only up to Monte Carlo error (about "
        "sqrt(alpha (1 - alpha) / R)). The calibration report uses the same seeding rule and is the empirical "
        "evidence for it."),
    "one_night_carryover": (
        "The arm acts on the same night and the next night only: night D's outcome depends on the schedule "
        "through t_D and t_(D-1). Not tested by the analysis; the protocol must declare it "
        "(analysis.carryover_nights: 1) and justify it (analysis.model_justification), and a treatment that can "
        "last longer uses the period design (section 4.2)."),
    "constant_additive_effects": (
        "The same-night effect tau and the carryover gamma are the same on every night and add to the outcome: "
        "Y_D(t) = Y_D(0) + tau * t_D + gamma * t_(D-1). Not tested by the analysis; covered by the protocol's "
        "analysis.model_justification."),
    "missing_not_caused_by_arm": (
        "Whether a night has an outcome, and which blocks are left out, does not depend on the schedule. "
        "Checked only for a large imbalance: missing shares more than 10 points apart between the arms fail it "
        "(in an A/A check, where only a pipeline fault can tie missing nights to identical arms, Fisher's exact "
        "test of the arm x missing table at alpha instead); passing does not prove it."),
    "pre_trial_day_is_control": (
        "The day before the trial counts as the control arm for the first night's carryover. Covered by the "
        "protocol's analysis.model_justification."),
    "constant_multiplicative_effects": (
        "For the ln(HRV) sensitivity fit only: the model holds for ln(outcome), i.e. each arm multiplies the "
        "outcome by a constant factor on its own night and the next one. It cannot hold together with "
        "constant_additive_effects unless the effects are zero, so the primary result and this fit do not both "
        "rest on a true model. Neither tested nor declared by the protocol; the fit is a sensitivity check the "
        "decision rule never reads."),
}

_MODEL = ["randomized_schedule", "one_night_carryover", "constant_additive_effects", "missing_not_caused_by_arm",
          "pre_trial_day_is_control"]
_FISHER = ["randomized_schedule", "missing_not_caused_by_arm"]
_LOG_MODEL = ["randomized_schedule", "one_night_carryover", "constant_multiplicative_effects",
              "missing_not_caused_by_arm", "pre_trial_day_is_control"]


def secondary_missing_assumption(name: str) -> str:
    """The id of the assumption that a secondary outcome's own missing nights are not caused by the arm."""
    return f"missing_not_caused_by_arm:{name}"


def secondary_assumptions(names: Any) -> dict[str, str]:
    """The per-series missingness assumption of each secondary outcome (added to the report's list)."""
    return {secondary_missing_assumption(name): (
        f"Whether a night has a {name} value does not depend on the schedule. Checked per series with the "
        "primary outcome's rule (missing_not_caused_by_arm); passing does not prove it.") for name in names}


def output_semantics(beta: float = NUISANCE_BETA, alpha: float = 0.05, *, sensitivity: Any = (),
                     secondary: Any = ()) -> dict[str, dict[str, Any]]:
    """Null hypothesis, assumptions and validity of every number the report carries.

    sensitivity  the keys of the report's sensitivity block (ln_outcome, per_protocol,
                 covariate_<name>); each gets an entry "sensitivity.<key>"
    secondary    the names of its secondary outcomes; each gets "secondary_outcomes.<name>"
    An entry with approximate True is not certified even when every assumption it lists holds."""
    level = f"{100 * (1 - beta):g}%"
    # Every guarantee below is a Monte Carlo randomization test's (module docstring, randomized_schedule).
    mc = ("; as for every seeded Monte Carlo randomization test, this rests on the pseudo-randomness assumption "
          "of randomized_schedule (the re-draws' hashed seed treated as random) and holds for the report's one "
          "fixed re-draw set only up to Monte Carlo error")
    ols = ("OLS coefficient; approximately unbiased over the randomization when the assumptions hold (exact only "
           "with complete nights and a symmetric design: missing nights, the lag term and the fixed pre-trial day "
           "break the symmetry slightly)")
    enclosure = (f"a certified enclosure ({INTERVAL_METHOD}) of every value the test does not reject (p >= alpha), "
                 f"so it covers the true value with probability at least {1 - alpha:g} when the assumptions hold{mc}; "
                 "an infinite end means the nights cannot bound it, or it could not be certified. The accepted values "
                 "need not form one piece, so the interval can contain 0 while the p-value rejects 0; the reverse "
                 "cannot happen")
    out: dict[str, dict[str, Any]] = {
        "estimate": {"estimand": "tau: same-night effect, arm A minus arm B, intention to treat", "needs": _MODEL,
                     "validity": ols},
        "carryover": {"estimand": "gamma: the effect on the next night", "needs": _MODEL, "validity": ols},
        "two_night_total": {"estimand": "tau + gamma", "needs": _MODEL, "validity": "point estimate only"},
        "p_value": {
            "null": "tau = 0 (no same-night effect), any carryover gamma", "needs": _MODEL,
            "method": (f"Berger-Boos: the largest joint sharp-null randomization p-value over a {level} randomization "
                       f"confidence set for gamma, plus {beta:g}"),
            "validity": f"type I error at most alpha when the assumptions hold, whatever gamma is{mc}"},
        "ci_low / ci_high": {
            "null": "the tau0 values the p_value test of tau = tau0 does not reject", "needs": _MODEL,
            "validity": enclosure},
        "p_carryover": {
            "null": "gamma = 0 (no carryover), any same-night effect tau", "needs": _MODEL,
            "method": f"Berger-Boos as for p_value, with a {level} confidence set for tau",
            "validity": f"type I error at most alpha when the assumptions hold, whatever tau is{mc}"},
        "carryover_ci_low / carryover_ci_high": {
            "null": "the gamma0 values the p_carryover test of gamma = gamma0 does not reject", "needs": _MODEL,
            "validity": enclosure},
        "p_value_no_effect": {
            "null": "Fisher's sharp null: the schedule changes no night's outcome", "needs": _FISHER,
            "validity": ("exact without the effect model (one-night carryover, constant effects), but still only "
                         "with the randomized schedule and missing nights not caused by the arm; rejecting it says "
                         f"the arm acts on some night, not that the same-night effect is non-zero{mc}. Not read by "
                         "the decision rule")},
        "p_carryover_no_effect": {
            "null": "Fisher's sharp null, tested with the carryover coefficient", "needs": _FISHER,
            "validity": ("exact without the effect model, with the randomized schedule and missing nights not caused "
                         f"by the arm{mc}. Not read by the decision rule")},
        "hac_se / hac_se_carryover": {
            "validity": "approximate Newey-West cross-check (lags count observed nights). Not read by the decision rule"},
    }
    berger_boos = "the same Berger-Boos test and certified interval as p_value and ci_low / ci_high"
    for key in sensitivity:
        if key == "ln_outcome":
            out["sensitivity.ln_outcome"] = {
                "estimand": "tau on ln(HRV); estimate_pct = 100 * (exp(estimate_ln) - 1), the same-night change in %",
                "null": "p_value: tau = 0 on ln(HRV), any carryover on that scale; the interval: the tau0 not rejected",
                "needs": _LOG_MODEL,
                "validity": (f"{berger_boos}, on ln(HRV): type I error at most alpha and coverage at least "
                             f"{1 - alpha:g} when the model holds on the log scale (constant_multiplicative_effects), "
                             f"which it cannot do together with the primary model unless the effects are zero{mc}. A "
                             "sensitivity check, not read by the decision rule")}
        elif key == "per_protocol":
            out["sensitivity.per_protocol"] = {
                "estimand": "tau on adherent days only", "needs": _MODEL,
                "validity": ("estimate only: leaving out non-adherent days is no longer a randomized comparison, so "
                             "there is no p-value or interval. Not read by the decision rule")}
        elif key.startswith("covariate_"):
            covariate = key[len("covariate_"):]
            out[f"sensitivity.{key}"] = {
                "estimand": f"tau with {covariate} added to the nuisance columns",
                "null": "p_value: tau = 0, any gamma; the interval: the tau0 not rejected", "needs": _MODEL,
                "approximate": True,
                "validity": (f"approximate, not certified: {covariate} is built from earlier trial nights, whose "
                             "outcomes depend on earlier arms under the model, but the re-draws hold it fixed, so "
                             "the identity behind the exact joint test holds only at tau = gamma = 0. Read the "
                             "fit's p_value_no_effect for an exact test. A sensitivity check, not read by the "
                             "decision rule")}
            out[f"sensitivity.{key}.p_value_no_effect"] = {
                "null": "Fisher's sharp null: the schedule changes no night's outcome", "needs": _FISHER,
                "validity": (f"exact: under that null the outcomes, and so {covariate}, are the same under every "
                             "schedule, so holding it fixed is right. Rejecting it says the arm acts on some night, "
                             f"not which{mc}. Not read by the decision rule")}
    for name in secondary:
        out[f"secondary_outcomes.{name}"] = {
            "estimand": f"tau and gamma for {name}: its own same-night effect and carryover",
            "null": f"p_value: tau = 0 for {name}, any carryover; the interval: the tau0 not rejected",
            "needs": [*_MODEL, secondary_missing_assumption(name)],
            "validity": (f"{berger_boos}, for this series: valid when the model holds for it (one-night carryover, "
                         "its own constant effects) and its own missing nights are not caused by the arm (checked "
                         f"per series){mc}. A failed primary missingness check marks it too, the excluded blocks "
                         "being shared. Reported next to the primary result; the decision rule never reads it")}
    return out


def assumption_checks(primary: dict[str, Any], missingness: dict[str, Any],
                      spec: TrialSpec | None = None,
                      secondary_missingness: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """What the data, the registered protocol and the method record can check. A failed or pending
    check with blocks_decision withholds the decision; `covers` names the assumptions a failed
    check leaves unsupported (the outputs that need them are marked unsupported in the report).
    Without a spec nothing is declared, so the protocol checks fail (closed). Each secondary
    outcome gets its own missingness check, which never withholds the decision (the rule does not
    read secondary outcomes) but marks that series' numbers unsupported when it fails.

    Missing nights: a treatment trial fails the check on the 10-point rule (fail closed; the arm can
    change behaviour). In an A/A check both arms are the same instruction, so only a pipeline fault
    can tie missing nights to the arm; it fails on Fisher's exact test of the arm x missing table at
    the trial's alpha instead, because on a 4-week check the 10-point rule fires on chance alone
    about half the time when a fifth of nights are missing (14 nights per arm), which would void
    the check's own no-effect test."""
    kind = spec.kind if spec is not None else design.KIND_TREATMENT
    alpha = spec.alpha if spec is not None else 0.05

    def missing_failed(check: dict[str, Any]) -> bool:
        if kind == design.KIND_AA:
            fisher_p = check.get("fisher_p")
            return isinstance(fisher_p, (int, float)) and not isinstance(fisher_p, bool) and fisher_p < alpha
        return bool(check.get("threat"))

    if kind == design.KIND_AA:
        missing_rule = (f"missing nights are tied to the arm (Fisher exact p < {alpha:g}) although both arms carry the "
                        "same instruction, which only a pipeline fault can cause")
    else:
        missing_rule = "missing nights differ between the arms by more than 10 points"
    justification = (spec.model_justification or "").strip() if spec is not None else ""
    carryover = spec.carryover_nights if spec is not None else None
    if kind == design.KIND_AA:
        model_status = "ok"
        model_reason = "an A/A check: both arms are the same instruction, so the model holds with no effect"
    elif carryover != design.CARRYOVER_NIGHTS or not justification:
        model_status = "failed"
        model_reason = ("the registered protocol does not declare one night of carryover (analysis.carryover_nights: "
                        "1) with a justification (analysis.model_justification) for the parts of the model the "
                        "analysis cannot test: one-night carryover, constant additive effects and the pre-trial "
                        "day as control")
    else:
        model_status, model_reason = "ok", "declared and justified in the registered protocol"
    registered = spec.inference_method if spec is not None else None
    review = method_review_problem(spec.alpha if spec is not None else 0.05,
                                   spec.n_redraws if spec is not None else 10000)
    return [
        {"id": "missing_not_caused_by_arm", "status": "failed" if missing_failed(missingness) else "ok",
         "blocks_decision": True, "covers": ["missing_not_caused_by_arm"],
         "reason": f"{missing_rule}; the randomization tests assume the arm did not cause missing nights"},
        {"id": "model_justified", "status": model_status, "blocks_decision": True,
         "covers": ["one_night_carryover", "constant_additive_effects", "pre_trial_day_is_control"],
         "reason": model_reason},
        {"id": "carryover_set_bounded", "status": "ok" if primary.get("carryover_set_bounded") else "failed",
         "blocks_decision": False, "covers": [],
         "reason": ("the nights cannot bound the carryover, so the same-night test cannot reject (valid, "
                    "uninformative); a longer trial or the period design is needed")},
        {"id": "registered_method", "status": "ok" if registered == INFERENCE_METHOD else "failed",
         "blocks_decision": True, "covers": [],
         "reason": (f"the registration recorded the inference method {registered!r}, not {INFERENCE_METHOD}: the "
                    "analysis that ran is not the one registered")},
        {"id": "method_reviewed", "status": "ok" if review is None else "pending", "blocks_decision": True,
         "covers": [], "reason": review or "recorded for this trial's alpha and re-draw count"},
    ] + [
        {"id": secondary_missing_assumption(name), "status": "failed" if missing_failed(check) else "ok",
         "blocks_decision": False, "covers": [secondary_missing_assumption(name)],
         "reason": (f"{name}: {missing_rule}, so that secondary outcome's p-value and interval are not "
                    "supported")}
        for name, check in (secondary_missingness or {}).items()
    ]


def unsupported_outputs(outputs: dict[str, dict[str, Any]], checks: list[dict[str, Any]]) -> list[str]:
    """Marks every output whose assumptions a failed check leaves unsupported
    (outputs[name]["supported"]) and returns their names."""
    failed = {a for c in checks if c.get("status") == "failed" for a in c.get("covers", [])}
    out = []
    for name, entry in outputs.items():
        entry["supported"] = not (set(entry.get("needs", [])) & failed)
        if not entry["supported"]:
            out.append(name)
    return out


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


def _per_day(values: Any, n_days: int, name: str) -> np.ndarray:
    out = np.asarray(values, dtype=float)
    if out.shape != (n_days,):
        raise ValueError(f"{name} must have one value per scheduled day")
    return out


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

    primary = randomization_analysis(t, y, dow, **common, with_carryover_ci=True)

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
            pp = randomization_analysis(t, y_pp, dow, **{**common, "n_redraws": 1}, with_ci=False, with_p=False)
            sensitivity["per_protocol"] = {
                "estimate": pp["estimate"], "n_nights": pp["n_nights"],
                "note": "adherent days only: no longer a randomized comparison, so no p-value",
            }
        except ValueError as exc:
            sensitivity["per_protocol"] = {"estimate": None, "note": str(exc)}
    # Doc 8: the primary model plus one covariate at a time. A night whose covariate is missing is
    # left out, so these fits can use fewer nights than the primary one. hrv_lag1 / hrv_7d_mean are
    # built from earlier trial nights, so they depend on earlier arms: the fits' p_value and
    # interval are approximate and their p_value_no_effect is the exact test (output_semantics).
    for name, values in (data.covariates or {}).items():
        try:
            fit = randomization_analysis(t, y, dow, **common, covariates=_per_day(values, n_sched, name))
            sensitivity[f"covariate_{name}"] = {key: fit[key] for key in (
                "estimate", "ci_low", "ci_high", "p_value", "p_value_no_effect", "n_nights")}
        except ValueError as exc:
            sensitivity[f"covariate_{name}"] = {"estimate": None, "note": str(exc)}

    # Doc 6.1 "outcome.secondary": the same model on another series (a second sensor, resting HR).
    # Reported next to the primary result; the decision rule never reads them.
    # Each series has its own missing nights, checked like the primary outcome's.
    secondary: dict[str, Any] = {}
    secondary_missing: dict[str, dict[str, Any]] = {}
    for name, values in (data.secondary_outcomes or {}).items():
        y2 = _per_day(values, n_sched, name).copy()
        if used_days < n_sched:
            y2[used_days:] = np.nan
        secondary_missing[name] = missingness_check(t[in_scope], np.isnan(y2[in_scope]))
        try:
            fit = randomization_analysis(t, y2, dow, **common)
            secondary[name] = {key: fit[key] for key in ("estimate", "carryover", "ci_low", "ci_high", "p_value", "n_nights")}
        except ValueError as exc:
            secondary[name] = {"estimate": None, "note": str(exc)}
        secondary[name]["missingness"] = secondary_missing[name]

    missingness = missingness_check(t[in_scope], np.isnan(y[in_scope]))
    rule = decide(primary["estimate"], primary["ci_low"], primary["ci_high"], primary["p_value"], spec.mid_ms, spec.alpha)
    checks = assumption_checks(primary, missingness, spec, secondary_missing)
    withheld = [c["reason"] for c in checks if c["blocks_decision"] and c["status"] != "ok"]
    outputs = output_semantics(primary["nuisance_beta"], spec.alpha, sensitivity=list(sensitivity),
                               secondary=list(secondary))
    unsupported = unsupported_outputs(outputs, checks)

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
        # The rule's verdict is the decision only when nothing withholds it (doc 8.1); otherwise the
        # decision is "inconclusive" and the verdict stays visible next to the reasons.
        "decision": rule if not withheld else "inconclusive",
        "decision_if_supported": rule,
        "decision_firm": not withheld,
        "decision_withheld": withheld,
        # Doc 5.3: a carryover above half the MID means the next trial of this treatment needs periods.
        "carryover_exceeds_half_mid": abs(primary["carryover"]) > spec.mid_ms / 2,
        "missingness": missingness,
        "inference": {
            "method": INFERENCE_METHOD,
            "interval_method": INTERVAL_METHOD,
            "registered_method": spec.inference_method,
            "nuisance_beta": primary["nuisance_beta"],
            "assumptions": {**ASSUMPTIONS, **secondary_assumptions(secondary)},
            "checks": checks,
            "outputs": outputs,
            # Numbers whose assumptions a failed check leaves unsupported (each output also carries "supported").
            "unsupported_outputs": unsupported,
            "review": {key: (list(value) if isinstance(value, (tuple, list)) else value)
                       for key, value in METHOD_REVIEW.items()},
        },
        "sensitivity": sensitivity,
        "secondary_outcomes": secondary,
        "redraw_seed": str(seed),
        "generator": design.GENERATOR,
    }
    return report
