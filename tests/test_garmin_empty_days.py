"""Garmin empty days must not read as a healthy sync (roadmap row 2026-11-11).

When the watch is not worn, Garmin still returns a daily summary per day
(goals, profile BMR, stress -1/-2, sedentary 86400) and the ETL used to log
`success`, so /status stayed green through 40 empty days (2026-10-03 ->
2026-11-11). Now a run whose fetched days are ALL empty logs `partial` with
the reason, and `daily_summary_has_wearable_values` is the per-day rule.

The payload shapes below mirror the live rows (key names checked 2026-11-11;
values synthetic). No Garmin credentials, no network, no database: the
Garmin and Supabase clients are fakes, and missing third-party modules are
stubbed so this runs on a bare Python too.

Run: python tests/test_garmin_empty_days.py
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
import types
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for _name, _attrs in (("dotenv", {"load_dotenv": lambda *a, **k: None}),
                      ("garminconnect", {"Garmin": object}),
                      ("supabase", {"create_client": None, "Client": object})):
    if importlib.util.find_spec(_name) is None:
        sys.modules[_name] = types.SimpleNamespace(**_attrs)

for _key, _value in (("SUPABASE_URL", "https://stub.invalid"), ("SUPABASE_SERVICE_ROLE_KEY", "stub"),
                     ("GARMIN_EMAIL", "stub@example.invalid"), ("GARMIN_PASSWORD", "stub")):
    os.environ.setdefault(_key, _value)

import garmin_etl as g  # noqa: E402

logging.disable(logging.CRITICAL)  # the ETL logs every fake day; keep test output readable


def not_worn(ds: str) -> dict:
    """What Garmin returns for a day the watch was off (2026-10-04 onwards)."""
    return {"calendarDate": ds, "displayName": "x", "includesActivityData": False,
            "includesWellnessData": False, "includesCalorieConsumedData": False,
            "netRemainingKilocalories": 0, "privacyProtected": False, "source": "GARMIN",
            "userProfileId": 1, "totalSteps": None, "restingHeartRate": None,
            "maxHeartRate": None, "bodyBatteryHighestValue": None, "averageStressLevel": None}


def bmr_only(ds: str) -> dict:
    """An unworn day that still carries profile BMR and 'no data' stress (2026-10-03)."""
    return {**not_worn(ds), "includesWellnessData": True, "totalKilocalories": 2000.0,
            "bmrKilocalories": 2000.0, "sedentarySeconds": 86400, "activeSeconds": 0,
            "averageStressLevel": -1, "dailyStepGoal": 7500}


def worn(ds: str) -> dict:
    return {**bmr_only(ds), "includesActivityData": True, "totalSteps": 6400,
            "restingHeartRate": 52, "maxHeartRate": 140, "sedentarySeconds": 60000}


class FakeGarmin:
    def __init__(self, stats_by_date: dict, sleep_by_date: dict | None = None, activities=None):
        self.stats_by_date = stats_by_date
        self.sleep_by_date = sleep_by_date or {}
        self.activities = activities or []

    def get_stats(self, ds):
        return self.stats_by_date.get(ds)

    def get_sleep_data(self, ds):
        return self.sleep_by_date.get(ds, {"dailySleepDTO": {"id": None}})

    def get_heart_rates(self, ds):
        return {"restingHeartRate": None, "heartRateValues": None}

    def get_hrv_data(self, ds):
        return None

    def get_stress_data(self, ds):
        return {"overallStressLevel": -1}

    def get_training_readiness(self, ds):
        return []

    def get_activities_by_date(self, start, end):
        return self.activities


class FakeQuery:
    def __init__(self, sb, table):
        self.sb, self.table, self.payload = sb, table, None

    def upsert(self, rows, on_conflict=None):
        self.payload = rows
        self.sb.upserts.setdefault(self.table, []).extend(rows)
        return self

    def insert(self, row):
        self.payload = [row]
        self.sb.inserts.setdefault(self.table, []).append(row)
        return self

    def execute(self):
        return types.SimpleNamespace(data=self.payload or [])


class FakeSupabase:
    def __init__(self):
        self.upserts: dict[str, list] = {}
        self.inserts: dict[str, list] = {}

    def schema(self, _name):
        return self

    def table(self, name):
        return FakeQuery(self, name)

    def rpc(self, *_args, **_kwargs):
        return types.SimpleNamespace(execute=lambda: None)


def run_main(fake_garmin: FakeGarmin, days: int = 7) -> dict:
    """Run garmin_etl.main() end to end on fakes and return the full_sync heartbeat."""
    sb = FakeSupabase()
    with patch.object(g, "get_garmin_client", return_value=fake_garmin), \
         patch.object(g, "get_supabase_client", return_value=sb), \
         patch.object(g.time, "sleep", lambda *_: None), \
         patch("subprocess.run", lambda *a, **k: None), \
         patch.object(sys, "argv", ["garmin_etl.py", "--days", str(days)]):
        g.main()
    beats = [r for r in sb.inserts.get("sync_log", []) if r["data_type"] == "full_sync"]
    assert len(beats) == 1, beats
    return {**beats[0], "_summary_rows": len(sb.upserts.get("garmin_daily_summary", []))}


def window(days: int = 7) -> list[str]:
    today = g._et_local_today()
    return [(today - timedelta(days=days - i)).isoformat() for i in range(days + 1)]


class WearableRule(unittest.TestCase):
    def test_unworn_payloads_are_empty(self):
        for payload in (None, {}, not_worn("2026-11-10"), bmr_only("2026-10-03")):
            self.assertFalse(g.daily_summary_has_wearable_values(payload), payload)

    def test_zero_steps_alone_is_empty(self):
        self.assertFalse(g.daily_summary_has_wearable_values({**not_worn("d"), "totalSteps": 0}))

    def test_any_watch_signal_counts(self):
        self.assertTrue(g.daily_summary_has_wearable_values(worn("2026-10-02")))
        self.assertTrue(g.daily_summary_has_wearable_values({**not_worn("d"), "totalSteps": 12}))
        for field in g.WEARABLE_SUMMARY_FIELDS:
            self.assertTrue(g.daily_summary_has_wearable_values({**not_worn("d"), field: 50}), field)


class ClassifyRun(unittest.TestCase):
    days = [date(2026, 11, 4) + timedelta(days=i) for i in range(8)]

    def test_errors_win(self):
        status, message = g.classify_run(2, self.days, {"2026-11-05"}, 1, 1, 1)
        self.assertEqual(status, "failed")
        self.assertEqual(message, "2 sync error(s) across 8 day(s)")

    def test_all_empty_is_partial(self):
        status, message = g.classify_run(0, self.days, set(), 0, 0, 0)
        self.assertEqual(status, "partial")
        self.assertTrue(message.startswith("No wearable data in the 8 fetched day(s) (2026-11-04 to 2026-11-11)"), message)

    def test_any_evidence_is_success(self):
        for args in (({"2026-11-05"}, 0, 0, 0), (set(), 1, 0, 0), (set(), 0, 1, 0), (set(), 0, 0, 1)):
            self.assertEqual(g.classify_run(0, self.days, *args), ("success", None), args)


class MainHeartbeat(unittest.TestCase):
    def test_week_of_empty_days_logs_partial(self):
        stats = {ds: not_worn(ds) for ds in window()}
        beat = run_main(FakeGarmin(stats))
        self.assertEqual(beat["status"], "partial")
        self.assertTrue(beat["error_message"].startswith("No wearable data in the 8 fetched day(s)"))
        # Rows are still written (other consumers read them); only the heartbeat changes.
        self.assertEqual(beat["_summary_rows"], 8)

    def test_bmr_only_days_still_partial(self):
        stats = {ds: bmr_only(ds) for ds in window()}
        self.assertEqual(run_main(FakeGarmin(stats))["status"], "partial")

    def test_one_worn_day_logs_success(self):
        days = window()
        stats = {ds: not_worn(ds) for ds in days}
        stats[days[2]] = worn(days[2])
        beat = run_main(FakeGarmin(stats))
        self.assertEqual(beat["status"], "success")
        self.assertIsNone(beat["error_message"])

    def test_activity_only_logs_success(self):
        stats = {ds: not_worn(ds) for ds in window()}
        activity = {"activityId": 1, "startTimeGMT": "2026-11-10 12:00:00", "hasSplits": False}
        self.assertEqual(run_main(FakeGarmin(stats, activities=[activity]))["status"], "success")

    def test_failed_upsert_still_logs_failed(self):
        stats = {ds: worn(ds) for ds in window()}

        def boom(*_a, **_k):
            raise RuntimeError("constraint violation")

        with patch.object(g, "sync_stress", side_effect=boom):
            beat = run_main(FakeGarmin(stats))
        self.assertEqual(beat["status"], "failed")
        self.assertEqual(beat["error_message"], "8 sync error(s) across 8 day(s)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
