"""Offline tests for emptying Cronometer days that no longer have food (PIPE-03).

The date-set replace (pds.replace_cronometer_servings) only touches dates that
have rows in an export, so a day whose last food was removed in Cronometer kept
its old servings and daily total in Onyx. The automated export now passes the
window it requested; run_import checks the export is the whole window
(check_trusted_export: well formed, inside the window, per-day sums equal the
daily totals) and pds.replace_cronometer_servings_window writes the servings and
daily totals in one transaction and empties the window's inner days that have no
food, with a backup copy and a per-run limit.

Everything is faked: no network, no database, no credentials, synthetic rows
only. FakeDB applies the SQL function's contract the way Postgres does
(validate, then change everything or nothing).

Run: python tests/test_cronometer_empty_days.py
"""
from __future__ import annotations

import contextlib
import copy
import io
import os
import re
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import cronometer_import as ci  # noqa: E402

WINDOW_SQL = ROOT / "sql" / "cronometer_replace_servings_window.sql"
LEGACY_SQL = ROOT / "sql" / "cronometer_replace_servings.sql"

W_START, W_END = date(2030, 1, 1), date(2030, 1, 10)
WINDOW = (W_START, W_END)
OUTSIDE = "2029-12-20"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data):
        self.data = data


class FakeAPIError(Exception):
    """Shaped like postgrest.exceptions.APIError (code + message)."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


_UNSET = object()


class FakeDB:
    """pds.cronometer_servings + cronometer_nutrition_daily + cronometer_cleared_rows
    behind the two replace functions. The importer may change the servings table only
    through a function (any direct write fails the test); reads are recorded."""

    def __init__(self, servings=(), daily=(), missing=(), rpc_error=None, reply=_UNSET,
                 read_error=None):
        self.servings = [dict(r) for r in servings]
        self.daily = {r["calendar_date"]: dict(r) for r in daily}
        self.cleared: list[dict] = []
        self.rpc_calls: list[tuple[str, dict]] = []
        self.sync_logs: list[dict] = []
        self.reads: list[str] = []
        self.direct_daily_upserts = 0
        self.missing = set(missing)      # function names not in the database yet
        self.rpc_error = rpc_error
        self.reply = reply
        self.read_error = read_error

    def schema(self, name):
        assert name == "pds", name
        return self

    def rpc(self, fn, params):
        return _Rpc(self, fn, params)

    def table(self, name):
        if name == "sync_log":
            return _Sink(self.sync_logs)
        if name == "user_tz_log":
            return _Empty()
        if name in ("cronometer_servings", "cronometer_nutrition_daily"):
            return _Table(self, name)
        raise AssertionError(f"importer touched pds.{name} directly")

    from_ = table

    # ── the two SQL functions ─────────────────────────────────────────────
    def _legacy(self, p):
        assert set(p) == {"p_dates", "p_rows"}, p.keys()
        dates, rows = p["p_dates"], p["p_rows"]
        if not rows:
            raise FakeAPIError("22023", "replace_cronometer_servings: p_rows is empty")
        if sorted(set(dates)) != sorted({r["calendar_date"] for r in rows}):
            raise FakeAPIError("22023", "replace_cronometer_servings: p_dates mismatch")
        before = len(self.servings)
        self.servings = [r for r in self.servings if r["calendar_date"] not in dates] + [dict(r) for r in rows]
        return {"dates": len(set(dates)), "deleted": before - (len(self.servings) - len(rows)),
                "inserted": len(rows)}

    def _window(self, p):
        assert set(p) == {"p_window_start", "p_window_end", "p_dates", "p_rows", "p_empty_dates",
                          "p_servings_empty_dates", "p_daily_rows", "p_max_cleared_days"}, p.keys()
        lo, hi = p["p_window_start"], p["p_window_end"]
        dates, rows, cap = p["p_dates"], p["p_rows"], p["p_max_cleared_days"]
        empty, s_empty, drows = set(p["p_empty_dates"]), set(p["p_servings_empty_dates"]), p["p_daily_rows"]
        ddates = [r["calendar_date"] for r in drows]
        bad = lambda msg: FakeAPIError("22023", f"replace_cronometer_servings_window: {msg}")  # noqa: E731
        if hi < lo:
            raise bad("the window ends before it starts")
        if (date.fromisoformat(hi) - date.fromisoformat(lo)).days + 1 > 400:
            raise bad("the window is too long")
        if not isinstance(cap, int) or cap < 0:
            raise bad("p_max_cleared_days must be 0 or more")
        if not rows and not drows and not empty and not s_empty:
            raise bad("no rows and no empty dates; nothing to do")
        if sorted(set(dates)) != sorted({r["calendar_date"] for r in rows}):
            raise bad("p_dates is not the set of calendar_date values in p_rows")
        if len(set(ddates)) != len(ddates):
            raise bad("a date appears twice in p_daily_rows")
        if any(not (lo <= d <= hi) for d in (*dates, *empty, *s_empty, *ddates)):
            raise bad("a date lies outside the window")
        if (set(dates) & empty) or (set(dates) & s_empty) or (empty & s_empty):
            raise bad("a date is in more than one of p_dates, p_empty_dates and p_servings_empty_dates")
        if empty & set(ddates):
            raise bad("a date in p_empty_dates has a row in p_daily_rows")
        if not s_empty <= set(ddates):
            raise bad("a date in p_servings_empty_dates has no row in p_daily_rows")
        if len({tuple(sorted(r)) for r in drows}) > 1:
            raise bad("the rows of p_daily_rows do not all carry the same keys")
        has_servings = lambda d: any(r["calendar_date"] == d for r in self.servings)  # noqa: E731
        populated = (sum(1 for d in empty if d in self.daily or has_servings(d))
                     + sum(1 for d in s_empty if has_servings(d)))
        out = {"dates": len(set(dates)), "deleted": 0, "inserted": 0, "daily_upserted": 0,
               "empty_dates": len(empty), "servings_empty_dates": len(s_empty),
               "populated_empty_days": populated, "cleared_days": 0, "cleared_servings": 0,
               "cleared_daily": 0, "refused_days": 0, "max_cleared_days": cap}
        if populated > cap:
            out["refused_days"] = populated
        elif populated:
            gone = [r for r in self.servings if r["calendar_date"] in empty | s_empty]
            self.servings = [r for r in self.servings if r["calendar_date"] not in empty | s_empty]
            gone_daily = [self.daily.pop(d) for d in sorted(empty) if d in self.daily]
            for r in gone:
                self.cleared.append({"source_table": "cronometer_servings", "calendar_date": r["calendar_date"],
                                     "window_start": lo, "window_end": hi, "row_data": dict(r)})
            for r in gone_daily:
                self.cleared.append({"source_table": "cronometer_nutrition_daily",
                                     "calendar_date": r["calendar_date"],
                                     "window_start": lo, "window_end": hi, "row_data": dict(r)})
            out.update(cleared_days=populated, cleared_servings=len(gone), cleared_daily=len(gone_daily))
        if rows:
            before = len(self.servings)
            self.servings = [r for r in self.servings if r["calendar_date"] not in dates] + [dict(r) for r in rows]
            out.update(deleted=before - (len(self.servings) - len(rows)), inserted=len(rows))
        for r in drows:   # ON CONFLICT (calendar_date) DO UPDATE: the sent columns win
            self.daily[r["calendar_date"]] = {**self.daily.get(r["calendar_date"], {}), **r}
        out["daily_upserted"] = len(drows)
        return out


class _Rpc:
    def __init__(self, db, fn, params):
        self.db, self.fn, self.params = db, fn, params

    def execute(self):
        db = self.db
        db.rpc_calls.append((self.fn, copy.deepcopy(self.params)))
        if self.fn in db.missing:
            raise FakeAPIError("PGRST202", f"Could not find the function pds.{self.fn} in the schema cache")
        if db.rpc_error is not None:
            raise db.rpc_error                       # transaction rolled back: nothing changes
        snapshot = (copy.deepcopy(db.servings), copy.deepcopy(db.daily), copy.deepcopy(db.cleared))
        try:
            if self.fn == "replace_cronometer_servings":
                out = db._legacy(self.params)
            elif self.fn == "replace_cronometer_servings_window":
                out = db._window(self.params)
            else:
                raise AssertionError(f"unexpected function {self.fn}")
        except Exception:
            db.servings, db.daily, db.cleared = snapshot
            raise
        return _Result(out if db.reply is _UNSET else db.reply)


class _Table:
    """Direct access to the two Cronometer tables: reads, and the daily upsert of the
    manual path / the not-usable path / the rollout fallback. Nothing else."""

    def __init__(self, db, name):
        self.db, self.name = db, name
        self.rows = None

    def select(self, cols):
        self.db.reads.append(self.name)
        return _Read(self.db, self.name)

    def upsert(self, rows, on_conflict=None):
        assert self.name == "cronometer_nutrition_daily", f"direct write to pds.{self.name}"
        assert on_conflict == "calendar_date", on_conflict
        self.rows = [dict(r) for r in rows]
        return self

    def execute(self):
        self.db.direct_daily_upserts += 1
        for r in self.rows:
            self.db.daily[r["calendar_date"]] = r
        return _Result(self.rows)


class _Read:
    def __init__(self, db, name):
        self.db, self.name = db, name
        self.dates, self.n = None, None

    def eq(self, col, value):
        assert col == "calendar_date"
        self.dates = {value}
        return self

    def in_(self, col, values):
        assert col == "calendar_date"
        self.dates = set(values)
        return self

    def limit(self, n):
        self.n = n
        return self

    def execute(self):
        if self.db.read_error is not None:
            raise self.db.read_error
        src = self.db.servings if self.name == "cronometer_servings" else list(self.db.daily.values())
        got = [{"calendar_date": r["calendar_date"]} for r in src
               if self.dates is None or r["calendar_date"] in self.dates]
        return _Result(got[:self.n] if self.n else got)


class _Sink:
    def __init__(self, sink):
        self.sink = sink

    def insert(self, row):
        self.sink.append(row)
        return self

    def execute(self):
        return _Result(None)


class _Empty:
    def select(self, *_a, **_k): return self
    def order(self, *_a, **_k): return self
    def execute(self): return _Result([])


# ---------------------------------------------------------------------------
# Synthetic data
# ---------------------------------------------------------------------------

S_HEADER = "Day,Time,Group,Food Name,Amount,Energy (kcal),Protein (g)"
D_HEADER = "Date,Group,Energy (kcal),Protein (g),Completed"


def _srow(day, name, kcal=100.0):
    return {"calendar_date": day, "food_name": name, "calories": kcal, "event_time": None,
            "onyx_et_date": day, "onyx_behavioral_date": day, "onyx_local_date": day,
            "onyx_tz_source": "cronometer_csv_date", "raw_json": {"Day": day, "Food Name": name}}


def _drow(day, kcal):
    return {"calendar_date": day, "onyx_et_date": day, "onyx_behavioral_date": day,
            "onyx_local_date": day, "onyx_tz_source": "cronometer_csv_date", "completed": None,
            "calories": kcal, "raw_json": {"by_group": {}}}


def _stored():
    """Synthetic stored state: three days in the window, one outside it."""
    servings = [_srow("2030-01-02", "test oats"), _srow("2030-01-02", "test tea"),
                _srow("2030-01-05", "test rice"), _srow("2030-01-07", "test soup"),
                _srow(OUTSIDE, "test outside")]
    daily = [_drow("2030-01-02", 200.0), _drow("2030-01-05", 100.0), _drow("2030-01-07", 100.0),
             _drow(OUTSIDE, 100.0)]
    return servings, daily


def _write(folder, name, lines):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write("\n".join(lines) + "\n")
    return path


def _export(folder, servings, daily=None):
    """servings: list of (day, food, kcal); daily (default: derived) list of (day, kcal)."""
    if daily is None:
        totals: dict[str, float] = {}
        for day, _food, kcal in servings:
            totals[day] = totals.get(day, 0.0) + kcal
        daily = sorted(totals.items())
    # Protein is kcal / 100 on both sides, so a day's servings add up to its daily
    # total exactly when the energy does (the importer compares both).
    s_lines = [S_HEADER] + [f"{d},8:00 AM,Breakfast,{food},1.00 serving,{kcal},{kcal / 100}"
                            for d, food, kcal in servings]
    d_lines = [D_HEADER] + [f"{d},Total,{kcal},{kcal / 100},false" for d, kcal in daily]
    return [_write(folder, "servings.csv", s_lines), _write(folder, "dailysummary.csv", d_lines)]


def _run(db, paths, **kw):
    saved = ci.create_client
    ci.create_client = lambda *_a, **_k: db
    try:
        return ci.run_import(paths, **kw)
    finally:
        ci.create_client = saved


def _names(db, day=None):
    return sorted(r["food_name"] for r in db.servings if day is None or r["calendar_date"] == day)


def _hb(db):
    return {r["data_type"]: r for r in db.sync_logs}


def _window_calls(db):
    return [p for fn, p in db.rpc_calls if fn == "replace_cronometer_servings_window"]


# ---------------------------------------------------------------------------
# Acceptance: an authoritative empty day is emptied, and only that day
# ---------------------------------------------------------------------------

def test_authoritative_empty_day_removes_that_day_only() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        # Cronometer now has no food on 2030-01-05; the other two days are unchanged.
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-02", "test tea", 100.0),
                              ("2030-01-07", "test soup", 100.0)])
        assert _run(db, paths, window=WINDOW) == (3, 2)
    assert _names(db, "2030-01-05") == [] and "2030-01-05" not in db.daily, "the empty day was kept"
    assert _names(db, "2030-01-02") == ["test oats", "test tea"]
    assert _names(db, "2030-01-07") == ["test soup"]
    assert _names(db, OUTSIDE) == ["test outside"] and OUTSIDE in db.daily, "a day outside the window changed"
    # Every removed row has a backup copy, tagged with its table and the window.
    backed = sorted((c["source_table"], c["calendar_date"]) for c in db.cleared)
    assert backed == [("cronometer_nutrition_daily", "2030-01-05"), ("cronometer_servings", "2030-01-05")]
    assert all(c["window_start"] == "2030-01-01" and c["window_end"] == "2030-01-10" for c in db.cleared)
    assert db.cleared[0]["row_data"]["calendar_date"] == "2030-01-05"
    # One call, one transaction, daily totals included; the inner food-less days were
    # passed but held nothing; the first and last day of the window are never passed.
    calls = _window_calls(db)
    assert len(db.rpc_calls) == 1 and len(calls) == 1 and db.direct_daily_upserts == 0
    p = calls[0]
    assert p["p_dates"] == ["2030-01-02", "2030-01-07"]
    assert [r["calendar_date"] for r in p["p_daily_rows"]] == ["2030-01-02", "2030-01-07"]
    assert p["p_empty_dates"] == ["2030-01-03", "2030-01-04", "2030-01-05", "2030-01-06",
                                  "2030-01-08", "2030-01-09"], p["p_empty_dates"]
    assert p["p_servings_empty_dates"] == [] and p["p_max_cleared_days"] == ci.DEFAULT_MAX_EMPTY_DAYS
    # The removal leaves a counts-only note on the servings heartbeat, which /status does
    # not show; the daily heartbeat (the Cronometer card) stays a clean success.
    hb = _hb(db)
    assert hb["servings"]["status"] == "success"
    note = hb["servings"]["error_message"]
    assert note.startswith("emptied 1 day(s)") and "pds.cronometer_cleared_rows" in note, note
    assert "test" not in note and "2030" not in note, "the note must carry counts only"
    assert hb["daily"]["status"] == "success" and hb["daily"]["error_message"] is None


def test_moving_the_last_serving_to_another_day_converges_and_a_retry_is_a_no_op() -> None:
    db = FakeDB([_srow("2030-01-03", "test bar")], [_drow("2030-01-03", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-04", "test bar", 100.0)])      # moved one day later
        _run(db, paths, window=WINDOW)
        state = (_names(db, "2030-01-03"), _names(db, "2030-01-04"), sorted(db.daily))
        assert state == ([], ["test bar"], ["2030-01-04"]), state
        n_backup = len(db.cleared)
        # A retry (same export, e.g. the next scheduled run) changes nothing more.
        _run(db, paths, window=WINDOW)
    assert (_names(db, "2030-01-03"), _names(db, "2030-01-04"), sorted(db.daily)) == state
    assert len(db.cleared) == n_backup == 2, "a retry backed the same rows up again"
    assert all(_hb(db)[k]["status"] == "success" for k in ("servings", "daily"))
    assert _hb(db)["servings"]["error_message"] is None, "the retry emptied nothing, so no note"


def test_order_of_two_overlapping_imports_does_not_matter() -> None:
    """Concurrent runs take turns (advisory lock, checked in the SQL test); whichever
    goes first, the result is the same as Cronometer's current state."""
    finals = []
    for order in ((WINDOW, (date(2030, 1, 4), date(2030, 1, 12))),
                  ((date(2030, 1, 4), date(2030, 1, 12)), WINDOW)):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        for window in order:
            lo, hi = window[0].isoformat(), window[1].isoformat()
            upstream = [("2030-01-02", "test oats", 100.0), ("2030-01-02", "test tea", 100.0),
                        ("2030-01-07", "test soup", 100.0)]
            with tempfile.TemporaryDirectory() as tmp:
                _run(db, _export(tmp, [r for r in upstream if lo <= r[0] <= hi]), window=window)
        finals.append((sorted((r["calendar_date"], r["food_name"]) for r in db.servings), sorted(db.daily)))
    assert finals[0] == finals[1], finals


