"""sync_log_helper.log_sync: ordinary heartbeat row, and a failed insert logged as a category code only.

Offline: a fake Supabase client. The "upstream" error text is a synthetic sentinel standing in for a
PostgREST error that echoes the failing row.

Run: python tests/test_sync_log_helper.py
"""
import io
import logging
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sync_log_helper as h  # noqa: E402

SENTINEL = "SENTINEL-ROW-owner@example.com-3e9d"


class FakeSupa:
    def __init__(self, fail=None):
        self.fail, self.rows = fail, []

    def schema(self, name):
        assert name == "pds"
        return self

    def table(self, name):
        assert name == "sync_log"
        return self

    def insert(self, row):
        self.rows.append(row)
        return self

    def execute(self):
        if self.fail is not None:
            raise self.fail
        return SimpleNamespace(data=self.rows)


def capture(fn):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    records = []
    recorder = logging.Handler()
    recorder.emit = records.append
    h.log.addHandler(handler)
    h.log.addHandler(recorder)
    try:
        fn()
    finally:
        h.log.removeHandler(handler)
        h.log.removeHandler(recorder)
    return stream.getvalue(), records


class LogSyncTests(unittest.TestCase):
    def test_ordinary_row_is_unchanged(self):
        supa = FakeSupa()
        h.log_sync(supa, "urgent_email", "labels", "partial", records=3, started_at=0.0, error="account abcd1234: x",
                   date_range_start=date(2026, 11, 1), date_range_end=date(2026, 11, 15))
        [row] = supa.rows
        self.assertEqual((row["source"], row["data_type"], row["status"], row["records_synced"], row["error_message"]),
                         ("urgent_email", "labels", "partial", 3, "account abcd1234: x"))
        self.assertEqual((row["date_range_start"], row["date_range_end"]), ("2026-11-01", "2026-11-15"))

    def test_failed_insert_logs_a_code_not_the_error_text(self):
        class APIError(Exception):
            pass
        APIError.__module__ = "postgrest.exceptions"
        for exc, code in ((APIError(f"Failing row contains ({SENTINEL})"), "db_error"),
                          (ConnectionError(SENTINEL), "connection_error"),
                          (Exception(SENTINEL), "unexpected_error")):
            with self.subTest(code=code):
                supa = FakeSupa(fail=exc)
                text, records = capture(lambda: h.log_sync(supa, "flights", "email", "failed", error="fatal:x"))
                self.assertIn(f"sync_log insert (flights|email) failed: {code}", text, "the failure stays visible")
                self.assertNotIn(SENTINEL, text)
                self.assertNotIn("owner@example.com", text)
                self.assertTrue(all(r.exc_info is None for r in records))

    def test_failed_insert_never_raises(self):
        supa = FakeSupa(fail=RuntimeError(SENTINEL))
        capture(lambda: self.assertIsNone(h.log_sync(supa, "delivery", "email", "failed")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
