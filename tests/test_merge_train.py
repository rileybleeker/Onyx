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

    def verdict(self, tests_ok, before, after, host=HOST, exact=True):
        return mt.smoke_verdict(self.E, host, tests_ok, before, after, exact_deployment=exact)[0]

    def test_exact_target_both_ends_passes_or_fails(self):
        self.assertEqual(self.verdict(True, self.rec(), self.rec()), "pass")
        self.assertEqual(self.verdict(False, self.rec(), self.rec()), "fail")

    def test_alias_moved_during_the_run_is_deferred_never_a_pass_or_a_fail(self):
        # a newer merge deployed while the run was going: its UI must not count for the older commit
        moved = self.rec(self.N, self.OTHER)
        for exact in (True, False):
            for tests_ok in (True, False):
                self.assertEqual(self.verdict(tests_ok, self.rec(), moved, exact=exact), "deferred", (exact, tests_ok))
                self.assertEqual(self.verdict(tests_ok, moved, moved, exact=exact), "deferred", (exact, tests_ok))
                self.assertEqual(self.verdict(tests_ok, moved, None, exact=exact), "deferred", (exact, tests_ok))

    def test_newer_commit_served_from_the_start_names_it(self):
        verdict, detail = mt.smoke_verdict(self.E, self.HOST, True, self.rec(self.N), self.rec(self.N))
        self.assertEqual(verdict, "deferred")
        self.assertIn(self.N[:7], detail)
        self.assertEqual(mt.served_other(self.E, self.rec(), self.rec(self.N)), self.N)
        self.assertIsNone(mt.served_other(self.E, self.rec(), None))

    def test_moving_on_needs_the_final_record_and_never_goes_backwards(self):
        # Codex round 4: a newer commit at the start must not make a run benign when production ends on an older
        # commit (a Vercel rollback) or the end record could not be read. Synthetic master history P < E < N < M.
        P, M = "d" * 40, "a" * 40
        order = [P, self.E, self.N, M]

        def contains(older, newer):
            return order.index(newer) > order.index(older)
        moved = mt.moved_on_to
        self.assertEqual(moved(self.E, self.rec(), self.rec(self.N), contains), self.N)
        self.assertEqual(moved(self.E, self.rec(self.N), self.rec(self.N), contains), self.N)
        self.assertEqual(moved(self.E, self.rec(self.N), self.rec(M), contains), M)  # moved on twice, forwards
        self.assertEqual(moved(self.E, None, self.rec(self.N), contains), self.N)  # no start record: the end decides
        self.assertIsNone(moved(self.E, self.rec(self.N), None, contains))  # end unreadable
        self.assertIsNone(moved(self.E, self.rec(self.N), self.rec(P), contains))  # newer, then older: rollback
        self.assertIsNone(moved(self.E, self.rec(self.N), self.rec(), contains))  # newer, then back to the target
        self.assertIsNone(moved(self.E, self.rec(M), self.rec(self.N), contains))  # newer, then less new
        self.assertIsNone(moved(self.E, self.rec(), self.rec(P), contains))
        self.assertIsNone(moved(self.E, None, None, contains))

    def test_other_deployment_of_the_same_commit_is_deferred_after_a_merge(self):
        # a redeploy (or a Vercel rollback) of the same commit is not the deployment this run was started for
        self.assertEqual(self.verdict(True, self.rec(), self.rec(deployment=self.OTHER)), "deferred")
        self.assertEqual(self.verdict(False, self.rec(deployment=self.OTHER), self.rec()), "deferred")

    def test_scheduled_run_matches_the_commit_alone(self):
        # nothing is attributed on a schedule: a redeploy of the same commit is the same code
        other = self.rec(deployment=self.OTHER)
        self.assertEqual(self.verdict(True, self.rec(), other, host=None, exact=False), "pass")
        self.assertEqual(self.verdict(False, other, other, host=None, exact=False), "fail")
        self.assertIn("matched on the commit", mt.smoke_verdict(self.E, None, True, other, other, False)[1])

    def test_record_without_a_deployment_is_not_confirmed_after_a_merge(self):
        # two deployments of one commit could not be told apart, so it never passes or fails post-merge
        unnamed = self.rec(deployment=None)
        for before, after in ((unnamed, unnamed), (self.rec(), unnamed), (unnamed, self.rec())):
            self.assertEqual(self.verdict(True, before, after), "deferred")
            self.assertEqual(self.verdict(False, before, after), "unverified")
        # no usable expected host at all: nothing can be confirmed either
        self.assertEqual(self.verdict(True, self.rec(), self.rec(), host=None), "deferred")
        self.assertEqual(self.verdict(False, self.rec(), self.rec(), host=None), "unverified")
        # on a schedule the commit is enough
        self.assertEqual(self.verdict(True, unnamed, unnamed, host=None, exact=False), "pass")

    def test_unconfirmed_target_never_passes_and_a_failure_is_not_attributed(self):
        for exact in (True, False):
            for before, after in ((None, None), (self.rec(), None), (None, self.rec())):
                self.assertEqual(self.verdict(True, before, after, exact=exact), "deferred")
                self.assertEqual(self.verdict(False, before, after, exact=exact), "unverified")

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

    def test_exit_code(self):
        for scheduled in (False, True):
            self.assertEqual(mt.smoke_exit("fail", scheduled, False), 1)
            self.assertEqual(mt.smoke_exit("unverified", scheduled, True), 1)
            self.assertEqual(mt.smoke_exit("pass", scheduled, False), 0)
            self.assertEqual(mt.smoke_exit("deferred", scheduled, True), 0)
        # post-merge: a deferral is pending verification and the receipt records it
        self.assertEqual(mt.smoke_exit("deferred", False, False), 0)
        # schedule: nothing else would notice, so any deferral but a newer master commit fails the run
        self.assertEqual(mt.smoke_exit("deferred", True, False), 1)