def test_daily_totals_ride_in_the_same_transaction_as_the_servings() -> None:
    """Codex review: with the daily upsert as a separate request, an older import could
    put a day's daily total back after a newer import emptied it. Each automated import
    is now ONE call, so whatever order two imports land in, a day's servings and its
    daily row always come from the same import."""
    older = [("2030-01-02", "test oats", 100.0), ("2030-01-05", "test rice", 100.0)]
    newer = [("2030-01-02", "test oats", 100.0)]                    # 2030-01-05 emptied upstream
    for order in ((older, newer), (newer, older)):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        for export in order:
            with tempfile.TemporaryDirectory() as tmp:
                _run(db, _export(tmp, export), window=WINDOW)
        assert db.direct_daily_upserts == 0 and len(db.rpc_calls) == 2, "one write call per import"
        for day in ("2030-01-02", "2030-01-05", "2030-01-07"):
            assert bool(_names(db, day)) == (day in db.daily), (day, _names(db, day), sorted(db.daily))


def test_listed_day_with_no_food_loses_its_servings_and_keeps_the_exported_daily_row() -> None:
    # Cronometer can still list an emptied day in the daily summary (a non-food entry,
    # a day marked completed) with zero energy. Its servings go; its daily row is
    # rewritten from the export in the same transaction.
    db = FakeDB([_srow("2030-01-02", "test oats"), _srow("2030-01-05", "test rice")],
                [_drow("2030-01-02", 100.0), _drow("2030-01-05", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0)],
                        daily=[("2030-01-02", 100.0), ("2030-01-05", 0.0)])
        _run(db, paths, window=WINDOW)
        p = _window_calls(db)[0]
        assert p["p_servings_empty_dates"] == ["2030-01-05"] and "2030-01-05" not in p["p_empty_dates"]
        assert _names(db, "2030-01-05") == [], "the stale servings were kept"
        assert db.daily["2030-01-05"]["calories"] == 0.0, "the daily row must be the exported one"
        assert [(c["source_table"], c["calendar_date"]) for c in db.cleared] == \
            [("cronometer_servings", "2030-01-05")], "only the servings are removed (and backed up)"
        # A retry: nothing stored is left to empty, so no new backup and no limit trip.
        _run(db, paths, window=WINDOW, max_empty_days=0)
    assert len(db.cleared) == 1 and _window_calls(db)[1]["p_servings_empty_dates"] == ["2030-01-05"]
    assert _hb(db)["servings"]["status"] == "success" and _hb(db)["daily"]["status"] == "success"


