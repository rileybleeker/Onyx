"""Experiment framework (N-of-1 trials): allocation, protocol rules, analysis and the admin CLI.

Covers
  * experiment_design: block orderings, a pinned golden schedule (fails if numpy's PCG64 raw
    stream or SeedSequence ever changes), balance and uniformity, the re-draws use the same
    procedure, seed commitment, protocol template + validation rules (8 ms floor, future start,
    alignment version, seed commitment, supported objective source);
  * experiment_analysis: on synthetic AR(1) nights with missing data, the randomization test's
    type I error is near nominal, it detects a planted effect, the carryover term keeps the
    same-night estimate unbiased when the effect lingers, slow drift is absorbed, the interval
    covers the truth and agrees with the p-value, missing nights are never imputed, the
    missingness check flags arm-dependent gaps, and analyze_trial REFUSES before the
    pre-registered end;
  * experiment_admin: seed / register / verify / stop against an in-memory store: nothing
    printed contains a seed or an arm, registration needs a merged clean protocol and a matching
    commitment, a tampered schedule is a GUARD failure, every write leaves a heartbeat;
  * the SQL file: service-role only, additive.

Synthetic data only. No network, no credentials, no database.

Run: python tests/test_experiment_framework.py
"""
import hashlib
import io
import re
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import experiment_admin as admin  # noqa: E402
import experiment_analysis as ea  # noqa: E402
import experiment_design as ed  # noqa: E402

GOLDEN_SEED = hashlib.sha256(b"onyx experiment framework golden test seed (synthetic)").digest()
GOLDEN_SCHEDULE = "ABBABABAABBAABABBAABABBABAABAABBABBAABBABAABBABA"
GOLDEN_COMMITMENT = "919e1c5dfe09e313586b2900f7bc959ccf7a7f6f57212cea234d3996b56e5bf3"

# The doc's "current regime" planning numbers (docs/experiment-framework.md 7.1, set A).
SIGMA, RHO, MISSING, N_DAYS = 21.4, 0.476, 0.189, 232


def _ar1(rng, n, sigma=SIGMA, rho=RHO):
    e = np.empty(n)
    e[0] = rng.normal(0, sigma)
    shocks = rng.normal(0, sigma * np.sqrt(1 - rho ** 2), n)
    for i in range(1, n):
        e[i] = rho * e[i - 1] + shocks[i]
    return e