class SmokeTarget(unittest.TestCase):
    E = "e" * 40
    A = "https://frontend-aaa111-example.vercel.app"
    B = "https://frontend-bbb222-example.vercel.app"

    def test_requested_url_must_be_a_successful_deployment_of_the_commit(self):
        self.assertEqual(mt.pick_deployment([("success", self.A)], self.A, self.E)[0], self.A)
        self.assertEqual(mt.pick_deployment([("success", self.A + "/")], self.A, self.E)[0], self.A)
        self.assertIsNone(mt.pick_deployment([("success", self.A)], self.B, self.E)[0])  # another commit's URL
        self.assertIsNone(mt.pick_deployment([("success", self.A)], "http://x", self.E)[0])

    def test_unsuccessful_deployment_is_not_a_target(self):
        # a failed build, one still building, or one canceled from Vercel's dashboard. (A deployment a newer one
        # replaced still reads success on GitHub; smoke_target and the provenance check refuse that one.)
        for state in ("failure", "pending", "inactive"):
            url, why = mt.pick_deployment([(state, self.A)], self.A, self.E)
            self.assertIsNone(url, state)
            self.assertIn(state, why)

    def test_without_a_request_the_newest_successful_deployment_is_taken(self):
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

    def test_a_retry_that_never_ran_is_unverified(self):
        # the retry must run after a failed first attempt; skipped means the workflow did not schedule it
        for result in ("skipped", ""):
            self.assertEqual(mt.retry_verdict("", result), "unverified", result)
        self.assertEqual(mt.retry_verdict("", "cancelled"), "deferred")  # superseded by a newer run, same commit
        self.assertEqual(mt.retry_verdict("fail", "failure"), "fail")
        self.assertEqual(mt.retry_verdict("pass", "success"), "pass")
        self.assertEqual(mt.smoke_outcome("fail", mt.retry_verdict("", "skipped")), "halt")

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
    NOW = 1_800_000_000.0

    def status(self, state, creator="github-actions[bot]", context=mt.SMOKE_CONTEXT, created_at="", at=None,
               attempt="9.1.first"):
        """A synthetic commit status. at = the attempt time its receipt carries (None = no attempt mark)."""
        row = dict(context=context, state=state, creator=creator, created_at=created_at)
        if at is not None:
            row["description"] = mt.receipt_description(at, attempt, f"{state}: synthetic")
        return row

    def test_receipt_reads_only_the_workflows_own_newest_exact_smoke_status(self):
        self.assertEqual(mt.smoke_state_of([self.status("success")]), "pass")
        self.assertEqual(mt.smoke_state_of([self.status("failure"), self.status("success")]), "fail")
        self.assertEqual(mt.smoke_state_of([self.status("pending")]), "unknown")
        self.assertEqual(mt.smoke_state_of([]), "unknown")
        self.assertEqual(mt.smoke_state_of([self.status("success", creator="someone")]), "unknown")
        self.assertEqual(mt.smoke_state_of([self.status("success", context="ci/other")]), "unknown")

    def test_a_later_pending_receipt_does_not_erase_an_exact_one(self):
        # a re-dispatch after master moved only reaches "pending verification"; the exact pass or fail still counts
        self.assertEqual(mt.smoke_state_of([self.status("pending"), self.status("success")]), "pass")
        self.assertEqual(mt.smoke_state_of([self.status("pending"), self.status("failure")]), "fail")
        row = mt.smoke_receipt_row([self.status("pending"), self.status("success", created_at="2026-01-01T00:00:00Z")])
        self.assertEqual(row["created_at"], "2026-01-01T00:00:00Z")

    def test_receipt_age(self):
        from datetime import datetime, timezone
        at = datetime(2027, 1, 15, 8, 0, 0, tzinfo=timezone.utc).timestamp()
        self.assertEqual(mt.receipt_age_s("2027-01-15T08:00:00Z", at + 90), 90)
        self.assertIsNone(mt.receipt_age_s("not a time", self.NOW))
        self.assertIsNone(mt.receipt_age_s(None, self.NOW))

    def test_revert_only_when_the_parent_passed_recently_on_its_own_deployment(self):
        self.assertEqual(mt.smoke_culprit(self.E, "pass", 600), self.E)
        self.assertEqual(mt.smoke_culprit(self.E, "pass", mt.SMOKE_PARENT_MAX_AGE_S), self.E)
        # an older pass does not rule out live data that changed since: a person decides
        self.assertIsNone(mt.smoke_culprit(self.E, "pass", mt.SMOKE_PARENT_MAX_AGE_S + 1))
        self.assertIsNone(mt.smoke_culprit(self.E, "pass", None))  # no readable time
        # the parent was superseded / deferred: it may hold the breaking change, so no unrelated revert
        self.assertIsNone(mt.smoke_culprit(self.E, "unknown", 600))
        # the parent already failed: its own verification acted; a person decides
        self.assertIsNone(mt.smoke_culprit(self.E, "fail", 600))

    def at(self, offset_s):
        """A synthetic created_at, offset_s seconds after NOW, in the form GitHub writes."""
        return mt.iso_utc(self.NOW + offset_s)

    def test_failed_smoke_fixed_by_a_newer_exact_pass_is_a_stale_rollback(self):
        later, t = self.at(60), self.NOW
        self.assertEqual(mt.smoke_fixed_later("fail", [(self.N, "pass", later), (self.P, "unknown", "")], t), self.N)
        self.assertEqual(mt.smoke_fixed_later("fail", [(self.N, "unknown", ""), (self.P, "pass", later)], t), self.P)
        self.assertIsNone(mt.smoke_fixed_later("fail", [(self.N, "fail", later), (self.P, "unknown", "")], t))
        self.assertIsNone(mt.smoke_fixed_later("fail", [], t))
        # a commit whose own smoke receipt is not a failure is never "fixed" by a later pass
        self.assertIsNone(mt.smoke_fixed_later("pass", [(self.N, "pass", later)], t))
        self.assertIsNone(mt.smoke_fixed_later("unknown", [(self.N, "pass", later)], t))

    def test_a_newer_commits_pass_counts_only_when_recorded_after_the_failure(self):
        # Codex R6: an older descendant pass, then a new failure (a Vercel rollback, changed live data), proves
        # nothing about that failure; neither does a pass whose time cannot be read, or a failure with no time
        for unattributed in (False, True):
            own = "unknown" if unattributed else "fail"
            self.assertIsNone(mt.smoke_fixed_later(own, [(self.N, "pass", self.at(-60))], self.NOW, unattributed))
            self.assertIsNone(mt.smoke_fixed_later(own, [(self.N, "pass", self.at(0))], self.NOW, unattributed))
            self.assertIsNone(mt.smoke_fixed_later(own, [(self.N, "pass", "")], self.NOW, unattributed))
            self.assertIsNone(mt.smoke_fixed_later(own, [(self.N, "pass", "2027-01-15T08:00:00")], self.NOW,
                                                   unattributed))  # no zone: never read in the runner's zone
            self.assertIsNone(mt.smoke_fixed_later(own, [(self.N, "pass", self.at(60))], None, unattributed))
            # a newer commit's old pass is skipped; an even newer one that passed after the failure counts
            chain = [(self.N, "pass", self.at(120)), (self.P, "pass", self.at(-60))]
            self.assertEqual(mt.smoke_fixed_later(own, chain, self.NOW, unattributed), self.N)
            chain = [(self.N, "pass", self.at(-30)), (self.P, "pass", self.at(-60))]
            self.assertIsNone(mt.smoke_fixed_later(own, chain, self.NOW, unattributed))

    def test_receipt_times(self):
        self.assertEqual(mt.receipt_time(mt.iso_utc(self.NOW)), self.NOW)
        self.assertEqual(mt.iso_utc(self.NOW + 0.9), mt.iso_utc(self.NOW))  # GitHub's resolution: whole seconds
        self.assertEqual(mt.receipt_time("2027-01-15T08:00:00+00:00"), mt.receipt_time("2027-01-15T08:00:00Z"))
        for bad in ("", None, "not a time", "2027-01-15T08:00:00"):
            self.assertIsNone(mt.receipt_time(bad), bad)

    def rows(self, *states, newest=0, delay=0):
        """Synthetic commit statuses, newest first, written by the workflow's own token. The newest attempt is
        `newest` seconds after NOW, each older one a minute before the one above it; each receipt is written `delay`
        seconds after its attempt (a receipt job that ran late)."""
        return [self.status(st, at=self.NOW + newest - 60 * i, created_at=self.at(newest - 60 * i + delay))
                for i, st in enumerate(states)]

    def fixed(self, receipts, own_states=("success",), later=None, unattributed=False, failed_at=None):
        later = [(self.N, ["success"])] if later is None else later
        with patch.object(mt, "later_chain", return_value=later), \
                patch.object(mt, "production_states", return_value=list(own_states)), \
                patch.object(mt, "smoke_rows", side_effect=lambda sha: receipts.get(sha, [])):
            return mt.already_fixed(self.E, unattributed=unattributed, failed_at=failed_at)

    def test_already_fixed_checks_the_smoke_receipts_after_the_build(self):
        receipts = {self.E: self.rows("failure"), self.N: self.rows("success", newest=600)}
        self.assertEqual(self.fixed(receipts), self.N)  # no time given: E's own failure receipt is the failure
        self.assertEqual(self.fixed(receipts, failed_at=self.NOW + 5), self.N)  # the receipt job's observed_at
        # the newer pass is from before this failure: it proves nothing, the revert goes ahead
        receipts = {self.E: self.rows("failure"), self.N: self.rows("success", newest=-600)}
        self.assertIsNone(self.fixed(receipts))
        self.assertIsNone(self.fixed(receipts, failed_at=self.NOW + 5))
        # smoke passed (and never failed): nothing to fix
        self.assertIsNone(self.fixed({self.E: self.rows("success"), self.N: self.rows("success", newest=600)}))

    def test_a_later_pass_of_the_commit_itself_is_recovery(self):
        # Codex round 2: the failure did not last, so the queued revert would take a working change off the site
        self.assertTrue(mt.smoke_recovered(self.rows("success", "failure")))
        self.assertTrue(mt.smoke_recovered(self.rows("pending", "success", "pending", "failure")))
        self.assertFalse(mt.smoke_recovered(self.rows("failure", "success")))  # failed again after the pass
        self.assertFalse(mt.smoke_recovered(self.rows("success")))  # no failure to recover from (a drill)
        self.assertFalse(mt.smoke_recovered(self.rows("pending", "failure")))
        self.assertFalse(mt.smoke_recovered([self.status("success", creator="someone"), self.status("failure")]))
        self.assertFalse(mt.smoke_recovered([]))
        self.assertEqual(self.fixed({self.E: self.rows("success", "failure")}, later=[]), self.E)
        # with the failure's own time: only a pass recorded after it
        self.assertTrue(mt.smoke_recovered(self.rows("success", newest=60), self.NOW))
        self.assertFalse(mt.smoke_recovered(self.rows("success", newest=0), self.NOW))
        self.assertFalse(mt.smoke_recovered(self.rows("success", newest=-60), self.NOW))
        self.assertFalse(mt.smoke_recovered([self.status("success")], self.NOW))  # no readable time
        self.assertFalse(mt.smoke_recovered(self.rows("failure", "success", newest=60), self.NOW))
        # a drill on a commit that only ever passed still opens its revert
        self.assertIsNone(self.fixed({self.E: self.rows("success")}, later=[]))
        self.assertIn("did not last", mt.fixed_how(self.E, self.E))
        self.assertIn(f"fixed by `{self.N[:7]}`", mt.fixed_how(self.E, self.N))

    def test_an_unattributed_halt_is_resolved_by_a_newer_exact_pass_after_the_failure(self):
        # Codex round 2: a newer commit containing this one passed on its own deployment, so production works again
        later = self.at(60)
        self.assertEqual(mt.smoke_fixed_later("unknown", [(self.N, "pass", later)], self.NOW, True), self.N)
        self.assertEqual(mt.smoke_fixed_later("fail", [(self.N, "pass", later)], self.NOW, True), self.N)
        self.assertIsNone(mt.smoke_fixed_later("unknown", [(self.N, "unknown", "")], self.NOW, True))
        self.assertIsNone(mt.smoke_fixed_later("unknown", [], self.NOW, True))
        receipts = {self.E: self.rows("pending"), self.N: self.rows("success", newest=600)}  # the halt left "pending"
        self.assertEqual(self.fixed(receipts, unattributed=True, failed_at=self.NOW), self.N)
        self.assertIsNone(self.fixed(receipts))  # a revert still needs sha's own exact failure first
        # Codex R6: a halt whose failure time is not known (its receipt could not be written) keeps the halt
        self.assertIsNone(self.fixed(receipts, unattributed=True))
        # a build halt: a newer good build containing it settles it, as for a revert, with or without a time
        self.assertEqual(self.fixed({}, own_states=["failure"], unattributed=True), self.N)

    def test_an_old_recovery_never_hides_a_new_unattributed_failure(self):
        # Codex R6: an exact failure, then a pass on the commit's own deployment, then a run that failed twice without
        # confirmed provenance. Pending never overwrites the old pass, so it is still the newest exact receipt: it
        # must not count as recovery from the NEW failure, observed after it.
        history = self.rows("success", "failure", newest=-600)  # failed at NOW-660, recovered at NOW-600
        failed_at = self.NOW  # the new double unverified failure, as the receipt job observed it
        self.assertFalse(mt.smoke_recovered(history, failed_at))
        self.assertIsNone(self.fixed({self.E: history}, later=[], unattributed=True, failed_at=failed_at))
        # an older descendant pass, from before the new failure, does not resolve it either
        old_descendant = {self.E: history, self.N: self.rows("success", newest=-300)}
        self.assertIsNone(self.fixed(old_descendant, unattributed=True, failed_at=failed_at))
        # a pass recorded after the new failure does: on the commit itself, or on a newer commit containing it
        self.assertEqual(self.fixed({self.E: self.rows("success", "success", "failure", newest=120)}, later=[],
                                    unattributed=True, failed_at=failed_at), self.E)
        self.assertEqual(self.fixed({self.E: history, self.N: self.rows("success", newest=300)},
                                    unattributed=True, failed_at=failed_at), self.N)

    def test_receipt_marks_carry_the_attempts_own_time_and_identity(self):
        # Codex round 5: a receipt dates the attempt it records, never the receipt job
        d = mt.receipt_description(self.NOW, "123.1.retry", "fail: failed on host " + "x" * 300)
        self.assertTrue(d.startswith(f"[{mt.iso_utc(self.NOW)} 123.1.retry] fail: failed on host"))
        self.assertLessEqual(len(d), 140)
        self.assertEqual(mt.receipt_mark({"description": d}), (self.NOW, "123.1.retry"))
        self.assertEqual(mt.receipt_mark({"description": mt.receipt_description(None, "", "pending")}), (None, ""))
        self.assertEqual(mt.receipt_mark({"description": mt.receipt_description(self.NOW, "bad id;", "x")}),
                         (self.NOW, ""))
        for bad in ("", "fail: no mark", "[2027-01-15T08:00:00 1.1.first] naive time", None):
            self.assertEqual(mt.receipt_mark({"description": bad}), (None, ""), bad)
        # a pass proves something only with its own attempt time; an undated failure falls back to when GitHub
        # recorded it, which can only make it look later
        self.assertIsNone(mt.receipt_at(self.status("success", created_at=self.at(60))))
        self.assertEqual(mt.receipt_at(self.status("failure", created_at=self.at(60))), self.NOW + 60)
        self.assertEqual(mt.receipt_at(self.status("failure", at=self.NOW, created_at=self.at(60))), self.NOW)
        # a smoke runner whose clock ran ahead of GitHub's: an attempt dated well after its own receipt was written
        # is not believed (a pass would look later than it was); a failure then falls back to when GitHub recorded it
        slack = mt.RECEIPT_CLOCK_SLACK_S
        ahead = self.status("success", at=self.NOW + slack + 60, created_at=self.at(0))
        self.assertIsNone(mt.receipt_at(ahead))
        self.assertEqual(mt.receipt_at(self.status("success", at=self.NOW + slack, created_at=self.at(0))),
                         self.NOW + slack)
        self.assertEqual(mt.receipt_at(self.status("failure", at=self.NOW + slack + 60, created_at=self.at(0))),
                         self.NOW)
        self.assertFalse(mt.smoke_recovered([ahead, self.status("failure", at=self.NOW - 60, created_at=self.at(-50))]))

    def test_receipts_are_ordered_by_attempt_not_by_when_they_were_written(self):
        # a receipt job that ran late writes its receipt after a later attempt's: GitHub lists it first, but the
        # later attempt decides (GitHub's order is newest written first)
        late_fail = self.status("failure", at=self.NOW, created_at=self.at(300))
        later_pass = self.status("success", at=self.NOW + 60, created_at=self.at(120))
        self.assertEqual(mt.smoke_state_of([late_fail, later_pass]), "pass")
        self.assertTrue(mt.smoke_recovered([late_fail, later_pass]))
        late_pass = self.status("success", at=self.NOW, created_at=self.at(300))
        later_fail = self.status("failure", at=self.NOW + 60, created_at=self.at(120))
        self.assertEqual(mt.smoke_state_of([late_pass, later_fail]), "fail")
        self.assertFalse(mt.smoke_recovered([late_pass, later_fail]))
        self.assertEqual(mt.failure_time([late_pass, later_fail]), self.NOW + 60)
        # equal attempt times keep GitHub's order
        same = [self.status("failure", at=self.NOW, created_at=self.at(9)),
                self.status("success", at=self.NOW, created_at=self.at(5))]
        self.assertEqual(mt.smoke_state_of(same), "fail")

    def test_a_late_receipt_never_rejects_a_pass_that_came_after_the_failure(self):
        # Codex round 5: E failed twice, its retry ending at NOW; N, which contains it, then passed in a run that
        # started at NOW+30 (receipt written at NOW+40); E's receipt job ran only at NOW+90. The failure is dated by
        # its attempt, so N's pass resolves it: no revert, no halt, and a queued rollback PR is closed.
        receipts = {self.E: [self.status("failure", at=self.NOW, created_at=self.at(90))],
                    self.N: [self.status("success", at=self.NOW + 30, created_at=self.at(40))]}
        self.assertEqual(self.fixed(receipts, failed_at=self.NOW), self.N)  # rollback, with the receipt's observed_at
        self.assertEqual(self.fixed(receipts), self.N)  # a queued rollback PR: E's own failure receipt dates it
        self.assertEqual(self.fixed({self.E: [self.status("pending", at=self.NOW, created_at=self.at(90))],
                                     self.N: receipts[self.N]}, unattributed=True, failed_at=self.NOW), self.N)
        # the same on the commit itself: a later run of E that started after the failure ended
        own = [self.status("failure", at=self.NOW, created_at=self.at(90)),
               self.status("success", at=self.NOW + 30, created_at=self.at(40))]
        self.assertTrue(mt.smoke_recovered(own, self.NOW))
        self.assertEqual(self.fixed({self.E: own}, later=[]), self.E)
        # the other way round: a pass whose run started BEFORE the failure ended proves nothing, however late its
        # receipt was written (Codex R6 again, now on attempt times)
        early = {self.E: receipts[self.E],
                 self.N: [self.status("success", at=self.NOW - 30, created_at=self.at(120))]}
        self.assertIsNone(self.fixed(early, failed_at=self.NOW))
        self.assertIsNone(self.fixed(early))
        self.assertIsNone(self.fixed({self.E: [self.status("pending")], self.N: early[self.N]}, unattributed=True,
                                     failed_at=self.NOW))
        self.assertFalse(mt.smoke_recovered([self.status("success", at=self.NOW - 30, created_at=self.at(120)),
                                             self.status("failure", at=self.NOW, created_at=self.at(90))], self.NOW))
        # a pass that cannot be dated never resolves anything
        undated = {self.E: receipts[self.E], self.N: [self.status("success", created_at=self.at(120))]}
        self.assertIsNone(self.fixed(undated, failed_at=self.NOW))

    def test_already_fixed_never_reads_receipts_for_a_failed_build_and_survives_an_unreadable_one(self):
        with patch.object(mt, "later_chain", return_value=[(self.N, ["failure"])]), \
                patch.object(mt, "production_states", return_value=["failure"]), \
                patch.object(mt, "smoke_rows", side_effect=AssertionError("not read for a failed build")):
            self.assertIsNone(mt.already_fixed(self.E))
            self.assertIsNone(mt.already_fixed(self.E, unattributed=True))
        with patch.object(mt, "later_chain", return_value=[(self.N, ["success"])]), \
                patch.object(mt, "production_states", return_value=["success"]), \
                patch.object(mt, "smoke_rows", side_effect=mt.GhError("HTTP 502")):
            self.assertIsNone(mt.already_fixed(self.E))  # unknown, never a crash before the revert or halt
            self.assertIsNone(mt.already_fixed(self.E, unattributed=True, failed_at=self.NOW))


