"""Synthetic regression test: fetch_all must page under an explicit total ordering.

Follow-up to PR #393's post-merge review (P2): offset pagination without an ORDER BY
let PostgREST return unstable pages, so a recent matrix night could be skipped and
backfill_actuals would clear its correct stored actual.

No real data, no network, no database: hrv_predict's supabase client is replaced with a
fake whose query builder shuffles the in-memory rows on every call unless an order was
applied, simulating an unspecified server-side row order.
"""

import os
import random
import sys
import unittest
from datetime import date, timedelta
from unittest import mock

sys.path.insert(0, ".")

# hrv_predict builds a Supabase client at import time; give it inert env and stub the
# factory so the import needs no secrets, network or database.
os.environ.setdefault("SUPABASE_URL", "https://example.invalid")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")
with mock.patch("supabase.create_client", return_value=mock.Mock()):
    import hrv_predict  # noqa: E402


class FakeQuery:
    """Mimics the supabase-py query builder just enough for fetch_all.

    Records .order()/.range() calls; serves pages from `rows`. When `unstable` is
    True and no order was requested, the rows are re-shuffled for every call, so
    offset paging loses or repeats rows exactly like an ORDER-BY-less PostgREST."""

    def __init__(self, rows, chunk_rows, unstable):
        self._rows = list(rows)
        self._chunk = chunk_rows
        self._unstable = unstable
        self._filters = []
        self._order = []
        self._range = None
        self.calls = []

    def select(self, _select):
        return self

    def eq(self, col, val):
        self._filters.append((col, "eq", val))
        return self

    def gte(self, col, val):
        self._filters.append((col, "gte", val))
        return self

    def lte(self, col, val):
        self._filters.append((col, "lte", val))
        return self

    def is_(self, col, val):
        self._filters.append((col, "is_", val))
        return self

    def order(self, col, **_kwargs):
        self._order.append(col)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        self.calls.append({"order": list(self._order), "range": self._range})
        if self._order:
            rows = sorted(self._rows, key=lambda r: tuple(r.get(c) for c in self._order))
        elif self._unstable:
            rows = list(self._rows)
            random.shuffle(rows)
        else:
            rows = list(self._rows)
        for col, op, val in self._filters:
            if op == "gte":
                rows = [r for r in rows if r.get(col) is not None and str(r.get(col)) >= str(val)]
            elif op == "eq":
                rows = [r for r in rows if r.get(col) == val]
            elif op == "is_":
                rows = [r for r in rows if (r.get(col) is None) == (val is None)]
        start, end = self._range
        batch = rows[start:end + 1]
        resp = mock.Mock()
        resp.data = batch
        return resp


class FakeSupabase:
    def __init__(self, rows_by_table, chunk_rows, unstable):
        self.tables = rows_by_table
        self.chunk_rows = chunk_rows
        self.unstable = unstable
        self.queries = []

    def schema(self, _schema):
        return self

    def from_(self, table):
        q = FakeQuery(self.tables.get(table, []), self.chunk_rows, self.unstable)
        self.queries.append(q)
        return q


def make_matrix_rows(n_days):
    return [
        {"calendar_date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(),
         "whoop_hrv_rmssd": 50.0 + (i % 7)}
        for i in range(n_days)
    ]


