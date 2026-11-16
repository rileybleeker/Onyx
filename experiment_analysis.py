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
error is at most alpha whatever gamma is, whenever M holds. The interval inverts that test; the
carryover p-value and interval are the same construction with the roles swapped. Fisher's sharp null of no effect on any night is
reported too (p_value_no_effect): exact with no model, but rejecting it does not say which night.
The re-drawing never assumes anything about the HRV series, so autocorrelation does not break it.

analyze_trial() REFUSES to run before the pre-registered end (Riley's decision 1, doc section 13:
analyse only at the pre-registered end). A trial stopped early is reported as such. It reports the
decision rule's verdict as a firm decision only when the checks in assumption_checks() pass and
the method's calibration and independent review are recorded in METHOD_REVIEW; otherwise the
decision is withheld ("inconclusive") and the reasons are in the report.
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
NUISANCE_BETA = 0.001
MIN_NUISANCE_TAIL = 5
INFERENCE_METHOD = "joint_sharp_null_berger_boos_v1"
# Filled in by the PR that records the seeded calibration report (experiment_calibration.py, run in
# the scheduled validation phase) and the independent statistical review of INFERENCE_METHOD.
# Until both are set, analyze_trial withholds the decision (docs/experiment-framework.md 8.1).
METHOD_REVIEW: dict[str, str | None] = {"calibration_report": None, "independent_review": None}


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
    # Optional pre-registered extras, one array per scheduled day each (NaN = not available):
    covariates: dict[str, np.ndarray] | None = None          # pre-treatment covariates, one sensitivity fit each
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
    """Exact randomization p-value of component `comp` (0 = same night, 1 = next night) under the
    joint sharp null H(tau, gamma) of model M. A singular re-draw counts as extreme (conservative)."""
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


def nuisance_beta_for(n_redraws: int) -> float:
    """The registered nuisance level for a trial with n_redraws re-draws (fixed by the protocol's count)."""
    return max(NUISANCE_BETA, MIN_NUISANCE_TAIL / (n_redraws + 1))


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


def invert_p_value(p: Callable[[float], float], center: float, alpha: float, scale: float) -> tuple[float, float]:
    """An interval holding the values v with p(v) > alpha around `center` (where p is 1): step out
    until the test rejects, look further out for another accepted value before settling, then
    bisect. On purpose this is a hull, not the connected part around `center`: an accepted value
    found beyond a rejected gap widens the interval (a superset, so coverage can only rise)."""

    def bound(direction: float) -> float:
        inside, dist = center, scale
        outside = None
        for _ in range(64):
            x = center + direction * dist
            if p(x) > alpha:
                inside, dist = x, dist * 2
                continue
            hit = next((v for v in (center + direction * dist * k for k in (4.0, 3.0, 2.0, 1.5)) if p(v) > alpha), None)
            if hit is None:
                outside = x
                break
            inside, dist = hit, abs(hit - center) * 2
        if outside is None:
            return math.inf * direction
        lo, hi = inside, outside
        for _ in range(40):
            if abs(hi - lo) <= 1e-7 * scale:
                break
            mid = (lo + hi) / 2
            if p(mid) <= alpha:
                hi = mid
            else:
                lo = mid
        return float(lo)

    return bound(-1.0), bound(1.0)


def interval(draws: Draws, comp: int, alpha: float, beta: float | None = None) -> tuple[float, float]:
    """Interval for coefficient `comp` by inverting its Berger-Boos test (coverage at least
    1 - alpha under model M)."""
    return invert_p_value(lambda v: bb_p_value(draws, comp, v, beta)[0], float(draws.obs[comp]), alpha,
                          draws.scale(comp))


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
    covariates  optional (n_days, k) pre-treatment covariates for the sensitivity analysis; a day
                with a NaN covariate is left out
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
        "job checks the stored schedule against the seed before analysing (GUARD experiment_schedule)."),
    "one_night_carryover": (
        "The arm acts on the same night and the next night only: night D's outcome depends on the schedule "
        "through t_D and t_(D-1). Not tested by the analysis; the protocol must justify it, and a treatment "
        "that can last longer uses the period design (section 4.2)."),
    "constant_additive_effects": (
        "The same-night effect tau and the carryover gamma are the same on every night and add to the outcome: "
        "Y_D(t) = Y_D(0) + tau * t_D + gamma * t_(D-1). Not tested by the analysis."),
    "missing_not_caused_by_arm": (
        "Whether a night has an outcome, and which blocks are left out, does not depend on the schedule. "
        "Checked: missing shares more than 10 points apart between the arms fail it."),
    "pre_trial_day_is_control": "The day before the trial counts as the control arm for the first night's carryover.",
}

_MODEL = ["randomized_schedule", "one_night_carryover", "constant_additive_effects", "missing_not_caused_by_arm",
          "pre_trial_day_is_control"]