def test_first_and_last_day_of_the_window_are_never_emptied() -> None:
    # Nothing has checked that Cronometer's start and end are inclusive; an edge day
    # missing from the export proves nothing (it is an inner day of a neighbouring run).
    db = FakeDB([_srow("2030-01-01", "test first"), _srow("2030-01-10", "test last"),
                 _srow("2030-01-05", "test rice")],
                [_drow("2030-01-01", 100.0), _drow("2030-01-10", 100.0), _drow("2030-01-05", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        _run(db, _export(tmp, [("2030-01-05", "test rice", 100.0)],
                         daily=[("2030-01-05", 100.0), ("2030-01-10", 0.0)]), window=WINDOW)
    p = _window_calls(db)[0]
    assert "2030-01-01" not in p["p_empty_dates"] and "2030-01-10" not in p["p_empty_dates"]
    assert p["p_servings_empty_dates"] == []
    assert _names(db, "2030-01-01") == ["test first"] and "2030-01-01" in db.daily
    assert _names(db, "2030-01-10") == ["test last"] and db.cleared == []


# ---------------------------------------------------------------------------
# Manual / unknown exports can never empty a day
# ---------------------------------------------------------------------------

def test_manual_export_without_a_window_never_empties_a_day() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        _run(db, paths)                                             # inbox / CLI: no window
        # A header-only manual export makes no call at all.
        _run(db, _export(tmp, []))
    assert [fn for fn, _ in db.rpc_calls] == ["replace_cronometer_servings"]
    assert _names(db, "2030-01-05") == ["test rice"] and _names(db, "2030-01-07") == ["test soup"]
    assert _names(db, "2030-01-02") == ["test oats"], "the date-set replace still works"
    assert db.cleared == []


def test_window_longer_than_the_bound_is_treated_as_manual() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    long_window = (date(2028, 6, 1), date(2030, 1, 10))          # 589 days
    assert ci.trusted_window(long_window) is None
    with tempfile.TemporaryDirectory() as tmp:
        _run(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=long_window)
    assert [fn for fn, _ in db.rpc_calls] == ["replace_cronometer_servings"]
    assert _names(db, "2030-01-05") == ["test rice"]


# ---------------------------------------------------------------------------
# Dry run: counts what a real run would empty, read only
# ---------------------------------------------------------------------------

def _dry(db, paths, **kw):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = _run(db, paths, window=WINDOW, dry_run=True, **kw)
    return result, out.getvalue()


def test_dry_run_counts_the_stored_days_a_real_run_would_empty() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = (_names(db), copy.deepcopy(db.daily))
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-07", "test soup", 100.0)])
        result, out = _dry(db, paths)
    assert result == (2, 2)
    assert "a real run would empty 1 stored day(s) (limit 3" in out, out
    assert db.rpc_calls == [] and db.sync_logs == [] and db.direct_daily_upserts == 0
    assert (_names(db), db.daily) == before and db.cleared == []
    assert db.reads, "the dry run must read the stored days"
    assert "test" not in out.split("empty days:", 1)[1], "counts only"


def test_dry_run_reports_a_refusal_and_an_unreadable_database() -> None:
    servings, daily = _stored()
    servings += [_srow("2030-01-08", "test extra"), _srow("2030-01-09", "test extra 2")]
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        _result, out = _dry(FakeDB(servings, daily), paths)
        assert "4 stored day(s) have no food any more, more than the limit of 3" in out, out
        _result, out = _dry(FakeDB(servings, daily, read_error=FakeAPIError("08006", "offline")), paths)
        assert "could not be read" in out, out


# ---------------------------------------------------------------------------
# The per-run limit, and a blank export
# ---------------------------------------------------------------------------

def test_more_stored_empty_days_than_the_limit_are_refused_and_say_so() -> None:
    servings, daily = _stored()
    servings += [_srow("2030-01-08", "test extra"), _srow("2030-01-09", "test extra 2")]
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        assert _run(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=WINDOW) == (1, 1)
    assert _names(db, "2030-01-05") == ["test rice"] and _names(db, "2030-01-09") == ["test extra 2"]
    assert db.cleared == [], "a refused run emptied something"
    assert _names(db, "2030-01-02") == ["test oats"], "the days with food are still written"
    hb = _hb(db)
    assert hb["servings"]["status"] == "partial" and hb["daily"]["status"] == "partial"
    msg = hb["servings"]["error_message"]
    assert "4 stored day(s)" in msg and "limit of 3" in msg and "--max-empty-days 4" in msg, msg
    assert "on a PC" in msg, "the scheduled run cannot take the override; say where to run it"
    assert hb["daily"]["error_message"].startswith("servings: "), "the /status card must show it"


def test_blank_export_never_empties_stored_days() -> None:
    # An export with no food anywhere in the window looks the same as a broken session.
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = (_names(db), sorted(db.daily))
    with tempfile.TemporaryDirectory() as tmp:
        assert _run(db, _export(tmp, []), window=WINDOW, max_empty_days=10) == (0, 0)
    assert (_names(db), sorted(db.daily)) == before and db.cleared == []
    assert _window_calls(db)[0]["p_max_cleared_days"] == 0
    hb = _hb(db)
    assert hb["servings"]["status"] == "partial" and hb["daily"]["status"] == "partial"
    assert "no food anywhere in the window" in hb["servings"]["error_message"]
    # With nothing stored in the window, a blank export is simply a quiet window.
    quiet = FakeDB([_srow(OUTSIDE, "test outside")], [_drow(OUTSIDE, 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        _run(quiet, _export(tmp, []), window=WINDOW)
    assert _hb(quiet)["servings"]["status"] == "success" and _names(quiet) == ["test outside"]


def test_limit_is_inclusive_and_zero_empties_nothing() -> None:
    servings, daily = _stored()
    with tempfile.TemporaryDirectory() as tmp:
        db = FakeDB(servings, daily)
        # Food only on a new day: the three stored days are exactly the limit.
        _run(db, _export(tmp, [("2030-01-08", "test new", 100.0)]), window=WINDOW, max_empty_days=3)
        assert _names(db) == ["test new", "test outside"] and sorted(db.daily) == [OUTSIDE, "2030-01-08"]
        db0 = FakeDB([_srow("2030-01-05", "test rice")])
        _run(db0, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=WINDOW, max_empty_days=0)
        assert _names(db0, "2030-01-05") == ["test rice"] and _hb(db0)["servings"]["status"] == "partial"
    for bad in (-1, 1.5, True, None):
        try:
            ci.import_servings_window([], [], WINDOW, ["2030-01-02"], [], bad, dry_run=False, sb=FakeDB())
        except ValueError:
            pass
        else:
            raise AssertionError(f"max_empty_days={bad!r} must be refused")


# ---------------------------------------------------------------------------
# Malformed / partial / inconsistent exports clear nothing
# ---------------------------------------------------------------------------

def _assert_nothing_written(db, before, reason_part):
    assert db.rpc_calls == [], "a servings function was called for an unusable export"
    assert _names(db) == before and db.cleared == []
    hb = _hb(db)
    assert hb["servings"]["status"] == "partial" and hb["servings"]["records_synced"] == 0
    assert reason_part in hb["servings"]["error_message"], hb["servings"]["error_message"]
    assert hb["daily"]["status"] == "partial", "the Cronometer card must show a partial run"


def test_cut_off_servings_row_writes_no_servings() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = _names(db)
    with tempfile.TemporaryDirectory() as tmp:
        spath, dpath = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        with open(spath, "a", encoding="utf-8") as f:
            f.write("2030-01-07,8:00 AM,Breakfast,test cut\n")        # cut off mid-row
        assert _run(db, [spath, dpath], window=WINDOW) == (0, 1)
    _assert_nothing_written(db, before, "do not have 7 cells")
    assert db.daily["2030-01-02"]["calories"] == 100.0, "a well-formed daily summary is still upserted"


def test_unreadable_date_writes_no_servings() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = _names(db)
    with tempfile.TemporaryDirectory() as tmp:
        spath, dpath = _export(tmp, [("2030-01-02", "test oats", 100.0), ("Jan 7th", "test soup", 1.0)],
                               daily=[("2030-01-02", 100.0)])
        _run(db, [spath, dpath], window=WINDOW)
    _assert_nothing_written(db, before, "no readable date")


def test_garbled_daily_summary_writes_neither_file() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before, daily_before = _names(db), copy.deepcopy(db.daily)
    with tempfile.TemporaryDirectory() as tmp:
        spath, dpath = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        with open(dpath, "a", encoding="utf-8") as f:
            f.write("2030-01-05,Total\n")
        assert _run(db, [spath, dpath], window=WINDOW) == (0, 0)
    _assert_nothing_written(db, before, "dailysummary.csv")
    assert db.daily == daily_before, "a garbled daily summary overwrote stored totals"
    assert "daily totals not written" in _hb(db)["daily"]["error_message"]


def test_export_without_a_servings_file_writes_no_servings() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = _names(db)
    with tempfile.TemporaryDirectory() as tmp:
        _spath, dpath = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        _run(db, [dpath], window=WINDOW)
    _assert_nothing_written(db, before, "no servings.csv")


def test_days_the_two_files_disagree_on_are_not_written_and_nothing_is_emptied() -> None:
    cases = [
        # (servings, daily, expected reason, day whose stored servings must survive, days written)
        ([("2030-01-02", "test oats", 100.0), ("2030-01-11", "test late", 1.0)], None,
         "outside the requested window", "2030-01-05", ["2030-01-02"]),
        ([("2030-01-02", "test oats", 100.0)], [], "no daily Total row", "2030-01-02", []),
        ([("2030-01-02", "test oats", 100.0)], [("2030-01-02", 100.0), ("2030-01-05", 300.0)],
         "shows food", "2030-01-05", ["2030-01-02"]),
        # A download cut off exactly between two rows: 2030-01-02 lost "test tea" but still
        # has a row, so only the sums against the daily total can tell.
        ([("2030-01-02", "test oats", 100.0), ("2030-01-07", "test soup", 100.0)],
         [("2030-01-02", 200.0), ("2030-01-07", 100.0)], "do not add up", "2030-01-02", ["2030-01-07"]),
    ]
    for srows, drows, reason, kept_day, written in cases:
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        kept = _names(db, kept_day)
        with tempfile.TemporaryDirectory() as tmp:
            _run(db, _export(tmp, srows, daily=drows), window=WINDOW)
        assert _names(db, kept_day) == kept, (reason, _names(db, kept_day))
        assert db.cleared == [] and _names(db, "2030-01-05") == ["test rice"], reason
        for p in _window_calls(db):
            assert p["p_empty_dates"] == [] and p["p_servings_empty_dates"] == [], reason
            assert p["p_dates"] == written, (reason, p["p_dates"])
            assert all("2030-01-01" <= r["calendar_date"] <= "2030-01-10" for r in p["p_daily_rows"]), \
                "a daily row outside the window was sent"
        hb = _hb(db)
        assert hb["servings"]["status"] == "partial" and reason in hb["servings"]["error_message"], \
            (reason, hb["servings"]["error_message"])
        assert hb["daily"]["status"] == "partial", reason


def test_sums_within_rounding_agree() -> None:
    # Per-row rounding must not make a day doubtful.
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test a", 33.33), ("2030-01-02", "test b", 33.33),
                              ("2030-01-02", "test c", 33.33)], daily=[("2030-01-02", 100.0)])
        check = ci.check_trusted_export(WINDOW, *paths)
    assert check.complete and check.skip_dates == (), check.reason


def test_scan_reasons_never_carry_row_contents() -> None:
    secret_food, secret_day = "Synthetic Marker Food", "Day Marker 77"
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp, "servings.csv", [S_HEADER,
                                            f"{secret_day},8:00 AM,Breakfast,{secret_food},1.00 g,5.0,1.0",
                                            f"2030-01-02,8:00 AM,Breakfast,{secret_food}"])
        scan = ci.scan_export_file(path, "servings")
        assert not scan.ok
        assert secret_food not in scan.reason and secret_day not in scan.reason, scan.reason
        nohdr = _write(tmp, "x.csv", ["Day,Group,Amount", "2030-01-02,Breakfast,1.00 g"])
        assert ci.scan_export_file(nohdr, "servings").reason == "servings.csv has no Food Name column"
        blank = _write(tmp, "b.csv", [S_HEADER, "", "2030-01-02,8:00 AM,Breakfast,f,1.00 g,5.0,1.0", ""])
        ok = ci.scan_export_file(blank, "servings")
        assert ok.ok and ok.by_date == {"2030-01-02": 1}, "blank lines must be ignored"
        # A mismatch reason names counts, never the day or a value.
        paths = _export(tmp, [("2030-01-02", secret_food, 100.0)], daily=[("2030-01-02", 250.0)])
        check = ci.check_trusted_export(WINDOW, *paths)
        assert not check.complete and "2030" not in check.reason and "250" not in check.reason


# ---------------------------------------------------------------------------
# Database failures, rollout order and replies
# ---------------------------------------------------------------------------

def test_failed_call_changes_nothing_and_has_no_second_path() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily, rpc_error=FakeAPIError("57014", "canceling statement due to statement timeout"))
    before = (_names(db), copy.deepcopy(db.daily))
    with tempfile.TemporaryDirectory() as tmp:
        try:
            _run(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=WINDOW)
        except FakeAPIError:
            pass
        else:
            raise AssertionError("run_import must re-raise")
    assert len(db.rpc_calls) == 1, "no retry and no fallback after a real failure"
    assert (_names(db), db.daily) == before and db.cleared == [] and db.direct_daily_upserts == 0
    hb = [r for r in db.sync_logs if r["data_type"] == "servings"]
    assert len(hb) == 1 and hb[0]["status"] == "error"


def test_function_raising_mid_transaction_rolls_everything_back() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = (_names(db), copy.deepcopy(db.daily))
    bad_rows = [_srow("2030-01-02", "test oats"), _srow("2030-01-11", "test outside window")]
    try:
        ci.import_servings_window(bad_rows, [_drow("2030-01-02", 100.0)], WINDOW, ["2030-01-05"], [], 3,
                                  dry_run=False, sb=db)
    except FakeAPIError as e:
        assert "outside the window" in str(e)
    else:
        raise AssertionError("the function must refuse a row outside the window")
    assert (_names(db), db.daily) == before and db.cleared == []


def test_missing_window_function_falls_back_to_the_date_set_replace() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily, missing={"replace_cronometer_servings_window"})
    with tempfile.TemporaryDirectory() as tmp:
        assert _run(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=WINDOW) == (1, 1)
    assert [fn for fn, _ in db.rpc_calls] == ["replace_cronometer_servings_window", "replace_cronometer_servings"]
    assert db.direct_daily_upserts == 1, "the daily totals go the usual way"
    assert _names(db, "2030-01-02") == ["test oats"], "days with food were not replaced"
    assert _names(db, "2030-01-05") == ["test rice"] and db.cleared == [], "the fallback emptied a day"
    hb = _hb(db)
    assert hb["servings"]["status"] == "partial"
    assert ci.REPLACE_WINDOW_SQL in hb["servings"]["error_message"]
    assert ci.REPLACE_WINDOW_SQL in hb["daily"]["error_message"]


def test_missing_function_names_are_not_confused() -> None:
    window_missing = FakeAPIError("PGRST202", "Could not find the function "
                                              "pds.replace_cronometer_servings_window(p_dates, p_empty_dates) "
                                              "in the schema cache")
    legacy_missing = FakeAPIError("PGRST202", "Could not find the function "
                                              "pds.replace_cronometer_servings(p_dates, p_rows) in the schema cache")
    assert ci._is_missing_function(window_missing, ci.REPLACE_WINDOW_RPC)
    assert not ci._is_missing_function(window_missing, ci.REPLACE_SERVINGS_RPC)
    assert ci._is_missing_function(legacy_missing, ci.REPLACE_SERVINGS_RPC)
    assert not ci._is_missing_function(legacy_missing, ci.REPLACE_WINDOW_RPC)
    # Both functions missing: the fallback's own clear error names the legacy SQL file.
    db = FakeDB([_srow("2030-01-02", "x")],
                missing={"replace_cronometer_servings_window", "replace_cronometer_servings"})
    try:
        ci.import_servings_window([_srow("2030-01-02", "y")], [], WINDOW, [], [], 3, dry_run=False, sb=db)
    except RuntimeError as e:
        assert ci.REPLACE_SERVINGS_SQL in str(e) and "No servings were changed" in str(e)
    else:
        raise AssertionError("both functions missing must raise")
    assert _names(db) == ["x"]


def test_reply_that_does_not_confirm_the_import_raises() -> None:
    good = {"inserted": 1, "daily_upserted": 0, "cleared_days": 0, "cleared_servings": 0,
            "cleared_daily": 0, "refused_days": 0}
    for reply in (None, [], "ok", {**good, "inserted": 0}, {**good, "refused_days": "1"},
                  {k: v for k, v in good.items() if k != "cleared_days"}, {**good, "cleared_days": -1},
                  {**good, "daily_upserted": 1}, {k: v for k, v in good.items() if k != "daily_upserted"}):
        db = FakeDB(reply=reply)
        try:
            ci.import_servings_window([_srow("2030-01-02", "a")], [], WINDOW, [], [], 3, dry_run=False, sb=db)
        except RuntimeError as e:
            assert "cannot be confirmed" in str(e)
        else:
            raise AssertionError(f"reply {reply!r} must not count as a confirmed import")


def test_nothing_to_do_makes_no_call() -> None:
    db = FakeDB()
    out = ci.import_servings_window([], [], WINDOW, [], [], 3, dry_run=False, sb=db)
    assert out["mode"] == "none" and db.rpc_calls == []


# ---------------------------------------------------------------------------
# The automated exporter: only it passes a window, and failures reach nothing
# ---------------------------------------------------------------------------

def _etl():
    os.environ.setdefault("CRONOMETER_EMAIL", "synthetic@example.invalid")
    os.environ.setdefault("CRONOMETER_PASSWORD", "synthetic")
    import cronometer_etl
    return cronometer_etl


class _Patch:
    def __init__(self, module, **attrs):
        self.module, self.attrs, self.saved = module, attrs, {}

    def __enter__(self):
        for k, v in self.attrs.items():
            self.saved[k] = getattr(self.module, k)
            setattr(self.module, k, v)
        return self

    def __exit__(self, *_exc):
        for k, v in self.saved.items():
            setattr(self.module, k, v)


def _fake_auth(*_a, **_k):
    return "PERM", "POLICY", 1


def test_etl_passes_the_window_it_requested() -> None:
    etl = _etl()
    seen = {}

    def fake_run_import(paths, dry_run=False, window=None, max_empty_days=None):
        seen.update(paths=paths, dry_run=dry_run, window=window, max_empty_days=max_empty_days)
        return 0, 0

    requested = []

    def fake_export(_client, _token, generate, start, end):
        requested.append((generate, start, end))
        return (S_HEADER if generate == "servings" else D_HEADER) + "\n"

    with _Patch(etl, authenticate_session=_fake_auth, mint_token=lambda *a, **k: "TOKEN",
                export_csv=fake_export, _save_session=lambda *a, **k: None, run_import=fake_run_import):
        etl.fetch_and_import(days=14, dry_run=True, max_empty_days=2)
        start, end = seen["window"]
        assert (end - start).days == 14 and seen["max_empty_days"] == 2 and seen["dry_run"] is True
        assert requested == [("servings", start.isoformat(), end.isoformat()),
                             ("dailySummary", start.isoformat(), end.isoformat())]
        # The switch off: imported like a manual export (no window, nothing emptied).
        seen.clear()
        etl.fetch_and_import(days=14, dry_run=True, empty_days=False)
        assert seen["window"] is None


def test_etl_switch_reads_the_flag_and_the_environment() -> None:
    etl = _etl()
    saved = os.environ.pop("CRONOMETER_EMPTY_DAYS", None)
    try:
        assert etl.empty_days_enabled(False) is True
        assert etl.empty_days_enabled(True) is False
        for off in ("off", "OFF", "0", "false", "no"):
            os.environ["CRONOMETER_EMPTY_DAYS"] = off
            assert etl.empty_days_enabled(False) is False, off
        os.environ["CRONOMETER_EMPTY_DAYS"] = "on"
        assert etl.empty_days_enabled(False) is True
    finally:
        os.environ.pop("CRONOMETER_EMPTY_DAYS", None)
        if saved is not None:
            os.environ["CRONOMETER_EMPTY_DAYS"] = saved


def test_etl_auth_or_export_failure_never_reaches_the_importer() -> None:
    etl = _etl()
    calls = []

    def boom(*_a, **_k):
        raise RuntimeError("Cronometer login failed: synthetic")

    def export_fails_on_daily(_client, _token, generate, _start, _end):
        if generate == "dailySummary":
            raise RuntimeError("dailySummary export returned no CSV (token expired or rejected)")
        return S_HEADER + "\n"

    for patches in ({"authenticate_session": boom},
                    {"authenticate_session": _fake_auth, "mint_token": boom},
                    {"authenticate_session": _fake_auth, "mint_token": lambda *a, **k: "T",
                     "export_csv": export_fails_on_daily}):
        with _Patch(etl, _save_session=lambda *a, **k: None,
                    run_import=lambda *a, **k: calls.append(1) or (0, 0), **patches):
            try:
                etl.fetch_and_import(days=30, dry_run=False)
            except RuntimeError:
                pass
            else:
                raise AssertionError("the failure must propagate")
    assert calls == [], "the importer ran after a failed login / export"


def test_etl_end_to_end_empties_a_day_removed_in_cronometer() -> None:
    etl = _etl()
    today = date.today()
    d_kept, d_gone = (today - timedelta(days=3)).isoformat(), (today - timedelta(days=2)).isoformat()
    db = FakeDB([_srow(d_kept, "test oats"), _srow(d_gone, "test rice")],
                [_drow(d_kept, 100.0), _drow(d_gone, 100.0)])

    def fake_export(_client, _token, generate, _start, _end):
        if generate == "servings":
            return "﻿" + S_HEADER + f"\n{d_kept},8:00 AM,Breakfast,test oats,1.00 g,100.0,1.0\n"
        return "﻿" + D_HEADER + f"\n{d_kept},Total,100.0,1.0,false\n"

    saved = ci.create_client
    ci.create_client = lambda *_a, **_k: db
    try:
        with _Patch(etl, authenticate_session=_fake_auth, mint_token=lambda *a, **k: "TOKEN",
                    export_csv=fake_export, _save_session=lambda *a, **k: None):
            assert etl.fetch_and_import(days=30, dry_run=False) == (1, 1)
    finally:
        ci.create_client = saved
    assert _names(db, d_kept) == ["test oats"] and _names(db, d_gone) == []
    assert sorted(db.daily) == [d_kept]
    assert {c["calendar_date"] for c in db.cleared} == {d_gone}


# ---------------------------------------------------------------------------
# Static checks on the SQL the ship stage reviews and applies
# ---------------------------------------------------------------------------

def _code(path):
    raw = path.read_text(encoding="utf-8")
    code = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())   # drop comments
    return raw, re.sub(r"\s+", " ", code)


