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

    def test_builder_branch_never_enters_the_train(self):
        # Ordinary green CI on a new head cannot replace the local worker's exact-head receipt. Missing CI
        # and behind branches must not dispatch or update either; the worker exclusively owns this lane.
        for state in ("CLEAN", "BEHIND"):
            for runs in (GREEN, []):
                for head in ("a" * 40, "b" * 40):
                    with self.subTest(state=state, runs=runs, head=head):
                        p = pr(headRefName="builder/task-1", headRefOid=head, mergeStateStatus=state)
                        decision = judge(p, runs=runs)
                        self.assertEqual(decision[0], "skip")
                        self.assertIn("feature worker", decision[1])
                        self.assertEqual(mt.plan([(p, *decision)])[0], "idle")

    def test_builder_skip_does_not_stall_other_release_lanes(self):
        worker = pr(headRefName="builder/task-1")
        ordinary = pr(number=2, headRefName="feat/builder-settings")
        rollback = pr(number=3, author="github-actions[bot]", labels=["rollback"],
                      title="Revert abc1234: x", headRefName="rollback/abc1234")
        for candidate, halted in ((ordinary, False), (rollback, True)):
            with self.subTest(branch=candidate["headRefName"]):
                decisions = [(worker, *judge(worker, halted=halted)),
                             (candidate, *judge(candidate, halted=halted))]
                move, selected, _ = mt.plan(decisions)
                self.assertEqual(move, "merge")
                self.assertEqual(selected["number"], candidate["number"])

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


class AlreadyFixed(unittest.TestCase):
    """2026-11-15: #294's build failed, #297 fixed it and deployed, and the rollback of #294 still merged (#296)."""
    A, B, C = "a" * 40, "b" * 40, "c" * 40

    def test_failed_build_fixed_by_a_newer_good_build(self):
        self.assertEqual(mt.fixed_later(["failure"], [(self.C, ["success"]), (self.B, ["success"])]), self.C)
        self.assertEqual(mt.fixed_later(["failure"], [(self.C, []), (self.B, ["success"])]), self.B)

    def test_no_newer_good_build_is_not_fixed(self):
        self.assertIsNone(mt.fixed_later(["failure"], []))
        self.assertIsNone(mt.fixed_later(["failure"], [(self.C, ["failure"]), (self.B, ["inactive"])]))

    def test_only_a_build_failure_can_be_fixed_by_a_later_build(self):
        # a smoke failure on a commit whose own build succeeded is not disproved by a later good build
        self.assertIsNone(mt.fixed_later(["success"], [(self.C, ["success"])]))
        self.assertIsNone(mt.fixed_later([], [(self.C, ["success"])]))
        self.assertIsNone(mt.fixed_later(["error"], [(self.C, ["success"])]))

    def test_rollback_target_reads_the_body_rollback_writes(self):
        body = f"Automatic rollback of `{self.A}`.\n\nReason: Production deployment failure\n\nCloses #295"
        self.assertEqual(mt.rollback_target(body), self.A)
        self.assertIsNone(mt.rollback_target("Revert something by hand"))
        self.assertIsNone(mt.rollback_target(None))