def output_semantics(beta: float = NUISANCE_BETA, alpha: float = 0.05) -> dict[str, dict[str, Any]]:
    """Null hypothesis, assumptions and validity of every number the report carries."""
    level = f"{100 * (1 - beta):g}%"
    return {
        "estimate": {"estimand": "tau: same-night effect, arm A minus arm B, intention to treat", "needs": _MODEL,
                     "validity": "OLS coefficient; unbiased over the randomization when the assumptions hold"},
        "carryover": {"estimand": "gamma: the effect on the next night", "needs": _MODEL,
                      "validity": "OLS coefficient; unbiased over the randomization when the assumptions hold"},
        "two_night_total": {"estimand": "tau + gamma", "needs": _MODEL, "validity": "point estimate only"},
        "p_value": {
            "null": "tau = 0 (no same-night effect), any carryover gamma", "needs": _MODEL,
            "method": (f"Berger-Boos: the largest joint sharp-null randomization p-value over a {level} randomization "
                       f"confidence set for gamma, plus {beta:g}"),
            "validity": "type I error at most alpha when the assumptions hold, whatever gamma is"},
        "ci_low / ci_high": {
            "null": "the tau0 values the p_value test of tau = tau0 does not reject", "needs": _MODEL,
            "validity": f"covers tau with probability at least {1 - alpha:g} when the assumptions hold"},
        "p_carryover": {
            "null": "gamma = 0 (no carryover), any same-night effect tau", "needs": _MODEL,
            "method": f"Berger-Boos as for p_value, with a {level} confidence set for tau",
            "validity": "type I error at most alpha when the assumptions hold, whatever tau is"},
        "carryover_ci_low / carryover_ci_high": {
            "null": "the gamma0 values the p_carryover test of gamma = gamma0 does not reject", "needs": _MODEL,
            "validity": f"covers gamma with probability at least {1 - alpha:g} when the assumptions hold"},
        "p_value_no_effect": {
            "null": "Fisher's sharp null: the schedule changes no night's outcome",
            "needs": ["randomized_schedule", "missing_not_caused_by_arm"],
            "validity": ("exact with no model of the effect; rejecting it says the arm acts on some night, not that "
                         "the same-night effect is non-zero. Not read by the decision rule")},
        "p_carryover_no_effect": {
            "null": "Fisher's sharp null, tested with the carryover coefficient",
            "needs": ["randomized_schedule", "missing_not_caused_by_arm"],
            "validity": "exact with no model of the effect. Not read by the decision rule"},
        "hac_se / hac_se_carryover": {
            "validity": "approximate Newey-West cross-check (lags count observed nights). Not read by the decision rule"},
    }


def assumption_checks(primary: dict[str, Any], missingness: dict[str, Any]) -> list[dict[str, Any]]:
    """What the data and the method record can check. A failed or pending check with
    blocks_decision withholds the decision."""
    reviewed = all(METHOD_REVIEW.get(key) for key in ("calibration_report", "independent_review"))
    return [
        {"id": "missing_not_caused_by_arm", "status": "failed" if missingness.get("threat") else "ok",
         "blocks_decision": True,
         "reason": ("missing nights differ between the arms by more than 10 points; the randomization test assumes "
                    "the arm did not cause missing nights")},
        {"id": "carryover_set_bounded", "status": "ok" if primary.get("carryover_set_bounded") else "failed",
         "blocks_decision": False,
         "reason": ("the nights cannot bound the carryover, so the same-night test cannot reject (valid, "
                    "uninformative); a longer trial or the period design is needed")},
        {"id": "method_reviewed", "status": "ok" if reviewed else "pending", "blocks_decision": True,
         "reason": (f"the calibration report and the independent statistical review of {INFERENCE_METHOD} are not "
                    "recorded yet (experiment_analysis.METHOD_REVIEW)")},
    ]


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
    # Doc 8: the primary model plus one pre-treatment covariate at a time. A night whose covariate
    # is missing is left out, so these fits can use fewer nights than the primary one.
    for name, values in (data.covariates or {}).items():
        try:
            fit = randomization_analysis(t, y, dow, **common, covariates=_per_day(values, n_sched, name))
            sensitivity[f"covariate_{name}"] = {key: fit[key] for key in ("estimate", "ci_low", "ci_high", "p_value", "n_nights")}
        except ValueError as exc:
            sensitivity[f"covariate_{name}"] = {"estimate": None, "note": str(exc)}

    # Doc 6.1 "outcome.secondary": the same model on another series (a second sensor, resting HR).
    # Reported next to the primary result; the decision rule never reads them.
    secondary: dict[str, Any] = {}
    for name, values in (data.secondary_outcomes or {}).items():
        y2 = _per_day(values, n_sched, name).copy()
        if used_days < n_sched:
            y2[used_days:] = np.nan
        try:
            fit = randomization_analysis(t, y2, dow, **common)
            secondary[name] = {key: fit[key] for key in ("estimate", "carryover", "ci_low", "ci_high", "p_value", "n_nights")}
        except ValueError as exc:
            secondary[name] = {"estimate": None, "note": str(exc)}

    missingness = missingness_check(t[in_scope], np.isnan(y[in_scope]))
    rule = decide(primary["estimate"], primary["ci_low"], primary["ci_high"], primary["p_value"], spec.mid_ms, spec.alpha)
    checks = assumption_checks(primary, missingness)
    withheld = [c["reason"] for c in checks if c["blocks_decision"] and c["status"] != "ok"]

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
            "nuisance_beta": primary["nuisance_beta"],
            "assumptions": dict(ASSUMPTIONS),
            "checks": checks,
            "outputs": output_semantics(primary["nuisance_beta"], spec.alpha),
            "review": dict(METHOD_REVIEW),
        },
        "sensitivity": sensitivity,
        "secondary_outcomes": secondary,
        "redraw_seed": str(seed),
        "generator": design.GENERATOR,
    }
    return report
