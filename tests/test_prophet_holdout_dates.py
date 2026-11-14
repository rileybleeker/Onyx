"""The Prophet holdout is scored night-for-night by date, not by row position (offline).

dot's review 2026-11-11, finding 4: train_prophet fitted on all but the last 30 nights,
forecast the next 30 CALENDAR days, and compared forecast day k with held-out row k. The
held-out rows are the last 30 nights that HAVE an HRV value, so wherever a day is missing
they span more than 30 calendar days and, from the first gap on, each forecast was scored
against a different night's HRV. Diagnostics only (val_metrics is logged and returned; it
does not pick or weight a model).

The pairing now lives in hrv_alignment.pair_holdout_by_date (+ holdout_forecast_periods,
which makes the forecast reach the last held-out night). This test uses a synthetic
series (no personal data) and checks:

* each held-out night is paired with the forecast for its own date;
* the old positional rule really gets this fixture wrong (so the test would have failed
  before the fix, and keeps proving the fixture has a gap inside the holdout);
* with no gap the result is exactly the old positional pairing;
* a held-out night the forecast does not reach is dropped, never matched to another date;
* train_prophet itself hands compute_metrics date-matched arrays. hrv_analysis needs the
  full ML stack to import, so the function is lifted out of the source file and run with a
  stand-in Prophet whose forecast for a date equals that date's true value: any misdated
  pair shows up as a non-zero error.

Run: python tests/test_prophet_holdout_dates.py
"""
from __future__ import annotations

import ast
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hrv_alignment as al  # noqa: E402

DAY0 = pd.Timestamp("2026-01-01")
HOLDOUT = 30


def value_on(dates) -> np.ndarray:
    """Synthetic HRV for a date: 30 + day number. Every night is distinct, so a pair made
    of two different dates can never agree by accident."""
    d = pd.to_datetime(pd.Series(np.asarray(dates)))
    return 30.0 + (d - DAY0).dt.days.to_numpy(dtype=float)


def history(missing_day_numbers=()) -> pd.DataFrame:
    """120 calendar days as a Prophet frame (ds, y) without the listed day numbers."""
    days = pd.date_range(DAY0, periods=120, freq="D")
    keep = [d for k, d in enumerate(days) if k not in set(missing_day_numbers)]
    return pd.DataFrame({"ds": keep, "y": value_on(keep)})


# Three missing nights, all inside the last 30 observed nights (day numbers 87..119).
GAPS_IN_HOLDOUT = (95, 96, 104)