def _trial(rng, effect=0.0, carry=0.0, n_days=N_DAYS, missing=MISSING, drift=0.0):
    arms = ed.generate_schedule(rng.bytes(32), n_days // 4)
    t = np.array([1.0 if a == "A" else 0.0 for a in arms])
    lag = np.concatenate([[0.0], t[:-1]])
    y = 70 + _ar1(rng, n_days) + effect * t + carry * lag
    if drift:
        y = y + np.cumsum(rng.normal(0, drift, n_days))
    y[rng.random(n_days) < missing] = np.nan
    return t, y, np.arange(n_days) % 7


def _simulate(seed, reps, n_redraws=499, with_ci=False, **kw):
    rng = np.random.default_rng(seed)
    out = []
    for i in range(reps):
        t, y, dow = _trial(rng, **kw)
        out.append(ea.randomization_analysis(t, y, dow, n_redraws=n_redraws, redraw_seed=i, with_ci=with_ci))
    return out


# ---------------------------------------------------------------------------
# Allocation
# ---------------------------------------------------------------------------

def test_block_orderings():
    assert ed.block_orderings() == ("AABB", "ABAB", "ABBA", "BAAB", "BABA", "BBAA")
    assert ed.block_orderings(2, 1) == ("AB", "BA")
    assert len(ed.block_orderings(6, 3)) == 20
    for bad in ((4, 0), (4, 4)):
        try:
            ed.block_orderings(*bad)
        except ValueError:
            continue
        raise AssertionError("a one-armed block must be refused")


def test_golden_schedule_is_stable():
    # If this fails after a numpy upgrade, the raw PCG64 stream or SeedSequence changed: a stored
    # seed would no longer regenerate its schedule. Do not update the constant; pin numpy instead.
    assert "".join(ed.generate_schedule(GOLDEN_SEED, 12)) == GOLDEN_SCHEDULE
    assert ed.seed_commitment(GOLDEN_SEED) == GOLDEN_COMMITMENT
    assert ed.generate_schedule(GOLDEN_SEED, 58)[:48] == list(GOLDEN_SCHEDULE), "a longer trial extends the same stream"
    assert ed.redraw_seed("EXP-901", date(2030, 1, 1)) == 159056050193301463243657735986377462997


def test_schedule_is_balanced_and_orderings_are_uniform():
    arms = ed.generate_schedule(hashlib.sha256(b"uniformity").digest(), 6000)
    blocks = ["".join(arms[i:i + 4]) for i in range(0, len(arms), 4)]
    assert all(b.count("A") == 2 for b in blocks)
    counts = np.array([blocks.count(o) for o in ed.block_orderings()])
    chi2 = float(((counts - 1000) ** 2 / 1000).sum())
    assert chi2 < 20.5, f"orderings are not uniform (chi2 {chi2:.1f}, 5 df; 20.5 is p = 0.001)"
    assert len({"".join(ed.generate_schedule(hashlib.sha256(bytes([i])).digest(), 8)) for i in range(40)}) > 20


def test_redraws_use_the_registered_procedure():
    seed_int = int.from_bytes(GOLDEN_SEED, "big")
    one = ed.redraw_blocks(seed_int, 1, 12)[0]
    assert "".join("A" if v else "B" for v in one) == GOLDEN_SCHEDULE
    many = ed.redraw_blocks(7, 500, 58)
    assert many.shape == (500, 232)
    assert (many.reshape(500, 58, 4).sum(axis=2) == 2).all(), "every re-drawn block is balanced"
    assert (ed.redraw_blocks(7, 500, 58) == many).all(), "same seed, same re-draws"
    assert abs(many.mean() - 0.5) < 1e-12


def test_uniform_ints_cover_the_range_exactly():
    for k in (1, 2, 6, 7, 20):
        draws = ed._uniform_ints(ed._bitgen(123), k, 5000)
        assert draws.min() == 0 and draws.max() == k - 1 and len(draws) == 5000
    for bad_seed in (b"short", "x" * 32):
        try:
            ed.generate_schedule(bad_seed, 4)
        except ValueError:
            continue
        raise AssertionError("a seed that is not 32 bytes must be refused")


def test_schedule_rows():
    rows = ed.schedule_rows("EXP-901", date(2030, 1, 30), list("ABBABAAB"))
    assert [r["behavioral_date"] for r in rows][:3] == ["2030-01-30", "2030-01-31", "2030-02-01"]
    assert [(r["day_index"], r["block_index"], r["pos_in_block"]) for r in rows][3:6] == [(3, 0, 3), (4, 1, 0), (5, 1, 1)]
    assert "".join(r["arm"] for r in rows) == "ABBABAAB"


# ---------------------------------------------------------------------------
# Analysis on synthetic nights
# ---------------------------------------------------------------------------

def test_type_one_error_is_near_nominal_on_null_data():
    fits = _simulate(seed=11, reps=400)
    rate = np.mean([f["p_value"] < 0.05 for f in fits])
    # 400 trials: one standard error of a true 5% rate is 1.1 points.
    assert 0.02 <= rate <= 0.085, f"type I error {rate:.3f} is not near 0.05"
    assert abs(np.mean([f["estimate"] for f in fits])) < 0.6, "no effect must estimate to about zero"
    carry_rate = np.mean([f["p_carryover"] < 0.05 for f in fits])
    assert carry_rate <= 0.085, f"carryover test rejects too often under the null ({carry_rate:.3f})"


def test_detects_a_planted_effect():
    fits = _simulate(seed=12, reps=300, effect=8.0)
    power = np.mean([f["p_value"] < 0.05 for f in fits])
    assert power > 0.65, f"power {power:.2f} at +8 ms over 232 days (the design assumes about 0.8)"
    assert abs(np.mean([f["estimate"] for f in fits]) - 8.0) < 0.8
    weak = np.mean([f["p_value"] < 0.05 for f in _simulate(seed=13, reps=200, effect=1.0)])
    assert weak < 0.25, "a 1 ms effect must not look detectable"


def test_carryover_term_keeps_the_same_night_effect_unbiased():
    fits = _simulate(seed=14, reps=300, effect=8.0, carry=4.0, n_redraws=199)
    b0 = np.mean([f["estimate"] for f in fits])
    b1 = np.mean([f["carryover"] for f in fits])
    assert abs(b0 - 8.0) < 0.8, f"same-night estimate {b0:.2f} is biased by a lingering effect"
    assert abs(b1 - 4.0) < 0.9, f"carryover estimate {b1:.2f}"
    assert abs(np.mean([f["two_night_total"] for f in fits]) - 12.0) < 1.2


def test_slow_drift_is_absorbed_by_blocks():
    fits = _simulate(seed=15, reps=200, effect=8.0, drift=1.5, n_redraws=199)
    assert abs(np.mean([f["estimate"] for f in fits]) - 8.0) < 1.0


def test_interval_covers_the_truth_and_agrees_with_the_test():
    fits = _simulate(seed=16, reps=150, effect=8.0, n_redraws=999, with_ci=True)
    covered = np.mean([f["ci_low"] <= 8.0 <= f["ci_high"] for f in fits])
    assert covered >= 0.90, f"95% interval covers the true effect in {covered:.2f} of trials"
    disagree = sum((f["p_value"] <= 0.05) != (f["ci_low"] > 0 or f["ci_high"] < 0) for f in fits)
    assert disagree <= 2, f"interval and p-value disagree about zero in {disagree} trials"
    for f in fits[:20]:
        assert f["ci_low"] < f["estimate"] < f["ci_high"]
        assert 0.4 < f["hac_se"] / f["redraw_sd"] < 2.5, "HAC standard error is a sane cross-check"


def test_missing_nights_are_left_out_never_imputed():
    rng = np.random.default_rng(17)
    t, y, dow = _trial(rng, effect=8.0, missing=0.0)
    full = ea.randomization_analysis(t, y, dow, n_redraws=199, with_ci=False)
    assert full["n_nights"] == N_DAYS and full["n_nights_a"] == full["n_nights_b"] == N_DAYS // 2
    holes = y.copy()
    holes[::5] = np.nan
    part = ea.randomization_analysis(t, holes, dow, n_redraws=199, with_ci=False)
    assert part["n_nights"] == int((~np.isnan(holes)).sum())
    excl = ea.randomization_analysis(t, y, dow, n_redraws=199, with_ci=False, excluded_blocks={0, 5, 9})
    assert excl["n_nights"] == N_DAYS - 12
    try:
        ea.randomization_analysis(1 - t * 0, y, dow, n_redraws=9)
    except ValueError:
        pass
    else:
        raise AssertionError("an assignment that is not a permuted-block schedule must be refused")


def test_missingness_check_flags_arm_dependent_gaps():
    t = np.tile([1, 1, 0, 0], 50)
    even = np.tile([1, 0, 0, 0, 0, 0, 1, 0], 25).astype(bool)
    assert not ea.missingness_check(t, even)["threat"]
    skewed = (t == 1) & (np.arange(200) % 3 == 0)
    check = ea.missingness_check(t, skewed)
    assert check["threat"] and check["difference"] > 0.10 and check["fisher_p"] < 0.001


def test_decision_rule():
    assert ea.decide(9.0, 3.0, 15.0, 0.01, 8.0, 0.05) == "adopt_A"
    assert ea.decide(-9.0, -15.0, -3.0, 0.01, 8.0, 0.05) == "inconclusive", "a significant harm is not 'adopt A'"
    assert ea.decide(1.0, -4.0, 6.0, 0.6, 8.0, 0.05) == "no_meaningful_effect"
    assert ea.decide(4.0, -2.0, 10.0, 0.2, 8.0, 0.05) == "inconclusive"


def _spec_and_data(effect=8.0, n_redraws=999, seed=18, **spec_kw):
    rng = np.random.default_rng(seed)
    start = date(2030, 1, 7)
    arms = ed.generate_schedule(rng.bytes(32), N_DAYS // 4)
    t = np.array([1.0 if a == "A" else 0.0 for a in arms])
    y = 70 + _ar1(rng, N_DAYS) + effect * t
    y[rng.random(N_DAYS) < MISSING] = np.nan
    spec = ea.TrialSpec("EXP-901", start, start + timedelta(days=N_DAYS - 1), mid_ms=8.0, n_redraws=n_redraws, **spec_kw)
    return spec, ea.TrialData(arms=arms, outcome=y)


def test_analysis_refuses_before_the_preregistered_end():
    spec, data = _spec_and_data()
    for as_of in (spec.start, spec.start + timedelta(days=115), spec.planned_end):
        try:
            ea.analyze_trial(spec, data, as_of)
        except ea.AnalysisNotAllowed as exc:
            assert "pre-registered end" in str(exc)
        else:
            raise AssertionError(f"analysis ran on {as_of}, before the trial's last night was in")
    report = ea.analyze_trial(spec, data, spec.planned_end + timedelta(days=1))
    assert report["stopped_early"] is False and report["last_day_analysed"] == spec.planned_end.isoformat()


def test_report_is_deterministic_and_complete():
    spec, data = _spec_and_data()
    as_of = spec.planned_end + timedelta(days=1)
    first, second = ea.analyze_trial(spec, data, as_of), ea.analyze_trial(spec, data, as_of)
    assert first == second, "the same report on the same day must return identical numbers"
    other_day = ea.analyze_trial(spec, data, as_of + timedelta(days=1))
    assert other_day["estimate"] == first["estimate"] and other_day["redraw_seed"] != first["redraw_seed"]
    for key in ("estimate", "ci_low", "ci_high", "p_value", "carryover", "p_carryover", "two_night_total", "hac_se",
                "n_nights", "decision", "missingness", "sensitivity", "carryover_exceeds_half_mid", "generator"):
        assert key in first, key
    assert first["days_scheduled"] == N_DAYS and first["n_nights"] == int((~np.isnan(data.outcome)).sum())
    assert first["decision"] in ("adopt_A", "no_meaningful_effect", "inconclusive")
    assert "ln_outcome" in first["sensitivity"] and "per_protocol" not in first["sensitivity"]
    assert np.sign(first["sensitivity"]["ln_outcome"]["estimate_pct"]) == np.sign(first["estimate"])

    data.adherent = np.arange(N_DAYS) % 10 != 0
    with_pp = ea.analyze_trial(spec, data, as_of)
    assert "no longer a randomized comparison" in with_pp["sensitivity"]["per_protocol"]["note"]
    assert with_pp["sensitivity"]["per_protocol"]["n_nights"] < with_pp["n_nights"]
    assert with_pp["estimate"] == first["estimate"], "the primary estimate is intention to treat"


def test_stopped_early_trial_is_reported_as_such():
    spec, data = _spec_and_data()
    stop = spec.start + timedelta(days=121)
    spec.stopped_on = stop
    try:
        ea.analyze_trial(spec, data, stop)
    except ea.AnalysisNotAllowed:
        pass
    else:
        raise AssertionError("the stop day's night is not in until the next day")
    report = ea.analyze_trial(spec, data, stop + timedelta(days=1))
    assert report["stopped_early"] is True and report["last_day_analysed"] == stop.isoformat()
    assert report["days_in_scope"] <= 122 and report["n_nights"] < 122


# ---------------------------------------------------------------------------
# Protocol file
# ---------------------------------------------------------------------------

TODAY = date(2030, 1, 1)


def _protocol_text(**changes):
    text = (ROOT / "docs" / "experiments" / "TEMPLATE.md").read_text(encoding="utf-8")
    base = {"id: EXP-000": "id: EXP-901", "start: 2099-01-05": "start: 2030-01-07",
            "planned_end: 2099-08-24": "planned_end: 2030-08-26",
            "seed_sha256: paste-the-value-printed-by-the-seed-step": f"seed_sha256: {GOLDEN_COMMITMENT}"}
    base.update(changes)
    for old, new in base.items():
        assert old in text, old
        text = text.replace(old, new)
    return text


def _validate(text, **kw):
    kw.setdefault("today", TODAY)
    kw.setdefault("alignment_version", "same_night_v1")
    return ed.validate_protocol(ed.parse_protocol(text.encode()), **kw)


def _problems(text, **kw):
    try:
        _validate(text, **kw)
    except ed.ProtocolError as exc:
        return " | ".join(exc.problems)
    return ""


def test_template_cannot_be_registered_as_is():
    raw = (ROOT / "docs" / "experiments" / "TEMPLATE.md").read_bytes()
    problems = _problems(raw.decode("utf-8"))
    assert "template id" in problems and "seed_sha256" in problems
    assert ed.protocol_sha256(raw) == ed.protocol_sha256(raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")), \
        "the protocol hash must not depend on the checkout's line endings"


def test_filled_template_validates():
    fields = _validate(_protocol_text(), seed_sha256=GOLDEN_COMMITMENT)
    assert fields["experiment_id"] == "EXP-901" and fields["n_days"] == 232 and fields["n_blocks"] == 58
    assert fields["start_date"] == "2030-01-07" and fields["planned_end"] == "2030-08-26"
    assert fields["mid_ms"] == 8.0 and fields["alpha"] == 0.05 and fields["n_redraws"] == 10000
    assert fields["control_arm"] == "B" and fields["arm_a_instruction"].startswith("No phone")
    assert fields["adherence"]["objective"] == {"source": ed.OBJECTIVE_SOURCES[0], "max": 5, "arm": "A"}
    assert fields["protocol"]["start"] == "2030-01-07", "dates are stored as text, not Python objects"
    import json
    json.dumps(fields)


def test_protocol_rules():
    assert "8 ms or more" in _problems(_protocol_text(**{"mid_ms: 8 ": "mid_ms: 5 "}))
    assert "must be after today" in _problems(_protocol_text(), today=date(2030, 1, 7))
    assert "must be after today" in _problems(_protocol_text(), today=date(2030, 3, 1))
    assert "planned_end must be" in _problems(_protocol_text(**{"planned_end: 2099-08-24": "planned_end: 2030-08-27"}))
    assert "n_days must be" in _problems(_protocol_text(**{"n_days: 232": "n_days: 230"}))
    assert "not implemented" in _problems(_protocol_text(**{"type: daily_4day_permuted_blocks": "type: period_ab"}))
    assert "alignment_version" in _problems(_protocol_text(), alignment_version="wake_day_v0")
    assert "does not match the seed" in _problems(_protocol_text(), seed_sha256="0" * 64)
    assert "objective.source" in _problems(_protocol_text(**{
        "source: pds.phone_usage_daily.minutes_last_hour_before_sleep_est": "source: pds.habit_journal.answer"}))
    assert "arms.B is missing" in _problems(_protocol_text(**{
        "  B: Usual evening (control). Use your phone as you normally would.\n": ""}))
    assert "interim looks are not built" in _problems(_protocol_text(**{
        "interim: none ": "interim: at 50% of blocks, O'Brien-Fleming "}))
    assert "front matter" in " ".join(_catch(lambda: ed.parse_protocol(b"# no front matter\n")))


def _catch(fn):
    try:
        fn()
    except ed.ProtocolError as exc:
        return exc.problems
    return []


# ---------------------------------------------------------------------------
# Admin CLI against an in-memory store
# ---------------------------------------------------------------------------

class FakeSupa:
    """Only what sync_log_helper.log_sync touches."""

    def __init__(self):
        self.heartbeats = []

    def schema(self, _):
        return self

    def table(self, name):
        assert name == "sync_log"
        return self

    def insert(self, row):
        self.heartbeats.append(row)
        return self

    def execute(self):
        return self


class FakeStore:
    def __init__(self):
        self.supa = FakeSupa()
        self.rows, self.seeds, self.sched = {}, {}, {}
        self.today = date(2030, 2, 1)

    def experiment(self, experiment_id):
        return self.rows.get(experiment_id)

    def experiments(self):
        return list(self.rows.values())

    def create_draft(self, experiment_id, title, commitment, seed_hex):
        assert hashlib.sha256(bytes.fromhex(seed_hex)).hexdigest() == commitment
        self.rows[experiment_id] = {"experiment_id": experiment_id, "title": title, "status": "draft", "seed_sha256": commitment}
        self.seeds[experiment_id] = seed_hex

    def seed_hex(self, experiment_id):
        return self.seeds.get(experiment_id)

    def register(self, experiment_id, fields, schedule):
        self.rows[experiment_id].update(fields, status="registered", locked_at="2030-01-01T00:00:00+00:00")
        self.sched[experiment_id] = [dict(r) for r in schedule]
        return {"experiment_id": experiment_id, "status": "registered", "locked_at": "2030-01-01T00:00:00+00:00"}

    def schedule(self, experiment_id):
        return self.sched.get(experiment_id, [])

    def behavioral_today(self):
        return self.today

    def experiment_active(self):
        return any(r["status"] in ("registered", "running", "paused") for r in self.rows.values())

    def hrv_by_day(self, first, last):
        self.hrv_window = (first, last)
        return {d: v for d, v in getattr(self, "hrv", {}).items() if first.isoformat() <= d <= last.isoformat()}

    def stop(self, experiment_id, stopped_on, reason):
        self.rows[experiment_id].update(status="stopped_early", stopped_on=stopped_on.isoformat(), stop_reason=reason)


MERGED = lambda _path: {"tracked": True, "clean": True, "commit": "c0ffee", "branch": "master", "on_master": True}  # noqa: E731


def _repo(tmp, text=None, name="EXP-901.md"):
    folder = Path(tmp) / "docs" / "experiments"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(text or _protocol_text(), encoding="utf-8", newline="\n")
    return Path(tmp), f"docs/experiments/{name}"


def _refused(fn):
    try:
        fn()
    except (admin.AdminError, ed.ProtocolError) as exc:
        return str(exc)
    raise AssertionError("expected a refusal")


def test_admin_seed_then_register_then_verify():
    store = FakeStore()
    with tempfile.TemporaryDirectory() as tmp:
        root, path = _repo(tmp)
        out = admin.cmd_seed(store, path, root=root, new_seed=lambda: GOLDEN_SEED)
        text = "\n".join(out)
        assert f"seed_sha256: {GOLDEN_COMMITMENT}" in text and GOLDEN_SEED.hex() not in text
        assert store.rows["EXP-901"]["status"] == "draft" and store.sched == {}
        again = "\n".join(admin.cmd_seed(store, path, root=root, new_seed=lambda: b"\x01" * 32))
        assert "already has a draft" in again and GOLDEN_COMMITMENT in again, "a second seed step must not replace the seed"

        assert "--confirm" in _refused(lambda: admin.cmd_register(store, path, "yes", root=root, today=TODAY, git=MERGED))
        not_merged = lambda _p: {**MERGED(_p), "branch": "feat/x", "on_master": False}  # noqa: E731
        assert "merged to master" in _refused(lambda: admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=not_merged))
        dirty = lambda _p: {**MERGED(_p), "clean": False}  # noqa: E731
        assert "committed" in _refused(lambda: admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=dirty))
        assert "must be after today" in _refused(lambda: admin.cmd_register(store, path, "EXP-901", root=root, today=date(2030, 1, 7), git=MERGED))
        assert store.rows["EXP-901"]["status"] == "draft" and store.sched == {}, "a refused registration writes nothing"

        out = "\n".join(admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=MERGED))
        row, rows = store.rows["EXP-901"], store.sched["EXP-901"]
        assert row["status"] == "registered" and row["git_commit"] == "c0ffee" and row["protocol_path"] == path
        assert row["protocol_sha256"] == ed.protocol_sha256((root / path).read_bytes())
        assert len(rows) == 232 and rows[0]["behavioral_date"] == "2030-01-07" and rows[-1]["behavioral_date"] == "2030-08-26"
        assert "".join(r["arm"] for r in rows[:48]) == GOLDEN_SCHEDULE
        arms = "".join(r["arm"] for r in rows)
        assert GOLDEN_SEED.hex() not in out and arms[:12] not in out and not re.search(r"\b[AB]{4,}\b", out), \
            "the registration output must not show a seed or any arms"
        assert "registered again" in _refused(lambda: admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=MERGED))
        assert "new trial needs a new id" in _refused(lambda: admin.cmd_seed(store, path, root=root))

        assert "all 232 stored days match" in admin.cmd_verify(store, "EXP-901")[0]
        store.sched["EXP-901"][40]["arm"] = "A" if store.sched["EXP-901"][40]["arm"] == "B" else "B"
        assert _refused(lambda: admin.cmd_verify(store, "EXP-901")).startswith("GUARD experiment_schedule:")


