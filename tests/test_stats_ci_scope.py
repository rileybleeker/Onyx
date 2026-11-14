"""Offline checks for the conservative stats CI scope decision."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("stats_ci_scope", ROOT / "tools/stats_ci_scope.py")
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class StatsScopeTests(unittest.TestCase):
    def test_frontend_only(self):
        self.assertTrue(scope.frontend_only(["frontend/src/app/page.tsx", "frontend/src/app/globals.css"]))

    def test_full_for_every_other_trigger_or_mixed_change(self):
        for path in ["hrv_analysis.py", "tests/test_tdee_source_guard.py", "requirements-ci.txt", ".github/workflows/stats-pr-check.yml", "frontend/src/tool.py", "docs/ci-checks.md", "frontend/src/lib/spotify-reconnect.ts"]:
            with self.subTest(path=path):
                self.assertFalse(scope.frontend_only(["frontend/src/app/page.tsx", path]))
        self.assertFalse(scope.frontend_only([]))
        self.assertFalse(scope.frontend_only([""]))

    def test_manual_and_missing_metadata_are_full(self):
        for event, base, head in [("workflow_dispatch", "a"*40, "b"*40), ("pull_request", "", "b"*40), ("pull_request", "--bad", "b"*40)]:
            self.assertEqual(scope.select_scope(event, base, head), "full")

    @patch.object(scope.subprocess, "run")
    def test_successful_diff(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, b"frontend/src/app/page.tsx\0")
        self.assertEqual(scope.select_scope("pull_request", "a"*40, "b"*40), "frontend")
        self.assertIn("--no-renames", run.call_args.args[0])
        self.assertIn("-z", run.call_args.args[0])

    @patch.object(scope.subprocess, "run")
    def test_deleted_or_renamed_backend_path_stays_full(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, b"old.py\0frontend/src/new.ts\0")
        self.assertEqual(scope.select_scope("pull_request", "a"*40, "b"*40), "full")

    @patch.object(scope.subprocess, "run")
    def test_unavailable_history_and_timeout_stay_full(self, run):
        for error in [OSError(), subprocess.CalledProcessError(128, "git"), subprocess.TimeoutExpired("git", 30)]:
            run.side_effect = error
            self.assertEqual(scope.select_scope("pull_request", "a"*40, "b"*40), "full")


if __name__ == "__main__":
    unittest.main()
