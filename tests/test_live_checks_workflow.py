"""Offline: which live-checks.yml steps GitHub Actions would run after a failure (Codex PR851-RPCSKIP).

The RPC check (tests/test_required_rpcs_live.py) is independent of the HRV alignment assertion. Before
this test its step had no `if:`, so GitHub's implicit success() skipped it whenever the HRV step failed:
a persistent HRV failure hid a missing database function on every run. This simulates the job's steps
in order with synthetic outcomes and evaluates each step's `if:` the way GitHub Actions does (an
expression with no status function gets an implicit success()). It reads only the workflow file:
no credentials, network or database.

The evaluator knows only the expression forms this workflow uses and fails on anything else, so a
later edit to a condition cannot slip past it unread.
"""
import re
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "live-checks.yml"

STATUS_FUNCS = ("success()", "failure()", "always()", "cancelled()")
TERM = re.compile(
    r"^(?P<neg>!)?(?:(?P<func>success|failure|always|cancelled)\(\)"
    r"|steps\.(?P<step>[A-Za-z0-9_-]+)\.outcome\s*==\s*'(?P<outcome>[a-z]+)'"
    r"|github\.event_name\s*==\s*'(?P<event>[a-z_]+)'"
    r"|inputs\.(?P<input>[A-Za-z0-9_]+)\s*==\s*(?P<ival>true|false))$"
)


def load_steps():
    doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    return doc["jobs"]["live-checks"]["steps"]


def evaluate(condition, *, failed, cancelled, outcomes, event, inputs):
    expr = (condition or "success()").strip()
    if expr.startswith("${{") and expr.endswith("}}"):
        expr = expr[3:-2].strip()
    if "||" in expr:
        raise AssertionError(f"evaluator does not support '||': {condition!r}")
    if not any(f in expr for f in STATUS_FUNCS):
        expr = f"success() && {expr}"
    result = True
    for raw in expr.split("&&"):
        term = raw.strip()
        m = TERM.match(term)
        if not m:
            raise AssertionError(f"unsupported expression term {term!r} in {condition!r}")
        if m.group("func"):
            value = {
                "success": not failed and not cancelled,
                "failure": failed and not cancelled,
                "always": True,
                "cancelled": cancelled,
            }[m.group("func")]
        elif m.group("step"):
            value = outcomes.get(m.group("step"), "") == m.group("outcome")
        elif m.group("event"):
            value = event == m.group("event")
        else:
            value = inputs.get(m.group("input"), False) == (m.group("ival") == "true")
        if m.group("neg"):
            value = not value
        result = result and value
    return result


def simulate(fail=(), cancel_after=None, event="schedule", inputs=None):
    """Run the steps in order. `fail` = step ids whose run fails; `cancel_after` = step id after which
    the run is cancelled. Returns {step key: True if it would run}."""
    outcomes, ran = {}, {}
    failed = cancelled = False
    for i, step in enumerate(load_steps()):
        key = step.get("id") or step.get("name") or f"step{i}"
        runs = evaluate(step.get("if"), failed=failed, cancelled=cancelled, outcomes=outcomes,
                        event=event, inputs=inputs or {})
        ran[key] = runs
        outcome = ("failure" if key in fail else "success") if runs else "skipped"
        if step.get("id"):
            outcomes[step["id"]] = outcome
        failed = failed or outcome == "failure"
        if key == cancel_after:
            cancelled = True
    return ran


WRITE_STEP = "Habit-rename cascade (WRITES fixtures to production; manual opt-in only)"


class LiveChecksWorkflowTests(unittest.TestCase):
    def test_step_ids_exist(self):
        ids = [s.get("id") for s in load_steps()]
        for needed in ("checkout", "python", "install", "hrv", "rpcs"):
            self.assertIn(needed, ids)

    def test_normal_run_runs_both_read_only_checks(self):
        ran = simulate()
        self.assertTrue(ran["hrv"])
        self.assertTrue(ran["rpcs"])
        self.assertFalse(ran[WRITE_STEP])

    def test_hrv_failure_still_runs_the_rpc_check(self):
        ran = simulate(fail={"hrv"})
        self.assertTrue(ran["hrv"])
        self.assertTrue(ran["rpcs"], "a failed HRV assertion must not hide a missing database function")
        self.assertFalse(ran[WRITE_STEP])

    def test_setup_failure_skips_the_rpc_check(self):
        for step in ("checkout", "python", "install"):
            with self.subTest(failed=step):
                ran = simulate(fail={step})
                self.assertFalse(ran["rpcs"])
                self.assertFalse(ran["hrv"])

    def test_cancelled_run_skips_the_rpc_check(self):
        ran = simulate(cancel_after="install")
        self.assertFalse(ran["rpcs"])

    def test_write_test_stays_manual_and_behind_success(self):
        manual = {"run_live_write_tests": True}
        self.assertTrue(simulate(event="workflow_dispatch", inputs=manual)[WRITE_STEP])
        self.assertFalse(simulate(event="workflow_dispatch", inputs={})[WRITE_STEP])
        self.assertFalse(simulate(event="schedule", inputs=manual)[WRITE_STEP])
        self.assertFalse(simulate(fail={"hrv"}, event="workflow_dispatch", inputs=manual)[WRITE_STEP])
        self.assertFalse(simulate(fail={"rpcs"}, event="workflow_dispatch", inputs=manual)[WRITE_STEP])

    def test_old_unconditioned_step_would_have_been_skipped(self):
        # The regression itself: the same evaluator skips an `if:`-less step after a failure.
        self.assertFalse(evaluate(None, failed=True, cancelled=False, outcomes={}, event="schedule", inputs={}))


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
