"""Decision-logic tests for tools/merge_train.py. No network, no credentials, no gh calls."""
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import merge_train as mt  # noqa: E402


def pr(**kw):
    base = dict(number=1, title="feat: x", isDraft=False, baseRefName="master", isCrossRepository=False,
                author="rileybleeker", labels=[], headRefOid="a" * 40, headRefName="feat/x",
                mergeable="MERGEABLE", mergeStateStatus="CLEAN")
    base.update(kw)
    return base


GREEN = [dict(id=1, name="offline-checks", status="completed", conclusion="success")]
OTHER = dict(id=2, name="kindle-harvester", status="completed", conclusion="success")  # a non-required check
OK_FILES = ["frontend/src/components/Foo.tsx"]


def judge(p=None, files=OK_FILES, runs=GREEN, statuses=(), active=0, halted=False):
    return mt.judge(p or pr(), files, list(runs), list(statuses), active, halted)


class Judge(unittest.TestCase):
    def test_green_clean_merges(self):
        self.assertEqual(judge()[0], "merge")

    def test_unstable_only_from_ignored_vercel_preview(self):
        runs = GREEN + [dict(id=3, name="Vercel Preview Comments", status="completed", conclusion="failure")]
        self.assertEqual(judge(pr(mergeStateStatus="UNSTABLE"), runs=runs)[0], "merge")

    def test_failed_other_check_blocks(self):
        runs = GREEN + [dict(id=3, name="stats-tests", status="completed", conclusion="failure")]
        self.assertEqual(judge(runs=runs)[0], "skip")

    def test_newer_success_replaces_older_failure(self):
        runs = [dict(id=1, name="offline-checks", status="completed", conclusion="failure"),
                dict(id=9, name="offline-checks", status="completed", conclusion="success"), OTHER]
        self.assertEqual(judge(runs=runs)[0], "merge")

    def test_cancelled_latest_blocks(self):
        runs = [dict(id=9, name="offline-checks", status="completed", conclusion="cancelled"), OTHER]
        self.assertEqual(judge(runs=runs)[0], "skip")

    def test_failed_commit_status_blocks_but_vercel_preview_does_not(self):
        self.assertEqual(judge(statuses=[dict(context="ci/other", state="failure")])[0], "skip")
        self.assertEqual(judge(statuses=[dict(context="Vercel Preview Comments", state="failure")])[0], "merge")

    def test_running_check_waits(self):
        runs = [dict(id=1, name="offline-checks", status="in_progress", conclusion=None), OTHER]
        self.assertEqual(judge(runs=runs)[0], "wait")
        self.assertEqual(judge(active=1)[0], "wait")

    def test_missing_required_check_dispatches_ci(self):
        self.assertEqual(judge(runs=[OTHER])[0], "dispatch")
        self.assertEqual(judge(runs=[])[0], "dispatch")

    def test_only_offline_checks_is_required(self):
        # 2026-11-14: frontend-types and stats-tests moved to scheduled-tests.yml; offline-checks alone merges
        self.assertEqual(mt.REQUIRED, ("offline-checks",))
        self.assertEqual(judge(runs=GREEN)[0], "merge")

    def test_behind_merges_without_a_rebase_round(self):
        self.assertEqual(judge(pr(mergeStateStatus="BEHIND"))[0], "merge")
        self.assertEqual(judge(pr(mergeStateStatus="BEHIND"), runs=[])[0], "dispatch")

    def test_behind_with_failed_check_is_left_alone(self):
        runs = [dict(id=1, name="offline-checks", status="completed", conclusion="failure"), OTHER]
        self.assertEqual(judge(pr(mergeStateStatus="BEHIND"), runs=runs)[0], "skip")

    def test_conflict_skips(self):
        self.assertEqual(judge(pr(mergeable="CONFLICTING", mergeStateStatus="DIRTY"))[0], "skip")

    def test_draft_hold_fork_wrong_base_skip(self):
        for p in (pr(isDraft=True), pr(labels=["hold"]), pr(isCrossRepository=True), pr(baseRefName="dev")):
            self.assertEqual(judge(p)[0], "skip", p)

    def test_unknown_author_skips(self):
        self.assertEqual(judge(pr(author="mallory"))[0], "skip")
        self.assertEqual(judge(pr(author="github-actions[bot]"))[0], "skip")  # bot without rollback shape

    def test_protected_paths_skip(self):
        for path in (".github/workflows/x.yml", "frontend/src/middleware.ts", "sql/owner_read_rls.sql", "frontend/.env.local",
                     "tools/merge_train.py", "frontend/src/lib/auth.ts", "vercel.json"):
            self.assertEqual(judge(files=OK_FILES + [path])[0], "skip", path)

    def test_ordinary_paths_pass(self):
        for path in ("frontend/src/app/today/page.tsx", "hrv_analysis.py", "sql/new_table.sql", "docs/x.md"):
            self.assertEqual(judge(files=[path])[0], "merge", path)

    def test_file_list_unknown_or_huge_skips(self):
        self.assertEqual(judge(files=None)[0], "skip")
        self.assertEqual(judge(files=["a.md"] * 101)[0], "skip")

    def test_halt_blocks_all_but_rollback(self):
        self.assertEqual(judge(halted=True)[0], "skip")
        rb = pr(author="github-actions[bot]", labels=["rollback"], title="Revert abc1234: x", headRefName="rollback/abc1234")
        self.assertEqual(judge(rb, halted=True)[0], "merge")

    def test_rollback_shape_is_enforced(self):
        spoof = pr(author="github-actions[bot]", labels=["rollback"], title="Revert x", headRefName="feat/other")
        self.assertEqual(judge(spoof)[0], "skip")
        spoof = pr(author="mallory", labels=["rollback"], title="Revert x", headRefName="rollback/x")
        self.assertEqual(judge(spoof)[0], "skip")

    def test_rollback_still_blocked_on_protected_path(self):
        rb = pr(author="github-actions[bot]", labels=["rollback"], title="Revert a: x", headRefName="rollback/a")
        self.assertEqual(judge(rb, files=[".github/workflows/x.yml"], halted=True)[0], "skip")