class SmokeProvenance(unittest.TestCase):
    """DEL-02: a smoke result counts for a commit only when production served exactly that commit and deployment
    before and after the run. Synthetic commits and hosts only."""
    E, N = "e" * 40, "f" * 40  # expected commit, a newer merge
    HOST = "frontend-abc123-example.vercel.app"
    OTHER = "frontend-zzz999-example.vercel.app"

    def rec(self, version=None, deployment=HOST):
        return mt.provenance_record({"version": version or self.E, "deployment": deployment})

    def verdict(self, tests_ok, before, after, host=HOST):
        return mt.smoke_verdict(self.E, host, tests_ok, before, after)[0]

    def test_exact_target_both_ends_passes_or_fails(self):
        self.assertEqual(self.verdict(True, self.rec(), self.rec()), "pass")
        self.assertEqual(self.verdict(False, self.rec(), self.rec()), "fail")

    def test_alias_moved_during_the_run_is_deferred_never_a_pass_or_a_fail(self):
        # a newer merge deployed while the run was going: its UI must not count for the older commit
        moved = self.rec(self.N, self.OTHER)
        for tests_ok in (True, False):
            self.assertEqual(self.verdict(tests_ok, self.rec(), moved), "deferred", tests_ok)
            self.assertEqual(self.verdict(tests_ok, moved, moved), "deferred", tests_ok)
            self.assertEqual(self.verdict(tests_ok, moved, None), "deferred", tests_ok)

    def test_newer_commit_served_from_the_start_names_it(self):
        verdict, detail = mt.smoke_verdict(self.E, self.HOST, True, self.rec(self.N), self.rec(self.N))
        self.assertEqual(verdict, "deferred")
        self.assertIn(self.N[:7], detail)

    def test_other_deployment_of_the_same_commit_is_deferred(self):
        # a redeploy (or a Vercel rollback) of the same commit is not the deployment this run was started for
        self.assertEqual(self.verdict(True, self.rec(), self.rec(deployment=self.OTHER)), "deferred")
        self.assertEqual(self.verdict(False, self.rec(deployment=self.OTHER), self.rec()), "deferred")

    def test_build_that_names_no_deployment_matches_on_the_commit(self):
        old = self.rec(deployment=None)
        self.assertEqual(self.verdict(True, old, old), "pass")
        self.assertIn("matched on commit", mt.smoke_verdict(self.E, self.HOST, True, old, old)[1])

    def test_unconfirmed_target_never_passes_and_a_failure_is_not_attributed(self):
        for before, after in ((None, None), (self.rec(), None), (None, self.rec())):
            self.assertEqual(self.verdict(True, before, after), "deferred")
            self.assertEqual(self.verdict(False, before, after), "unverified")

    def test_malformed_records_prove_nothing(self):
        for raw in (None, [], "x", {}, {"version": "E" * 40}, {"version": "abc"}, {"version": self.E[:39]},
                    {"version": self.E, "deployment": "not a host!"}, {"version": self.E, "deployment": 7}):
            self.assertIsNone(mt.provenance_record(raw), raw)
        self.assertEqual(mt.provenance_record({"version": self.E, "deployment": ""}),
                         {"version": self.E, "deployment": None})
        self.assertEqual(mt.provenance_record({"version": self.E, "deployment": self.HOST.upper()})["deployment"],
                         self.HOST)

    def test_deployment_host_accepts_only_a_bare_https_deployment_address(self):
        self.assertEqual(mt.deployment_host(f"https://{self.HOST}"), self.HOST)
        self.assertEqual(mt.deployment_host(f"https://{self.HOST}/"), self.HOST)
        for bad in ("", None, f"http://{self.HOST}", f"https://{self.HOST}/login", f"https://u@{self.HOST}",
                    f"https://{self.HOST}:8443", "https://", "https://-bad-.example"):
            self.assertIsNone(mt.deployment_host(bad), bad)