class RollbackReconciles(unittest.TestCase):
    """rollback() and the train re-read the deployment history and the smoke receipts before acting (Codex round 2).
    GitHub and git are faked; nothing is created or pushed."""
    E, N = "e" * 40, "f" * 40
    NOW = 1_800_000_000.0

    def run_rollback(self, fixer, failed_at=None):
        calls = []

        def fake_gh(*a, check=True):
            calls.append(a)
            return ""
        fixed = fixer if callable(fixer) else (lambda sha, unattributed=False, failed_at=None: fixer)
        subject = type("Proc", (), {"stdout": "feat: synthetic change\n"})()
        with patch.object(mt, "gh", side_effect=fake_gh), patch.object(mt, "ensure_labels"), \
                patch.object(mt, "note"), patch.object(mt, "already_fixed", side_effect=fixed), \
                patch.object(mt.subprocess, "run", return_value=subject):
            code = mt.rollback(self.E, "synthetic reason", halt_only=True, failed_at=failed_at)
        return code, calls

    def test_a_halt_is_dropped_when_a_newer_commit_already_passed(self):
        code, calls = self.run_rollback(self.N)
        self.assertEqual(code, 0)
        self.assertFalse([c for c in calls if c[:2] == ("issue", "create")])

    def test_a_halt_goes_ahead_without_evidence_or_with_an_unreadable_history(self):
        def unreadable(sha, unattributed=False, failed_at=None):
            raise mt.GhError("HTTP 502")
        for fixer in (None, unreadable):
            code, calls = self.run_rollback(fixer)
            self.assertEqual(code, 1)
            self.assertTrue([c for c in calls if c[:2] == ("issue", "create")], fixer)

    def test_the_halt_check_reads_the_unattributed_rule_with_the_failure_time(self):
        seen = []

        def fixed(sha, unattributed=False, failed_at=None):
            seen.append((sha, unattributed, failed_at))
            return None
        self.run_rollback(fixed, failed_at=self.NOW)
        self.run_rollback(fixed)
        self.assertEqual(seen, [(self.E, True, self.NOW), (self.E, True, None)])

    def test_fail_pass_then_a_double_unverified_failure_still_halts(self):
        # Codex R6, end to end through rollback() with the real reconciliation: the commit failed exactly, passed on
        # its own deployment, and now failed twice without confirmed provenance (its receipt stayed the old pass).
        def status(state, offset):
            return dict(context=mt.SMOKE_CONTEXT, state=state, creator="github-actions[bot]",
                        created_at=mt.iso_utc(self.NOW + offset),
                        description=mt.receipt_description(self.NOW + offset, "9.1.first", f"{state}: synthetic"))
        history = {self.E: [status("success", -600), status("failure", -660)]}

        def run(receipts, failed_at, later=()):
            calls = []

            def fake_gh(*a, check=True):
                calls.append(a)
                return ""
            subject = type("Proc", (), {"stdout": "feat: synthetic change\n"})()
            with patch.object(mt, "gh", side_effect=fake_gh), patch.object(mt, "ensure_labels"), \
                    patch.object(mt, "note"), patch.object(mt.subprocess, "run", return_value=subject), \
                    patch.object(mt, "later_chain", return_value=list(later)), \
                    patch.object(mt, "production_states", return_value=["success"]), \
                    patch.object(mt, "smoke_rows", side_effect=lambda sha: receipts.get(sha, [])):
                code = mt.rollback(self.E, "synthetic reason", halt_only=True, failed_at=failed_at)
            return code, [c for c in calls if c[:2] == ("issue", "create")]
        for failed_at in (self.NOW, None):  # the new failure's time, or none at all
            code, issues = run(history, failed_at)
            self.assertEqual((code, len(issues)), (1, 1), failed_at)
        # an older pass of a newer commit containing it does not drop the halt either
        code, issues = run(dict(history, **{self.N: [status("success", -300)]}), self.NOW, [(self.N, ["success"])])
        self.assertEqual((code, len(issues)), (1, 1))
        # a pass recorded after the new failure does
        code, issues = run(dict(history, **{self.N: [status("success", 300)]}), self.NOW, [(self.N, ["success"])])
        self.assertEqual((code, len(issues)), (0, 0))

    def test_a_late_receipt_reverts_nothing_a_later_pass_already_cleared(self):
        # Codex round 5, end to end through rollback(): E failed twice (retry ended at NOW), N containing it passed
        # in a run that started at NOW+30, and E's receipt job ran at NOW+90. rollback gets the attempt's time, so
        # neither the revert nor the halt goes ahead; a pass that started before NOW still lets the revert go ahead.
        def status(state, at, written):
            return dict(context=mt.SMOKE_CONTEXT, state=state, creator="github-actions[bot]",
                        created_at=mt.iso_utc(self.NOW + written),
                        description=mt.receipt_description(self.NOW + at, "9.1.retry", f"{state}: synthetic"))

        def run(n_pass_at, halt_only):
            calls = []

            def fake_gh(*a, check=True):
                calls.append(a)
                if a[:2] == ("api", f"repos/{mt.REPO}/issues"):
                    return '{"number": 5}'
                return "https://github.com/example/repo/pull/9\n" if a[:2] == ("pr", "create") else ""
            receipts = {self.E: [status("failure", 0, 90)], self.N: [status("success", n_pass_at, 120)]}
            subject = type("Proc", (), {"stdout": "feat: synthetic change\n"})()
            with patch.object(mt, "gh", side_effect=fake_gh), patch.object(mt, "ensure_labels"), \
                    patch.object(mt, "note"), patch.object(mt.subprocess, "run", return_value=subject), \
                    patch.object(mt, "later_chain", return_value=[(self.N, ["success"])]), \
                    patch.object(mt, "production_states", return_value=["success"]), \
                    patch.object(mt, "halted", return_value=False), patch.object(mt, "open_prs", return_value=[]), \
                    patch.object(mt, "smoke_rows", side_effect=lambda sha: receipts.get(sha, [])):
                code = mt.rollback(self.E, "synthetic reason", halt_only=halt_only, failed_at=self.NOW)
            acted = [c for c in calls if c[:2] in (("issue", "create"), ("pr", "create"))
                     or c[:2] == ("api", f"repos/{mt.REPO}/issues")]
            return code, acted
        for halt_only in (False, True):
            self.assertEqual(run(30, halt_only), (0, []), halt_only)
            code, acted = run(-30, halt_only)
            self.assertTrue(acted, halt_only)  # the halt issue (and, for a revert, the revert PR) goes ahead

    def test_rollback_reads_the_failure_time_from_the_command_line(self):
        seen = []
        with patch.object(mt, "rollback", side_effect=lambda *a: seen.append(a) or 0):
            mt.main(["rollback", "--sha", self.E, "--reason", "r", "--halt-only",
                     "--failed-at", mt.iso_utc(self.NOW)])
            mt.main(["rollback", "--sha", self.E, "--reason", "r", "--failed-at", ""])
            mt.main(["rollback", "--sha", self.E, "--reason", "r", "--failed-at", "not a time"])
            mt.main(["rollback", "--sha", self.E, "--reason", "r"])
        self.assertEqual(seen, [(self.E, "r", True, self.NOW), (self.E, "r", False, None),
                                (self.E, "r", False, None), (self.E, "r", False, None)])

    def test_a_queued_revert_of_a_commit_that_passed_again_is_closed(self):
        calls = []
        body = f"Automatic rollback of `{self.E}`.\n\nReason: smoke\n\nCloses #7"

        def fake_gh(*a, check=True):
            calls.append(a)
            return body if a[0] == "api" else ""
        with patch.object(mt, "gh", side_effect=fake_gh), patch.object(mt, "note"), \
                patch.object(mt, "already_fixed", return_value=self.E):
            self.assertTrue(mt.retire_fixed_rollback(pr(number=9)))
        closed = [c for c in calls if c[:2] == ("pr", "close")]
        self.assertEqual(len(closed), 1)
        self.assertIn("did not last", " ".join(closed[0]))
        self.assertTrue([c for c in calls if c[:3] == ("issue", "close", "7")])