class Plan(unittest.TestCase):
    def d(self, number, action, state="CLEAN"):
        return (pr(number=number, mergeStateStatus=state), action, "r")

    def test_merge_beats_everything(self):
        move, p, _ = mt.plan([self.d(1, "update", "BEHIND"), self.d(2, "merge")])
        self.assertEqual((move, p["number"]), ("merge", 2))

    def test_only_one_update_in_flight_behind_a_waiting_head(self):
        move, p, _ = mt.plan([self.d(1, "update", "BEHIND"), self.d(2, "wait")])
        self.assertEqual((move, p["number"]), ("wait", 2))

    def test_oldest_behind_pr_is_updated_first(self):
        move, p, _ = mt.plan([self.d(3, "update", "BEHIND"), self.d(5, "update", "BEHIND")])
        self.assertEqual((move, p["number"]), ("update", 3))

    def test_idle(self):
        self.assertEqual(mt.plan([self.d(1, "skip")])[0], "idle")


class Culprit(unittest.TestCase):
    """A failed build is reverted at the commit that broke it, and only when the deployment history proves which one
    that is; otherwise nothing is reverted and the train halts (Codex review 2026-11-14)."""
    A, B, C = "a" * 40, "b" * 40, "c" * 40

    def test_head_broke_it(self):
        self.assertEqual(mt.culprit_of([(self.C, ["failure"]), (self.B, ["success"])]), self.C)

    def test_parent_already_broken(self):
        chain = [(self.C, ["failure"]), (self.B, ["failure"]), (self.A, ["success"])]
        self.assertEqual(mt.culprit_of(chain), self.B)

    def test_a_commit_without_a_build_inside_the_run_is_unknown(self):
        # Codex: A broke it, B was never built (superseded, like #187), C failed with A's fault. Reverting C is wrong.
        self.assertIsNone(mt.culprit_of([(self.C, ["failure"]), (self.B, []), (self.A, ["failure"])]))
        self.assertIsNone(mt.culprit_of([(self.C, ["failure"]), (self.B, []), (self.A, ["success"])]))

    def test_canceled_errored_or_pending_parent_is_unknown(self):
        # Vercel's `inactive` is "Canceled from the Vercel Dashboard": that commit never built.
        for states in (["inactive"], ["error"], ["pending"], ["failure", "error"]):
            self.assertIsNone(mt.culprit_of([(self.C, ["failure"]), (self.B, states), (self.A, ["success"])]), states)

    def test_failing_merge_without_a_failed_build_is_unknown(self):
        # A deploy that never finished (timeout) or an infrastructure error is not evidence against the source.
        for states in ([], ["pending"], ["error"], ["inactive"]):
            self.assertIsNone(mt.culprit_of([(self.C, states), (self.B, ["success"])]), states)

    def test_no_good_build_within_the_commits_read_is_unknown(self):
        self.assertIsNone(mt.culprit_of([(self.C, ["failure"]), (self.B, ["failure"])]))
        self.assertIsNone(mt.culprit_of([]))

    def test_build_state(self):
        self.assertEqual(mt.build_state(["failure", "success"]), "good")
        self.assertEqual(mt.build_state(["failure", "failure"]), "failed")
        for states in ([], ["inactive"], ["error"], ["queued"], ["failure", "pending"]):
            self.assertEqual(mt.build_state(states), "unknown", states)

    def test_describe_chain_is_one_line_of_evidence(self):
        self.assertEqual(mt.describe_chain([(self.C, ["failure"]), (self.B, [])]), "ccccccc failure, bbbbbbb no deployment")