class SmokeTarget(unittest.TestCase):
    E = "e" * 40
    A = "https://frontend-aaa111-example.vercel.app"
    B = "https://frontend-bbb222-example.vercel.app"

    def test_requested_url_must_be_a_live_deployment_of_the_commit(self):
        self.assertEqual(mt.pick_deployment([("success", self.A)], self.A, self.E)[0], self.A)
        self.assertEqual(mt.pick_deployment([("success", self.A + "/")], self.A, self.E)[0], self.A)
        self.assertIsNone(mt.pick_deployment([("success", self.A)], self.B, self.E)[0])  # another commit's URL
        self.assertIsNone(mt.pick_deployment([("success", self.A)], "http://x", self.E)[0])

    def test_superseded_deployment_is_not_a_target(self):
        url, why = mt.pick_deployment([("inactive", self.A)], self.A, self.E)
        self.assertIsNone(url)
        self.assertIn("inactive", why)
        self.assertIsNone(mt.pick_deployment([("pending", self.A)], self.A, self.E)[0])

    def test_without_a_request_the_newest_live_deployment_is_taken(self):
        deps = [("failure", self.B), ("success", self.A)]
        self.assertEqual(mt.pick_deployment(deps, "", self.E)[0], self.A)
        self.assertIsNone(mt.pick_deployment([], "", self.E)[0])
        self.assertIsNone(mt.pick_deployment([("success", "")], "", self.E)[0])

    def test_only_merged_commits_run_with_the_smoke_credentials(self):
        self.assertTrue(mt.on_master("ahead"))
        self.assertTrue(mt.on_master("identical"))
        for status in ("behind", "diverged", "", "unknown"):
            self.assertFalse(mt.on_master(status), status)


class SmokeOutcome(unittest.TestCase):
    def test_attempt_from_job_outputs(self):
        self.assertEqual(mt.attempt_verdict("pass", "success"), "pass")
        self.assertEqual(mt.attempt_verdict("fail", "failure"), "fail")
        # superseded by a newer smoke run (concurrency cancel) or never started: proves nothing
        for result in ("cancelled", "skipped", ""):
            self.assertEqual(mt.attempt_verdict("fail", result), "deferred", result)
        # the job failed before it wrote a verdict (install, runner)
        self.assertEqual(mt.attempt_verdict("", "failure"), "unverified")
        self.assertEqual(mt.attempt_verdict("bogus", "failure"), "unverified")

    def test_outcomes(self):
        self.assertEqual(mt.smoke_outcome("pass", ""), "pass")
        self.assertEqual(mt.smoke_outcome("fail", "pass"), "pass")  # a flaky first attempt
        self.assertEqual(mt.smoke_outcome("fail", "fail"), "fail")
        self.assertEqual(mt.smoke_outcome("deferred", ""), "pending")
        self.assertEqual(mt.smoke_outcome("fail", "deferred"), "pending")  # alias moved before the retry
        for first, retry in (("unverified", "unverified"), ("fail", "unverified"), ("unverified", "fail")):
            self.assertEqual(mt.smoke_outcome(first, retry), "halt", (first, retry))

    def test_status_records_pending_verification_unless_exact(self):
        self.assertEqual(mt.smoke_status("pass"), "success")
        self.assertEqual(mt.smoke_status("fail"), "failure")
        self.assertEqual(mt.smoke_status("pending"), "pending")
        self.assertEqual(mt.smoke_status("halt"), "pending")


