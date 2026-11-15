"""PC activity logger: active/idle split, hour bucketing, caps, program names, upload rows. Synthetic only.

Run: python tests/test_pc_activity_aggregation.py
"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "pc_activity_logger"))

import activity_logger as al  # noqa: E402

H = int(datetime(2026, 11, 14, 15, tzinfo=timezone.utc).timestamp())  # an hour start


def s(t, dt=30, idle=5, app="excel"):
    return {"t": t, "dt": dt, "idle": idle, "app": app}


class Aggregate(unittest.TestCase):
    def test_active_idle_split_and_program_time(self):
        hours, apps = al.aggregate([
            s(H + 30),                      # active, excel
            s(H + 60, app="CODE.EXE"),      # active, normalized to "code"
            s(H + 90, idle=200),            # no input for 200 s: idle
            s(H + 120, app="LockApp"),      # locked screen: idle even with recent input
            s(H + 150, app=None),           # input but no readable program: active, "unknown"
        ])
        self.assertEqual(hours, {H: {"active": 90, "idle": 60}})
        self.assertEqual(apps, {(H, "excel"): 30, (H, "code"): 30, (H, "unknown"): 30})

    def test_idle_threshold_boundary(self):
        hours, _ = al.aggregate([s(H + 30, idle=al.IDLE_THRESHOLD_S - 1), s(H + 60, idle=al.IDLE_THRESHOLD_S)])
        self.assertEqual(hours[H], {"active": 30, "idle": 30})

    def test_sample_never_reaches_back_into_the_previous_hour(self):
        hours, apps = al.aggregate([s(H + 3600 + 10, dt=30)])
        self.assertEqual(hours, {H + 3600: {"active": 10, "idle": 0}})
        self.assertEqual(apps, {(H + 3600, "excel"): 10})

    def test_gap_after_sleep_counts_at_most_the_cap(self):
        hours, _ = al.aggregate([s(H + 1000, dt=5 * 3600)])
        self.assertEqual(hours[H]["active"], al.MAX_CREDIT_S)

    def test_an_hour_never_holds_more_than_3600_seconds(self):
        # the same minute logged three times over (a clock jump, a second logger): capped, apps stay consistent
        samples = [s(H + 60 * (1 + i % 59), dt=60) for i in range(3 * 59)]
        hours, apps = al.aggregate(samples)
        self.assertEqual(hours[H]["active"] + hours[H]["idle"], 3600)
        self.assertEqual(sum(v for (h, _), v in apps.items() if h == H), hours[H]["active"])

    def test_bad_samples_are_skipped_or_idle(self):
        hours, apps = al.aggregate([
            {"t": "x", "dt": 30}, {"dt": 30}, {"t": H + 30, "dt": 0}, {"t": H + 30, "dt": -5},
            {"t": H + 30, "dt": 30, "idle": "abc", "app": "excel"},  # unreadable idle time: not active
        ])
        self.assertEqual(hours, {H: {"active": 0, "idle": 30}})
        self.assertEqual(apps, {})

    def test_samples_out_of_order_give_the_same_totals(self):
        samples = [s(H + 30), s(H + 60, idle=500), s(H + 90, app="chrome")]
        self.assertEqual(al.aggregate(samples), al.aggregate(list(reversed(samples))))

    def test_empty_input(self):
        self.assertEqual(al.aggregate([]), ({}, {}))


class ProgramNames(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(al.normalize_app(r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"), "excel")
        self.assertEqual(al.normalize_app("Code.exe"), "code")
        self.assertEqual(al.normalize_app("My App (x86).exe"), "my_app__x86")
        self.assertEqual(al.normalize_app("a" * 100 + ".exe"), "a" * 64)
        self.assertIsNone(al.normalize_app(""))
        self.assertIsNone(al.normalize_app(None))
        self.assertIsNone(al.normalize_app(".exe"))

    def test_screensaver_and_lock_are_never_active(self):
        self.assertFalse(al.is_active(1, "scrnsave.scr"))
        self.assertFalse(al.is_active(1, "logonui"))
        self.assertFalse(al.is_active(None, "excel"))
        self.assertTrue(al.is_active(1, "excel"))

    def test_device_name(self):
        self.assertEqual(al.safe_device("RILEY-PC"), "riley-pc")
        self.assertEqual(al.safe_device(""), "pc")


class UploadRows(unittest.TestCase):
    def test_rows(self):
        hours = {H: {"active": 90, "idle": 30}}
        apps = {(H, "excel"): 60, (H, "code"): 30, (H + 3600, "orphan"): 5, (H, "zero"): 0}
        hour_rows, app_rows = al.build_rows(hours, apps, "riley-pc", "2026-11-14T16:00:00+00:00")
        self.assertEqual(hour_rows, [{"device": "riley-pc", "hour_start": "2026-11-14T15:00:00+00:00",
                                      "active_seconds": 90, "idle_seconds": 30,
                                      "synced_at": "2026-11-14T16:00:00+00:00"}])
        self.assertEqual([(r["app"], r["active_seconds"]) for r in app_rows], [("code", 30), ("excel", 60)])
        self.assertTrue(all(r["hour_start"] == "2026-11-14T15:00:00+00:00" for r in app_rows))

    def test_parse_lines_skips_torn_and_foreign_lines(self):
        self.assertEqual(al.parse_lines(['{"t":1,"dt":30}', '{"t":2', "", "[1,2]", "null"]), [{"t": 1, "dt": 30}])

    def test_pending_days(self):
        days = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]
        self.assertEqual(al.pending_days(days, ["2026-11-12"], "2026-11-14"), ["2026-11-13", "2026-11-14"])

    def test_sample_credit(self):
        self.assertEqual(al.sample_credit(100.0, None), 0)
        self.assertEqual(al.sample_credit(100.0, 70.0), 30)
        self.assertEqual(al.sample_credit(100.0, 10.0), al.MAX_CREDIT_S)
        self.assertEqual(al.sample_credit(100.0, 150.0), 0)  # clock went back


class PrivacyGuards(unittest.TestCase):
    """The logger must never read window titles, keystrokes, URLs or the screen."""

    def test_no_title_keyboard_or_screen_apis(self):
        src = (ROOT / "tools" / "pc_activity_logger" / "activity_logger.py").read_text(encoding="utf-8")
        for api in ("GetWindowText", "SetWindowsHookEx", "GetAsyncKeyState", "GetKeyState", "GetKeyboardState",
                    "GetClipboardData", "BitBlt", "PrintWindow", "UIAutomation", "pynput", "ImageGrab"):
            self.assertNotIn(api, src, api)

    def test_schema_has_no_destructive_statement(self):
        # The Supabase MCP connector declines a migration whose text contains the word at all.
        sql = (ROOT / "sql" / "pc_activity_schema.sql").read_text(encoding="utf-8").lower()
        self.assertNotIn("drop", sql)


if __name__ == "__main__":
    unittest.main()