def split(hrv_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    cutoff = len(hrv_df) - HOLDOUT
    return hrv_df.iloc[:cutoff].copy(), hrv_df.iloc[cutoff:].copy()


def daily_forecast(train_df: pd.DataFrame, periods: int) -> pd.DataFrame:
    """What Prophet returns: the training dates plus `periods` calendar days after the
    last one. yhat is the true value of each date."""
    last = train_df["ds"].max()
    ds = pd.concat([train_df["ds"], pd.Series(pd.date_range(last + pd.Timedelta(days=1),
                                                            periods=periods, freq="D"))],
                   ignore_index=True)
    yhat = value_on(ds)
    return pd.DataFrame({"ds": ds, "yhat": yhat, "yhat_lower": yhat - 5, "yhat_upper": yhat + 5})


def positional_pairs(holdout_df: pd.DataFrame, forecast_df: pd.DataFrame):
    """The pre-fix rule: last 30 forecast rows against the held-out rows, by position."""
    fc_30 = forecast_df.tail(30)
    return holdout_df["y"].values, fc_30["yhat"].values[: len(holdout_df)]


class PairingHelper(unittest.TestCase):
    def test_each_held_out_night_meets_its_own_date(self):
        train, holdout = split(history(GAPS_IN_HOLDOUT))
        periods = al.holdout_forecast_periods(train["ds"], holdout["ds"])
        self.assertEqual(periods, HOLDOUT + len(GAPS_IN_HOLDOUT))

        paired = al.pair_holdout_by_date(holdout, daily_forecast(train, periods))
        self.assertEqual(len(paired), HOLDOUT, "every held-out night must be scored")
        self.assertEqual(list(paired["ds"]), list(pd.to_datetime(holdout["ds"])))
        np.testing.assert_array_equal(paired["yhat"].to_numpy(), value_on(paired["ds"]))
        np.testing.assert_array_equal(paired["y"].to_numpy(), paired["yhat"].to_numpy())
        np.testing.assert_array_equal(paired["yhat_lower"].to_numpy(), paired["y"].to_numpy() - 5)
        np.testing.assert_array_equal(paired["yhat_upper"].to_numpy(), paired["y"].to_numpy() + 5)

    def test_old_positional_rule_misdates_this_fixture(self):
        train, holdout = split(history(GAPS_IN_HOLDOUT))
        actual, pred = positional_pairs(holdout, daily_forecast(train, 30))
        wrong = int(np.sum(actual != pred))
        self.assertGreater(wrong, 0, "fixture has no gap inside the holdout")
        # Rows before the first gap still agree; every row after it is another night.
        first_gap_row = int(np.argmax(actual != pred))
        self.assertTrue(np.all(actual[:first_gap_row] == pred[:first_gap_row]))
        self.assertTrue(np.all(actual[first_gap_row:] != pred[first_gap_row:]))
        self.assertGreater(float(np.mean(np.abs(actual - pred))), 0.5)

    def test_no_gap_is_exactly_the_positional_pairing(self):
        train, holdout = split(history())
        self.assertEqual(al.holdout_forecast_periods(train["ds"], holdout["ds"]), 30)
        forecast = daily_forecast(train, 30)
        # Give the forecast its own noise so equality is not a property of value_on.
        rng = np.random.default_rng(4)
        forecast["yhat"] = forecast["yhat"] + rng.normal(0, 3, len(forecast))
        old_actual, old_pred = positional_pairs(holdout, forecast)
        paired = al.pair_holdout_by_date(holdout, forecast)
        np.testing.assert_array_equal(paired["y"].to_numpy(), old_actual)
        np.testing.assert_array_equal(paired["yhat"].to_numpy(), old_pred)

    def test_gap_only_in_training_history_changes_nothing(self):
        train, holdout = split(history((10, 11, 40)))
        self.assertEqual(al.holdout_forecast_periods(train["ds"], holdout["ds"]), 30)
        forecast = daily_forecast(train, 30)
        old_actual, old_pred = positional_pairs(holdout, forecast)
        paired = al.pair_holdout_by_date(holdout, forecast)
        np.testing.assert_array_equal(paired["y"].to_numpy(), old_actual)
        np.testing.assert_array_equal(paired["yhat"].to_numpy(), old_pred)

    def test_night_beyond_the_forecast_is_dropped_not_misdated(self):
        train, holdout = split(history(GAPS_IN_HOLDOUT))
        paired = al.pair_holdout_by_date(holdout, daily_forecast(train, 30))
        self.assertEqual(len(paired), HOLDOUT - len(GAPS_IN_HOLDOUT))
        np.testing.assert_array_equal(paired["y"].to_numpy(), paired["yhat"].to_numpy())

    def test_dates_join_across_types_and_units(self):
        train, holdout = split(history(GAPS_IN_HOLDOUT))
        forecast = daily_forecast(train, 33)
        forecast["ds"] = forecast["ds"].astype("datetime64[s]")
        holdout = holdout.assign(ds=holdout["ds"].dt.strftime("%Y-%m-%d"))
        paired = al.pair_holdout_by_date(holdout, forecast)
        self.assertEqual(len(paired), HOLDOUT)
        np.testing.assert_array_equal(paired["y"].to_numpy(), paired["yhat"].to_numpy())


# ---------------------------------------------------------------------------
# train_prophet, run from the source file with a stand-in Prophet
# ---------------------------------------------------------------------------

class FakeProphet:
    """Just enough of Prophet's interface for train_prophet. Its forecast for a date is
    that date's true synthetic value."""

    instances: list["FakeProphet"] = []

    def __init__(self, **_kwargs):
        self.regressors: list[str] = []
        self.history_ds: pd.Series | None = None
        FakeProphet.instances.append(self)

    def add_regressor(self, name):
        self.regressors.append(name)

    def fit(self, frame):
        if frame[self.regressors].isna().any().any():
            raise ValueError("NaN regressor in the training frame")
        self.history_ds = pd.to_datetime(frame["ds"]).reset_index(drop=True)
        return self

    def make_future_dataframe(self, periods):
        last = self.history_ds.max()
        future = pd.Series(pd.date_range(last + pd.Timedelta(days=1), periods=periods, freq="D"))
        return pd.DataFrame({"ds": pd.concat([self.history_ds, future], ignore_index=True)})

    def predict(self, future):
        # The real Prophet refuses a NaN regressor; so does this one.
        if future[self.regressors].isna().any().any():
            raise ValueError("NaN regressor in the future frame")
        yhat = value_on(future["ds"])
        return pd.DataFrame({"ds": pd.to_datetime(future["ds"]).to_numpy(), "yhat": yhat,
                             "yhat_lower": yhat - 5, "yhat_upper": yhat + 5})


def load_train_prophet(recorder: list, out_dir: Path):
    """train_prophet from hrv_analysis.py, bound to stand-ins for its module globals."""
    source = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "train_prophet")

    def compute_metrics(y_true, y_pred, y_lower=None, y_upper=None):
        recorder.append({k: np.asarray(v, dtype=float) for k, v in
                         {"y_true": y_true, "y_pred": y_pred, "y_lower": y_lower, "y_upper": y_upper}.items()})
        err = np.abs(np.asarray(y_true, dtype=float) - np.asarray(y_pred, dtype=float))
        return {"mae": float(err.mean()), "ci_coverage": 100.0}

    plt = mock.MagicMock()
    plt.subplots.return_value = (mock.MagicMock(), mock.MagicMock())
    namespace = {
        "pd": pd, "np": np, "al": al, "plt": plt,
        "Prophet": FakeProphet, "HAS_PROPHET": True,
        "TARGET": al.TARGET, "CI_NOMINAL": 0.9, "OUTPUT_DIR": out_dir,
        "log": logging.getLogger("test_prophet_holdout_dates"),
        "compute_metrics": compute_metrics,
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), "hrv_analysis.py", "exec"), namespace)
    return namespace["train_prophet"]


