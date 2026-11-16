"""One calendar-aware sparse-feature fill for HRV training and serving (audit PIPE-07).

HIGH_VALUE_SPARSE_FEATURES (Garmin training-state metrics) may carry a value forward for
up to SPARSE_FILL_MAX_AGE_DAYS calendar days. Until 2026-11-16 prepare_ml_data dropped the
rows without an HRV outcome FIRST and then filled 7 ROWS forward, while serve_features filled
the full frame: after an HRV gap, 7 kept rows spanned more than 7 days, and a value observed
on a night without HRV was never carried, so training rows and the live row disagreed.

These tests pin:
  1. on consecutive days the fill equals the old 7-row ffill (ordinary behaviour unchanged);
  2. no value is carried more than 7 calendar days, also across dates missing from the frame;
  3. nothing moves backwards in time: row D's result is the same with or without later rows;
  4. prepare_ml_data's training row for day D equals serve_features' live row on day D, on a
     fixture with an HRV gap, a spine gap and a value observed on a night without HRV
     (and the old training procedure does NOT match on that fixture);
  5. model pickles carry their fill: an old pickle is served with its own row fill until the
     next retrain (with a partial heartbeat, written at most every 12 h), an unknown fill is
     refused with a GUARD heartbeat, and a heartbeat failure never stops a forecast.

Synthetic data only. No credentials, no network. Run: python tests/test_hrv_sparse_fill.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402

NAN = np.nan
BASE = date(2026, 3, 1)
SPARSE_A = "acute_training_load"      # in HIGH_VALUE_SPARSE_FEATURES
SPARSE_B = "garmin_vo2_max_running"   # in HIGH_VALUE_SPARSE_FEATURES
DENSE = "synthetic_dense_feature"     # an ordinary numeric feature (never filled)


def _day(offset: int) -> str:
    return (BASE + timedelta(days=offset)).isoformat()


def _noon_et(day: str) -> datetime:
    """A clock time whose behavioral day (ET - 6 h) is `day`."""
    d = date.fromisoformat(day)
    return datetime(d.year, d.month, d.day, 12, 0, tzinfo=al.ET)


def _frame() -> pd.DataFrame:
    """30 calendar days of synthetic rows, with:
    - no row at all on days 12 and 13 (a gap in the spine);
    - no HRV on nights 5-8 and 20 (rows a training set drops);
    - SPARSE_A observed on days 0-9 and 22 only;
    - SPARSE_B observed on days 0, 7 (a night without HRV) and 25 only.
    """
    rows = []
    for i in range(30):
        if i in (12, 13):
            continue
        rows.append({
            "calendar_date": _day(i),
            "whoop_hrv_rmssd": NAN if i in (5, 6, 7, 8, 20) else 50.0 + (i % 5),
            "hrv_lag1": 48.0 + (i % 3),
            SPARSE_A: 100.0 + i if (i <= 9 or i == 22) else NAN,
            SPARSE_B: {0: 40.0, 7: 42.0, 25: 44.0}.get(i, NAN),
            DENSE: float(i),
        })
    return pd.DataFrame(rows)


def _by_day(df: pd.DataFrame, col: str) -> dict:
    return dict(zip(df["calendar_date"], df[col]))


# ---------------------------------------------------------------------------
# The fill itself
# ---------------------------------------------------------------------------

def test_consecutive_days_match_the_old_seven_row_fill():
    rng = np.random.default_rng(7)
    days = pd.date_range("2026-01-01", periods=120, freq="D").strftime("%Y-%m-%d")
    x = rng.normal(60, 5, size=120)
    x[rng.random(120) < 0.7] = NAN          # mostly missing, runs longer and shorter than 7
    x[40:55] = NAN                          # one run of 15 missing days
    df = pd.DataFrame({"calendar_date": days, SPARSE_A: x})
    out = h.fill_sparse_features(df, [SPARSE_A])
    expected = df[SPARSE_A].ffill(limit=7)
    np.testing.assert_array_equal(out[SPARSE_A].to_numpy(), expected.to_numpy())


def test_no_value_is_carried_more_than_seven_calendar_days():
    df = _frame()
    out = _by_day(h.fill_sparse_features(df), SPARSE_A)
    # last observation before the gap: day 9 (value 109)
    for i in (10, 11, 14, 15, 16):          # 1..7 days old (12 and 13 have no row)
        assert out[_day(i)] == 109.0, (i, out[_day(i)])
    assert np.isnan(out[_day(17)]), "8 days old: must not be carried"
    assert np.isnan(out[_day(21)])
    assert out[_day(22)] == 122.0           # observed values never change
    for i in range(23, 30):                 # day 29 is exactly 7 days after day 22
        assert out[_day(i)] == 122.0, i
    # the old row-count fill carries day 9 into day 17 (7 ROWS later, 8 days later)
    legacy = _by_day(h._legacy_row_fill(df), SPARSE_A)
    assert legacy[_day(17)] == 109.0


def test_a_shorter_age_limit_is_counted_in_days():
    df = _frame()
    out = _by_day(h.fill_sparse_features(df, [SPARSE_A], max_age_days=2), SPARSE_A)
    assert out[_day(11)] == 109.0           # 2 days old
    assert np.isnan(out[_day(14)])          # next row, but 5 days old
    zero = _by_day(h.fill_sparse_features(df, [SPARSE_A], max_age_days=0), SPARSE_A)
    assert np.isnan(zero[_day(10)])
    try:
        h.fill_sparse_features(df, [SPARSE_A], max_age_days=-1)
    except ValueError:
        pass
    else:
        raise AssertionError("a negative age limit must be refused")


def test_nothing_moves_backwards_in_time():
    df = _frame()
    full = h.fill_sparse_features(df).set_index("calendar_date")
    # day 25's SPARSE_B is never pulled back into days 15-24
    for i in range(15, 25):
        if i not in (12, 13):
            assert np.isnan(full.loc[_day(i), SPARSE_B]), i
    # as-of: row D is the same whether or not the frame continues past D
    for day in df["calendar_date"]:
        upto = h.fill_sparse_features(df[df["calendar_date"] <= day]).set_index("calendar_date")
        for col in (SPARSE_A, SPARSE_B):
            a, b = upto.loc[day, col], full.loc[day, col]
            assert (np.isnan(a) and np.isnan(b)) or a == b, (day, col, a, b)


def test_row_order_index_and_other_columns_are_kept():
    df = _frame().sample(frac=1.0, random_state=3)
    df.index = [f"r{i}" for i in range(len(df))]
    out = h.fill_sparse_features(df)
    assert list(out.index) == list(df.index)
    assert list(out["calendar_date"]) == list(df["calendar_date"])
    pd.testing.assert_series_equal(out[DENSE], df[DENSE])
    observed = df[SPARSE_A].notna()
    pd.testing.assert_series_equal(out.loc[observed, SPARSE_A], df.loc[observed, SPARSE_A])
    # the input frame is not modified
    assert df[SPARSE_A].isna().sum() > 0
    # unordered input gives the same values per day as ordered input
    ordered = _by_day(h.fill_sparse_features(_frame()), SPARSE_A)
    shuffled = _by_day(out, SPARSE_A)
    for day, v in ordered.items():
        assert (np.isnan(v) and np.isnan(shuffled[day])) or v == shuffled[day], day


def test_duplicate_and_unparseable_dates():
    df = pd.DataFrame({
        "calendar_date": ["2026-01-01", "2026-01-02", "2026-01-02", "2026-01-03", "not a date",
                          "2026-01-04"],
        SPARSE_A: [NAN, 5.0, NAN, NAN, 99.0, NAN],
    })
    out = list(h.fill_sparse_features(df, [SPARSE_A])[SPARSE_A])
    assert np.isnan(out[0])                 # nothing earlier
    assert out[1] == 5.0 and out[2] == 5.0  # same day: age 0
    assert out[3] == 5.0
    assert out[4] == 99.0                   # left as is
    assert out[5] == 5.0                    # the unparseable row is not a source
    # no dated rows at all, or no sparse columns: returned unchanged
    nodate = pd.DataFrame({"calendar_date": ["x"], SPARSE_A: [NAN]})
    assert np.isnan(h.fill_sparse_features(nodate, [SPARSE_A])[SPARSE_A].iloc[0])
    other = pd.DataFrame({"calendar_date": ["2026-01-01"], DENSE: [NAN]})
    pd.testing.assert_frame_equal(h.fill_sparse_features(other), other)


# ---------------------------------------------------------------------------
# Training and serving use the same values
# ---------------------------------------------------------------------------

def _old_training_values(df: pd.DataFrame, col: str) -> dict:
    """The pre-2026-11-16 training procedure: drop rows without outcome, then fill 7 rows."""
    d = df.copy()
    d["_y"] = al.outcome_series(d, 1)
    d = d.dropna(subset=["_y", "hrv_lag1"]).copy()
    d[col] = d[col].ffill(limit=7)
    return _by_day(d, col)


def test_training_rows_equal_the_live_row_of_that_day():
    df = _frame()
    model_df, feat_cols, X, y = h.prepare_ml_data(df)
    assert SPARSE_A in feat_cols and SPARSE_B in feat_cols and DENSE in feat_cols
    # nights without HRV are not training rows
    trained = set(model_df["calendar_date"])
    assert not trained & {_day(i) for i in (5, 6, 7, 8, 20)}
    for pos, day in enumerate(model_df["calendar_date"]):
        live, served_day = h.serve_features(df[df["calendar_date"] <= day], feat_cols,
                                            now=_noon_et(day))
        assert served_day == day
        np.testing.assert_allclose(live.to_numpy(dtype=float)[0],
                                   X.iloc[pos].to_numpy(dtype=float),
                                   equal_nan=True, err_msg=day)
    # day 7 had no HRV but did observe SPARSE_B: days 9-11 and 14 carry ITS value
    got = dict(zip(model_df["calendar_date"], X[SPARSE_B]))
    for i in (9, 10, 11, 14):
        assert got[_day(i)] == 42.0, (i, got[_day(i)])
    # the old training procedure gave those rows day 0's value (9+ days old) or nothing
    old = _old_training_values(df, SPARSE_B)
    assert old[_day(9)] == 40.0 and np.isnan(old[_day(14)])


def test_backtest_horizons_use_the_same_fill():
    df = _frame()
    m3, _, X3, _ = h.prepare_ml_data(df, horizon=3)
    filled = h.fill_sparse_features(df).set_index("calendar_date")
    for pos, day in enumerate(m3["calendar_date"]):
        a, b = X3.iloc[pos][SPARSE_A], filled.loc[day, SPARSE_A]
        assert (np.isnan(a) and np.isnan(b)) or a == b, day


# ---------------------------------------------------------------------------
# Model pickles carry their fill
# ---------------------------------------------------------------------------

def test_model_preprocessing_and_serve_versions():
    assert h.model_preprocessing({}) == h.LEGACY_SPARSE_FILL_VERSION
    assert h.model_preprocessing({"preprocessing": None}) == h.LEGACY_SPARSE_FILL_VERSION
    assert h.model_preprocessing({"preprocessing": h.SPARSE_FILL_VERSION}) == h.SPARSE_FILL_VERSION
    df = _frame()
    feat_cols = [SPARSE_A, DENSE]
    now = _noon_et(_day(17))
    upto = df[df["calendar_date"] <= _day(17)]
    cur, _ = h.serve_features(upto, feat_cols, now=now)
    old, _ = h.serve_features(upto, feat_cols, h.LEGACY_SPARSE_FILL_VERSION, now=now)
    assert np.isnan(cur[SPARSE_A].iloc[0])      # 8 days old
    assert old[SPARSE_A].iloc[0] == 109.0       # the fill that model shipped with
    try:
        h.serve_features(upto, feat_cols, "calendar_ffill_7d_v9", now=now)
    except ValueError:
        pass
    else:
        raise AssertionError("an unknown fill must be refused")


class _Resp:
    def __init__(self, data):
        self.data = data


class _SyncLogQuery:
    def __init__(self, db):
        self.db, self.filters = db, {}

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        if self.db.fail_reads:
            raise RuntimeError("synthetic read failure")
        rows = [(r["sync_start"], i, r) for i, r in enumerate(self.db.rows)
                if all(r.get(k) == v for k, v in self.filters.items())]
        rows.sort(key=lambda t: (t[0], t[1]), reverse=True)   # newest; ties: last written
        return _Resp([r for _, _, r in rows[:1]])


class _FakeDb:
    def __init__(self):
        self.rows: list[dict] = []
        self.fail_reads = False
        self.fail_writes = False

    def schema(self, _name):
        return self

    def from_(self, table):
        assert table == "sync_log", table
        return _SyncLogQuery(self)

    def write(self, _supa, source, data_type, status, records=0, error=None, **_k):
        if self.fail_writes:
            raise RuntimeError("synthetic write failure")
        self.rows.append({"source": source, "data_type": data_type, "status": status,
                          "error_message": error,
                          "sync_start": datetime.now(al.ET).isoformat()})


class _FakeModel:
    def __init__(self):
        self.seen: list[pd.DataFrame] = []

    def predict(self, X):
        self.seen.append(X.copy())
        return np.array([55.0])


def _live_frame() -> pd.DataFrame:
    """Two rows: 10 days ago (SPARSE_A observed) and behavioral today (SPARSE_A missing).
    The row-count fill carries the value one row on; the calendar fill does not (10 days)."""
    today = al.behavioral_today()
    return pd.DataFrame({
        "calendar_date": [(today - timedelta(days=10)).isoformat(), today.isoformat()],
        "whoop_hrv_rmssd": [52.0, NAN],
        "hrv_lag1": [50.0, 52.0],
        SPARSE_A: [30.0, NAN],
        DENSE: [1.0, 2.0],
    })


def _predict(hp, db, preprocessing="<absent>"):
    model = _FakeModel()
    bundle = {"model": model, "feat_cols": [SPARSE_A, DENSE], "pred_std": 10.0,
              "model_version": "2026-11-16_behavioral_v1", "alignment": al.ALIGNMENT_VERSION}
    if preprocessing != "<absent>":
        bundle["preprocessing"] = preprocessing
    frame = _live_frame()
    hp.get_latest_features = lambda feat_cols: (frame, frame[feat_cols])
    return hp.predict_tomorrow(bundle), model


def _heartbeats(db):
    return [r for r in db.rows if (r["source"], r["data_type"]) == ("hrv_predict", "preprocessing")]


def test_predict_serves_each_pickle_with_its_own_fill():
    import hrv_predict as hp
    db = _FakeDb()
    hp.supa = db
    hp._shared_log_sync = db.write

    # (a) a pickle from before the field: forecasts with its row fill + one partial heartbeat
    pred, model = _predict(hp, db)
    assert pred is not None and pred["predicted_hrv"] == 55.0
    assert model.seen[-1][SPARSE_A].iloc[0] == 30.0
    beats = _heartbeats(db)
    assert [b["status"] for b in beats] == ["partial"]
    assert "predates" in beats[0]["error_message"]
    assert not beats[0]["error_message"].startswith("GUARD")

    # (b) the next hourly run repeats nothing
    pred, _ = _predict(hp, db)
    assert pred is not None and len(_heartbeats(db)) == 1

    # (c) ... until the last row is 12 h old
    db.rows[-1]["sync_start"] = (datetime.now(al.ET) - timedelta(hours=13)).isoformat()
    _predict(hp, db)
    assert [b["status"] for b in _heartbeats(db)] == ["partial", "partial"]

    # (d) after a retrain: the calendar fill (10 days is too old), one "success" row
    pred, model = _predict(hp, db, h.SPARSE_FILL_VERSION)
    assert pred is not None
    assert np.isnan(model.seen[-1][SPARSE_A].iloc[0])
    assert _heartbeats(db)[-1]["status"] == "success"
    assert _heartbeats(db)[-1]["error_message"] is None
    n = len(_heartbeats(db))
    _predict(hp, db, h.SPARSE_FILL_VERSION)
    assert len(_heartbeats(db)) == n, "no row while nothing changes"

    # (e) a fill this code does not know (a newer pickle after a code rollback): refused
    pred, model = _predict(hp, db, "calendar_ffill_7d_v9")
    assert pred is None and not model.seen
    last = _heartbeats(db)[-1]
    assert last["status"] == "failed"
    assert last["error_message"].startswith("GUARD model_preprocessing:")


def test_heartbeat_problems_never_stop_a_forecast():
    import hrv_predict as hp
    db = _FakeDb()
    hp.supa = db
    hp._shared_log_sync = db.write

    # a fresh database never gets a "success" row (nothing to clear)
    pred, _ = _predict(hp, db, h.SPARSE_FILL_VERSION)
    assert pred is not None and _heartbeats(db) == []

    # the lookup fails: the partial row is written anyway and the forecast is made
    db.fail_reads = True
    pred, _ = _predict(hp, db)
    assert pred is not None
    assert [b["status"] for b in _heartbeats(db)] == ["partial"]

    # the write fails: the forecast is still made
    db.fail_reads, db.fail_writes = False, True
    db.rows.clear()
    pred, _ = _predict(hp, db)
    assert pred is not None and _heartbeats(db) == []
    assert hp.report_preprocessing("partial", "x") is False


def test_the_retrain_pickles_the_current_fill():
    src = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
    assert '"preprocessing": SPARSE_FILL_VERSION' in src
    # one fill function for training and serving; no row-count fill left in prepare_ml_data
    body = src.split("def prepare_ml_data(", 1)[1].split("\ndef ", 1)[0]
    assert "fill_sparse_features(df)" in body and ".ffill(" not in body


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS: {name}")