class FetchAllOrdering(unittest.TestCase):

    def test_order_applied_before_range(self):
        rows = make_matrix_rows(5)
        supa = FakeSupabase({"daily_health_matrix_behavioral": rows},
                            chunk_rows=1000, unstable=False)
        with mock.patch.object(hrv_predict, "supa", supa):
            hrv_predict.fetch_all("daily_health_matrix_behavioral",
                                  select="calendar_date", order=["calendar_date"])
        q = supa.queries[0]
        self.assertEqual(q._order, ["calendar_date"])
        for call in q.calls:
            self.assertEqual(call["order"], ["calendar_date"])

    def test_multi_page_unstable_read_returns_every_row_once(self):
        rows = make_matrix_rows(25)  # 3 chunks of 10
        supa = FakeSupabase({"daily_health_matrix_behavioral": rows},
                            chunk_rows=10, unstable=True)
        with mock.patch.object(hrv_predict, "supa", supa):
            df = hrv_predict.fetch_all("daily_health_matrix_behavioral",
                                       select="calendar_date,whoop_hrv_rmssd",
                                       order=["calendar_date"])
        self.assertEqual(len(df), 25)
        self.assertEqual(sorted(df["calendar_date"]), sorted(r["calendar_date"] for r in rows))

    def test_unstable_read_without_order_is_detectable(self):
        # Sanity check of the harness itself: without an order the unstable fake
        # loses/duplicates rows, which is the bug this change fixes.
        rows = make_matrix_rows(25)
        supa = FakeSupabase({"daily_health_matrix_behavioral": rows},
                            chunk_rows=10, unstable=True)
        with mock.patch.object(hrv_predict, "supa", supa):
            df = hrv_predict.fetch_all("daily_health_matrix_behavioral",
                                       select="calendar_date,whoop_hrv_rmssd")
        self.assertNotEqual(len(df), 25)


class BackfillDoesNotClearSkippedNight(unittest.TestCase):
    """A recent valid matrix night must keep its stored actual even when the matrix
    read spans multiple pages with an unstable underlying order (the P2 finding)."""

    def _run_backfill(self, matrix_rows, pred_rows, chunk_rows):
        tables = {
            "daily_health_matrix_behavioral": matrix_rows,
            "hrv_predictions": pred_rows,
        }
        supa = FakeSupabase(tables, chunk_rows=chunk_rows, unstable=True)
        upserted = []

        class UpsertQuery:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                upserted.extend(self.payload)

        class UpsertSupa(FakeSupabase):
            def upsert(self, payload, on_conflict=None):
                return UpsertQuery(payload)

        supa_up = UpsertSupa(tables, chunk_rows=chunk_rows, unstable=True)
        with mock.patch.object(hrv_predict, "supa", supa_up), \
             mock.patch.object(hrv_predict, "et_today", lambda: date(2026, 1, 26)):
            hrv_predict.backfill_actuals()
        return upserted

    def test_recent_night_survives_paged_matrix_read(self):
        today = date(2026, 1, 26)
        matrix = make_matrix_rows(25)  # 2026-01-02 .. 2026-01-26, one per night
        recent_night = matrix[20]["calendar_date"]  # 2026-01-22, well inside both windows
        # A stored forecast for that night whose actual is already correct…
        pred = {
            "prediction_date": recent_night,
            "model": "xgboost_v1",
            "horizon_days": 1,
            "model_version": "live_v1",
            "predicted_hrv": 55.0,
            "actual_hrv": matrix[20]["whoop_hrv_rmssd"],
            "residual": matrix[20]["whoop_hrv_rmssd"] - 55.0,
        }
        # …and an older NULL-actual forecast so min_date reaches the first matrix night
        # and the matrix read spans several chunks (a page boundary over present rows).
        old_pred = {
            "prediction_date": matrix[0]["calendar_date"],
            "model": "xgboost_v1",
            "horizon_days": 1,
            "model_version": "live_v1",
            "predicted_hrv": 50.0,
            "actual_hrv": None,
            "residual": None,
        }
        upserted = self._run_backfill(matrix, [pred, old_pred], chunk_rows=10)
        self.assertTrue(any(r["prediction_date"] == matrix[0]["calendar_date"] for r in upserted),
                        "the older NULL forecast should have been filled from the matrix")
        for row in upserted:
            if row["prediction_date"] == recent_night:
                self.assertIsNotNone(row["actual_hrv"],
                                     "a present, valid recent matrix night must not be cleared")
                self.assertAlmostEqual(row["residual"], pred["residual"])


if __name__ == "__main__":
    unittest.main()