def test_window_sql_contract() -> None:
    raw, flat = _code(WINDOW_SQL)
    upper = flat.upper()
    assert ci.REPLACE_WINDOW_SQL == "sql/cronometer_replace_servings_window.sql" and WINDOW_SQL.is_file()

    # The argument names are the keys the importer sends (PostgREST matches by name).
    sig = re.search(r"FUNCTION pds\.replace_cronometer_servings_window\(([^)]*)\) RETURNS jsonb", flat)
    assert sig, "function signature not found"
    args = [a.strip().split(" ")[0] for a in sig.group(1).split(",")]
    db = FakeDB()
    ci.import_servings_window([_srow("2030-01-02", "a")], [_drow("2030-01-02", 100.0)], WINDOW,
                              ["2030-01-03"], [], 3, dry_run=False, sb=db)
    assert sorted(args) == sorted(db.rpc_calls[0][1]), (args, db.rpc_calls[0][1].keys())

    # The word the Supabase connector refuses never appears, not even in a comment.
    assert "DROP" not in raw.upper()
    for word in ("TRUNCATE", "SECURITY DEFINER"):
        assert word not in upper, f"unexpected {word.strip()}"
    # The only UPDATE is the daily upsert's ON CONFLICT branch.
    assert upper.count("UPDATE ") == 1 and "ON CONFLICT (calendar_date) DO UPDATE SET %s" in flat

    # Exactly three deletes, each scoped to the dates it may touch.
    deletes = re.findall(r"DELETE FROM [^;]*?(?:;|RETURNING)", flat)
    assert len(deletes) == 3 and upper.count("DELETE ") == 3, deletes
    assert ("DELETE FROM pds.cronometer_servings s WHERE s.calendar_date = ANY (v_empty || v_sempty) "
            "RETURNING") in flat
    assert "DELETE FROM pds.cronometer_nutrition_daily n WHERE n.calendar_date = ANY (v_empty) RETURNING" in flat
    assert "DELETE FROM pds.cronometer_servings WHERE calendar_date = ANY (v_arg_dates);" in flat
    # Every empty-day delete feeds the backup table in the same statement.
    assert flat.count("INSERT INTO pds.cronometer_cleared_rows") == 2
    assert flat.count("RETURNING s.* ) INSERT INTO pds.cronometer_cleared_rows") == 1
    assert flat.count("RETURNING n.* ) INSERT INTO pds.cronometer_cleared_rows") == 1

    # Lock first (same key as the date-set function), then count, then the limit, then
    # delete, and the daily upsert inside the same locked transaction.
    lock = "pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'))"
    _legacy_raw, legacy_flat = _code(LEGACY_SQL)
    assert lock in flat and lock in legacy_flat, "the two functions must share one lock"
    i_lock, i_count = flat.index(lock), flat.index("SELECT count(*) INTO v_populated")
    i_limit = flat.index("IF v_populated > p_max_cleared_days THEN v_refused := v_populated;")
    i_delete = flat.index("DELETE FROM")
    i_daily = flat.index("INSERT INTO pds.cronometer_nutrition_daily")
    assert i_lock < i_count < i_limit < i_delete < i_daily
    # A servings-emptied day counts only when it still holds servings.
    assert ("SELECT u.d FROM unnest(v_sempty) AS u(d) WHERE EXISTS (SELECT 1 FROM pds.cronometer_servings s "
            "WHERE s.calendar_date = u.d)) AS stored;") in flat

    # Bounded window and dates, same bound as the importer.
    assert f"(p_window_end - p_window_start) + 1 > {ci.MAX_WINDOW_DAYS}" in flat
    assert "p_window_end > current_date + 2" in flat
    assert "WHERE u.d < p_window_start OR u.d > p_window_end" in flat
    assert "(v_empty && coalesce(v_arg_dates, '{}'::date[]))" in flat and "(v_empty && v_sempty)" in flat
    assert "IF v_empty && v_daily_dates THEN" in flat and "IF NOT (v_sempty <@ v_daily_dates) THEN" in flat
    assert "v_row_dates IS DISTINCT FROM v_arg_dates" in flat
    assert "a date appears twice in p_daily_rows" in flat
    assert "do not all carry the same keys" in flat

    # Caller's rights, fixed search_path, service_role only (function and backup table).
    assert "SECURITY INVOKER" in upper and "SET search_path = pds, pg_temp" in flat
    fsig = "pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], jsonb, integer)"
    assert f"REVOKE ALL ON FUNCTION {fsig} FROM PUBLIC;" in flat
    assert f"REVOKE ALL ON FUNCTION {fsig} FROM anon, authenticated;" in flat
    assert f"GRANT EXECUTE ON FUNCTION {fsig} TO service_role;" in flat
    assert "ALTER TABLE pds.cronometer_cleared_rows ENABLE ROW LEVEL SECURITY;" in flat
    assert "REVOKE ALL ON pds.cronometer_cleared_rows FROM anon, authenticated;" in flat
    grants = re.findall(r"GRANT [^;]*;", flat)
    assert grants and all(g.endswith("TO service_role;") for g in grants), grants
    assert not re.search(r"\b(TO|FOR\s+\w+\s+TO)\s+(anon|authenticated)\b", flat.replace("FROM anon", "")), \
        "nothing may be granted to anon or authenticated"


def test_legacy_function_is_unchanged_by_this_feature() -> None:
    _raw, flat = _code(LEGACY_SQL)
    assert "FUNCTION pds.replace_cronometer_servings(p_dates date[], p_rows jsonb)" in flat
    assert "replace_cronometer_servings_window" not in flat
    assert "p_rows is empty" in flat, "the date-set function must still refuse to wipe days"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    if failures:
        print(f"{failures} failure(s)")
        sys.exit(1)
    print("OK - cronometer empty-day tests passed.")
