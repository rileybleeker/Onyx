"""Regression tests for hrv_predict's live rolling metrics (2026-11-11).

pds.hrv_model_metrics is keyed (eval_date, model, horizon_days). hrv_predict.py used to
upsert its live 30-day accuracy under the plain model name, so every hourly predict run
replaced the retrain's walk-forward backtest h=1 row for the same eval_date (live MAE / n
next to the backtest's R2 / MAPE / CI), and the "live" number itself was computed from
backtest rows of every horizon. These tests run the production functions against an
in-memory stand-in for the Supabase client that applies upserts the way PostgREST's
merge-duplicates does (only the columns sent are updated).

No credentials, no network. Run: python tests/test_hrv_live_metrics.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import pandas as pd  # noqa: E402

PK = {"hrv_model_metrics": ("eval_date", "model", "horizon_days")}


class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db: "FakeDb", table: str):
        self.db, self.table = db, table
        self.filters: list = []
        self._order: tuple | None = None
        self._limit: int | None = None
        self._range: tuple | None = None
        self._upsert: tuple | None = None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.filters.append((col, lambda v, x=val: v == x)); return self

    def gte(self, col, val):
        self.filters.append((col, lambda v, x=val: v is not None and str(v) >= str(x))); return self

    def lte(self, col, val):
        self.filters.append((col, lambda v, x=val: v is not None and str(v) <= str(x))); return self

    def is_(self, col, val):
        self.filters.append((col, lambda v: v is None)); return self

    def order(self, col, desc=False):
        self._order = (col, desc); return self

    def limit(self, n):
        self._limit = n; return self

    def range(self, a, b):
        self._range = (a, b); return self

    def upsert(self, rows, on_conflict=""):
        self._upsert = (rows, on_conflict); return self

    def execute(self):
        if self._upsert is not None:
            rows, on_conflict = self._upsert
            self.db.upserts.append((self.table, on_conflict, rows))
            key_cols = PK.get(self.table) or tuple(on_conflict.split(","))
            table = self.db.tables.setdefault(self.table, [])
            for r in rows:
                hit = next((t for t in table if all(t.get(k) == r.get(k) for k in key_cols)), None)
                if hit is None:
                    table.append(dict(r))
                else:
                    hit.update(r)  # merge-duplicates: unsent columns keep their old values
            return _Resp(rows)
        out = [r for r in self.db.tables.get(self.table, [])
               if all(f(r.get(c)) for c, f in self.filters)]
        if self._order:
            col, desc = self._order
            out = sorted(out, key=lambda r: str(r.get(col)), reverse=desc)
        if self._range:
            a, b = self._range
            out = out[a:b + 1]
        if self._limit is not None:
            out = out[: self._limit]
        return _Resp([dict(r) for r in out])


class FakeDb:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.upserts: list = []

    def schema(self, _name):
        return self

    def from_(self, table):
        return _Query(self, table)

    table = from_


_stub = types.ModuleType("supabase")
_stub.create_client = lambda *_a, **_k: FakeDb()
sys.modules.setdefault("supabase", _stub)

import hrv_predict as hp  # noqa: E402

TODAY = date(2026, 11, 20)


def _pred(d, model="xgboost", version=None, created="2026-11-12T12:00:00Z", h=1,
          pred=70.0, actual=65.0):
    return {"prediction_date": d, "model": model, "horizon_days": h,
            "model_version": version or f"{d}_v1", "created_at": created,
            "predicted_hrv": pred, "actual_hrv": actual,
            "prediction_lower": pred - 20, "prediction_upper": pred + 20}


def _live_week():
    """Seven scored live forecasts after the cutover, 2026-11-11 .. 2026-11-17."""
    rows = []
    for i, d in enumerate(pd.date_range("2026-11-11", periods=7).strftime("%Y-%m-%d")):
        rows.append(_pred(d, created=f"{d}T15:00:00Z", pred=70.0 + i, actual=60.0 + 2 * i))
    return rows


class SelectLiveForecasts(unittest.TestCase):
    def test_skips_backtest_other_horizons_precutover_and_unscored(self):
        rows = [
            _pred("2026-11-12", version="backtest_initial", created="2026-11-13T12:00:00Z"),
            _pred("2026-11-12", h=2, version="2026-11-11_behavioral_v1"),
            # The old code's last forecast: version date 2026-11-11 but created 00:05 ET.
            _pred("2026-11-12", version="2026-11-11_v1", created="2026-11-11T05:05:01Z"),
            _pred("2026-11-13", actual=None),
        ]
        self.assertTrue(hp.select_live_forecasts(pd.DataFrame(rows)).empty)

    def test_one_row_per_date_like_the_latest_view(self):
        rows = [
            # Same date: the predict path beats the retrain path, then newest created_at.
            _pred("2026-11-12", version="2026-11-12_behavioral_v1", created="2026-11-12T16:00:00Z", pred=1),
            _pred("2026-11-12", version="2026-11-12_v1", created="2026-11-12T11:00:00Z", pred=2),
            _pred("2026-11-12", version="2026-11-13_v1", created="2026-11-13T05:05:00Z", pred=3),
        ]
        live = hp.select_live_forecasts(pd.DataFrame(rows))
        self.assertEqual(len(live), 1)
        self.assertEqual(float(live["predicted_hrv"].iloc[0]), 3.0)


class RecomputeRollingMetrics(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()
        hp.supa = self.db
        self._et_today = hp.et_today
        hp.et_today = lambda: TODAY

    def tearDown(self):
        hp.et_today = self._et_today

    def test_writes_live_label_only_from_live_forecasts(self):
        backtest = [_pred(d, version="backtest_initial", h=h, created="2026-11-12T12:00:00Z",
                          pred=100.0, actual=60.0)
                    for d in pd.date_range("2026-11-01", periods=15).strftime("%Y-%m-%d")
                    for h in (1, 2, 3)]
        self.db.tables["hrv_predictions"] = backtest + _live_week()
        rows = hp.recompute_rolling_metrics()
        self.assertEqual([r["model"] for r in rows], ["xgboost_live_rolling"])
        r = rows[0]
        self.assertEqual(r["horizon_days"], 1)
        self.assertEqual(r["n_predictions"], 7)  # the 45 backtest rows are not counted
        # errors: actual - pred = (60+2i) - (70+i) = i - 10 for i = 0..6
        self.assertAlmostEqual(r["mae"], sum(abs(i - 10) for i in range(7)) / 7)
        self.assertEqual(r["ci_coverage"], 100.0)  # every miss (4..10 ms) is inside pred ± 20
        self.assertEqual(r["ci_avg_width"], 40.0)
        table, on_conflict, sent = self.db.upserts[-1]
        self.assertEqual((table, on_conflict), ("hrv_model_metrics", "eval_date,model,horizon_days"))
        self.assertNotIn("xgboost", {s["model"] for s in sent})

    def test_backtest_h1_row_survives_the_hourly_predict_run(self):
        # The retrain's walk-forward rows for today (plain labels, every horizon) ...
        retrain = [{"eval_date": str(TODAY), "model": "xgboost", "horizon_days": h,
                    "mae": 24.2, "r_squared": 0.36, "n_predictions": 500,
                    "model_version": "backtest_initial"} for h in range(1, 8)]
        hp.supa.from_("hrv_model_metrics").upsert(retrain, on_conflict="eval_date,model,horizon_days").execute()
        # ... then the hourly predict job.
        self.db.tables["hrv_predictions"] = _live_week()
        hp.recompute_rolling_metrics()
        metrics = {(m["model"], m["horizon_days"]): m for m in self.db.tables["hrv_model_metrics"]}
        bt = metrics[("xgboost", 1)]
        self.assertEqual((bt["model_version"], bt["mae"], bt["n_predictions"]), ("backtest_initial", 24.2, 500))
        live = metrics[("xgboost_live_rolling", 1)]
        self.assertEqual(live["n_predictions"], 7)
        self.assertEqual(len(metrics), 8)

    def test_fewer_than_five_live_forecasts_writes_nothing(self):
        self.db.tables["hrv_predictions"] = _live_week()[:4]
        self.assertEqual(hp.recompute_rolling_metrics(), [])
        self.assertEqual(self.db.upserts, [])


class CheckDrift(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()
        hp.supa = self.db
        self.alerts = []
        self._log_sync = hp._shared_log_sync
        hp._shared_log_sync = lambda *_a, **k: self.alerts.append(k)
        self.db.tables["hrv_model_metrics"] = [
            {"eval_date": "2026-04-04", "model": "xgboost", "horizon_days": 1, "mae": 10.0,
             "model_version": "backtest_initial"},
            {"eval_date": "2026-11-19", "model": "xgboost", "horizon_days": 1, "mae": 24.0,
             "model_version": "backtest_initial"},
            {"eval_date": "2026-11-20", "model": "xgboost_live_rolling", "horizon_days": 1,
             "mae": 30.0, "model_version": "2026-11-20_v1"},
        ]

    def tearDown(self):
        hp._shared_log_sync = self._log_sync

    def test_live_mae_read_from_the_live_label(self):
        self.assertEqual(hp.latest_live_mae("xgboost"), 30.0)

    def test_anchor_is_the_newest_backtest(self):
        hp.check_drift(30.0)  # 30 < 1.5 x 24 (newest); the 2026-04-04 row (10) would alert
        self.assertEqual(self.alerts, [])
        hp.check_drift(37.0)
        self.assertEqual(len(self.alerts), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
