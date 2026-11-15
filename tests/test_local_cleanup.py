"""Local cleanup: which %TEMP% items are selected for the Recycle Bin and which are kept, on a synthetic
temp tree. Nothing is ever recycled: `recycle` is replaced for every test and fails the test if reached.

Run: python tests/test_local_cleanup.py
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "local_cleanup"))

import local_cleanup as lc  # noqa: E402

NOW = time.time() + 3 * 86400   # the test's "now": everything the test creates is 3 days old
RECENT = NOW - 3600             # modified 1 hour before "now"
U1 = "11111111-2222-3333-4444-555555555555"
U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(os.path.realpath(self._tmp.name))
        self.base = base
        self.temp = base / "Temp"
        self.temp.mkdir()
        self.sessions = base / "sessions"
        self.sessions.mkdir()
        self.protected = [str(base / "LocalAppData" / "Onyx"), str(base / ".codex"),
                          str(base / ".claude" / "projects")]
        self._saved = {name: getattr(lc, name) for name in
                       ("recycle", "MAX_ITEM_BYTES", "run", "single_instance", "temp_root", "check_root")}
        lc.recycle = self._no_recycle

    def tearDown(self):
        for name, value in self._saved.items():
            setattr(lc, name, value)
        self._tmp.cleanup()

    @staticmethod
    def _no_recycle(path):
        raise AssertionError(f"recycle() reached for {path}")

    def mk(self, rel, data=b"x" * 10, mtime=None):
        p = self.temp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p

    def session(self, sid, name="1.json"):
        (self.sessions / name).write_text(json.dumps({"pid": 1, "sessionId": sid}), encoding="utf-8")

    def rel(self, path):
        return os.path.relpath(path, self.temp).replace(os.sep, "/")

    def items(self, sessions=None, protected=None, **kw):
        found = lc.scan(str(self.temp), self.sessions if sessions is None else sessions,
                        self.protected if protected is None else protected, NOW, **kw)
        return {self.rel(i.path): i for i in found}


class Categories(Base):
    def test_each_category_matches_and_nothing_else_does(self):
        self.session(U1)
        self.mk(f"claude/proj1/{U2}/notes.txt")
        self.mk("claude/proj1/not-a-session/f.txt")
        self.mk("claude/bundled-skills/2.1.323/skill.md")
        self.mk("onyx-care-ui-8GH1v4/package.json")
        self.mk("onyx-care-ui-toolong7/package.json")        # 7-character suffix: not a frontend copy
        self.mk("onyx-wins-AbC123/out.json")
        self.mk("onyx-wins-library-20261115-001/out.json")
        self.mk("onyx-install-builds-x1Y2z3/out.json")
        self.mk("onyx-supp-reminders-q9W8e7/out.json")
        self.mk("edit_foo.py")
        self.mk("patch2.py")
        self.mk("claude-1a2b-cwd")
        self.mk("playwright-artifacts-xyz/trace.zip")
        self.mk("playwright_chromiumdev_profile-abc/Default/Prefs")
        self.mk("onyx-desktop-app-abc/x")                     # not a listed category
        self.mk("onyx-checkin-pr-body.md")
        self.mk("keep-me.txt")
        self.mk("edit_dir.py/inner.txt")                      # a FOLDER named like a script: not matched
        self.mk("onyx-wins-file")                             # a FILE named like a test folder: not matched
        got = {k: i.category for k, i in self.items().items()}
        self.assertEqual(got, {
            f"claude/proj1/{U2}": "claude-scratch",
            "onyx-care-ui-8GH1v4": "ui-copies",
            "onyx-wins-AbC123": "test-temp",
            "onyx-wins-library-20261115-001": "test-temp",
            "onyx-install-builds-x1Y2z3": "test-temp",
            "onyx-supp-reminders-q9W8e7": "test-temp",
            "edit_foo.py": "edit-scripts",
            "patch2.py": "edit-scripts",
            "claude-1a2b-cwd": "claude-cwd",
            "playwright-artifacts-xyz": "playwright",
            "playwright_chromiumdev_profile-abc": "playwright",
        })
        self.assertTrue(all(not i.reason for i in self.items().values()))

    def test_size_counts_every_file_in_the_tree(self):
        self.mk("onyx-wins-size01/a.bin", b"a" * 100)
        self.mk("onyx-wins-size01/sub/deeper/b.bin", b"b" * 50)
        self.assertEqual(self.items()["onyx-wins-size01"].size, 150)


class KeepRules(Base):
    def test_git_anywhere_keeps_the_item(self):
        self.session(U1)
        self.mk("onyx-wins-git001/repo/.git/HEAD")
        self.mk(f"claude/p/{U2}/worktree/.git")              # a worktree's .git is a file
        self.mk("onyx-wins-clean1/x")
        got = self.items()
        self.assertEqual(got["onyx-wins-git001"].reason, "git")
        self.assertEqual(got[f"claude/p/{U2}"].reason, "git")
        self.assertEqual(got["onyx-wins-clean1"].reason, "")

    def test_scratch_of_a_listed_session_is_kept(self):
        self.session(U1.upper())
        self.mk(f"claude/p/{U1}/f.txt")
        self.mk(f"claude/p/{U2}/f.txt")
        got = self.items()
        self.assertEqual(got[f"claude/p/{U1}"].reason, "active-session")
        self.assertEqual(got[f"claude/p/{U2}"].reason, "")

    def test_unreadable_session_list_keeps_every_scratch_folder(self):
        self.session(U1)
        (self.sessions / "2.json").write_text("{not json", encoding="utf-8")
        self.mk(f"claude/p/{U2}/f.txt")
        self.mk("onyx-wins-other1/x")
        got = self.items()
        self.assertEqual(got[f"claude/p/{U2}"].reason, "sessions-unreadable")
        self.assertEqual(got["onyx-wins-other1"].reason, "")

    def test_missing_session_list_or_session_id_keeps_every_scratch_folder(self):
        self.mk(f"claude/p/{U2}/f.txt")
        missing = self.base / "no-such-sessions-dir"
        self.assertEqual(self.items(sessions=missing)[f"claude/p/{U2}"].reason, "sessions-unreadable")
        (self.sessions / "3.json").write_text(json.dumps({"pid": 3}), encoding="utf-8")
        self.assertEqual(self.items()[f"claude/p/{U2}"].reason, "sessions-unreadable")

    def test_session_key_files_are_never_read(self):
        (self.sessions / "1.abc.key").write_bytes(b"\x00\xff not json")
        self.mk(f"claude/p/{U2}/f.txt")
        self.assertEqual(self.items()[f"claude/p/{U2}"].reason, "")

    def test_anything_modified_in_the_last_12_hours_keeps_the_item(self):
        self.mk("onyx-wins-old001/a/b/c.txt")
        self.mk("onyx-wins-new001/a/b/c.txt", mtime=RECENT)
        self.mk("onyx-wins-new001/a/old.txt")
        self.mk("edit_new.py", mtime=RECENT)
        self.mk("onyx-wins-edge01/x", mtime=NOW - 12 * 3600 + 60)
        self.mk("onyx-wins-edge02/x", mtime=NOW - 12 * 3600 - 60)
        got = self.items()
        self.assertEqual(got["onyx-wins-old001"].reason, "")
        self.assertEqual(got["onyx-wins-new001"].reason, "recent")
        self.assertEqual(got["edit_new.py"].reason, "recent")
        self.assertEqual(got["onyx-wins-edge01"].reason, "recent")
        self.assertEqual(got["onyx-wins-edge02"].reason, "")

    def test_a_path_over_the_limit_anywhere_keeps_the_item(self):
        item = self.temp / "onyx-wins-long01"
        limit = len(str(item)) + 40
        self.mk("onyx-wins-long01/" + "d" * 30 + "/" + "f" * 30)
        self.mk("onyx-wins-short1/x")
        got = self.items(max_path=limit)
        self.assertEqual(got["onyx-wins-long01"].reason, "long-path")
        self.assertEqual(got["onyx-wins-short1"].reason, "")
        too_short = len(str(self.temp / "onyx-wins-short1")) - 1
        self.assertEqual(self.items(max_path=too_short)["onyx-wins-short1"].reason, "long-path")

    def test_the_real_limit_is_259_characters(self):
        self.assertEqual(lc.MAX_PATH_CHARS, 259)
        self.assertEqual(lc.RECENT_HOURS, 12)

    def _symlink(self, target, link):
        try:
            os.symlink(target, link, target_is_directory=True)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"cannot create a symlink here: {e}")

    def test_a_link_is_kept_and_links_inside_are_never_followed(self):
        outside = self.base / "real-checkout" / "node_modules"
        (outside / ".git").mkdir(parents=True)
        (outside / "big.bin").write_bytes(b"z" * 5000)
        os.utime(outside / "big.bin", (RECENT, RECENT))
        self._symlink(outside, self.temp / "onyx-wins-link01")
        self.mk("onyx-care-ui-hold01/package.json")
        self._symlink(outside, self.temp / "onyx-care-ui-hold01" / "node_modules")
        got = self.items()
        self.assertEqual(got["onyx-wins-link01"].reason, "link")
        held = got["onyx-care-ui-hold01"]
        self.assertEqual(held.reason, "")          # the target's .git and recent file are never seen
        self.assertEqual(held.links, 1)
        self.assertEqual(held.size, 10)            # the target's 5000 bytes are not counted

    def test_items_in_or_around_protected_folders_are_kept(self):
        self.mk("onyx-wins-prot01/x")
        self.mk("onyx-wins-free01/x")
        prot = self.protected + [str(self.temp / "onyx-wins-prot01" / "inside")]
        got = self.items(protected=prot)
        self.assertEqual(got["onyx-wins-prot01"].reason, "protected")
        self.assertEqual(got["onyx-wins-free01"].reason, "")

    def test_the_run_refuses_a_temp_folder_that_overlaps_a_protected_one(self):
        self.assertEqual(lc.check_root(str(self.temp), self.protected), "")
        self.assertNotEqual(lc.check_root(str(self.temp), [str(self.temp.parent)]), "")
        self.assertNotEqual(lc.check_root(str(self.temp), [str(self.temp / "sub")]), "")
        self.assertNotEqual(lc.check_root(str(Path.home()), []), "")
        self.assertNotEqual(lc.check_root(os.path.abspath(os.sep), []), "")
        self.assertNotEqual(lc.check_root(str(self.base / "missing"), []), "")

    def test_the_default_protected_folders(self):
        roots = [os.path.normcase(r) for r in lc.protected_roots()]
        home = Path.home()
        self.assertIn(os.path.normcase(str(home / ".codex")), roots)
        self.assertIn(os.path.normcase(str(home / ".claude" / "projects")), roots)
        self.assertTrue(any(r.endswith(os.path.normcase(os.sep + "Onyx")) for r in roots))

    def test_an_item_over_the_size_cap_is_kept(self):
        lc.MAX_ITEM_BYTES = 5
        self.mk("onyx-wins-huge01/x", b"y" * 10)
        self.assertEqual(self.items()["onyx-wins-huge01"].reason, "too-big")

    def test_run_limits_take_the_oldest_first(self):
        def it(path, newest, size=5):
            return lc.Item(path=path, category="test-temp", size=size, newest=newest)
        items = [it("young", 3), it("oldest", 1), it("middle", 2), it("kept", 0)]
        items[3].reason = "git"
        lc.apply_limits(items, max_items=2, max_bytes=10 ** 9)
        self.assertEqual({i.path: i.reason for i in items},
                         {"young": "run-limit", "oldest": "", "middle": "", "kept": "git"})
        items = [it("a", 1), it("b", 2), it("c", 3)]
        lc.apply_limits(items, max_items=100, max_bytes=7)
        self.assertEqual([i.reason for i in items], ["", "run-limit", "run-limit"])


class Modes(Base):
    def tree(self):
        self.session(U1)
        self.mk("onyx-wins-sel001/x")
        self.mk("onyx-wins-sel002/x")
        self.mk("onyx-wins-git001/.git/HEAD")
        self.mk(f"claude/p/{U1}/f.txt")

    def snapshot(self):
        return sorted(str(p) for p in self.base.rglob("*"))

    def test_dry_run_changes_nothing_and_reports_counts(self):
        self.tree()
        before = self.snapshot()
        lines = []
        rc = lc.run(str(self.temp), self.sessions, self.protected, NOW, apply=False, out=lines.append)
        self.assertEqual(rc, 0)
        self.assertEqual(self.snapshot(), before)
        text = "\n".join(lines)
        self.assertIn("DRY RUN", text)
        total = next(line for line in lines if line.strip().startswith("total"))
        self.assertEqual(total.split()[1], "2")
        self.assertIn("--apply", text)

    def test_apply_rechecks_each_item_and_recycles_only_unchanged_selected_ones(self):
        self.tree()
        items = lc.scan(str(self.temp), self.sessions, self.protected, NOW)
        lc.apply_limits(items, lc.DEFAULT_MAX_ITEMS, 10 ** 12)
        self.mk("onyx-wins-sel002/new.txt", mtime=RECENT)    # changed after the scan
        sent = []
        lc.recycle = lambda path: (sent.append(path), (True, ""))[1]
        log = self.base / "log" / "cleanup.log"
        res = lc.apply_items(items, self.sessions, self.protected, NOW, log=log)
        self.assertEqual([self.rel(p) for p in sent], ["onyx-wins-sel001"])
        self.assertEqual([(self.rel(i.path), why) for i, why in res.changed], [("onyx-wins-sel002", "recent")])
        self.assertEqual(res.failed, [])
        logged = log.read_text(encoding="utf-8")
        self.assertIn("recycled", logged)
        self.assertIn("changed since the scan", logged)

    def test_a_failed_recycle_is_reported_and_fails_the_run(self):
        self.tree()
        lc.recycle = lambda path: (False, "boom")
        lines = []
        rc = lc.run(str(self.temp), self.sessions, self.protected, NOW, apply=True, out=lines.append,
                    log=self.base / "cleanup.log")
        self.assertEqual(rc, 1)
        self.assertTrue(any("FAILED" in line and "boom" in line for line in lines))

    def test_dry_run_is_the_default_mode(self):
        seen = []
        lc.single_instance = lambda: True
        lc.temp_root = lambda: str(self.temp)
        lc.check_root = lambda root, protected: ""
        lc.run = lambda *a, **kw: seen.append(kw["apply"]) or 0
        self.assertEqual(lc.main([]), 0)
        self.assertEqual(lc.main(["--dry-run"]), 0)
        self.assertEqual(seen, [False, False])
        with self.assertRaises(SystemExit):
            lc.main(["--apply", "--dry-run"])

    def test_recycle_refuses_paths_it_cannot_take_safely(self):
        real = self._saved["recycle"]
        self.assertFalse(real("relative" + os.sep + "path")[0])
        self.assertFalse(real(os.path.abspath(os.sep) + "a" * 300)[0])
        self.assertTrue(lc.RECYCLE_FLAGS & lc.FOF_ALLOWUNDO)
        self.assertTrue(lc.RECYCLE_FLAGS & lc.FOF_WANTNUKEWARNING)
        self.assertEqual(lc.FO_DELETE, 3)

    def test_the_tool_has_no_permanent_delete_call(self):
        src = (ROOT / "tools" / "local_cleanup" / "local_cleanup.py").read_text(encoding="utf-8")
        for call in ("rmtree", "os.remove(", "os.unlink(", ".unlink(", "os.rmdir(", ".rmdir(", "Remove-Item",
                     "subprocess", "os.system"):
            self.assertNotIn(call, src)


if __name__ == "__main__":
    unittest.main()
