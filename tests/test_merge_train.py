"""Decision-logic tests for tools/merge_train.py. No network, no credentials, no gh calls."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import merge_train as mt  # noqa: E402


def pr(**kw):
    base = dict(number=1, title="feat: x", isDraft=False, baseRefName="master", isCrossRepository=False,
                author="rileybleeker", labels=[], headRefOid="a" * 40, headRefName="feat/x",
                mergeable="MERGEABLE", mergeStateStatus="CLEAN")
    base.update(kw)
    return base


GREEN = [dict(id=1, name="offline-checks", status="completed", conclusion="success"),
         dict(id=2, name="frontend-types", status="completed", conclusion="success")]
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
                dict(id=9, name="offline-checks", status="completed", conclusion="success"), GREEN[1]]
        self.assertEqual(judge(runs=runs)[0], "merge")

    def test_cancelled_latest_blocks(self):
        runs = [dict(id=9, name="offline-checks", status="completed", conclusion="cancelled"), GREEN[1]]
        self.assertEqual(judge(runs=runs)[0], "skip")

    def test_failed_commit_status_blocks_but_vercel_preview_does_not(self):
        self.assertEqual(judge(statuses=[dict(context="ci/other", state="failure")])[0], "skip")
        self.assertEqual(judge(statuses=[dict(context="Vercel Preview Comments", state="failure")])[0], "merge")

    def test_running_check_waits(self):
        runs = [dict(id=1, name="offline-checks", status="in_progress", conclusion=None), GREEN[1]]
        self.assertEqual(judge(runs=runs)[0], "wait")
        self.assertEqual(judge(active=1)[0], "wait")

    def test_missing_required_check_dispatches_ci(self):
        self.assertEqual(judge(runs=[GREEN[0]])[0], "dispatch")
        self.assertEqual(judge(runs=[])[0], "dispatch")

    def test_behind_updates(self):
        self.assertEqual(judge(pr(mergeStateStatus="BEHIND"), runs=[])[0], "update")

    def test_behind_with_failed_check_is_left_alone(self):
        runs = [dict(id=1, name="offline-checks", status="completed", conclusion="failure"), GREEN[1]]
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


class MasterCiVerdict(unittest.TestCase):
    def run_(self, conclusion, status="completed"):
        return dict(id=1, status=status, conclusion=conclusion)

    def test_green(self):
        self.assertEqual(mt.master_ci_verdict([self.run_("success")], False)[0], "ok")

    def test_still_running_waits(self):
        self.assertIsNone(mt.master_ci_verdict([self.run_(None, "in_progress")], True))

    def test_cancelled_by_next_merge_is_superseded_not_failed(self):
        # 2026-11-12: #32 landed while #24's master CI ran; the cancel halted the train and pushed a false revert
        self.assertEqual(mt.master_ci_verdict([self.run_("cancelled")], True)[0], "skipped")

    def test_cancelled_while_still_head_fails(self):
        self.assertEqual(mt.master_ci_verdict([self.run_("cancelled")], False)[0], "fail")

    def test_real_failure_fails_even_after_master_moved(self):
        self.assertEqual(mt.master_ci_verdict([self.run_("failure")], True)[0], "fail")

    def test_mixed_cancel_and_failure_fails(self):
        runs = [self.run_("cancelled"), dict(id=2, status="completed", conclusion="failure")]
        self.assertEqual(mt.master_ci_verdict(runs, True)[0], "fail")

    def test_rerun_success_beats_cancel(self):
        runs = [self.run_("cancelled"), dict(id=2, status="completed", conclusion="success")]
        self.assertEqual(mt.master_ci_verdict(runs, False)[0], "ok")


if __name__ == "__main__":
    unittest.main()