class SmokeCulpritAndStaleRollback(unittest.TestCase):
    E, P, N = "e" * 40, "d" * 40, "f" * 40

    def status(self, state, creator="github-actions[bot]", context=mt.SMOKE_CONTEXT):
        return dict(context=context, state=state, creator=creator)

    def test_receipt_reads_only_the_workflows_own_newest_smoke_status(self):
        self.assertEqual(mt.smoke_state_of([self.status("success")]), "pass")
        self.assertEqual(mt.smoke_state_of([self.status("failure"), self.status("success")]), "fail")
        self.assertEqual(mt.smoke_state_of([self.status("pending")]), "unknown")
        self.assertEqual(mt.smoke_state_of([]), "unknown")
        self.assertEqual(mt.smoke_state_of([self.status("success", creator="someone")]), "unknown")
        self.assertEqual(mt.smoke_state_of([self.status("success", context="ci/other")]), "unknown")

    def test_revert_only_when_the_parent_passed_on_its_own_deployment(self):
        self.assertEqual(mt.smoke_culprit(self.E, "pass"), self.E)
        # the parent was superseded / deferred: it may hold the breaking change, so no unrelated revert
        self.assertIsNone(mt.smoke_culprit(self.E, "unknown"))
        # the parent already failed: its own verification acted; a person decides
        self.assertIsNone(mt.smoke_culprit(self.E, "fail"))

    def test_failed_smoke_fixed_by_a_newer_exact_pass_is_a_stale_rollback(self):
        self.assertEqual(mt.smoke_fixed_later("fail", [(self.N, "pass"), (self.P, "unknown")]), self.N)
        self.assertEqual(mt.smoke_fixed_later("fail", [(self.N, "unknown"), (self.P, "pass")]), self.P)
        self.assertIsNone(mt.smoke_fixed_later("fail", [(self.N, "fail"), (self.P, "unknown")]))
        self.assertIsNone(mt.smoke_fixed_later("fail", []))
        # a commit whose own smoke receipt is not a failure is never "fixed" by a later pass
        self.assertIsNone(mt.smoke_fixed_later("pass", [(self.N, "pass")]))
        self.assertIsNone(mt.smoke_fixed_later("unknown", [(self.N, "pass")]))

    def test_already_fixed_checks_the_smoke_receipts_after_the_build(self):
        later = [(self.N, ["success"])]
        states = {self.E: "fail", self.N: "pass"}
        with patch.object(mt, "later_chain", return_value=later), \
                patch.object(mt, "production_states", return_value=["success"]), \
                patch.object(mt, "smoke_state", side_effect=states.get):
            self.assertEqual(mt.already_fixed(self.E), self.N)
        states = {self.E: "pass", self.N: "pass"}  # smoke passed: nothing to fix
        with patch.object(mt, "later_chain", return_value=later), \
                patch.object(mt, "production_states", return_value=["success"]), \
                patch.object(mt, "smoke_state", side_effect=states.get):
            self.assertIsNone(mt.already_fixed(self.E))