class PostMergeWorkflow(unittest.TestCase):
    def test_unknown_provenance_halts_without_a_revert(self):
        wf = (Path(__file__).resolve().parents[1] / ".github/workflows/post-merge.yml").read_text()
        self.assertIn("needs.verify.outputs.result == 'halt'", wf)
        self.assertIn("--halt-only", wf)


class PinnedCiWorkflow(unittest.TestCase):
    """Manual pinned runs of Autonomous CI (workflow_dispatch with sha) never satisfy the required check."""
    def test_workflow_checks_out_and_keys_concurrency_by_input(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/autonomous-ci.yml").read_text()
        self.assertEqual(workflow.count("ref: ${{ inputs.sha || github.sha }}"), len(mt.REQUIRED))  # one job per check
        self.assertIn("run-name: Autonomous CI ${{ inputs.sha || github.sha }}", workflow)
        self.assertIn("group: autonomous-ci-${{ inputs.sha || github.ref }}", workflow)
        for check in mt.REQUIRED:
            self.assertIn("name: ${{ inputs.sha && '" + check + "-pinned' || '" + check + "' }}", workflow)


class ProductionVerdict(unittest.TestCase):
    def test_success_wins(self):
        self.assertEqual(mt.production_verdict(["success"], True)[0], "ok")

    def test_failed_deploy_fails(self):
        self.assertEqual(mt.production_verdict(["failure"], False)[0], "fail")
        self.assertEqual(mt.production_verdict(["error", "failure"], True)[0], "fail")

    def test_replaced_deployment_is_skipped_not_failed(self):
        self.assertEqual(mt.production_verdict(["inactive"], False)[0], "skipped")
        self.assertEqual(mt.production_verdict(["pending"], True)[0], "skipped")

    def test_still_building_waits(self):
        self.assertIsNone(mt.production_verdict(["in_progress"], False))
        self.assertIsNone(mt.production_verdict([], False))


class MovedOnVerdict(unittest.TestCase):
    def test_ok_becomes_skipped_when_master_moved_during_the_wait(self):
        # 2026-11-14: #113 waited 14 min, #120/#124 landed, its old smoke spec failed against their new pages
        self.assertEqual(mt.moved_on_verdict("ok", "green", "a" * 40, "b" * 40)[0], "skipped")

    def test_ok_stays_ok_while_still_head(self):
        self.assertEqual(mt.moved_on_verdict("ok", "green", "a" * 40, "a" * 40), ("ok", "green"))

    def test_fail_stays_fail_even_after_master_moved(self):
        self.assertEqual(mt.moved_on_verdict("fail", "deploy failure", "a" * 40, "b" * 40)[0], "fail")


class SelfAndPreview(unittest.TestCase):
    def test_own_running_job_does_not_block(self):
        runs = GREEN + [dict(id=7, name="train", status="in_progress", conclusion=None)]
        self.assertEqual(judge(runs=runs)[0], "merge")

    def test_pending_vercel_preview_does_not_block_but_failure_does(self):
        self.assertEqual(judge(pr(mergeStateStatus="UNSTABLE"), statuses=[dict(context="Vercel", state="pending")])[0], "merge")
        self.assertEqual(judge(statuses=[dict(context="Vercel", state="failure")])[0], "skip")

    def test_other_pending_status_still_waits(self):
        self.assertEqual(judge(statuses=[dict(context="ci/other", state="pending")])[0], "wait")


if __name__ == "__main__":
    unittest.main()