def test_admin_refuses_bad_protocol_files():
    store = FakeStore()
    with tempfile.TemporaryDirectory() as tmp:
        root, path = _repo(tmp, text=(ROOT / "docs" / "experiments" / "TEMPLATE.md").read_text(encoding="utf-8"), name="TEMPLATE.md")
        assert "not the template id" in _refused(lambda: admin.cmd_seed(store, path, root=root))
        root, path = _repo(tmp, name="EXP-902.md")
        assert "must be named EXP-901.md" in _refused(lambda: admin.cmd_seed(store, path, root=root))
        (root / "elsewhere.md").write_text(_protocol_text(), encoding="utf-8")
        assert "under docs/experiments" in _refused(lambda: admin.cmd_seed(store, "elsewhere.md", root=root))
        assert "under docs/experiments" in _refused(lambda: admin.cmd_seed(store, "../outside.md", root=root))
        root, path = _repo(tmp)
        assert "no draft" in _refused(lambda: admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=MERGED))
        assert store.rows == {}


def test_admin_stop_and_status():
    store = FakeStore()
    assert admin.cmd_status(store) == ["No experiments."]
    with tempfile.TemporaryDirectory() as tmp:
        root, path = _repo(tmp)
        admin.cmd_seed(store, path, root=root, new_seed=lambda: GOLDEN_SEED)
        assert "not an active trial" in _refused(lambda: admin.cmd_stop(store, "EXP-901", "ill", "EXP-901"))
        admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=MERGED)
    assert "--confirm" in _refused(lambda: admin.cmd_stop(store, "EXP-901", "ill", "no"))
    assert "--reason" in _refused(lambda: admin.cmd_stop(store, "EXP-901", "  ", "EXP-901"))
    assert "stopped early on 2030-02-01" in admin.cmd_stop(store, "EXP-901", "ill", "EXP-901")[0]
    assert store.rows["EXP-901"]["status"] == "stopped_early"
    line = admin.cmd_status(store)[0]
    assert "EXP-901" in line and "stopped_early" in line and "2030-01-07 to 2030-08-26" in line