class SmokeCommands(unittest.TestCase):
    """The smoke-test.yml / post-merge.yml steps with GitHub faked: outputs and the commit status they write."""
    E, P, N = "e" * 40, "d" * 40, "f" * 40
    URL = "https://frontend-abc123-example.vercel.app"
    NEW_URL = "https://frontend-new999-example.vercel.app"
    NOW = 1_800_000_000.0

    def run_cmd(self, fn, *args, gh=None, **kwargs):
        import os
        import tempfile
        calls = []

        def fake_gh(*a, check=True):
            calls.append(a)
            return gh(a) if gh else ""
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            with patch.dict(os.environ, {"GITHUB_OUTPUT": out, "GITHUB_STEP_SUMMARY": os.path.join(d, "sum")}), \
                    patch.object(mt, "gh", side_effect=fake_gh), \
                    patch.object(mt, "annotate", side_effect=lambda *a: calls.append(("annotate", *a))):
                code = fn(*args, **kwargs)
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

    def verdict_cmd(self, tests, before, after, mode="post-merge", url=URL, gh=None):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self.write_provenance(d, before, after)
            return self.run_cmd(mt.smoke_verdict_cmd, self.E, url, True, "", tests, d, mode, gh=gh)

    def test_verdict_command_fails_a_post_merge_job_only_on_fail_or_unverified(self):
        host = mt.deployment_host(self.URL)
        same = {"version": self.E, "deployment": host}
        moved = {"version": self.N, "deployment": "frontend-new-example.vercel.app"}
        unnamed = {"version": self.E, "deployment": None}
        cases = [("success", same, same, "pass", 0), ("failure", same, same, "fail", 1),
                 ("success", same, moved, "deferred", 0), ("failure", same, moved, "deferred", 0),
                 ("failure", None, None, "unverified", 1), ("cancelled", same, None, "unverified", 1),
                 ("cancelled", same, same, "fail", 1),
                 ("success", unnamed, unnamed, "deferred", 0), ("failure", unnamed, same, "unverified", 1)]
        for tests, before, after, verdict, code in cases:
            got, out, calls = self.verdict_cmd(tests, before, after)
            self.assertEqual((out["verdict"], got), (verdict, code), (tests, before, after))
            self.assertEqual(out["tested_sha"], self.E if verdict in ("pass", "fail") else "")
            self.assertEqual(out["tested_deployment"], self.URL if verdict in ("pass", "fail") else "")
            # every deferral leaves an annotation on the run
            self.assertEqual(any(c[0] == "annotate" for c in calls), verdict == "deferred", (tests, before, after))

    def test_same_commit_on_a_deployment_github_does_not_know_is_unverified_not_deferred(self):
        # Claude round 2: /api/version and GitHub's environment_url no longer name hosts the same way. A quiet
        # deferral would leave every later merge unverified and green; this fails loudly instead.
        host = mt.deployment_host(self.URL)
        stray = {"version": self.E, "deployment": "frontend-elsewhere-example.vercel.app"}
        same = {"version": self.E, "deployment": host}
        with patch.object(mt, "production_deployments", return_value=[("success", self.URL)]):
            for tests in ("success", "failure"):
                got, out, calls = self.verdict_cmd(tests, stray, same)
                self.assertEqual((out["verdict"], got), ("unverified", 1), tests)
                self.assertIn(("annotate", "error", "Smoke provenance broken"), [c[:3] for c in calls])
        # a real redeploy or Vercel rollback of the commit is one of its own deployments: still a deferral
        again = "https://frontend-elsewhere-example.vercel.app"
        with patch.object(mt, "production_deployments", return_value=[("success", again), ("success", self.URL)]):
            got, out, _ = self.verdict_cmd("failure", stray, same)
        self.assertEqual((out["verdict"], got), ("deferred", 0))
        # an unreadable deployment history proves nothing: a deferral, as before
        with patch.object(mt, "production_deployments", side_effect=mt.GhError("HTTP 502")):
            got, out, _ = self.verdict_cmd("failure", stray, same)
        self.assertEqual((out["verdict"], got), ("deferred", 0))
        # pure parts
        self.assertEqual(mt.foreign_deployment(self.E, host, stray, same), stray["deployment"])
        self.assertIsNone(mt.foreign_deployment(self.E, host, same, same))
        self.assertIsNone(mt.foreign_deployment(self.E, None, stray, stray))
        self.assertIsNone(mt.foreign_deployment(self.E, host, {"version": self.N, "deployment": "x.example.app"}, same))
        self.assertTrue(mt.provenance_broken("a.example.app", {"b.example.app"}))
        self.assertFalse(mt.provenance_broken("a.example.app", {"a.example.app"}))
        self.assertFalse(mt.provenance_broken("a.example.app", None))
        self.assertFalse(mt.provenance_broken(None, set()))

    def test_scheduled_run_fails_unless_production_moved_on_to_a_newer_master_commit(self):
        same = {"version": self.E, "deployment": "frontend-abc123-example.vercel.app"}
        redeploy = {"version": self.E, "deployment": "frontend-again-example.vercel.app"}
        older = {"version": self.P, "deployment": "frontend-old-example.vercel.app"}
        newer = {"version": self.N, "deployment": "frontend-new-example.vercel.app"}

        def compare(a):
            path = a[1] if len(a) > 1 else ""
            if path.endswith(f"/compare/{self.E}...{self.N}"):
                return "ahead\n"  # N contains E
            if path.endswith(f"/compare/{self.E}...{self.P}"):
                return "behind\n"  # P is older: a Vercel rollback
            if path.endswith(f"/compare/{self.N}...{mt.BASE}"):
                return "identical\n"
            return "diverged\n"
        # the commit alone decides on a schedule: a redeploy of it is still a real test
        got, out, _ = self.verdict_cmd("success", same, redeploy, mode="scheduled", url="", gh=compare)
        self.assertEqual((out["verdict"], got), ("pass", 0))
        got, out, _ = self.verdict_cmd("failure", same, same, mode="scheduled", url="", gh=compare)
        self.assertEqual((out["verdict"], got, out["tested_deployment"]),
                         ("fail", 1, "https://frontend-abc123-example.vercel.app"))
        # moved on to a newer master merge mid-run: benign, that merge's post-merge smoke covers it
        got, out, calls = self.verdict_cmd("success", same, newer, mode="scheduled", url="", gh=compare)
        self.assertEqual((out["verdict"], got), ("deferred", 0))
        self.assertIn(("annotate", "warning"), [c[:2] for c in calls])
        # production pinned to an older deployment (Vercel rollback), or provenance never confirmed: red, annotated
        for before, after, tests in ((older, older, "failure"), (None, None, "success"), (same, None, "success")):
            got, out, calls = self.verdict_cmd(tests, before, after, mode="scheduled", url="", gh=compare)
            self.assertEqual((out["verdict"], got), ("deferred", 1), (before, after, tests))
            self.assertIn(("annotate", "error"), [c[:2] for c in calls])
        # Codex round 4: a newer commit at the START no longer makes the run green when the end shows an older
        # commit, the target again (a rollback) or nothing readable; the final record must show the newer commit
        for after in (older, same, None):
            for tests in ("success", "failure"):
                got, out, calls = self.verdict_cmd(tests, newer, after, mode="scheduled", url="", gh=compare)
                self.assertEqual((out["verdict"], got), ("deferred", 1), (after, tests))
                self.assertIn(("annotate", "error"), [c[:2] for c in calls])
                self.assertNotIn("moved on", out["detail"], (after, tests))
        # still benign when production ends the run on the newer commit
        got, out, _ = self.verdict_cmd("failure", newer, newer, mode="scheduled", url="", gh=compare)
        self.assertEqual((out["verdict"], got), ("deferred", 0))
        self.assertIn("moved on", out["detail"])
        # a target that could not be resolved is red on a schedule, pending after a merge
        code, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, "", False, "no deployment", "skipped", "", "scheduled")
        self.assertEqual((out["verdict"], code), ("deferred", 1))
        code, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, "", False, "no deployment", "skipped", "", "post-merge")
        self.assertEqual((out["verdict"], code), ("deferred", 0))

    def test_verdict_command_not_ready_is_deferred_without_reading_anything(self):
        code, out, calls = self.run_cmd(mt.smoke_verdict_cmd, self.E, "", False, "no live deployment", "skipped", "")
        self.assertEqual((out["verdict"], code), ("deferred", 0))
        self.assertIn("no live deployment", out["detail"])
        self.assertFalse([c for c in calls if c[0] != "annotate"])  # no GitHub call

    def test_target_refuses_an_unmerged_commit_before_any_checkout(self):
        code, out, calls = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "behind\n")
        self.assertEqual((code, out["ready"], out["sha"]), (0, "false", ""))
        self.assertEqual(len(calls), 1)  # the compare call only: no deployment lookup
        code, out, _ = self.run_cmd(mt.smoke_target, "not-a-sha", "")
        self.assertEqual(out["ready"], "false")

    def test_target_forwards_the_exact_commit_and_deployment(self):
        with patch.object(mt, "master_sha", return_value=self.E), \
                patch.object(mt, "production_deployments", return_value=[("success", self.URL)]):
            code, out, _ = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "ahead\n")
        self.assertEqual((out["ready"], out["sha"], out["deployment_url"]), ("true", self.E, self.URL))

    def test_target_superseded_by_a_deployed_newer_head_stops_before_any_checkout(self):
        # GitHub keeps "success" on a replaced deployment, so the newer head's own deployment is the evidence
        deps = {self.N: [("success", self.NEW_URL)], self.E: [("success", self.URL)]}
        with patch.object(mt, "master_sha", return_value=self.N), \
                patch.object(mt, "production_deployments", side_effect=deps.get):
            code, out, _ = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "ahead\n")
        self.assertEqual((code, out["ready"], out["sha"]), (0, "false", ""))
        self.assertIn("superseded", out["detail"])
        # the newer head is still deploying: production still serves this commit, so it runs
        deps = {self.N: [], self.E: [("success", self.URL)]}
        with patch.object(mt, "master_sha", return_value=self.N), \
                patch.object(mt, "production_deployments", side_effect=deps.get):
            code, out, _ = self.run_cmd(mt.smoke_target, self.E, self.URL, gh=lambda a: "ahead\n")
        self.assertEqual((out["ready"], out["sha"]), ("true", self.E))

    def test_scheduled_target_is_the_newest_deployed_master_commit(self):
        def fake(a):
            if a[1].endswith(f"/commits/{self.N}"):
                return self.E + "\n"  # N's parent
            return "identical\n"
        deps = {self.N: [("pending", "")], self.E: [("success", self.URL)]}
        with patch.object(mt, "master_sha", return_value=self.N), \
                patch.object(mt, "production_deployments", side_effect=deps.get):
            code, out, _ = self.run_cmd(mt.smoke_target, "", "", "scheduled", gh=fake)
        # head still deploying: its parent is what production serves; no deployment pin on a schedule
        self.assertEqual((code, out["ready"], out["sha"], out["deployment_url"]), (0, "true", self.E, ""))
        self.assertIn(self.N[:7], out["detail"])
        with patch.object(mt, "master_sha", return_value=self.N), \
                patch.object(mt, "production_deployments", return_value=[]):
            code, out, _ = self.run_cmd(mt.smoke_target, "", "", "scheduled", gh=lambda a: "")
        self.assertEqual(out["ready"], "false")

    def receipt(self, attempts, parent_state="pass", verify="ok", parent_age=600, existing="unknown",
                compare="ahead", post_error=False, record=True, clock=None, now=None):
        from datetime import datetime, timezone
        stamp = datetime.fromtimestamp(self.NOW - parent_age, timezone.utc).isoformat().replace("+00:00", "Z")
        receipts = {self.P: (parent_state, stamp if parent_state != "unknown" else ""), self.E: (existing, "")}

        def fake(a):
            if a[:3] == ("api", "-X", "POST"):
                if post_error:
                    raise mt.GhError("HTTP 403")
                return ""
            if "/compare/" in a[1]:
                return compare + "\n"
            return self.P + "\n" if a[1].startswith(f"repos/{mt.REPO}/commits/") else ""
        with patch.object(mt, "smoke_receipt_of", side_effect=receipts.get):
            code, out, calls = self.run_cmd(mt.smoke_receipt, self.E, self.URL, verify, "detail", attempts,
                                            self.NOW if now is None else now, gh=fake, record=record,
                                            clock=clock or (lambda: self.NOW))
        status = next((c for c in calls if c[:3] == ("api", "-X", "POST")), None)
        return code, out, status

    def test_receipt_reverts_only_a_double_exact_failure_with_a_recently_passing_parent(self):
        fail = ("fail", "failure", "failed on host")
        code, out, status = self.receipt([fail, fail])
        self.assertEqual((code, out["action"], out["culprit"]), (0, "revert", self.E))
        self.assertEqual(out["observed_at"], mt.iso_utc(self.NOW))  # rollback reconciles only after this time
        self.assertIn("state=failure", status)
        self.assertIn(f"context={mt.SMOKE_CONTEXT}", status)
        self.assertTrue(status[3].endswith(f"/statuses/{self.E}"))
        for kwargs in (dict(parent_state="unknown"), dict(parent_state="fail"),
                       dict(parent_age=mt.SMOKE_PARENT_MAX_AGE_S + 60)):
            code, out, status = self.receipt([fail, fail], **kwargs)
            self.assertEqual((out["action"], out["culprit"]), ("halt", ""), kwargs)
            self.assertIn("state=failure", status)  # the deployment did fail; only the culprit is unknown

    def test_receipt_records_pending_verification_and_never_reverts_otherwise(self):
        cases = [([("pass", "success", "ok"), ("", "skipped", "")], "none", "state=success"),
                 ([("deferred", "success", "moved"), ("", "skipped", "")], "none", "state=pending"),
                 ([("fail", "failure", "x"), ("deferred", "success", "moved")], "none", "state=pending"),
                 ([("fail", "cancelled", "x"), ("", "skipped", "")], "none", "state=pending"),
                 ([("unverified", "failure", "x"), ("unverified", "failure", "y")], "halt", "state=pending"),
                 # the retry never ran after a failed first attempt: halt, never "pending"
                 ([("fail", "failure", "x"), ("", "skipped", "")], "halt", "state=pending")]
        for attempts, action, state in cases:
            code, out, status = self.receipt(attempts)
            self.assertEqual((code, out["action"], out["culprit"]), (0, action, ""), attempts)
            self.assertIn(state, status, attempts)

    def test_pending_never_overwrites_an_earlier_exact_receipt(self):
        attempts = [("deferred", "success", "moved"), ("", "skipped", "")]
        for existing in ("pass", "fail"):
            code, out, status = self.receipt(attempts, existing=existing)
            self.assertEqual((code, out["action"]), (0, "none"))
            self.assertIsNone(status, existing)
        code, out, status = self.receipt([("pass", "success", "ok"), ("", "skipped", "")], existing="fail")
        self.assertIn("state=success", status)  # an exact result is always recorded

    def test_receipt_that_cannot_be_written_publishes_no_decision(self):
        fail = ("fail", "failure", "failed on host")
        code, out, status = self.receipt([fail, fail], post_error=True)
        self.assertEqual(code, 1)
        self.assertNotIn("action", out)  # the workflow then halts without a revert
        self.assertNotIn("culprit", out)
        self.assertNotIn("observed_at", out)  # and with no failure time, no smoke pass can cancel that halt

    def test_observed_at_is_read_after_the_status_is_written(self):
        # Claude round 4, now only the fallback: when the failing attempt left no time of its own, this job's clock
        # is read after the write, so a pass recorded in between never counts as after the failure
        fail = ("fail", "failure", "failed on host")
        posted = []

        def fake(a):
            if a[:3] == ("api", "-X", "POST"):
                posted.append(a)
                return ""
            return "ahead\n" if "/compare/" in a[1] else self.P + "\n"
        receipts = {self.P: ("pass", mt.iso_utc(self.NOW - 600)), self.E: ("unknown", "")}
        with patch.object(mt, "smoke_receipt_of", side_effect=receipts.get):
            code, out, _ = self.run_cmd(mt.smoke_receipt, self.E, self.URL, "ok", "", [fail, fail], self.NOW,
                                        gh=fake, clock=lambda: self.NOW + 3 if posted else self.NOW)
        self.assertEqual((code, out["action"], len(posted)), (0, "revert", 1))
        self.assertEqual(out["observed_at"], mt.iso_utc(self.NOW + 3))

    @staticmethod
    def description(status):
        return next(a for a in status if a.startswith("description="))[len("description="):]

    def test_receipt_dates_the_attempts_not_the_receipt_job(self):
        # Codex round 5: a receipt job that runs late (queued, or re-run the next day) records each attempt's own time
        # and identity and hands rollback the failing attempt's own end, so it decides exactly as an on-time one,
        # including the parent's age (an hour late would otherwise make a 2 h 57 min old parent pass "too old")
        t = mt.iso_utc
        fail1 = ("fail", "failure", "failed on host", t(self.NOW - 400), t(self.NOW - 300), "77.1.first")
        fail2 = ("fail", "failure", "failed on host", t(self.NOW - 200), t(self.NOW - 100), "77.1.retry")
        seen = set()
        for late in (0, 3600, 86400):
            code, out, status = self.receipt([fail1, fail2], now=self.NOW + late, clock=lambda: self.NOW + late + 5,
                                             parent_age=mt.SMOKE_PARENT_MAX_AGE_S - 60)
            self.assertEqual((code, out["action"], out["culprit"]), (0, "revert", self.E), late)
            self.assertEqual(out["observed_at"], t(self.NOW - 100), late)  # the retry's own end
            desc = self.description(status)
            self.assertTrue(desc.startswith(f"[{t(self.NOW - 100)} 77.1.retry] fail: "), (late, desc))
            self.assertLessEqual(len(desc), 140)
            seen.add((out["observed_at"], desc))
        self.assertEqual(len(seen), 1)  # identical however late the receipt job ran
        # a parent pass more than 3 h before the failure (NOW-100) still halts
        code, out, _ = self.receipt([fail1, fail2], parent_age=mt.SMOKE_PARENT_MAX_AGE_S + 200)
        self.assertEqual(out["action"], "halt")

    def test_receipt_marks_follow_the_attempt_that_decided(self):
        t = mt.iso_utc
        ok1 = ("pass", "success", "ok", t(self.NOW - 500), t(self.NOW - 400), "78.1.first")
        ok2 = ("pass", "success", "ok", t(self.NOW - 250), t(self.NOW - 150), "78.1.retry")
        failed = ("fail", "failure", "x", t(self.NOW - 900), t(self.NOW - 800), "78.1.first")
        unv = ("unverified", "failure", "y", t(self.NOW - 700), t(self.NOW - 600), "78.1.retry")
        late = lambda: self.NOW + 999  # noqa: E731 - this job's clock, far later than every attempt
        # a pass is dated by when its run STARTED
        _, out, status = self.receipt([ok1, ("", "skipped", "")], now=self.NOW + 999, clock=late)
        self.assertTrue(self.description(status).startswith(f"[{t(self.NOW - 500)} 78.1.first] pass: "))
        _, out, status = self.receipt([failed, ok2], now=self.NOW + 999, clock=late)
        self.assertTrue(self.description(status).startswith(f"[{t(self.NOW - 250)} 78.1.retry] pass: "))
        # a halt by when the last attempt that ran and failed ENDED
        _, out, status = self.receipt([failed, unv], now=self.NOW + 999, clock=late)
        self.assertEqual((out["action"], out["observed_at"]), ("halt", t(self.NOW - 600)))
        self.assertTrue(self.description(status).startswith(f"[{t(self.NOW - 600)} 78.1.retry] "))
        _, out, status = self.receipt([failed, ("", "skipped", "")], now=self.NOW + 999, clock=late)
        self.assertEqual((out["action"], out["observed_at"]), ("halt", t(self.NOW - 800)))  # the retry never ran
        # the retry ran but left no time (its job died before the verdict step): this job's clock, after the write
        _, out, status = self.receipt([failed, ("", "failure", "")], now=self.NOW + 999, clock=late)
        self.assertEqual((out["action"], out["observed_at"]), ("halt", t(self.NOW + 999)))
        self.assertTrue(self.description(status).startswith("[- -] "))
        # pending verification carries no time; nor does an attempt without the new outputs
        _, out, status = self.receipt([("deferred", "success", "moved", t(self.NOW), t(self.NOW), "78.1.first"),
                                       ("", "skipped", "")])
        self.assertTrue(self.description(status).startswith("[- -] pending verification: "))
        _, out, status = self.receipt([("pass", "success", "ok"), ("", "skipped", "")])
        self.assertTrue(self.description(status).startswith("[- -] pass: "))
        self.assertEqual(mt.attempt_fields(("pass", "success")), ("pass", "success", "", "", "", ""))

    def test_verdict_command_outputs_the_attempts_own_identity_and_times(self):
        import os
        import tempfile
        host = mt.deployment_host(self.URL)
        same = {"version": self.E, "deployment": host}
        end = mt.receipt_time("2027-01-15T08:06:00Z")

        def verdict(before_at, run_id="4242", attempt="retry", mode="post-merge"):
            with tempfile.TemporaryDirectory() as d:
                before = dict(same, checkedAt=before_at) if before_at is not None else dict(same)
                self.write_provenance(d, before, dict(same, checkedAt="2027-01-15T08:05:00.000Z"))
                with patch.dict(os.environ, {"GITHUB_RUN_ID": run_id, "GITHUB_RUN_ATTEMPT": "2"}):
                    _, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, self.URL, True, "", "failure", d, mode,
                                             attempt=attempt, clock=lambda: end)
            return out
        out = verdict("2027-01-15T08:00:00.250Z")
        self.assertEqual((out["verdict"], out["attempt_id"], out["started_at"], out["ended_at"]),
                         ("fail", "4242.2.retry", "2027-01-15T08:00:00Z", "2027-01-15T08:06:00Z"))
        self.assertEqual(verdict(None)["started_at"], "")  # no time in the "before" record
        self.assertEqual(verdict("2027-01-15T08:07:00Z")["started_at"], "")  # later than the verdict: not believed
        self.assertEqual(verdict("2027-01-15T08:00:00")["started_at"], "")  # no time zone
        self.assertEqual(verdict("2027-01-15T08:00:00Z", run_id="")["attempt_id"], "")
        self.assertEqual(verdict("2027-01-15T08:00:00Z", attempt="", mode="scheduled")["attempt_id"],
                         "4242.2.scheduled")
        # not ready: nothing was tested, so no start, but the attempt still names itself and its end
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "4242", "GITHUB_RUN_ATTEMPT": "1"}):
            _, out, _ = self.run_cmd(mt.smoke_verdict_cmd, self.E, "", False, "no live deployment", "skipped", "",
                                     attempt="first", clock=lambda: end)
        self.assertEqual((out["attempt_id"], out["started_at"], out["ended_at"]),
                         ("4242.1.first", "", "2027-01-15T08:06:00Z"))
        # pure parts
        self.assertEqual(mt.attempt_identity("", "1", "first"), "")
        self.assertEqual(mt.attempt_identity("7", "", "first"), "7.1.first")
        self.assertEqual(mt.attempt_identity("7", "1", "bad name"), "")
        self.assertEqual(mt.attempt_window(None, 5.0), (None, 5.0))
        self.assertEqual(mt.attempt_window(6.0, 5.0), (None, 5.0))
        self.assertEqual(mt.attempt_window(4.0, 5.0), (4.0, 5.0))

    def test_receipt_and_verdict_commands_forward_the_attempt_fields(self):
        seen = []
        with patch.object(mt, "smoke_receipt", side_effect=lambda *a, **k: seen.append(a[4]) or 0):
            mt.main(["smoke-receipt", "--sha", self.E, "--first", "fail", "--first-result", "failure",
                     "--first-detail", "d1", "--first-started-at", "s1", "--first-ended-at", "e1",
                     "--first-attempt-id", "i1", "--retry", "fail", "--retry-result", "failure", "--retry-detail", "d2",
                     "--retry-started-at", "s2", "--retry-ended-at", "e2", "--retry-attempt-id", "i2"])
            mt.main(["smoke-receipt", "--sha", self.E])
        self.assertEqual(seen, [[("fail", "failure", "d1", "s1", "e1", "i1"),
                                 ("fail", "failure", "d2", "s2", "e2", "i2")],
                                [("",) * 6, ("",) * 6]])
        got = []
        with patch.object(mt, "smoke_verdict_cmd", side_effect=lambda *a, **k: got.append(k.get("attempt")) or 0):
            mt.main(["smoke-verdict", "--sha", self.E, "--attempt", "retry"])
            mt.main(["smoke-verdict", "--sha", self.E])
        self.assertEqual(got, ["retry", ""])

    def test_with_recording_off_nothing_is_written_and_nothing_is_reverted(self):
        # Codex round 4: no post-merge/smoke status until every reader of master's combined status reads the
        # Vercel context (SMOKE_RECEIPT_STATUS); a revert needs a recorded receipt, so an exact double failure halts
        fail = ("fail", "failure", "failed on host")
        code, out, status = self.receipt([fail, fail], record=False)
        self.assertEqual((code, out["action"], out["culprit"]), (0, "halt", ""))
        self.assertIsNone(status)
        self.assertIn("SMOKE_RECEIPT_STATUS", out["reason"])
        self.assertEqual(out["observed_at"], mt.iso_utc(self.NOW))  # the halt still reconciles after this time
        cases = [([("pass", "success", "ok"), ("", "skipped", "")], "none"),
                 ([("deferred", "success", "moved"), ("", "skipped", "")], "none"),
                 ([("unverified", "failure", "x"), ("unverified", "failure", "y")], "halt"),
                 ([("fail", "failure", "x"), ("", "skipped", "")], "halt")]
        for attempts, action in cases:
            code, out, status = self.receipt(attempts, record=False)
            self.assertEqual((code, out["action"], out["culprit"]), (0, action, ""), attempts)
            self.assertIsNone(status, attempts)

    def test_receipt_command_records_only_when_the_variable_is_on(self):
        seen = []
        with patch.object(mt, "smoke_receipt", side_effect=lambda *a, **k: seen.append(k.get("record")) or 0):
            for value in ("on", " On ", "", "off", "true"):
                mt.main(["smoke-receipt", "--sha", self.E, "--record-status", value])
            mt.main(["smoke-receipt", "--sha", self.E])
        self.assertEqual(seen, [True, True, False, False, False, False])

    def test_receipt_only_on_a_master_commit(self):
        # a dispatch with a PR head must not put a pending status on that PR (the train would wait on it)
        code, out, status = self.receipt([("", "skipped", ""), ("", "skipped", "")], verify="skipped",
                                         compare="diverged")
        self.assertEqual((code, out["action"]), (0, "none"))
        self.assertIsNone(status)

    def test_receipt_with_an_unreadable_parent_receipt_halts(self):
        fail = ("fail", "failure", "failed on host")

        def receipts(sha):
            if sha == self.P:
                raise mt.GhError("HTTP 502")
            return "unknown", ""

        def fake(a):
            return "ahead\n" if "/compare/" in a[1] else self.P + "\n"
        with patch.object(mt, "smoke_receipt_of", side_effect=receipts):
            code, out, _ = self.run_cmd(mt.smoke_receipt, self.E, self.URL, "ok", "", [fail, fail], self.NOW, gh=fake)
        self.assertEqual((code, out["action"], out["culprit"]), (0, "halt", ""))

    def test_receipt_of_a_superseded_merge_is_pending(self):
        code, out, status = self.receipt([("", "skipped", ""), ("", "skipped", "")], verify="skipped")
        self.assertEqual(out["action"], "none")
        self.assertIn("state=pending", status)


