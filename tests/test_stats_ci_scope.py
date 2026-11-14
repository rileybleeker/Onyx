"""Offline checks for the conservative stats CI scope decision."""
import importlib.util
import hashlib
import tempfile
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("stats_ci_scope", ROOT / "tools/stats_ci_scope.py")
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class StatsScopeTests(unittest.TestCase):
    def setUp(self):
        snapshot = patch.object(scope, "dependency_snapshot_matches", return_value=True)
        self.snapshot = snapshot.start()
        self.addCleanup(snapshot.stop)

    def test_unknown_dependency_snapshot_stays_full(self):
        self.snapshot.return_value = False
        self.assertEqual(scope.select_scope("pull_request", "a"*40, "b"*40), "full")

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


class DependencySnapshotTests(unittest.TestCase):
    """Exercise the real fingerprint against an isolated Git index and files."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="onyx-stats-scope-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.git("init", "--quiet")
        (self.root / "tools").mkdir()
        self.source = self.root / "module.py"
        self.source.write_bytes(b"VALUE = 1\n")
        self.git("add", "module.py")
        self.manifest = self.root / "tools/stats_ci_dependencies.sha256"
        # Independent known fixture digest, not the implementation under test.
        self.manifest.write_text(hashlib.sha256(b"module.py\0VALUE = 1\n\0").hexdigest() + "\n")
        self.assertTrue(scope.dependency_snapshot_matches(self.root))

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def assert_full(self):
        self.assertFalse(scope.dependency_snapshot_matches(self.root))
        self.assertEqual(scope.select_scope("pull_request", "a" * 40, "b" * 40, self.root), "full")

    def test_modified_source(self):
        self.source.write_bytes(b"VALUE = 2\n")
        self.assert_full()

    def test_added_tracked_source(self):
        (self.root / "new.py").write_text("pass\n")
        self.git("add", "new.py")
        self.assert_full()

    def test_deleted_source_unstaged(self):
        self.source.unlink()
        self.assert_full()

    def test_deleted_source_staged(self):
        self.git("rm", "--cached", "module.py")
        self.assert_full()

    def test_crlf_is_equivalent(self):
        self.source.write_bytes(b"VALUE = 1\r\n")
        self.assertTrue(scope.dependency_snapshot_matches(self.root))

    def test_missing_manifest(self):
        self.manifest.unlink()
        self.assert_full()

    def test_malformed_manifest(self):
        for content in ["", "invalid", "0" * 64]:
            with self.subTest(content=content):
                self.manifest.write_text(content)
                self.assert_full()

    def test_unreadable_source(self):
        # Permission chmod is not portable on Windows; fault the actual read boundary.
        with patch.object(Path, "read_bytes", side_effect=PermissionError("unreadable")):
            self.assert_full()

    def test_unreadable_manifest(self):
        with patch.object(Path, "read_text", side_effect=PermissionError("unreadable")):
            self.assert_full()

    def test_invalid_utf8_git_path(self):
        result = subprocess.CompletedProcess([], 0, b"bad-\xff.py\0")
        with patch.object(scope.subprocess, "run", return_value=result):
            self.assert_full()

    def test_git_failures(self):
        for error in [OSError("missing git"), subprocess.CalledProcessError(128, "git"), subprocess.TimeoutExpired("git", 30)]:
            with self.subTest(error=type(error).__name__):
                with patch.object(scope.subprocess, "run", side_effect=error):
                    self.assert_full()


if __name__ == "__main__":
    unittest.main()