def test_planning_check_recovers_the_design_length_on_synthetic_nights():
    rng = np.random.default_rng(19)
    y = 70 + _ar1(rng, N_DAYS)
    y[rng.random(N_DAYS) < MISSING] = np.nan
    sd = ea.placebo_noise(y, np.arange(N_DAYS) % 7, n_trials=400, seed=1)
    need = ea.days_for_power(sd, N_DAYS, 8.0)
    # The design says about 232 days for 8 ms at this noise; one synthetic series lands near it.
    assert 150 <= need <= 340 and need % 4 == 0, need
    assert ea.days_for_power(sd, N_DAYS, 4.0) >= 3.9 * need, "half the effect needs four times the days"
    assert ea.placebo_noise(y, np.arange(N_DAYS) % 7, n_trials=400, seed=1) == sd, "same seed, same answer"


def test_admin_power_is_read_only_aggregates_and_refused_during_a_trial():
    store = FakeStore()
    rng = np.random.default_rng(20)
    series = 70 + _ar1(rng, 200)
    last = store.today - timedelta(days=1)
    store.hrv = {(last - timedelta(days=i)).isoformat(): float(series[i]) for i in range(200) if i % 6}
    out = admin.cmd_power(store, 122, 8.0, n_trials=200)
    assert store.hrv_window == (last - timedelta(days=119), last), "the window ends yesterday and is whole blocks"
    text = "\n".join(out)
    assert "of 120 nights with HRV" in text and re.search(r"needs about \d+ days \(\d+ blocks\) for 80% power", text)
    assert len(re.findall(r"\d{4}-\d{2}-\d{2}", text)) == 2 and len(out) == 4, "the window's two dates and aggregates, no per-day values"
    assert store.rows == {} and store.supa.heartbeats == [], "the planning check writes nothing"
    assert "--window" in _refused(lambda: admin.cmd_power(store, 30, 8.0))
    store.hrv = {}
    assert "nights with HRV" in _refused(lambda: admin.cmd_power(store, 120, 8.0))
    store.rows["EXP-901"] = {"experiment_id": "EXP-901", "title": "t", "status": "running"}
    assert "unregistered look" in _refused(lambda: admin.cmd_power(store, 120, 8.0))