class SmokeWorkflowContract(unittest.TestCase):
    """Workflow text contracts: SHA + URL forwarding, credential confinement, no artifacts. Comments are stripped
    first, so a comment that names a forbidden setting never satisfies or breaks a check."""
    ROOT = Path(__file__).resolve().parents[1]

    def read(self, rel):
        return (self.ROOT / rel).read_text(encoding="utf-8")

    def code(self, rel):
        import re
        lines = []
        for line in self.read(rel).splitlines():
            if line.lstrip().startswith("#"):
                continue
            lines.append(re.sub(r"\s+#\s.*$", "", line))
        return "\n".join(lines)

    def test_post_merge_forwards_the_verified_commit_and_deployment_to_both_attempts(self):
        wf = self.code(".github/workflows/post-merge.yml")
        self.assertIn("deployment_url: ${{ steps.v.outputs.deployment_url }}", wf)
        self.assertEqual(wf.count("expected_sha: ${{ needs.verify.outputs.sha }}"), 2)
        self.assertEqual(wf.count("deployment_url: ${{ needs.verify.outputs.deployment_url }}"), 2)
        self.assertEqual(wf.count("post_merge: true"), 2)

    def test_post_merge_hands_the_smoke_test_only_the_smoke_secrets(self):
        wf = self.code(".github/workflows/post-merge.yml")
        self.assertNotIn("secrets: inherit", wf)
        for name in ("SMOKE_BASE_URL", "SMOKE_TEST_EMAIL", "SMOKE_TEST_PASSWORD"):
            self.assertEqual(wf.count(f"{name}: ${{{{ secrets.{name} }}}}"), 2, name)

    def test_failure_conditions_carry_a_status_function(self):
        # without one GitHub prepends success(), which is false once the dependency failed: the job never runs
        import re
        for rel in (".github/workflows/post-merge.yml", ".github/workflows/smoke-test.yml"):
            for cond in re.findall(r"^\s*if:\s*(.+)$", self.code(rel), re.M):
                if ".result == 'failure'" in cond:
                    self.assertRegex(cond, r"(always|failure|cancelled)\(\)", (rel, cond))
        self.assertIn("if: failure() && needs.smoke.result == 'failure'", self.code(".github/workflows/post-merge.yml"))

    def test_rollback_follows_the_receipt_decision(self):
        wf = self.code(".github/workflows/post-merge.yml")
        self.assertIn("needs.receipt.outputs.action == 'revert'", wf)
        self.assertIn("needs.receipt.outputs.culprit ||", wf)
        self.assertIn("needs.receipt.outputs.action != 'revert'", wf)  # anything but a proven culprit halts
        self.assertIn("statuses: write", wf)
        # a second smoke failure alone no longer reverts: only the receipt's proven culprit does
        self.assertNotIn("|| needs.smoke-retry.result == 'failure'", wf)
        # an unwritable receipt after a failed first attempt halts whether the retry failed or never ran
        # (Claude round 2); a cancelled (superseded) retry does nothing
        self.assertIn("needs: [verify, smoke, smoke-retry, receipt]", wf)
        self.assertIn("(needs.receipt.result == 'failure' && needs.smoke.result == 'failure' && "
                      "(needs.smoke-retry.result == 'failure' || needs.smoke-retry.result == 'skipped'))", wf)
        self.assertNotIn("needs.smoke-retry.result == 'cancelled'", wf)
        # Codex R6: the failure time travels from the receipt to rollback, which reconciles only after it
        self.assertIn("observed_at: ${{ steps.r.outputs.observed_at }}", wf)
        self.assertIn("FAILED_AT: ${{ needs.receipt.outputs.observed_at }}", wf)
        self.assertIn('--failed-at "$FAILED_AT"', wf)
        # Codex round 4: the status is written only while the repository variable is on
        receipt_job = wf.split("\n  receipt:\n", 1)[1].split("\n  rollback:\n", 1)[0]
        self.assertIn("RECORD_STATUS: ${{ vars.SMOKE_RECEIPT_STATUS }}", receipt_job)
        self.assertIn('--record-status "$RECORD_STATUS"', receipt_job)
        # rollback() reads deployments and commit statuses; job permissions replace the workflow's
        rollback_job = wf.split("\n  rollback:\n", 1)[1]
        self.assertIn("statuses: read", rollback_job)
        self.assertIn("deployments: read", rollback_job)

    def test_each_attempt_carries_its_own_identity_and_times_to_the_receipt(self):
        # Codex round 5: the receipt dates the attempts from their own outputs, never from when the receipt job ran
        smoke = self.code(".github/workflows/smoke-test.yml")
        for name in ("attempt_id", "started_at", "ended_at"):
            self.assertIn(f"value: ${{{{ jobs.smoke.outputs.{name} }}}}", smoke)
            self.assertIn(f"{name}: ${{{{ steps.verdict.outputs.{name} }}}}", smoke)
        verdict_step = smoke.split("- name: Verdict and receipt", 1)[1]
        self.assertIn("ATTEMPT: ${{ inputs.attempt }}", verdict_step)
        self.assertIn('--attempt "$ATTEMPT"', verdict_step)
        wf = self.code(".github/workflows/post-merge.yml")
        self.assertIn("attempt: first", wf.split("\n  smoke:\n", 1)[1].split("\n  smoke-retry:\n", 1)[0])
        self.assertIn("attempt: retry", wf.split("\n  smoke-retry:\n", 1)[1].split("\n  receipt:\n", 1)[0])
        receipt_job = wf.split("\n  receipt:\n", 1)[1].split("\n  rollback:\n", 1)[0]
        for job, prefix in (("smoke", "FIRST"), ("smoke-retry", "RETRY")):
            for name in ("started_at", "ended_at", "attempt_id"):
                env = f"{prefix}_{name.upper()}"
                self.assertIn(f"{env}: ${{{{ needs.{job}.outputs.{name} }}}}", receipt_job)
                flag = f"--{prefix.lower()}-{name.replace('_', '-')}"
                self.assertIn(f'{flag} "${env}"', receipt_job)

    def test_smoke_workflow_is_bound_read_only_and_keeps_no_artifact(self):
        wf = self.code(".github/workflows/smoke-test.yml")
        self.assertIn("ref: ${{ steps.target.outputs.sha }}", wf)
        self.assertIn('smoke-target --mode "$SMOKE_MODE" --sha', wf)
        self.assertIn('smoke-verdict --mode "$SMOKE_MODE" --sha', wf)
        self.assertIn("SMOKE_MODE: ${{ inputs.post_merge && 'post-merge' || 'scheduled' }}", wf)
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
        # Claude round 2: the session is saved and "before" recorded as soon as the redirect proves a session, and
        # before anything on Today is checked, so a commit that breaks Today still leaves both records
        redirect = setup.index('page.waitForURL("**/today"')
        record = setup.index("const stale = await recordBefore()")
        self.assertLess(redirect, record)
        self.assertLess(record, setup.index("await expect(page).toHaveURL"))
        self.assertLess(record, setup.index('getByRole("heading"'))
        self.assertLess(setup.index("storageState({ path: authFile })"), setup.index('readServedRevision(page.request'))
        self.assertIn("} finally {", setup)
        self.assertIn("await recordBefore().catch(() => null)", setup)
        # a hang ends as a failed test run the verdict reads, never as a job cancelled by its own time limit
        self.assertIn("globalTimeout: process.env.CI ? 8 * 60_000 : 0", cfg)
        smoke = self.code(".github/workflows/smoke-test.yml")
        tests_step = smoke.split("- name: Run smoke tests", 1)[1].split("- name:", 1)[0]
        self.assertIn("continue-on-error: true", tests_step)
        self.assertIn("timeout-minutes: 10", tests_step)
        self.assertIn("timeout-minutes: 20", smoke.split("- name: Run smoke tests", 1)[0])
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