class SmokeCommands(unittest.TestCase):
    """The smoke-test.yml / post-merge.yml steps with GitHub faked: outputs and the commit status they write."""
    E, P = "e" * 40, "d" * 40
    URL = "https://frontend-abc123-example.vercel.app"

    def run_cmd(self, fn, *args, gh=None):
        import os
        import tempfile
        calls = []

        def fake_gh(*a, check=True):
            calls.append(a)
            return gh(a) if gh else ""
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            with patch.dict(os.environ, {"GITHUB_OUTPUT": out, "GITHUB_STEP_SUMMARY": os.path.join(d, "sum")}), \
                    patch.object(mt, "gh", side_effect=fake_gh):
                code = fn(*args)
            outputs = {}
            if os.path.exists(out):
                for line in open(out, encoding="utf-8"):
                    k, _, v = line.rstrip("\n").partition("=")
                    outputs[k] = v
        return code, outputs, calls

    def write_provenance(self, d, before, after):
        import json
        import os
        for phase, rec in (("before", before), ("after", after)):
            if rec is not None:
                with open(os.path.join(d, f"{phase}.json"), "w", encoding="utf-8") as fh:
                    json.dump(rec, fh)

    def test_verdict_command_fails_the_job_only_on_fail_or_unverified(self):
        import tempfile
        host = mt.deployment_host(self.URL)
        same = {"version": self.E, "deployment": host}
        moved = {"version": "f" * 40, "deployment": "frontend-new-example.vercel.app"}
        cases = [("success", same, same, "pass", 0), ("failure", same, same, "fail", 1),
                 ("success", same, moved, "deferred", 0), ("failure", same, moved, "deferred", 0),
                 ("failure", None, None, "unverified", 1), ("cancelled", same, None, "deferred", 0)]
        for tests, before, after, verdict, code in cases:
            with tempfile.TemporaryDirectory() as d:
                self.write_provenance(d, before, after)
                got, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, self.URL, True, "", tests, d)
            self.assertEqual((out["verdict"], got), (verdict, code), (tests, before, after))
            self.assertEqual(out["tested_sha"], self.E if verdict in ("pass", "fail") else "")

    def test_verdict_command_not_ready_is_deferred_without_reading_anything(self):
        code, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, "", False, "no live deployment", "skipped", "")
        self.assertEqual((out["verdict"], code), ("deferred", 0))
        self.assertIn("no live deployment", out["detail"])

    def test_target_refuses_an_unmerged_commit_before_any_checkout(self):
        code, out, calls = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "behind\n")
        self.assertEqual((code, out["ready"], out["sha"]), (0, "false", ""))
        self.assertEqual(len(calls), 1)  # the compare call only: no deployment lookup
        code, out, _ = self.run_cmd(mt.smoke_target, "not-a-sha", "")
        self.assertEqual(out["ready"], "false")

    def test_target_forwards_the_exact_commit_and_deployment(self):
        with patch.object(mt, "production_deployments", return_value=[("success", self.URL)]):
            code, out, _ = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "ahead\n")
        self.assertEqual((out["ready"], out["sha"], out["deployment_url"]), ("true", self.E, self.URL))

    def receipt(self, attempts, parent_state="pass", verify="ok"):
        def fake(a):
            return self.P + "\n" if a[1].startswith(f"repos/{mt.REPO}/commits/") else ""
        with patch.object(mt, "smoke_state", return_value=parent_state):
            code, out, calls = self.run_cmd(mt.smoke_receipt, self.E, self.URL, verify, "detail", attempts, gh=fake)
        status = next((c for c in calls if c[:3] == ("api", "-X", "POST")), None)
        return out, status

    def test_receipt_reverts_only_a_double_exact_failure_with_a_passing_parent(self):
        fail = ("fail", "failure", "failed on host")
        out, status = self.receipt([fail, fail])
        self.assertEqual((out["action"], out["culprit"]), ("revert", self.E))
        self.assertIn("state=failure", status)
        self.assertIn(f"context={mt.SMOKE_CONTEXT}", status)
        self.assertTrue(status[3].endswith(f"/statuses/{self.E}"))
        out, status = self.receipt([fail, fail], parent_state="unknown")
        self.assertEqual((out["action"], out["culprit"]), ("halt", ""))
        self.assertIn("state=failure", status)  # the deployment did fail; only the culprit is unknown

    def test_receipt_records_pending_verification_and_never_reverts_otherwise(self):
        cases = [([("pass", "success", "ok"), ("", "skipped", "")], "none", "state=success"),
                 ([("deferred", "success", "moved"), ("", "skipped", "")], "none", "state=pending"),
                 ([("fail", "failure", "x"), ("deferred", "success", "moved")], "none", "state=pending"),
                 ([("fail", "cancelled", "x"), ("", "skipped", "")], "none", "state=pending"),
                 ([("unverified", "failure", "x"), ("unverified", "failure", "y")], "halt", "state=pending")]
        for attempts, action, state in cases:
            out, status = self.receipt(attempts)
            self.assertEqual((out["action"], out["culprit"]), (action, ""), attempts)
            self.assertIn(state, status, attempts)

    def test_receipt_with_an_unreadable_parent_receipt_halts(self):
        fail = ("fail", "failure", "failed on host")
        with patch.object(mt, "smoke_state", side_effect=mt.GhError("HTTP 502")):
            code, out, _ = self.run_cmd(mt.smoke_receipt, self.E, self.URL, "ok", "", [fail, fail],
                                        gh=lambda a: self.P + "\n")
        self.assertEqual((code, out["action"], out["culprit"]), (0, "halt", ""))

    def test_receipt_of_a_superseded_merge_is_pending(self):
        out, status = self.receipt([("", "skipped", ""), ("", "skipped", "")], verify="skipped")
        self.assertEqual(out["action"], "none")
        self.assertIn("state=pending", status)


