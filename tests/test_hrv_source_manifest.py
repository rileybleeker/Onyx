"""Tests for the HRV input manifest and the retrain decision (audit PIPE-09).

hrv_feature_sources.py is the one list of HRV inputs and how a correction to each is seen
(row scans, the habit_journal trigger signal, content fingerprints from
pds.hrv_source_fingerprint). hrv_backfill_check.py decides from it whether to retrain, and a
check that cannot be made must be UNKNOWN (partial GUARD heartbeat, precautionary retrain),
never "no backfill". hrv_predict.py rescores stored actuals that no longer match the matrix.

Everything runs against an in-memory stand-in for the Supabase client with synthetic rows; the
stand-in computes fingerprints from its own rows, so a deleted or edited row changes them the way
the SQL function does. No credentials, no network.
Run: python tests/test_hrv_source_manifest.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import pandas as pd  # noqa: E402

PRIVATE = "do-not-leak-7731"  # appears in every simulated error text; must never reach a message


class ApiError(Exception):
    def __init__(self, code: str):
        super().__init__(f"{code}: row value {PRIVATE}")
        self.code = code


class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db: "FakeDb", table: str):
        self.db, self.table = db, table
        self.filters: list = []
        self._order = None
        self._limit = None
        self._range = None
        self._upsert = None

    def select(self, *_a, **_k):
        return self

    def _f(self, col, fn):
        self.filters.append((col, fn))
        return self

    def eq(self, col, val):
        return self._f(col, lambda v, x=val: v == x)

    def gt(self, col, val):
        return self._f(col, lambda v, x=val: v is not None and str(v) > str(x))

    def lt(self, col, val):
        return self._f(col, lambda v, x=val: v is not None and str(v) < str(x))

    def gte(self, col, val):
        return self._f(col, lambda v, x=val: v is not None and str(v) >= str(x))

    def lte(self, col, val):
        return self._f(col, lambda v, x=val: v is not None and str(v) <= str(x))

    def is_(self, col, _val):
        return self._f(col, lambda v: v is None)

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, a, b):
        self._range = (a, b)
        return self

    def upsert(self, rows, on_conflict=""):
        self._upsert = (rows if isinstance(rows, list) else [rows], on_conflict)
        return self

    def execute(self):
        if self.table in self.db.fail:
            raise ApiError(self.db.fail[self.table])
        if self._upsert is not None:
            rows, on_conflict = self._upsert
            self.db.upserts.append((self.table, rows))
            keys = tuple(on_conflict.split(","))
            table = self.db.tables.setdefault(self.table, [])
            for r in rows:
                hit = next((t for t in table if all(t.get(k) == r.get(k) for k in keys)), None)
                if hit is None:
                    table.append(dict(r))
                else:
                    hit.update(r)  # merge-duplicates: unsent columns keep their values
            return _Resp(rows)
        out = [r for r in self.db.tables.get(self.table, []) if all(f(r.get(c)) for c, f in self.filters)]
        if self._order:
            col, desc = self._order
            out = sorted(out, key=lambda r: str(r.get(col)), reverse=desc)
        if self._range:
            a, b = self._range
            out = out[a:b + 1]
        if self._limit is not None:
            out = out[: self._limit]
        return _Resp([dict(r) for r in out])


class _Rpc:
    def __init__(self, db, name, params):
        self.db, self.name, self.params = db, name, params

    def execute(self):
        self.db.rpc_calls.append((self.name, dict(self.params)))
        if self.db.rpc_missing:
            raise ApiError("PGRST202")
        rel = self.params["p_relation"]
        if rel in self.db.missing_relations:
            raise ApiError("42P01")
        if rel in self.db.fail_fp:
            raise ApiError(self.db.fail_fp[rel])
        excl = set(self.params.get("p_exclude") or [])
        before = str(self.params["p_before"])
        if self.params.get("p_date_col") is not None:
            rows = [r for r in self.db.tables.get(rel, [])
                    if str(r.get(self.params["p_date_col"])) < before]
        else:  # rows linked to a historical parent row (the SQL function's link form)
            keys = {p.get(self.params["p_parent_key"]) for p in self.db.tables.get(self.params["p_parent_relation"], [])
                    if str(p.get(self.params["p_parent_date_col"])) < before}
            rows = [r for r in self.db.tables.get(rel, []) if r.get(self.params["p_link_col"]) in keys]
        hashes = sorted(hashlib.md5(json.dumps({k: v for k, v in sorted(r.items()) if k not in excl
                                                and not k.startswith("raw_")}, default=str).encode()).hexdigest()
                        for r in rows)
        return _Resp([{"row_count": len(rows), "fingerprint": hashlib.md5("".join(hashes).encode()).hexdigest()}])


class FakeDb:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.upserts: list = []
        self.rpc_calls: list = []
        self.fail: dict[str, str] = {}      # table -> error code raised on any read/write
        self.fail_fp: dict[str, str] = {}   # relation -> error code raised by the fingerprint
        self.missing_relations: set[str] = set()  # the fingerprint answers 42P01 for these
        self.rpc_missing = False

    def schema(self, _name):
        return self

    def from_(self, table):
        return _Query(self, table)

    table = from_

    def rpc(self, name, params):
        return _Rpc(self, name, params)


_stub = types.ModuleType("supabase")
_stub.create_client = lambda *_a, **_k: FakeDb()
sys.modules.setdefault("supabase", _stub)
try:
    import dotenv  # noqa: F401
except ImportError:
    _dotenv = types.ModuleType("dotenv")
    _dotenv.load_dotenv = lambda *a, **k: None
    sys.modules["dotenv"] = _dotenv

import hrv_feature_sources as fs  # noqa: E402

TODAY = date(2026, 11, 20)
LAST = "2026-11-19T12:00:00+00:00"          # last retrain stored its results
CAPTURED = "2026-11-19T11:40:00+00:00"      # ... after reading its data from here
OLD = "2026-11-01"                          # a historical day for every source
SMALL = (
    fs.FeatureSource(
        name="matrix", feeds="test",
        scans=(fs.RowScan("cronometer_nutrition_daily", "calendar_date", "synced_at", "insert"),),
        fingerprint=fs.Fingerprint("daily_health_matrix_behavioral", "calendar_date"),
    ),
    fs.FeatureSource(
        name="habit_journal", feeds="test",
        scans=(fs.RowScan("habit_journal", "cycle_date", "synced_at", "insert"),),
        signal=("habit_journal", "backfill_signal"),
        fingerprint=fs.Fingerprint("habit_journal", "cycle_date"),
    ),
    fs.FeatureSource(
        name="weather_daily", feeds="test", settle_days=11,
        scans=(fs.RowScan("weather_daily", "calendar_date", "synced_at", "change"),),
        fingerprint=fs.Fingerprint("weather_daily", "calendar_date"),
    ),
)


def seeded_db() -> FakeDb:
    db = FakeDb()
    db.tables["daily_health_matrix_behavioral"] = [
        {"calendar_date": "2026-10-30", "whoop_hrv_rmssd": 61.0, "nutrition_calories": 2100},
        {"calendar_date": OLD, "whoop_hrv_rmssd": 58.5, "nutrition_calories": 2400},
        {"calendar_date": "2026-11-19", "whoop_hrv_rmssd": None, "nutrition_calories": 900},
    ]
    db.tables["cronometer_nutrition_daily"] = [{"calendar_date": OLD, "synced_at": "2026-11-02T03:00:00+00:00"}]
    db.tables["habit_journal"] = [
        {"cycle_date": OLD, "question": "Synthetic question A?", "answer": "Yes", "synced_at": "2026-11-02T00:00:00+00:00"},
        {"cycle_date": "2026-10-31", "question": "Synthetic question B?", "answer": "No", "synced_at": "2026-11-01T00:00:00+00:00"},
    ]
    db.tables["weather_daily"] = [
        {"calendar_date": "2026-10-20", "temperature_max": 21.0, "synced_at": "2026-10-21T00:00:00+00:00"},
        # inside the 11-day settle window: restamped by every run, never history
        {"calendar_date": "2026-11-15", "temperature_max": 18.0, "synced_at": "2026-11-19T21:00:00+00:00"},
    ]
    db.tables["sync_log"] = []
    return db


def baseline_for(db: FakeDb, sources=SMALL, captured_at=CAPTURED) -> dict:
    snap = fs.capture(db, TODAY, now=datetime.fromisoformat(captured_at), sources=sources)
    db.rpc_calls.clear()
    return snap


def run(db, baseline, sources=SMALL, last=LAST, baseline_at=LAST, baseline_error=None):
    return fs.detect(db, TODAY, last, baseline, baseline_at, baseline_error, sources=sources)


class ManifestCoverage(unittest.TestCase):
    def test_every_relation_hrv_analysis_reads_is_watched_or_explained(self):
        text = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
        read = set(re.findall(r'fetch(?:_all)?\(\s*"([a-z_0-9]+)"', text))
        read |= {m for m in re.findall(r'SUPPLEMENT_ROLLUP_(?:MAT|VIEW) = "([a-z_0-9]+)"', text)}
        self.assertIn("daily_health_matrix_behavioral", read)  # the scan of the source text works
        missing = sorted(r for r in read if not fs.covers(r))
        self.assertEqual(missing, [], "add these to hrv_feature_sources.SOURCES or UNWATCHED")

    def test_newer_inputs_are_registered(self):
        names = {s.name for s in fs.SOURCES}
        rels = fs.watched_relations()
        for rel in ("supplement_intake", "supplement_intake_by_compound", "supplement_intake_by_compound_mat",
                    "supplement_products", "garmin_activity_laps", "delivery_daily",
                    "phone_usage_daily", "weather_daily", "air_quality_daily", "whoop_workouts",
                    "garmin_activities", "daily_health_matrix_behavioral", "habit_journal",
                    "cronometer_nutrition_daily"):
            self.assertIn(rel, rels)
        self.assertIn("habit_journal", names)
        self.assertEqual(len(names), len(fs.SOURCES), "source names must be unique (baseline keys)")

    def test_every_source_has_a_way_to_see_deletions(self):
        for src in fs.SOURCES:
            self.assertTrue(src.fingerprint or src.signal, f"{src.name}: no deletion signal")
            for scan in src.scans:
                self.assertIn(scan.moves_on, ("change", "insert"))

    def test_rolling_window_etls_settle_past_their_window(self):
        by = {s.name: s for s in fs.SOURCES}
        self.assertGreater(by["weather_daily"].settle_days, 10)      # re-upserts 10 days
        self.assertGreater(by["air_quality_daily"].settle_days, 7)   # re-upserts 7 days

    def test_sql_function_is_service_role_only_and_never_drops(self):
        sql = (ROOT / "sql" / "hrv_source_fingerprint.sql").read_text(encoding="utf-8")
        self.assertNotRegex(sql.upper(), r"\bDROP\b")
        self.assertIn("SECURITY INVOKER", sql)
        self.assertIn("FROM anon, authenticated", sql)
        self.assertIn("TO service_role", sql)
        self.assertNotRegex(sql, r"GRANT[^;]*TO[^;]*\banon\b")


class Detection(unittest.TestCase):
    def test_nothing_changed_means_no_retrain_and_success(self):
        db = seeded_db()
        base = baseline_for(db)
        d = fs.decide(run(db, base), 20.0)
        self.assertFalse(d.retrain, d.reason)
        self.assertEqual((d.status, d.message), ("success", None))

    def test_rows_inside_the_settle_window_are_not_history(self):
        db = seeded_db()
        base = baseline_for(db)
        # weather_etl restamps the last 10 days every run: not a correction
        db.tables["weather_daily"][1]["temperature_max"] = 17.5
        db.tables["weather_daily"][1]["synced_at"] = "2026-11-20T00:00:00+00:00"
        self.assertFalse(fs.decide(run(db, base), 20.0).retrain)

    def test_backdated_insert_is_seen_by_its_row_scan(self):
        db = seeded_db()
        base = baseline_for(db)
        db.tables["cronometer_nutrition_daily"].append({"calendar_date": "2026-10-10", "synced_at": "2026-11-19T15:00:00+00:00"})
        det = run(db, base)
        self.assertIn("matrix/rows:cronometer_nutrition_daily", det.changed)
        self.assertTrue(fs.decide(det, 1.0).retrain)

    def test_change_written_while_the_last_retrain_ran_is_not_missed(self):
        db = seeded_db()
        base = baseline_for(db)
        # after the retrain read its data (11:40) but before it stored results (12:00)
        db.tables["cronometer_nutrition_daily"].append({"calendar_date": "2026-10-11", "synced_at": "2026-11-19T11:50:00+00:00"})
        self.assertIn("matrix/rows:cronometer_nutrition_daily", run(db, base).changed)

    def test_deletion_is_seen_by_the_fingerprint(self):
        db = seeded_db()
        base = baseline_for(db)
        db.tables["habit_journal"] = [r for r in db.tables["habit_journal"] if r["cycle_date"] != "2026-10-31"]
        det = run(db, base)
        self.assertIn("habit_journal/fingerprint", det.changed)
        self.assertTrue(fs.decide(det, 1.0).retrain)

    def test_edit_without_a_moving_timestamp_is_seen_by_the_fingerprint(self):
        db = seeded_db()
        base = baseline_for(db)
        db.tables["daily_health_matrix_behavioral"][1]["nutrition_calories"] = 2450  # synced_at untouched
        self.assertIn("matrix/fingerprint", run(db, base).changed)

    def test_restamped_identical_rows_do_not_change_the_fingerprint(self):
        db = seeded_db()
        base = baseline_for(db)
        db.tables["habit_journal"][0]["synced_at"] = "2026-11-19T10:00:00+00:00"  # before captured_at
        self.assertNotIn("habit_journal/fingerprint", run(db, base).changed)

    def test_trigger_signal_counts(self):
        db = seeded_db()
        base = baseline_for(db)
        db.tables["sync_log"].append({"source": "habit_journal", "data_type": "backfill_signal",
                                      "sync_start": "2026-11-19T18:00:00+00:00", "date_range_start": "2026-10-02"})
        self.assertIn("habit_journal/signal", run(db, base).changed)

    def test_fingerprint_uses_the_baselines_own_cutoff(self):
        db = seeded_db()
        base = baseline_for(db)
        later = TODAY + timedelta(days=3)  # a day crossed into history since: not a change by itself
        det = fs.detect(db, later, LAST, base, LAST, None, sources=SMALL)
        self.assertEqual([c for c in det.changed if c.endswith("/fingerprint")], [])
        befores = {p["p_relation"]: p["p_before"] for _, p in db.rpc_calls}
        self.assertEqual(befores["habit_journal"], base["sources"]["habit_journal"]["before"])


class UnknownIsNotNoChange(unittest.TestCase):
    def test_failed_scan_is_unknown_with_a_guard_message_and_no_private_text(self):
        db = seeded_db()
        base = baseline_for(db)
        db.fail["habit_journal"] = "57014"
        det = run(db, base)
        self.assertIn("habit_journal/rows:habit_journal:57014", det.unknown)
        d = fs.decide(det, 5.0)
        self.assertTrue(d.retrain)
        self.assertEqual(d.status, "partial")
        self.assertTrue(d.message.startswith("GUARD hrv_backfill_detection:"))
        self.assertNotIn(PRIVATE, d.message + d.reason)

    def test_unknown_retrain_is_bounded_by_the_last_retrain_age(self):
        db = seeded_db()
        base = baseline_for(db)
        db.fail_fp["weather_daily"] = "XX000"
        det = run(db, base)
        self.assertIn("weather_daily/fingerprint:XX000", det.unknown)
        self.assertFalse(fs.decide(det, 1.0).retrain)                      # retried next hour
        self.assertTrue(fs.decide(det, fs.UNKNOWN_RETRAIN_AFTER_HOURS).retrain)
        self.assertTrue(fs.decide(det, None).retrain)                      # age unknown too
        self.assertEqual(fs.decide(det, 1.0).status, "partial")            # visible either way

    def test_a_change_retrains_even_when_another_check_failed(self):
        db = seeded_db()
        base = baseline_for(db)
        db.fail["weather_daily"] = "57014"
        db.tables["habit_journal"].pop()
        d = fs.decide(run(db, base), 0.5)
        self.assertTrue(d.retrain)
        self.assertEqual(d.status, "partial")

    def test_missing_function_falls_back_to_scans_and_says_so(self):
        db = seeded_db()
        base = baseline_for(db)
        db.rpc_missing = True
        det = run(db, base)
        self.assertFalse(det.fingerprint_installed)
        self.assertEqual(len(db.rpc_calls), 1, "stop calling once the function is known missing")
        d = fs.decide(det, 20.0)
        self.assertFalse(d.retrain)
        self.assertEqual(d.status, "partial")
        self.assertIn("hrv_source_fingerprint", d.message)

    def test_first_run_with_the_function_retrains_once_to_record_a_baseline(self):
        db = seeded_db()
        det = run(db, None, baseline_at=None)
        self.assertTrue(det.no_baseline)
        self.assertTrue(fs.decide(det, 1.0).retrain)

    def test_never_installed_and_no_baseline_does_not_loop(self):
        db = seeded_db()
        db.rpc_missing = True
        d = fs.decide(run(db, None, baseline_at=None), 1.0)
        self.assertFalse(d.retrain)

    def test_stale_baseline_is_unknown(self):
        db = seeded_db()
        base = baseline_for(db)
        det = run(db, base, baseline_at="2026-11-17T12:00:00+00:00")  # an older retrain's
        self.assertIn("lineage/baseline:stale", det.unknown)
        self.assertEqual([c for c in db.rpc_calls], [], "a stale baseline is not compared")

    def test_unreadable_baseline_is_unknown(self):
        db = seeded_db()
        det = run(db, None, baseline_at=None, baseline_error="PGRST301")
        self.assertIn("lineage/baseline:PGRST301", det.unknown)

    def test_source_that_failed_at_capture_is_unknown_not_unchanged(self):
        db = seeded_db()
        db.fail_fp["habit_journal"] = "57014"
        base = baseline_for(db)
        self.assertEqual(base["sources"]["habit_journal"], {"before": "2026-11-18", "error": "57014"})
        db.fail_fp.clear()
        self.assertIn("habit_journal/fingerprint:baseline_57014", run(db, base).unknown)

    def test_new_source_without_a_baseline_entry_counts_as_changed(self):
        db = seeded_db()
        base = baseline_for(db, sources=SMALL[:2])
        self.assertIn("weather_daily/fingerprint:new_source", run(db, base).changed)


LINKED = (
    fs.FeatureSource(
        name="garmin_activity_laps", feeds="test",
        fingerprint=fs.Fingerprint("garmin_activity_laps", None,
                                   link=fs.Link("activity_id", "garmin_activities", "activity_id",
                                                "onyx_behavioral_date")),
    ),
    fs.FeatureSource(
        name="supplement_products", feeds="test",
        fingerprint=fs.Fingerprint("supplement_products", None, exclude=("fetched_at", "is_active"),
                                   link=fs.Link("product_id", "supplement_intake", "product_id", "intake_date")),
    ),
    fs.FeatureSource(
        name="supplement_rollup", feeds="test",
        fingerprint=fs.Fingerprint("supplement_intake_by_compound", "calendar_date",
                                   prefer=("supplement_intake_by_compound_mat",)),
    ),
)


def linked_db() -> FakeDb:
    db = FakeDb()
    db.tables["garmin_activities"] = [
        {"activity_id": 1, "onyx_behavioral_date": OLD},
        {"activity_id": 2, "onyx_behavioral_date": "2026-11-19"},   # inside the settle window
    ]
    db.tables["garmin_activity_laps"] = [
        {"activity_id": 1, "lap_index": 0, "avg_heart_rate": 150, "synced_at": "2026-11-02T00:00:00+00:00"},
        {"activity_id": 2, "lap_index": 0, "avg_heart_rate": 160, "synced_at": "2026-11-19T20:00:00+00:00"},
    ]
    db.tables["supplement_intake"] = [
        {"intake_id": 1, "intake_date": OLD, "product_id": "p-old", "doses": 1},
        {"intake_id": 2, "intake_date": "2026-11-19", "product_id": "p-new", "doses": 1},
    ]
    db.tables["supplement_products"] = [
        {"product_id": "p-old", "ingredients": [{"name": "Synthetic A", "quantity": None}],
         "is_active": True, "fetched_at": "2026-10-01T00:00:00+00:00"},
        {"product_id": "p-new", "ingredients": [{"name": "Synthetic B", "quantity": 5}],
         "is_active": True, "fetched_at": "2026-11-19T00:00:00+00:00"},
    ]
    db.tables["supplement_intake_by_compound"] = [{"calendar_date": OLD, "ingredient_group": "A", "total_amount": 5}]
    db.tables["supplement_intake_by_compound_mat"] = [{"calendar_date": OLD, "ingredient_group": "A", "total_amount": 5}]
    db.tables["sync_log"] = []
    return db


class LinkedAndPreferred(unittest.TestCase):
    def setUp(self):
        self.db = linked_db()
        self.base = baseline_for(self.db, sources=LINKED)

    def detect(self):
        return run(self.db, self.base, sources=LINKED)

    def test_untouched_linked_sources_are_unchanged(self):
        det = self.detect()
        self.assertEqual((det.changed, det.unknown), ([], []))

    def test_backfilled_lap_of_a_historical_activity_is_seen(self):
        self.db.tables["garmin_activity_laps"].append(
            {"activity_id": 1, "lap_index": 1, "avg_heart_rate": 155, "synced_at": "2026-11-19T22:00:00+00:00"})
        self.assertIn("garmin_activity_laps/fingerprint", self.detect().changed)

    def test_lap_of_a_recent_activity_is_not_history(self):
        self.db.tables["garmin_activity_laps"][1]["avg_heart_rate"] = 170
        self.assertEqual(self.detect().changed, [])

    def test_unquantified_ingredient_edit_on_a_past_product_is_seen(self):
        self.db.tables["supplement_products"][0]["ingredients"] = [{"name": "Synthetic A", "quantity": 3}]
        self.assertIn("supplement_products/fingerprint", self.detect().changed)

    def test_archiving_or_refetching_a_product_or_a_new_product_changes_nothing(self):
        self.db.tables["supplement_products"][0]["is_active"] = False
        self.db.tables["supplement_products"][0]["fetched_at"] = "2026-11-19T23:00:00+00:00"
        self.db.tables["supplement_products"][1]["ingredients"] = []
        self.db.tables["supplement_products"].append({"product_id": "p-unused", "ingredients": []})
        self.assertEqual(self.detect().changed, [])

    def test_the_rollup_fingerprint_reads_the_matview_the_pipeline_loads(self):
        # A correction in the live view that the matview has not picked up yet is not trained yet:
        # the baseline must not count it as consumed.
        self.db.tables["supplement_intake_by_compound"][0]["total_amount"] = 9
        self.assertEqual(self.detect().changed, [])
        self.db.tables["supplement_intake_by_compound_mat"][0]["total_amount"] = 9   # refreshed
        self.assertIn("supplement_rollup/fingerprint", self.detect().changed)
        relations = [p["p_relation"] for _, p in self.db.rpc_calls]
        self.assertNotIn("supplement_intake_by_compound", relations)

    def test_rollup_falls_back_to_the_live_view_when_the_matview_is_missing(self):
        db = linked_db()
        db.missing_relations.add("supplement_intake_by_compound_mat")
        base = baseline_for(db, sources=LINKED)
        self.assertNotIn("error", base["sources"]["supplement_rollup"])
        db.tables["supplement_intake_by_compound"][0]["total_amount"] = 9
        det = run(db, base, sources=LINKED)
        self.assertIn("supplement_rollup/fingerprint", det.changed)
        self.assertEqual(det.unknown, [])

    def test_link_arguments_are_sent_only_for_linked_sources(self):
        self.db.rpc_calls.clear()
        self.detect()
        params = {p["p_relation"]: p for _, p in self.db.rpc_calls}
        self.assertIsNone(params["garmin_activity_laps"]["p_date_col"])
        self.assertEqual(params["garmin_activity_laps"]["p_parent_relation"], "garmin_activities")
        self.assertNotIn("p_parent_relation", params["supplement_intake_by_compound_mat"])


class Lineage(unittest.TestCase):
    def test_capture_returns_none_when_the_function_is_missing(self):
        db = seeded_db()
        db.rpc_missing = True
        self.assertIsNone(fs.capture(db, TODAY, sources=SMALL))

    def test_capture_sends_exclusions_and_stores_no_rows(self):
        db = seeded_db()
        snap = fs.capture(db, TODAY, sources=fs.SOURCES)
        self.assertEqual(snap["version"], fs.LINEAGE_VERSION)
        journal = next(p for _, p in db.rpc_calls if p["p_relation"] == "journal_entries")
        self.assertIn("synced_at", journal["p_exclude"])
        self.assertIn("content_md", journal["p_exclude"])
        for entry in snap["sources"].values():
            self.assertLessEqual(set(entry), {"before", "row_count", "fingerprint", "error"})

    def test_baseline_round_trip(self):
        db = seeded_db()
        snap = fs.capture(db, TODAY, sources=SMALL)
        self.assertTrue(fs.store_baseline(db, snap, "h" * 64))
        self.assertEqual(db.tables["hrv_analysis_results"][0]["input_data_hash"], "h" * 64)
        got, at, err = fs.read_baseline(db)
        self.assertEqual((got, err), (snap, None))
        self.assertIsNotNone(at)
        self.assertFalse(fs.store_baseline(db, None))

    def test_store_failure_is_reported_not_raised(self):
        db = seeded_db()
        db.fail["hrv_analysis_results"] = "PGRST000"
        self.assertFalse(fs.store_baseline(db, {"version": 1, "sources": {}}))
        self.assertEqual(fs.read_baseline(db)[2], "PGRST000")


class BackfillCheckMain(unittest.TestCase):
    def setUp(self):
        import hrv_backfill_check as bfc
        self.bfc = bfc
        self.db = seeded_db()
        self.db.tables["hrv_analysis_results"] = [{"result_type": "x", "result_key": "y",
                                                   "computed_at": datetime.now(timezone.utc).isoformat()}]
        self._supa, self._log, self._today = bfc.supa, bfc.log_sync, bfc.et_today
        bfc.supa = self.db
        bfc.et_today = lambda: TODAY
        self.beats = []

        def fake_log_sync(_supa, **kw):
            self.beats.append(kw)
            self.db.tables["sync_log"].append({"source": kw["source"], "data_type": kw["data_type"],
                                               "status": kw["status"], "error_message": kw["error"],
                                               "sync_start": datetime.now(timezone.utc).isoformat()})
        bfc.log_sync = fake_log_sync
        self.out = tempfile.NamedTemporaryFile("w+", delete=False, suffix=".txt")
        self.out.close()
        os.environ["GITHUB_OUTPUT"] = self.out.name
        self._sources = bfc.sources.SOURCES   # bfc.sources is fs: save before patching
        bfc.sources.SOURCES = SMALL

    def tearDown(self):
        self.bfc.supa, self.bfc.log_sync, self.bfc.et_today = self._supa, self._log, self._today
        self.bfc.sources.SOURCES = self._sources
        os.environ.pop("GITHUB_OUTPUT", None)
        os.unlink(self.out.name)

    def output(self) -> str:
        return Path(self.out.name).read_text().strip().splitlines()[-1]

    def test_unreadable_last_analysis_retrains_with_a_guard_heartbeat(self):
        self.db.fail["hrv_analysis_results"] = "PGRST000"
        self.assertEqual(self.bfc.main(), 0)
        self.assertEqual(self.output(), "backfill_detected=true")
        self.assertEqual(self.beats[-1]["status"], "partial")
        self.assertTrue(self.beats[-1]["error"].startswith("GUARD hrv_backfill_detection:"))
        self.assertNotIn(PRIVATE, self.beats[-1]["error"])

    def test_partial_repeats_are_deduplicated_and_recovery_writes_one_success(self):
        fs.SOURCES  # noqa: B018 - the patched list is read through bfc.sources
        self.db.fail["weather_daily"] = "57014"
        self.bfc.main()
        self.bfc.main()
        self.assertEqual([b["status"] for b in self.beats], ["partial"])
        self.db.fail.clear()
        self.bfc.main()
        self.bfc.main()
        self.assertEqual([b["status"] for b in self.beats], ["partial", "success"])

    def test_clean_run_writes_no_heartbeat(self):
        snap = fs.capture(self.db, TODAY, sources=SMALL)
        fs.store_baseline(self.db, snap)
        self.bfc.main()
        self.assertEqual(self.output(), "backfill_detected=false")
        self.assertEqual(self.beats, [])


class RescoreActuals(unittest.TestCase):
    def setUp(self):
        import hrv_predict as hp
        self.hp = hp
        self.today = "2026-11-20"
        self.window = "2026-10-16"

    def preds(self, rows):
        return pd.DataFrame(rows)

    def row(self, d, actual, pred=70.0, residual="auto", model="xgboost", version=None):
        return {"prediction_date": d, "model": model, "horizon_days": 1,
                "model_version": version or f"{d}_v1", "predicted_hrv": pred, "actual_hrv": actual,
                "residual": (None if actual is None else actual - pred) if residual == "auto" else residual}

    def test_fill_rescore_clear_and_leave_alone(self):
        rows = [
            self.row("2026-11-10", None),                    # fill
            self.row("2026-11-11", 60.0),                    # WHOOP rescored -> 62.0
            self.row("2026-11-12", 55.0),                    # source now has no HRV that night
            self.row("2026-11-13", 50.0),                    # matrix has no row: not judged
            self.row("2026-11-14", 61.0),                    # same value: nothing to do
            self.row("2026-09-01", 40.0),                    # outside the window: left as it is
            self.row("2026-11-20", None),                    # today: not observable yet
        ]
        matrix = {"2026-11-10": 64.0, "2026-11-11": 62.0, "2026-11-12": None,
                  "2026-11-14": 61.00004, "2026-09-01": 45.0, "2026-11-20": 66.0}
        updates, counts = self.hp.plan_actual_updates(self.preds(rows), matrix, self.today, self.window)
        self.assertEqual(counts, {"filled": 1, "rescored": 1, "cleared": 1})
        by = {u["prediction_date"]: u for u in updates}
        self.assertEqual(set(by), {"2026-11-10", "2026-11-11", "2026-11-12"})
        self.assertEqual((by["2026-11-11"]["actual_hrv"], by["2026-11-11"]["residual"]), (62.0, -8.0))
        self.assertEqual((by["2026-11-12"]["actual_hrv"], by["2026-11-12"]["residual"]), (None, None))
        for u in updates:  # the issued forecast is never part of a write
            self.assertEqual(set(u), {"prediction_date", "model", "horizon_days", "model_version",
                                      "actual_hrv", "residual"})

    def test_recent_night_without_hrv_keeps_its_actual_for_now(self):
        rows = [self.row("2026-11-18", 55.0), self.row("2026-11-17", 54.0)]
        updates, counts = self.hp.plan_actual_updates(
            self.preds(rows), {"2026-11-18": None, "2026-11-17": None}, self.today, self.window)
        self.assertEqual(counts["cleared"], 1)
        self.assertEqual([u["prediction_date"] for u in updates], ["2026-11-17"])

    def test_inconsistent_residual_alone_is_rescored(self):
        rows = [self.row("2026-11-11", 60.0, residual=99.0)]
        updates, counts = self.hp.plan_actual_updates(self.preds(rows), {"2026-11-11": 60.0}, self.today, self.window)
        self.assertEqual(counts["rescored"], 1)
        self.assertEqual(updates[0]["residual"], -10.0)

    def test_duplicate_rows_from_both_reads_write_once(self):
        r = self.row("2026-11-11", None)
        updates, _ = self.hp.plan_actual_updates(self.preds([r, dict(r)]), {"2026-11-11": 61.0}, self.today, self.window)
        self.assertEqual(len(updates), 1)

    def test_backfill_actuals_is_idempotent_and_keeps_the_issued_forecast(self):
        hp = self.hp
        db = FakeDb()
        issued = {"prediction_date": "2026-11-11", "model": "xgboost", "horizon_days": 1,
                  "model_version": "2026-11-11_v1", "predicted_hrv": 70.0, "prediction_lower": 50.0,
                  "prediction_upper": 90.0, "actual_hrv": 60.0, "residual": -10.0,
                  "created_at": "2026-11-11T15:00:00+00:00", "model_artifact_sha256": "a" * 64}
        db.tables["hrv_predictions"] = [dict(issued)]
        db.tables["daily_health_matrix_behavioral"] = [{"calendar_date": "2026-11-11", "whoop_hrv_rmssd": 63.5}]
        saved_supa, saved_today = hp.supa, hp.et_today
        hp.supa, hp.et_today = db, (lambda: date(2026, 11, 20))
        try:
            self.assertEqual(hp.backfill_actuals(), 1)
            self.assertEqual(hp.backfill_actuals(), 0, "a second run writes nothing")
        finally:
            hp.supa, hp.et_today = saved_supa, saved_today
        row = db.tables["hrv_predictions"][0]
        self.assertEqual((row["actual_hrv"], row["residual"]), (63.5, -6.5))
        for k in ("predicted_hrv", "prediction_lower", "prediction_upper", "created_at",
                  "model_version", "model_artifact_sha256"):
            self.assertEqual(row[k], issued[k])


if __name__ == "__main__":
    unittest.main(verbosity=2)
