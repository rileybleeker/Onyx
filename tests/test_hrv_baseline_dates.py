"""Naive baselines in the multi-horizon backtest are scored against the right night (offline).

dot's review 2026-11-11, finding 3: run_evaluation scored the naive baselines (persistence,
7-day mean, day-of-week) at horizon h against row i + h - 1 of the gap-filtered model frame,
while labelling the row with the calendar date feature_date + h - 1. Wherever the history
has a missing day those are different nights, so the baseline bars on the /analytics/hrv
"Accuracy by Forecast Horizon" chart were scored against the wrong HRV for h >= 2, while
XGBoost (keyed by date through outcome_series) was scored against the right one.

The baselines now live in hrv_alignment.naive_baseline_rows and look the actual up by date.
This test builds a synthetic history with gaps (no personal data) and checks:

* every baseline row's actual_hrv is the HRV recorded on its prediction_date;
* the old positional rule really gets this fixture wrong (so the test would have failed
  before the fix, and keeps proving the fixture has gaps);
* run_evaluation in hrv_analysis.py calls the helper instead of an inline positional loop
  (checked by reading the source, since hrv_analysis needs the full ML stack to import).

Run: python tests/test_hrv_baseline_dates.py
"""
import ast
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hrv_alignment as al  # noqa: E402

HORIZONS = [1, 2, 3, 4, 5, 6, 7]
MIN_TRAIN = 10


def gappy_history() -> pd.DataFrame:
    """60 calendar days with every 4th and 9th day missing; HRV = 30 + day number, so
    every night has a distinct value and a misdated lookup cannot match by accident."""
    days = pd.date_range("2026-01-01", periods=60, freq="D")
    keep = [d for k, d in enumerate(days) if k % 4 != 3 and k % 9 != 8]
    return pd.DataFrame({
        al.DATE_COL: keep,
        al.TARGET: [30.0 + (d - days[0]).days for d in keep],
    })


def positional_actuals(model_df: pd.DataFrame, h: int) -> dict[str, float]:
    """The pre-fix rule: actual = row i + h - 1, labelled target_date(row i, h)."""
    hrv = model_df[al.TARGET].to_numpy(dtype=float)
    dates = pd.to_datetime(model_df[al.DATE_COL]).to_numpy()
    out = {}
    for i in range(max(MIN_TRAIN, 1), len(hrv) - h + 1):
        out[al.target_date(pd.Timestamp(dates[i]), h).strftime("%Y-%m-%d")] = float(hrv[i + h - 1])
    return out


class BaselineDates(unittest.TestCase):
    def setUp(self):
        self.df = gappy_history()
        self.truth = {d.strftime("%Y-%m-%d"): v
                      for d, v in zip(self.df[al.DATE_COL], self.df[al.TARGET])}
        self.rows = al.naive_baseline_rows(self.df, HORIZONS, MIN_TRAIN, outcome_df=self.df)

    def test_actual_is_the_hrv_of_the_prediction_date(self):
        self.assertTrue(self.rows)
        for r in self.rows:
            with self.subTest(model=r["model"], h=r["horizon_days"], date=r["prediction_date"]):
                self.assertIn(r["prediction_date"], self.truth)
                self.assertEqual(r["actual_hrv"], self.truth[r["prediction_date"]])
                self.assertAlmostEqual(r["residual"], r["actual_hrv"] - r["predicted_hrv"])

    def test_every_horizon_and_model_present(self):
        seen = {(r["model"], r["horizon_days"]) for r in self.rows}
        for h in HORIZONS:
            for m in ("baseline_naive", "baseline_7d_avg", "baseline_dow"):
                self.assertIn((m, h), seen)

    def test_missing_target_night_is_skipped(self):
        present = set(self.truth)
        self.assertTrue(all(r["prediction_date"] in present for r in self.rows))

    def test_old_positional_rule_is_wrong_on_this_fixture(self):
        wrong = 0
        for h in HORIZONS[1:]:
            for d, v in positional_actuals(self.df, h).items():
                if self.truth.get(d) != v:
                    wrong += 1
        self.assertGreater(wrong, 0, "fixture has no gaps that the old rule misdates")

    def test_h1_unchanged(self):
        # h = 1 scores row i against itself: date-keyed and positional agree.
        new = {r["prediction_date"]: r["actual_hrv"] for r in self.rows
               if r["horizon_days"] == 1 and r["model"] == "baseline_naive"}
        self.assertEqual(new, positional_actuals(self.df, 1))

    def test_history_is_strictly_before_the_feature_row(self):
        # Persistence = HRV of the model_df row just before the feature row.
        dates = list(pd.to_datetime(self.df[al.DATE_COL]))
        hrv = list(self.df[al.TARGET])
        for r in self.rows:
            if r["model"] != "baseline_naive":
                continue
            feat = al.feature_date([r["prediction_date"]], [r["horizon_days"]])[0]
            i = dates.index(pd.Timestamp(feat))
            self.assertEqual(r["predicted_hrv"], hrv[i - 1])

    def test_outcome_df_is_used_for_the_actual(self):
        # A night dropped from model_df but present in the full frame is still scored,
        # like XGBoost's outcome_series target.
        full = self.df
        model_df = full.drop(index=full.index[20]).reset_index(drop=True)
        dropped = pd.Timestamp(full[al.DATE_COL].iloc[20]).strftime("%Y-%m-%d")
        rows = al.naive_baseline_rows(model_df, [2], MIN_TRAIN, outcome_df=full)
        self.assertIn(dropped, {r["prediction_date"] for r in rows})


class RunEvaluationUsesHelper(unittest.TestCase):
    def test_run_evaluation_calls_naive_baseline_rows(self):
        tree = ast.parse((ROOT / "hrv_analysis.py").read_text(encoding="utf-8"))
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run_evaluation")
        calls = {ast.unparse(n.func) for n in ast.walk(fn) if isinstance(n, ast.Call)}
        self.assertIn("al.naive_baseline_rows", calls)
        src = ast.unparse(fn)
        self.assertNotIn("actual_idx = i + h - 1", src)


if __name__ == "__main__":
    unittest.main()