def matrix(missing_day_numbers=(), regressor: bool = False) -> pd.DataFrame:
    h = history(missing_day_numbers)
    df = pd.DataFrame({al.DATE_COL: h["ds"].dt.strftime("%Y-%m-%d"), al.TARGET: h["y"]})
    if regressor:
        df["journal_synthetic_flag"] = (np.arange(len(df)) % 3 == 0).astype(float)
    return df


class TrainProphetHoldout(unittest.TestCase):
    def run_holdout(self, df: pd.DataFrame, top_features=()):
        recorded: list = []
        with tempfile.TemporaryDirectory() as tmp:
            result = load_train_prophet(recorded, Path(tmp))(df, list(top_features))
        self.assertTrue(result, "train_prophet returned nothing (it swallowed an exception)")
        self.assertEqual(len(recorded), 1)
        return result, recorded[0]

    def assert_scored_by_date(self, call, expected_nights):
        self.assertEqual(len(call["y_true"]), expected_nights)
        # The stand-in forecasts each date's true value: a misdated pair is a non-zero error.
        np.testing.assert_array_equal(call["y_true"], call["y_pred"])
        np.testing.assert_array_equal(call["y_lower"], call["y_true"] - 5)
        np.testing.assert_array_equal(call["y_upper"], call["y_true"] + 5)

    def test_gap_inside_the_holdout(self):
        df = matrix(GAPS_IN_HOLDOUT)
        result, call = self.run_holdout(df)
        self.assert_scored_by_date(call, HOLDOUT)
        np.testing.assert_array_equal(call["y_true"], df[al.TARGET].to_numpy()[-HOLDOUT:])
        self.assertEqual(result["val_metrics"]["mae"], 0.0)

    def test_gap_inside_the_holdout_with_a_regressor(self):
        df = matrix(GAPS_IN_HOLDOUT, regressor=True)
        FakeProphet.instances.clear()
        _, call = self.run_holdout(df, ["journal_synthetic_flag"])
        self.assertEqual([m.regressors for m in FakeProphet.instances],
                         [["journal_synthetic_flag"]] * 2, "the regressor path did not run")
        self.assert_scored_by_date(call, HOLDOUT)

    def test_no_gap(self):
        df = matrix()
        result, call = self.run_holdout(df)
        self.assert_scored_by_date(call, HOLDOUT)
        np.testing.assert_array_equal(call["y_true"], df[al.TARGET].to_numpy()[-HOLDOUT:])
        # The 30-day forward forecast is untouched: 30 days after the last night.
        self.assertEqual(len(result["forecast_dates"]), 30)
        self.assertEqual(result["forecast_dates"][0], "2026-05-01")

    def test_source_no_longer_pairs_by_position(self):
        source = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "train_prophet")
        body = ast.get_source_segment(source, node)
        self.assertIn("al.pair_holdout_by_date(", body)
        self.assertIn("al.holdout_forecast_periods(", body)
        self.assertNotIn(".values[: len(holdout_df)]", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