class SmokeWorkflowContract(unittest.TestCase):
    """Workflow text contracts: SHA + URL forwarding, credential confinement, no artifacts."""
    ROOT = Path(__file__).resolve().parents[1]

    def read(self, rel):
        return (self.ROOT / rel).read_text(encoding="utf-8")

    def test_post_merge_forwards_the_verified_commit_and_deployment_to_both_attempts(self):
        wf = self.read(".github/workflows/post-merge.yml")
        self.assertIn("deployment_url: ${{ steps.v.outputs.deployment_url }}", wf)
        self.assertEqual(wf.count("expected_sha: ${{ needs.verify.outputs.sha }}"), 2)
        self.assertEqual(wf.count("deployment_url: ${{ needs.verify.outputs.deployment_url }}"), 2)

    def test_post_merge_hands_the_smoke_test_only_the_smoke_secrets(self):
        wf = self.read(".github/workflows/post-merge.yml")
        self.assertNotIn("secrets: inherit", wf)
        for name in ("SMOKE_BASE_URL", "SMOKE_TEST_EMAIL", "SMOKE_TEST_PASSWORD"):
            self.assertEqual(wf.count(f"{name}: ${{{{ secrets.{name} }}}}"), 2, name)

    def test_rollback_follows_the_receipt_decision(self):
        wf = self.read(".github/workflows/post-merge.yml")
        self.assertIn("needs.receipt.outputs.action == 'revert'", wf)
        self.assertIn("needs.receipt.outputs.culprit ||", wf)
        self.assertIn("needs.receipt.outputs.action != 'revert'", wf)  # anything but a proven culprit halts
        self.assertIn("statuses: write", wf)
        # a second smoke failure alone no longer reverts: only the receipt's proven culprit does
        self.assertNotIn("|| needs.smoke-retry.result == 'failure'", wf)

    def test_smoke_workflow_is_bound_read_only_and_keeps_no_artifact(self):
        wf = self.read(".github/workflows/smoke-test.yml")
        self.assertIn("ref: ${{ steps.target.outputs.sha }}", wf)
        self.assertIn("smoke-target --sha", wf)
        self.assertIn("smoke-verdict --sha", wf)
        self.assertIn("SMOKE_EXPECTED_SHA: ${{ steps.target.outputs.sha }}", wf)
        self.assertIn("SMOKE_EXPECTED_DEPLOYMENT: ${{ steps.target.outputs.deployment_url }}", wf)
        self.assertEqual(wf.count("persist-credentials: false"), 2)
        self.assertNotIn("upload-artifact", wf)
        self.assertNotIn("write", wf.split("permissions:")[1].split("concurrency:")[0])
        # the login reaches exactly one step: the test run
        self.assertEqual(wf.count("secrets.SMOKE_TEST_PASSWORD"), 1)
        self.assertEqual(wf.count("secrets.SMOKE_TEST_EMAIL"), 1)

    def test_playwright_records_provenance_and_keeps_no_sensitive_output_in_ci(self):
        cfg = self.read("frontend/playwright.config.ts")
        self.assertIn('teardown: "provenance"', cfg)
        self.assertIn("provenance\\.teardown\\.ts", cfg)
        self.assertIn('trace: process.env.CI ? "off"', cfg)
        self.assertIn('screenshot: process.env.CI ? "off"', cfg)
        self.assertIn('video: "off"', cfg)
        self.assertIn('preserveOutput: process.env.CI ? "never"', cfg)
        self.assertIn('reporter: [["list"]]', cfg)
        setup = self.read("frontend/e2e/auth.setup.ts")
        self.assertIn('readServedRevision(page.request, "before")', setup)
        self.assertIn("staleTarget(served)", setup)
        self.assertIn('readServedRevision(page.request, "after")', self.read("frontend/e2e/provenance.teardown.ts"))

    def test_version_route_names_the_deployment(self):
        route = self.read("frontend/src/app/api/version/route.ts")
        self.assertIn("process.env.VERCEL_GIT_COMMIT_SHA", route)
        self.assertIn("deployment: process.env.VERCEL_URL", route)


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