def test_admin_main_leaves_a_heartbeat_and_guard_prefix():
    store = FakeStore()
    with tempfile.TemporaryDirectory() as tmp:
        root, path = _repo(tmp)
        admin.cmd_seed(store, path, root=root, new_seed=lambda: GOLDEN_SEED)
        admin.cmd_register(store, path, "EXP-901", root=root, today=TODAY, git=MERGED)
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        assert admin.main(["verify", "--experiment", "EXP-901"], store=store) == 0
        assert admin.main(["status"], store=store) == 0
    assert store.supa.heartbeats == [], "read-only commands that succeed write nothing"
    store.sched["EXP-901"][3]["arm"] = "A" if store.sched["EXP-901"][3]["arm"] == "B" else "B"
    with redirect_stdout(out), redirect_stderr(err):
        assert admin.main(["verify", "--experiment", "EXP-901"], store=store) == 1
        assert admin.main(["stop", "--experiment", "EXP-901", "--reason", "synthetic", "--confirm", "EXP-901"], store=store) == 0
        assert admin.main(["stop", "--experiment", "EXP-901", "--reason", "again", "--confirm", "EXP-901"], store=store) == 1
    beats = store.supa.heartbeats
    assert [(b["source"], b["data_type"], b["status"]) for b in beats] == [
        ("experiments", "admin", "failed"), ("experiments", "admin", "success"), ("experiments", "admin", "failed")]
    assert beats[0]["error_message"].startswith("GUARD experiment_schedule:")
    assert beats[2]["error_message"].startswith("stop: ")
    printed = out.getvalue() + err.getvalue() + " ".join(str(b) for b in beats)
    assert GOLDEN_SEED.hex() not in printed and GOLDEN_SCHEDULE[:16] not in printed


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def test_sql_is_service_role_only_and_additive():
    sql = (ROOT / "sql" / "experiment_framework_schema.sql").read_text(encoding="utf-8")
    banned = re.findall(r"(?i)\b(?:drop|truncate|delete)\w*", sql)
    assert banned == [], f"the migration must be additive (found {banned})"
    for table in ("experiments", "experiment_secrets", "experiment_schedule", "experiment_days"):
        assert re.search(rf"ALTER TABLE pds\.{table}\s+ENABLE ROW LEVEL SECURITY", sql), table
    grants = re.findall(r"(?im)^GRANT\b.*?;", sql, flags=re.S)
    assert grants and all(re.search(r"TO service_role\s*;", g) for g in grants), "nothing is granted to anon or authenticated"
    assert "CREATE POLICY" not in sql, "no policy: the browser must never read the schedule"
    assert "FROM PUBLIC, anon, authenticated" in sql


def test_the_arm_never_enters_the_observational_pipeline():
    for name in ("hrv_analysis.py", "causal_inference.py", "hrv_predict.py"):
        src = (ROOT / name).read_text(encoding="utf-8")
        assert "experiment_" not in src.replace("experiment_framework", ""), f"{name} must not read the experiment tables"
    for name in ("experiment_design.py", "experiment_analysis.py"):
        src = (ROOT / name).read_text(encoding="utf-8")
        assert ".shift(-" not in src and "supabase" not in src.lower().replace("no database", ""), name


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
