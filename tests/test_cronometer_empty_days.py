"""Offline tests for emptying Cronometer days that no longer have food (PIPE-03).

The date-set replace (pds.replace_cronometer_servings) only touches dates that
have rows in an export, so a day whose last food was removed in Cronometer kept
its old servings and daily total in Onyx. The automated export now passes the
window it requested; run_import checks the export is the whole window
(check_trusted_export: well formed, inside the window, every nutrient cell blank
or a number, per-day sums equal the daily totals) and
pds.replace_cronometer_servings_window writes the servings and daily totals in one
transaction and empties the days without food that lie between two days with food
in the same export, on a second look at least 6 h after the first, with a backup
copy and a per-run limit. Manual imports write servings and daily totals in one
call too (pds.replace_cronometer_servings_and_daily), never empty a day, and start
the empty-day count of every day they write over.

Everything is faked: no network, no database, no credentials, synthetic rows
only. FakeDB applies the SQL functions' contracts the way Postgres does
(validate, then change everything or nothing), with its own clock for now().

Run: python tests/test_cronometer_empty_days.py
"""
from __future__ import annotations

import contextlib
import copy
import csv
import io
import os
import re
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
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
LATER = ci.EMPTY_CONFIRM_HOURS + 1          # hours between two looks that count as two
SOON = ci.EMPTY_CONFIRM_HOURS - 4           # hours between two looks that do not

LEGACY_FN = "replace_cronometer_servings"
COMBINED_FN = "replace_cronometer_servings_and_daily"
WINDOW_FN = "replace_cronometer_servings_window"
CANDIDATES = "cronometer_empty_day_candidates"


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
    """pds.cronometer_servings + cronometer_nutrition_daily + cronometer_cleared_rows +
    cronometer_empty_day_candidates behind the three import functions. The importer
    may change the servings table only through a function (any direct write fails
    the test); reads are recorded. `now` is the database clock (now() in the SQL)."""

    def __init__(self, servings=(), daily=(), missing=(), rpc_error=None, reply=_UNSET,
                 read_error=None, unreadable=()):
        self.servings = [dict(r) for r in servings]
        self.daily = {r["calendar_date"]: dict(r) for r in daily}
        self.cleared: list[dict] = []
        self.candidates: dict[str, dict] = {}
        self.now = datetime(2030, 1, 10, 12, 0, tzinfo=timezone.utc)
        self.rpc_calls: list[tuple[str, dict]] = []
        self.sync_logs: list[dict] = []
        self.reads: list[str] = []
        self.direct_daily_upserts = 0
        self.missing = set(missing)      # function names not in the database yet
        self.rpc_error = rpc_error
        self.reply = reply
        self.read_error = read_error
        self.unreadable = set(unreadable)

    def advance(self, hours):
        self.now += timedelta(hours=hours)

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
        if name in ("cronometer_servings", "cronometer_nutrition_daily", CANDIDATES):
            return _Table(self, name)
        raise AssertionError(f"importer touched pds.{name} directly")

    from_ = table

    def _has_servings(self, day):
        return any(r["calendar_date"] == day for r in self.servings)

    # ── the SQL functions ─────────────────────────────────────────────────
    def _legacy(self, p):
        assert set(p) == {"p_dates", "p_rows"}, p.keys()
        dates, rows = p["p_dates"], p["p_rows"]
        if not rows:
            raise FakeAPIError("22023", "replace_cronometer_servings: p_rows is empty")
        if sorted(set(dates)) != sorted({r["calendar_date"] for r in rows}):
            raise FakeAPIError("22023", "replace_cronometer_servings: p_dates mismatch")
        if any(k in ("serving_id", "synced_at") for r in rows for k in r):
            raise FakeAPIError("22023", "replace_cronometer_servings: keys that are not writable columns")
        before = len(self.servings)
        self.servings = [r for r in self.servings if r["calendar_date"] not in dates] + [dict(r) for r in rows]
        return {"dates": len(set(dates)), "deleted": before - (len(self.servings) - len(rows)),
                "inserted": len(rows)}

    def _upsert_daily(self, drows):
        """pds.cronometer_upsert_daily."""
        bad = lambda msg: FakeAPIError("22023", f"cronometer_upsert_daily: {msg}")  # noqa: E731
        ddates = [r.get("calendar_date") for r in drows]
        if any(not d for d in ddates):
            raise bad("every element of p_daily_rows must be a JSON object with a calendar_date")
        if len(set(ddates)) != len(ddates):
            raise bad("a date appears twice in p_daily_rows")
        if len({tuple(sorted(r)) for r in drows}) > 1:
            raise bad("the rows of p_daily_rows do not all carry the same keys")
        for r in drows:   # ON CONFLICT (calendar_date) DO UPDATE: the sent columns win
            self.daily[r["calendar_date"]] = {**self.daily.get(r["calendar_date"], {}), **r}
        return len(drows)

    def _combined(self, p):
        assert set(p) == {"p_dates", "p_rows", "p_daily_rows"}, p.keys()
        dates, rows, drows = p["p_dates"], p["p_rows"], p["p_daily_rows"]
        bad = lambda msg: FakeAPIError("22023", f"replace_cronometer_servings_and_daily: {msg}")  # noqa: E731
        if not rows and dates:
            raise bad("date(s) but no rows; this function never empties a day")
        if not rows and not drows:
            raise bad("no rows; nothing to do")
        # every date this import writes starts its empty-day count over
        for d in set(dates) | {r.get("calendar_date") for r in drows}:
            self.candidates.pop(d, None)
        out = {"dates": 0, "deleted": 0, "inserted": 0}
        if rows:
            out = self._legacy({"p_dates": dates, "p_rows": rows})
        return {**out, "daily_upserted": self._upsert_daily(drows)}

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
        if any(not (lo <= d <= hi) for d in (*dates, *empty, *s_empty, *ddates)):
            raise bad("a date lies outside the window")
        if (set(dates) & empty) or (set(dates) & s_empty) or (empty & s_empty):
            raise bad("a date is in more than one of p_dates, p_empty_dates and p_servings_empty_dates")
        if empty & set(ddates):
            raise bad("a date in p_empty_dates has a row in p_daily_rows")
        if not s_empty <= set(ddates):
            raise bad("a date in p_servings_empty_dates has no row in p_daily_rows")
        # coverage: food on both sides of every empty date, in this export
        first, last = (min(dates), max(dates)) if dates else (None, None)
        if any(first is None or not (first < d < last) for d in empty | s_empty):
            raise bad("an empty date does not lie strictly between the first and last date of p_dates")
        # 5. a day with food in this export starts its count over
        for d in (set(dates) | set(ddates)) - s_empty:
            self.candidates.pop(d, None)
        # 6. stored empty days, and those an earlier look at least 6 h ago confirms
        stored = sorted([d for d in empty if d in self.daily or self._has_servings(d)]
                        + [d for d in s_empty if self._has_servings(d)])
        cutoff = self.now - timedelta(hours=6)
        confirmed = [d for d in stored if d in self.candidates and self.candidates[d]["first_seen_at"] <= cutoff]
        out = {"dates": len(set(dates)), "deleted": 0, "inserted": 0, "daily_upserted": 0,
               "empty_dates": len(empty), "servings_empty_dates": len(s_empty),
               "populated_empty_days": len(stored), "confirmed_days": len(confirmed),
               "pending_days": 0, "cleared_days": 0, "cleared_servings": 0,
               "cleared_daily": 0, "refused_days": 0, "max_cleared_days": cap}
        # 7. the limit counts every stored empty day; then all confirmed or none
        if len(stored) > cap:
            out["refused_days"] = len(stored)
            kept = stored
        else:
            if confirmed:
                gone = [r for r in self.servings if r["calendar_date"] in confirmed]
                self.servings = [r for r in self.servings if r["calendar_date"] not in confirmed]
                gone_daily = [self.daily.pop(d) for d in confirmed if d in empty and d in self.daily]
                for r in gone:
                    self.cleared.append({"source_table": "cronometer_servings",
                                         "calendar_date": r["calendar_date"],
                                         "window_start": lo, "window_end": hi, "row_data": dict(r)})
                for r in gone_daily:
                    self.cleared.append({"source_table": "cronometer_nutrition_daily",
                                         "calendar_date": r["calendar_date"],
                                         "window_start": lo, "window_end": hi, "row_data": dict(r)})
                out.update(cleared_days=len(confirmed), cleared_servings=len(gone), cleared_daily=len(gone_daily))
            kept = [d for d in stored if d not in confirmed]
            out["pending_days"] = len(kept)
        # 8. keep the record of the days not emptied; forget those holding nothing
        for d in (empty | s_empty) - set(kept):
            self.candidates.pop(d, None)
        for d in kept:
            if d in self.candidates:
                self.candidates[d]["last_seen_at"] = self.now
                self.candidates[d]["times_seen"] += 1
            else:
                self.candidates[d] = {"first_seen_at": self.now, "last_seen_at": self.now, "times_seen": 1}
        # 9. + 10. replace through the date-set function, then the daily upsert
        if rows:
            r = self._legacy({"p_dates": dates, "p_rows": rows})
            out.update(deleted=r["deleted"], inserted=r["inserted"])
        out["daily_upserted"] = self._upsert_daily(drows)
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
        snapshot = copy.deepcopy((db.servings, db.daily, db.cleared, db.candidates))
        try:
            if self.fn == LEGACY_FN:
                out = db._legacy(self.params)
            elif self.fn == COMBINED_FN:
                out = db._combined(self.params)
            elif self.fn == WINDOW_FN:
                out = db._window(self.params)
            else:
                raise AssertionError(f"unexpected function {self.fn}")
        except Exception:
            db.servings, db.daily, db.cleared, db.candidates = snapshot
            raise
        return _Result(out if db.reply is _UNSET else db.reply)


class _Table:
    """Direct access to the Cronometer tables: reads, and the daily upsert of the
    rollout fallback (the functions not applied yet). Nothing else."""

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
        if self.name in self.db.unreadable:
            raise FakeAPIError("42P01", f'relation "pds.{self.name}" does not exist')
        if self.name == CANDIDATES:
            got = [{"calendar_date": d, "first_seen_at": c["first_seen_at"].isoformat()}
                   for d, c in sorted(self.db.candidates.items())
                   if self.dates is None or d in self.dates]
            return _Result(got)
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


UPSTREAM = [("2030-01-02", "test oats", 100.0), ("2030-01-02", "test tea", 100.0),
            ("2030-01-07", "test soup", 100.0)]          # _stored() with 2030-01-05 emptied


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


def _two_looks(db, paths, **kw):
    """The same export seen by two automated runs far enough apart to count."""
    _run(db, paths, **kw)
    db.advance(LATER)
    return _run(db, paths, **kw)


def _names(db, day=None):
    return sorted(r["food_name"] for r in db.servings if day is None or r["calendar_date"] == day)


def _hb(db):
    return {r["data_type"]: r for r in db.sync_logs}      # the newest heartbeat per data_type


def _calls(db, fn):
    return [p for f, p in db.rpc_calls if f == fn]


def _consistent(db, days):
    """A day's servings and its daily row always come from the same import."""
    for day in days:
        assert bool(_names(db, day)) == (day in db.daily), (day, _names(db, day), sorted(db.daily))


# ---------------------------------------------------------------------------
# Acceptance: an authoritative empty day is emptied (on the second look), and only that day
# ---------------------------------------------------------------------------

def test_authoritative_empty_day_removes_that_day_only() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        # Cronometer now has no food on 2030-01-05; the other two days are unchanged.
        paths = _export(tmp, UPSTREAM)
        # First look: recorded, not emptied yet, and the run is a clean success.
        assert _run(db, paths, window=WINDOW) == (3, 2)
        assert _names(db, "2030-01-05") == ["test rice"] and "2030-01-05" in db.daily
        assert sorted(db.candidates) == ["2030-01-05"] and db.cleared == []
        hb = _hb(db)
        assert hb["servings"]["status"] == "success" and hb["daily"]["status"] == "success"
        note = hb["servings"]["error_message"]
        assert note.startswith("1 stored day(s) have no food") and f"{ci.EMPTY_CONFIRM_HOURS} h" in note, note
        assert hb["daily"]["error_message"] is None, "the /status card stays clean"
        # Second look, later: emptied.
        db.advance(LATER)
        assert _run(db, paths, window=WINDOW) == (3, 2)
    assert _names(db, "2030-01-05") == [] and "2030-01-05" not in db.daily, "the empty day was kept"
    assert _names(db, "2030-01-02") == ["test oats", "test tea"]
    assert _names(db, "2030-01-07") == ["test soup"]
    assert _names(db, OUTSIDE) == ["test outside"] and OUTSIDE in db.daily, "a day outside the window changed"
    assert db.candidates == {}, "an emptied day is no longer waiting"
    # Every removed row has a backup copy, tagged with its table and the window.
    backed = sorted((c["source_table"], c["calendar_date"]) for c in db.cleared)
    assert backed == [("cronometer_nutrition_daily", "2030-01-05"), ("cronometer_servings", "2030-01-05")]
    assert all(c["window_start"] == "2030-01-01" and c["window_end"] == "2030-01-10" for c in db.cleared)
    assert db.cleared[0]["row_data"]["calendar_date"] == "2030-01-05"
    # One call per run, one transaction, daily totals included. Only the food-less
    # days between the first and last day with food (01-02, 01-07) were passed (the
    # others held nothing); the days after the newest day with food never are.
    calls = _calls(db, WINDOW_FN)
    assert len(db.rpc_calls) == 2 and len(calls) == 2 and db.direct_daily_upserts == 0
    p = calls[1]
    assert p["p_dates"] == ["2030-01-02", "2030-01-07"]
    assert [r["calendar_date"] for r in p["p_daily_rows"]] == ["2030-01-02", "2030-01-07"]
    assert p["p_empty_dates"] == ["2030-01-03", "2030-01-04", "2030-01-05", "2030-01-06"], p["p_empty_dates"]
    assert p["p_servings_empty_dates"] == [] and p["p_max_cleared_days"] == ci.DEFAULT_MAX_EMPTY_DAYS
    # The removal leaves a counts-only note on the servings heartbeat, which /status does
    # not show; the daily heartbeat (the Cronometer card) stays a clean success.
    hb = _hb(db)
    assert hb["servings"]["status"] == "success"
    note = hb["servings"]["error_message"]
    assert note.startswith("emptied 1 day(s)") and "pds.cronometer_cleared_rows" in note, note
    assert "test" not in note and "2030" not in note, "the note must carry counts only"
    assert hb["daily"]["status"] == "success" and hb["daily"]["error_message"] is None


def test_one_run_is_one_look_even_when_both_files_miss_the_same_day() -> None:
    """Codex review: servings.csv and dailysummary.csv can both miss a day that has food,
    and then they agree with each other. Agreement is not coverage, so a day is only
    emptied when a second export, at least 6 h later, still shows it empty."""
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        partial = _export(tmp, UPSTREAM)                     # both files miss 2030-01-05
        assert ci.check_trusted_export(WINDOW, *partial).complete, "the pair passes every file check"
        _run(db, partial, window=WINDOW)
        first_seen = db.candidates["2030-01-05"]["first_seen_at"]
        # The same miss again soon after (a manual re-run) is not a second look.
        db.advance(SOON)
        _run(db, partial, window=WINDOW)
        assert _names(db, "2030-01-05") == ["test rice"] and db.cleared == []
        assert db.candidates["2030-01-05"]["first_seen_at"] == first_seen
        assert db.candidates["2030-01-05"]["times_seen"] == 2
        # A complete export that shows the food again: the count starts over.
        db.advance(LATER)
        with tempfile.TemporaryDirectory() as tmp2:
            _run(db, _export(tmp2, UPSTREAM + [("2030-01-05", "test rice", 100.0)]), window=WINDOW)
        assert db.candidates == {} and _names(db, "2030-01-05") == ["test rice"]
        # Missed once more: a first look again, so still nothing is emptied.
        db.advance(LATER)
        _run(db, partial, window=WINDOW)
        assert _names(db, "2030-01-05") == ["test rice"] and "2030-01-05" in db.daily and db.cleared == []
        # Only a second miss, late enough, empties it.
        db.advance(LATER)
        _run(db, partial, window=WINDOW)
    assert _names(db, "2030-01-05") == [] and "2030-01-05" not in db.daily
    assert {c["calendar_date"] for c in db.cleared} == {"2030-01-05"}


def test_moving_the_last_serving_to_another_day_converges_and_a_retry_is_a_no_op() -> None:
    around = [("2030-01-02", "test oats", 100.0), ("2030-01-06", "test soup", 100.0)]
    db = FakeDB([_srow("2030-01-02", "test oats"), _srow("2030-01-03", "test bar"), _srow("2030-01-06", "test soup")],
                [_drow("2030-01-02", 100.0), _drow("2030-01-03", 100.0), _drow("2030-01-06", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, around + [("2030-01-04", "test bar", 100.0)])      # moved one day later
        _run(db, paths, window=WINDOW)
        assert _names(db, "2030-01-04") == ["test bar"] and _names(db, "2030-01-03") == ["test bar"]
        db.advance(LATER)
        _run(db, paths, window=WINDOW)
        state = (_names(db, "2030-01-03"), _names(db, "2030-01-04"), sorted(db.daily))
        assert state == ([], ["test bar"], ["2030-01-02", "2030-01-04", "2030-01-06"]), state
        n_backup = len(db.cleared)
        # A retry (same export, e.g. the next scheduled run) changes nothing more.
        db.advance(LATER)
        _run(db, paths, window=WINDOW)
    assert (_names(db, "2030-01-03"), _names(db, "2030-01-04"), sorted(db.daily)) == state
    assert len(db.cleared) == n_backup == 2, "a retry backed the same rows up again"
    assert all(_hb(db)[k]["status"] == "success" for k in ("servings", "daily"))
    assert _hb(db)["servings"]["error_message"] is None, "the retry emptied nothing, so no note"
    assert db.candidates == {}


def test_order_of_two_overlapping_imports_does_not_matter() -> None:
    """Concurrent runs take turns (advisory lock, checked in the SQL test); whichever
    goes first, the result is the same as Cronometer's current state."""
    finals = []
    for order in ((WINDOW, (date(2030, 1, 4), date(2030, 1, 12))),
                  ((date(2030, 1, 4), date(2030, 1, 12)), WINDOW)):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        for _round in range(2):
            for window in order:
                lo, hi = window[0].isoformat(), window[1].isoformat()
                with tempfile.TemporaryDirectory() as tmp:
                    _run(db, _export(tmp, [r for r in UPSTREAM if lo <= r[0] <= hi]), window=window)
            if _round == 0:
                # Two overlapping runs at the same moment are one look, not two.
                assert _names(db, "2030-01-05") == ["test rice"]
                db.advance(LATER)
        finals.append((sorted((r["calendar_date"], r["food_name"]) for r in db.servings), sorted(db.daily)))
    assert finals[0] == finals[1], finals
    assert ("2030-01-05", "test rice") not in finals[0][0]


def test_daily_totals_ride_in_the_same_transaction_as_the_servings() -> None:
    """With the daily upsert as a separate request, an older import could put a day's
    daily total back after a newer import emptied it. Each automated import is ONE
    call, so whatever order imports land in, a day's servings and its daily row
    always come from the same import."""
    older = [("2030-01-02", "test oats", 100.0), ("2030-01-05", "test rice", 100.0),
             ("2030-01-07", "test soup", 100.0)]
    newer = [("2030-01-02", "test oats", 100.0), ("2030-01-07", "test soup", 100.0)]   # 01-05 emptied upstream
    for sequence in ((newer, "later", newer, older), (older, newer, "later", newer, older),
                     (newer, "later", older, newer)):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        for step in sequence:
            if step == "later":
                db.advance(LATER)
                continue
            with tempfile.TemporaryDirectory() as tmp:
                _run(db, _export(tmp, step), window=WINDOW)
            _consistent(db, ("2030-01-02", "2030-01-05", "2030-01-07"))
        assert db.direct_daily_upserts == 0 and all(f == WINDOW_FN for f, _ in db.rpc_calls)


def test_listed_day_with_no_food_loses_its_servings_and_keeps_the_exported_daily_row() -> None:
    # Cronometer can still list an emptied day in the daily summary (a non-food entry,
    # a day marked completed) with every nutrient at zero. Its servings go; its daily
    # row is rewritten from the export in the same transaction.
    db = FakeDB([_srow("2030-01-02", "test oats"), _srow("2030-01-05", "test rice"), _srow("2030-01-07", "test soup")],
                [_drow("2030-01-02", 100.0), _drow("2030-01-05", 100.0), _drow("2030-01-07", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-07", "test soup", 100.0)],
                        daily=[("2030-01-02", 100.0), ("2030-01-05", 0.0), ("2030-01-07", 100.0)])
        _two_looks(db, paths, window=WINDOW)
        p = _calls(db, WINDOW_FN)[-1]
        assert p["p_servings_empty_dates"] == ["2030-01-05"] and "2030-01-05" not in p["p_empty_dates"]
        assert _names(db, "2030-01-05") == [], "the stale servings were kept"
        assert db.daily["2030-01-05"]["calories"] == 0.0, "the daily row must be the exported one"
        assert [(c["source_table"], c["calendar_date"]) for c in db.cleared] == \
            [("cronometer_servings", "2030-01-05")], "only the servings are removed (and backed up)"
        # A retry: nothing stored is left to empty, so no new backup and no limit trip.
        db.advance(LATER)
        _run(db, paths, window=WINDOW, max_empty_days=0)
    assert len(db.cleared) == 1 and _calls(db, WINDOW_FN)[-1]["p_servings_empty_dates"] == ["2030-01-05"]
    assert _hb(db)["servings"]["status"] == "success" and _hb(db)["daily"]["status"] == "success"


def test_zero_calorie_day_with_water_or_caffeine_is_not_empty() -> None:
    """Codex + Claude review: the daily summary's food signal was energy only, so a day
    holding only water or a zero-calorie caffeinated drink, missing from a cut
    servings download, read as empty. Every nutrient column now counts."""
    header_s = "Day,Time,Group,Food Name,Amount,Energy (kcal),Protein (g),Caffeine (mg),Water (g)"
    header_d = "Date,Group,Energy (kcal),Protein (g),Caffeine (mg),Water (g),Completed"
    for drink in ("0,0,0,500", "0,0,80,240"):              # water only; a diet drink with caffeine
        db = FakeDB([_srow("2030-01-02", "test oats"), _srow("2030-01-05", "test drink", 0.0)],
                    [_drow("2030-01-02", 100.0), _drow("2030-01-05", 0.0)])
        with tempfile.TemporaryDirectory() as tmp:
            spath = _write(tmp, "servings.csv", [header_s,
                                                 "2030-01-02,8:00 AM,Breakfast,test oats,1.00 g,100,1,0,0"])
            dpath = _write(tmp, "dailysummary.csv", [header_d, "2030-01-02,Total,100,1,0,0,false",
                                                     f"2030-01-05,Total,{drink},false"])
            check = ci.check_trusted_export(WINDOW, spath, dpath)
            assert not check.complete and "shows food on 1 day(s)" in check.reason, check.reason
            assert "2030-01-05" not in check.servings_empty_dates + check.empty_dates
            _two_looks(db, [spath, dpath], window=WINDOW)
        assert _names(db, "2030-01-05") == ["test drink"] and db.cleared == [], drink
        assert db.candidates == {} and _hb(db)["servings"]["status"] == "partial"
    # A day whose every nutrient is zero is still a day with no food (food on both sides).
    with tempfile.TemporaryDirectory() as tmp:
        spath = _write(tmp, "servings.csv", [header_s, "2030-01-02,8:00 AM,Breakfast,test oats,1.00 g,100,1,0,0",
                                             "2030-01-07,8:00 AM,Breakfast,test soup,1.00 g,100,1,0,0"])
        dpath = _write(tmp, "dailysummary.csv", [header_d, "2030-01-02,Total,100,1,0,0,false",
                                                 "2030-01-05,Total,0,0,0,0,true",
                                                 "2030-01-07,Total,100,1,0,0,false"])
        assert ci.check_trusted_export(WINDOW, spath, dpath).servings_empty_dates == ("2030-01-05",)


def test_first_and_last_day_of_the_window_are_never_emptied() -> None:
    # Nothing has checked that Cronometer's start and end are inclusive; an edge day
    # missing from the export proves nothing (it is an inner day of a neighbouring run).
    # An edge day can never have food on both sides inside the window, so it is never offered.
    db = FakeDB([_srow("2030-01-01", "test first"), _srow("2030-01-10", "test last"),
                 _srow("2030-01-05", "test rice"), _srow("2030-01-07", "test soup")],
                [_drow("2030-01-01", 100.0), _drow("2030-01-10", 100.0), _drow("2030-01-05", 100.0),
                 _drow("2030-01-07", 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        _two_looks(db, _export(tmp, [("2030-01-05", "test rice", 100.0), ("2030-01-07", "test soup", 100.0)],
                               daily=[("2030-01-05", 100.0), ("2030-01-07", 100.0), ("2030-01-10", 0.0)]),
                   window=WINDOW)
    for p in _calls(db, WINDOW_FN):
        assert "2030-01-01" not in p["p_empty_dates"] and "2030-01-10" not in p["p_empty_dates"]
        assert p["p_empty_dates"] == ["2030-01-06"] and p["p_servings_empty_dates"] == []
    assert _names(db, "2030-01-01") == ["test first"] and "2030-01-01" in db.daily
    assert _names(db, "2030-01-10") == ["test last"] and db.cleared == [] and db.candidates == {}


# ---------------------------------------------------------------------------
# Manual / unknown exports can never empty a day, and write in one call
# ---------------------------------------------------------------------------

def test_manual_export_without_a_window_never_empties_a_day() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0)])
        _run(db, paths)                                             # inbox / CLI: no window
        db.advance(LATER)
        _run(db, paths)
        # A header-only manual export makes no call at all.
        _run(db, _export(tmp, []))
    assert [fn for fn, _ in db.rpc_calls] == [COMBINED_FN, COMBINED_FN]
    assert _names(db, "2030-01-05") == ["test rice"] and _names(db, "2030-01-07") == ["test soup"]
    assert _names(db, "2030-01-02") == ["test oats"], "the date-set replace still works"
    assert db.cleared == [] and db.candidates == {} and db.direct_daily_upserts == 0
    p = db.rpc_calls[0][1]
    assert p["p_dates"] == ["2030-01-02"] and [r["calendar_date"] for r in p["p_daily_rows"]] == ["2030-01-02"]
    hb = _hb(db)
    assert hb["servings"]["status"] == "success" and hb["daily"]["status"] == "success"


def test_manual_import_writes_servings_and_daily_together_around_an_emptied_day() -> None:
    """Codex review: the manual path wrote its daily totals as a separate request, so
    "manual servings, then the automated export empties the day, then the manual
    daily row" left an old daily total with no servings under it, and the
    behavioural view shows that fallback row. Now each import is ONE call under the
    shared lock, so whichever order they land in, servings and daily row agree.
    The manual import also starts the day's empty-day count over (Codex review), so
    an automated export right after it is a first look again."""
    stale = [("2030-01-02", "test oats", 100.0), ("2030-01-05", "test rice", 100.0)]
    days = ("2030-01-02", "2030-01-05", "2030-01-07")
    for manual_after in (True, False):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tmp2:
            auto = _export(tmp, UPSTREAM)
            manual = _export(tmp2, stale)
            _run(db, auto, window=WINDOW)                   # first look at 2030-01-05
            db.advance(LATER)
            steps = [("auto", auto), ("manual", manual)] if manual_after else [("manual", manual), ("auto", auto)]
            for kind, paths in steps:
                _run(db, paths, window=WINDOW) if kind == "auto" else _run(db, paths)
                _consistent(db, days)
            # Either way the day has food now: the manual import wrote it last, or it
            # wrote it before the automated export, which then only looked once.
            assert _names(db, "2030-01-05") == ["test rice"], manual_after
            assert ("2030-01-05" in db.candidates) == (not manual_after), "the first look after the manual write"
            if not manual_after:
                db.advance(LATER)                            # the second look after it
                _run(db, auto, window=WINDOW)
                _consistent(db, days)
                assert _names(db, "2030-01-05") == [] and "2030-01-05" not in db.daily
        assert db.direct_daily_upserts == 0
        manual_calls = _calls(db, COMBINED_FN)
        assert len(manual_calls) == 1 and manual_calls[0]["p_daily_rows"], "one call, daily rows included"


def test_any_write_of_a_day_starts_its_empty_day_count_over() -> None:
    """Codex review (round 3): only the window function forgot a first look when food came
    back. After a manual import (or a run with emptying off, which imports the same
    way) or an automated daily-only write showed food on the day, the old first look
    survived, so the next automated export that missed the day emptied it on ONE
    look. Every writer now forgets the record of each day it writes, in the same
    transaction and under the same lock."""
    restored = UPSTREAM + [("2030-01-05", "test rice", 100.0)]

    def manual(db, folder):
        _run(db, _export(folder, restored))

    def daily_only(db, folder):
        # An automated export whose servings are unusable: only its daily rows are
        # written, and they show food on 2030-01-05 again.
        spath, dpath = _export(folder, restored)
        with open(spath, "a", encoding="utf-8") as f:
            f.write("2030-01-07,8:00 AM,Breakfast,test cut\n")
        _run(db, [spath, dpath], window=WINDOW)

    for name, writer in (("manual import", manual), ("daily-only write", daily_only)):
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tmp2:
            missed = _export(tmp, UPSTREAM)
            _run(db, missed, window=WINDOW)                          # first look at 2030-01-05
            assert "2030-01-05" in db.candidates, name
            db.advance(LATER)
            writer(db, tmp2)                                         # food on the day again
            assert db.candidates == {}, f"{name} left the old first look behind"
            _run(db, missed, window=WINDOW)                          # missed again: a first look only
            assert _names(db, "2030-01-05") == ["test rice"] and "2030-01-05" in db.daily, name
            assert db.candidates["2030-01-05"]["first_seen_at"] == db.now, name
            db.advance(LATER)
            _run(db, missed, window=WINDOW)                          # the second look
        assert _names(db, "2030-01-05") == [] and "2030-01-05" not in db.daily, name
        assert {c["calendar_date"] for c in db.cleared} == {"2030-01-05"}, name


def test_window_longer_than_the_bound_is_treated_as_manual() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    long_window = (date(2028, 6, 1), date(2030, 1, 10))          # 589 days
    assert ci.trusted_window(long_window) is None
    with tempfile.TemporaryDirectory() as tmp:
        _two_looks(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=long_window)
    assert [fn for fn, _ in db.rpc_calls] == [COMBINED_FN, COMBINED_FN]
    assert _names(db, "2030-01-05") == ["test rice"]


def test_window_must_be_plain_dates() -> None:
    # A datetime is a date subclass; its isoformat() would match no exported day and
    # make every inner day look empty.
    for bad in ((datetime(2030, 1, 1), datetime(2030, 1, 10)), (W_START, datetime(2030, 1, 10)),
                ("2030-01-01", "2030-01-10"), (W_END, W_START)):
        try:
            ci.trusted_window(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"window {bad!r} must be refused")
    assert ci.trusted_window(WINDOW) == WINDOW and ci.trusted_window(None) is None


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
        assert "a real run would empty 0 of 1 stored day(s)" in out and "the other 1 wait" in out, out
        # A day an earlier export already showed empty, long enough ago, counts as emptied.
        db.candidates["2030-01-05"] = {"first_seen_at": datetime(2000, 1, 1, tzinfo=timezone.utc),
                                       "last_seen_at": datetime(2000, 1, 1, tzinfo=timezone.utc),
                                       "times_seen": 1}
        _result, out = _dry(db, paths)
        assert "a real run would empty 1 of 1 stored day(s)" in out, out
        # The record cannot be read (the SQL is not applied yet): says so.
        _result, out2 = _dry(FakeDB(servings, daily, unreadable={CANDIDATES}), paths)
        assert "could not be read" in out2, out2
    assert db.rpc_calls == [] and db.sync_logs == [] and db.direct_daily_upserts == 0
    assert (_names(db), db.daily) == before and db.cleared == []
    assert set(db.reads) == {"cronometer_servings", "cronometer_nutrition_daily", CANDIDATES}
    assert "test" not in out.split("empty days:", 1)[1], "counts only"


def test_dry_run_reports_a_refusal_and_an_unreadable_database() -> None:
    servings, daily = _stored()
    servings += [_srow("2030-01-08", "test extra"), _srow("2030-01-09", "test extra 2")]
    with tempfile.TemporaryDirectory() as tmp:
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-10", "test late", 100.0)])
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
        # Food on the first and the last day of the export brackets every stored day.
        paths = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-10", "test late", 100.0)])
        assert _two_looks(db, paths, window=WINDOW) == (2, 2)
        assert _names(db, "2030-01-05") == ["test rice"] and _names(db, "2030-01-09") == ["test extra 2"]
        assert db.cleared == [], "a refused run emptied something"
        assert _names(db, "2030-01-02") == ["test oats"], "the days with food are still written"
        hb = _hb(db)
        assert hb["servings"]["status"] == "partial" and hb["daily"]["status"] == "partial"
        msg = hb["servings"]["error_message"]
        assert "4 stored day(s)" in msg and "limit of 3" in msg and "--max-empty-days 4" in msg, msg
        assert "on a PC" in msg, "the scheduled run cannot take the override; say where to run it"
        # The override run must keep the CI session in step (download before, upload after).
        assert msg.index("ci_token_helper.py download cronometer") < msg.index("--max-empty-days 4") \
            < msg.index("ci_token_helper.py upload cronometer"), msg
        assert len(msg) <= 500, "the heartbeat keeps 500 characters"
        assert hb["daily"]["error_message"].startswith("servings: "), "the /status card must show it"
        # A refused day keeps its record, so the override run (after checking Cronometer)
        # empties the days two looks have confirmed.
        assert sorted(db.candidates) == ["2030-01-05", "2030-01-07", "2030-01-08", "2030-01-09"]
        _run(db, paths, window=WINDOW, max_empty_days=4)
    assert _names(db) == ["test late", "test oats", "test outside"]
    assert sorted(db.daily) == [OUTSIDE, "2030-01-02", "2030-01-10"]
    assert _hb(db)["servings"]["status"] == "success"


def test_a_blank_export_empties_nothing() -> None:
    """Codex review (round 3): two looks hours apart are not coverage. A blank export
    (no food anywhere in the window, which is also what a logging pause returns)
    shows no date it covered, so it never offers a day for emptying, however many
    looks, and makes no call at all."""
    db = FakeDB([_srow("2030-01-05", "test rice"), _srow(OUTSIDE, "test outside")],
                [_drow("2030-01-05", 100.0), _drow(OUTSIDE, 100.0)])
    with tempfile.TemporaryDirectory() as tmp:
        blank = _export(tmp, [])
        for _look in range(3):
            assert _run(db, blank, window=WINDOW, max_empty_days=10) == (0, 0)
            db.advance(LATER)
    assert _names(db) == ["test outside", "test rice"] and sorted(db.daily) == [OUTSIDE, "2030-01-05"]
    assert db.rpc_calls == [] and db.cleared == [] and db.candidates == {}
    hb = _hb(db)
    assert hb["servings"]["status"] == "success" and hb["servings"]["error_message"] is None
    assert hb["daily"]["status"] == "success", "a quiet window is a healthy run"


def test_a_day_without_food_on_both_sides_waits_for_a_later_day_with_food() -> None:
    """Codex review (round 3): an export cut short after its newest day with food, in
    both files, passes every file check and looks the same on two looks. A day past
    the newest day with food is therefore never emptied; once a later day has food,
    the export shows it covered the day, and two such looks empty it."""
    db = FakeDB([_srow("2030-01-02", "test oats"), _srow("2030-01-05", "test rice"), _srow("2030-01-07", "test soup")],
                [_drow("2030-01-02", 100.0), _drow("2030-01-05", 100.0), _drow("2030-01-07", 100.0)])
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tmp2:
        cut = _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-05", "test rice", 100.0)])
        check = ci.check_trusted_export(WINDOW, *cut)
        assert check.complete and "2030-01-07" not in check.empty_dates, check.empty_dates
        assert check.empty_dates == ("2030-01-03", "2030-01-04"), "only days between days with food"
        for _look in range(3):
            _run(db, cut, window=WINDOW)
            db.advance(LATER)
        assert _names(db, "2030-01-07") == ["test soup"] and "2030-01-07" in db.daily and db.cleared == []
        assert db.candidates == {}
        # Food on a later day: 01-07 is now between two days with food.
        later = _export(tmp2, [("2030-01-02", "test oats", 100.0), ("2030-01-05", "test rice", 100.0),
                               ("2030-01-09", "test new", 100.0)])
        _run(db, later, window=WINDOW)
        assert _names(db, "2030-01-07") == ["test soup"] and "2030-01-07" in db.candidates, "first look"
        db.advance(LATER)
        _run(db, later, window=WINDOW)
    assert _names(db, "2030-01-07") == [] and "2030-01-07" not in db.daily
    assert {c["calendar_date"] for c in db.cleared} == {"2030-01-07"}


def test_function_refuses_an_empty_date_without_food_on_both_sides() -> None:
    """The coverage rule is enforced by the database function too (FakeDB mirrors it):
    a caller cannot empty a day past its newest day with food, or with no food."""
    for rows, empty in (([], ["2030-01-05"]),
                        ([_srow("2030-01-02", "a")], ["2030-01-05"]),
                        ([_srow("2030-01-02", "a"), _srow("2030-01-05", "b")], ["2030-01-07"]),
                        ([_srow("2030-01-02", "a"), _srow("2030-01-05", "b")], ["2030-01-02"])):
        db = FakeDB([_srow("2030-01-07", "test soup")], [_drow("2030-01-07", 100.0)])
        db.candidates["2030-01-07"] = {"first_seen_at": db.now - timedelta(hours=LATER),
                                       "last_seen_at": db.now - timedelta(hours=LATER), "times_seen": 1}
        before = (_names(db), copy.deepcopy(db.daily), copy.deepcopy(db.candidates))
        try:
            ci.import_servings_window(rows, [], WINDOW, empty, [], 3, dry_run=False, sb=db)
        except FakeAPIError as e:
            assert "strictly between" in str(e) or "more than one" in str(e), str(e)
        else:
            raise AssertionError(f"rows {[r['calendar_date'] for r in rows]} with empty {empty} must be refused")
        assert (_names(db), db.daily, db.candidates) == before and db.cleared == []


def test_limit_is_inclusive_and_zero_empties_nothing() -> None:
    servings, daily = _stored()
    with tempfile.TemporaryDirectory() as tmp:
        db = FakeDB(servings, daily)
        # Food only on two new days around them: the three stored days are exactly the limit.
        _two_looks(db, _export(tmp, [("2030-01-01", "test first", 100.0), ("2030-01-08", "test new", 100.0)]),
                   window=WINDOW, max_empty_days=3)
        assert _names(db) == ["test first", "test new", "test outside"]
        assert sorted(db.daily) == [OUTSIDE, "2030-01-01", "2030-01-08"]
        db0 = FakeDB([_srow("2030-01-05", "test rice")])
        _two_looks(db0, _export(tmp, [("2030-01-02", "test oats", 100.0), ("2030-01-07", "test soup", 100.0)]),
                   window=WINDOW, max_empty_days=0)
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
    assert _calls(db, WINDOW_FN) == [], "the window function was called for an unusable export"
    assert all(not p["p_rows"] and not p["p_dates"] for p in _calls(db, COMBINED_FN)), "servings were sent"
    assert _calls(db, LEGACY_FN) == [] and db.direct_daily_upserts == 0
    assert _names(db) == before and db.cleared == [] and db.candidates == {}
    hb = _hb(db)
    assert hb["servings"]["status"] == "partial" and hb["servings"]["records_synced"] == 0
    assert reason_part in hb["servings"]["error_message"], hb["servings"]["error_message"]
    assert hb["daily"]["status"] == "partial", "the Cronometer card must show a partial run"


def test_cut_off_servings_row_writes_no_servings() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = _names(db)
    with tempfile.TemporaryDirectory() as tmp:
        # The daily summary also lists a day outside the requested window.
        spath, dpath = _export(tmp, [("2030-01-02", "test oats", 100.0)],
                               daily=[("2030-01-02", 100.0), (OUTSIDE, 50.0)])
        with open(spath, "a", encoding="utf-8") as f:
            f.write("2030-01-07,8:00 AM,Breakfast,test cut\n")        # cut off mid-row
        assert _run(db, [spath, dpath], window=WINDOW) == (0, 1)
    _assert_nothing_written(db, before, "do not have 7 cells")
    assert db.daily["2030-01-02"]["calories"] == 100.0, "a well-formed daily summary is still upserted"
    # ... in one call under the shared lock, and only inside the window (Claude review).
    (p,) = _calls(db, COMBINED_FN)
    assert [r["calendar_date"] for r in p["p_daily_rows"]] == ["2030-01-02"]
    assert db.daily[OUTSIDE]["calories"] == 100.0, "a daily row outside the window was written"


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
    assert db.rpc_calls == [] and db.daily == daily_before, "a garbled daily summary overwrote stored totals"
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
            _two_looks(db, _export(tmp, srows, daily=drows), window=WINDOW)
        assert _names(db, kept_day) == kept, (reason, _names(db, kept_day))
        assert db.cleared == [] and _names(db, "2030-01-05") == ["test rice"], reason
        assert db.candidates == {}, reason
        for p in _calls(db, WINDOW_FN):
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


def test_unreadable_or_missing_values_are_never_zero_and_clear_nothing() -> None:
    """Codex review (round 3): `to_num(...) or 0.0` turned an unreadable cell into 0, so
    a garbled daily row could read as "no food" and later empty a day. An unreadable
    or non-finite nutrient cell, or a daily Total row with no Energy value, now puts
    that day in doubt: its servings and (when the doubt is in the daily summary) that
    daily row are not written, and nothing is emptied."""
    for bad in ("SyntheticMarker", "nan", "inf", "-inf", "1e999"):
        assert ci.to_num(bad) is None, bad
        assert ci.strict_num(bad) == (False, None), bad
    assert ci.strict_num("") == (True, None) and ci.strict_num("0") == (True, 0.0)
    cases = [
        # (line appended to dailysummary.csv, line appended to servings.csv, reason,
        #  days whose daily row must not be written)
        ("2030-01-05,Total,SyntheticMarker,0,true", None, "not a number", ("2030-01-05",)),
        ("2030-01-05,Total,nan,0,true", None, "not a number", ("2030-01-05",)),
        ("2030-01-05,Total,inf,0,true", None, "not a number", ("2030-01-05",)),
        ("2030-01-05,Total,,0,true", None, "no Energy value", ("2030-01-05",)),
        # A serving cell nobody can read: that day keeps its stored servings.
        (None, "2030-01-07,9:00 AM,Lunch,test extra,1.00 g,0,SyntheticMarker", "not a number", ()),
    ]
    for daily_line, serving_line, reason, daily_skip in cases:
        servings, daily = _stored()
        db = FakeDB(servings, daily)
        with tempfile.TemporaryDirectory() as tmp:
            spath, dpath = _export(tmp, UPSTREAM)
            for path, line in ((dpath, daily_line), (spath, serving_line)):
                if line:
                    with open(path, "a", encoding="utf-8") as f:
                        f.write(line + "\n")
            check = ci.check_trusted_export(WINDOW, spath, dpath)
            assert check.usable and not check.complete, reason
            assert reason in check.reason and "SyntheticMarker" not in check.reason, check.reason
            assert check.daily_skip_dates == daily_skip, check.daily_skip_dates
            assert check.empty_dates == () and check.servings_empty_dates == ()
            _two_looks(db, [spath, dpath], window=WINDOW)
        assert _names(db, "2030-01-05") == ["test rice"] and db.daily["2030-01-05"]["calories"] == 100.0, reason
        assert _names(db, "2030-01-07") == ["test soup"], "a day with an unreadable serving was replaced"
        assert db.cleared == [] and db.candidates == {}, reason
        for p in _calls(db, WINDOW_FN):
            sent = [r["calendar_date"] for r in p["p_daily_rows"]]
            assert not set(sent) & set(daily_skip), "a daily row with an unreadable value was written"
            assert p["p_empty_dates"] == [] and p["p_servings_empty_dates"] == []
        hb = _hb(db)
        assert hb["servings"]["status"] == "partial" and hb["daily"]["status"] == "partial", reason


def test_unreadable_daily_value_keeps_the_stored_row_when_the_servings_are_unusable() -> None:
    # The daily-only write of an unusable export leaves out the same rows.
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    with tempfile.TemporaryDirectory() as tmp:
        spath, dpath = _export(tmp, UPSTREAM)
        with open(dpath, "a", encoding="utf-8") as f:
            f.write("2030-01-05,Total,SyntheticMarker,0,true\n")
        with open(spath, "a", encoding="utf-8") as f:
            f.write("2030-01-07,8:00 AM,Breakfast,test cut\n")        # cut off mid-row
        _run(db, [spath, dpath], window=WINDOW)
    (p,) = _calls(db, COMBINED_FN)
    assert p["p_rows"] == [] and [r["calendar_date"] for r in p["p_daily_rows"]] == ["2030-01-02", "2030-01-07"]
    assert db.daily["2030-01-05"]["calories"] == 100.0 and _names(db, "2030-01-05") == ["test rice"]


def test_a_file_without_an_energy_column_is_not_usable() -> None:
    """Codex review (round 3): the per-day comparison used only the nutrients both files
    share, so a servings file without nutrient columns compared nothing and passed.
    Both files must carry Energy; without it no servings are written and nothing is
    emptied."""
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    before = _names(db)
    with tempfile.TemporaryDirectory() as tmp:
        spath = _write(tmp, "servings.csv", ["Day,Time,Group,Food Name,Amount",
                                             "2030-01-02,8:00 AM,Breakfast,test oats,1.00 g",
                                             "2030-01-07,8:00 AM,Breakfast,test soup,1.00 g"])
        dpath = _write(tmp, "dailysummary.csv", [D_HEADER, "2030-01-02,Total,200.0,2.0,false",
                                                 "2030-01-07,Total,100.0,1.0,false"])
        assert ci.scan_export_file(spath, "servings").reason == "servings.csv has no Energy column"
        check = ci.check_trusted_export(WINDOW, spath, dpath)
        assert not check.usable and not check.complete and check.daily_ok
        _two_looks(db, [spath, dpath], window=WINDOW)
        nodaily = _write(tmp, "d2.csv", ["Date,Group,Protein (g),Completed", "2030-01-02,Total,2.0,false"])
        assert ci.scan_export_file(nodaily, "daily").reason == "dailysummary.csv has no Energy column"
    _assert_nothing_written(db, before, "has no Energy column")
    assert db.daily["2030-01-05"]["calories"] == 100.0


# The shape of a real Cronometer web export (Claude review): a BOM, a wide servings
# header ending in Category, quoted cells with commas, units in parentheses with µ,
# and a daily summary with one row per day and NO Group column. Values are synthetic.
REAL_NUTRIENTS = [
    "Energy (kcal)", "Alcohol (g)", "Caffeine (mg)", "Oxalate (mg)", "Phytate (mg)", "Water (g)",
    "B1 (Thiamine) (mg)", "B2 (Riboflavin) (mg)", "B3 (Niacin) (mg)", "B5 (Pantothenic Acid) (mg)",
    "B6 (Pyridoxine) (mg)", "B12 (Cobalamin) (µg)", "Folate (µg)", "Vitamin A (µg)", "Vitamin C (mg)",
    "Vitamin D (IU)", "Vitamin E (mg)", "Vitamin K (µg)", "Calcium (mg)", "Copper (mg)", "Iron (mg)",
    "Magnesium (mg)", "Manganese (mg)", "Phosphorus (mg)", "Potassium (mg)", "Selenium (µg)",
    "Sodium (mg)", "Zinc (mg)", "Carbs (g)", "Fiber (g)", "Starch (g)", "Sugars (g)",
    "Added Sugars (g)", "Net Carbs (g)", "Fat (g)", "Cholesterol (mg)", "Monounsaturated (g)",
    "Polyunsaturated (g)", "Saturated (g)", "Trans-Fats (g)", "Omega-3 (g)", "Omega-6 (g)",
    "Cystine (g)", "Histidine (g)", "Isoleucine (g)", "Leucine (g)", "Lysine (g)", "Methionine (g)",
    "Phenylalanine (g)", "Protein (g)", "Threonine (g)", "Tryptophan (g)", "Tyrosine (g)", "Valine (g)",
]


def _csv_text(rows):
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(rows)
    return buf.getvalue().splitlines()


def _real_export(folder, servings):
    """servings: (day, food, kcal); every other nutrient is kcal / 50 per entry."""
    s_rows = [["Day", "Time", "Group", "Food Name", "Amount", *REAL_NUTRIENTS, "Category"]]
    totals: dict[str, list[float]] = {}
    for day, food, kcal in servings:
        values = [kcal] + [round(kcal / 50, 2)] * (len(REAL_NUTRIENTS) - 1)
        s_rows.append([day, "8:00 AM", "Breakfast", food, "1.00 x 2.0 pieces", *values, "Snacks, Sweets"])
        acc = totals.setdefault(day, [0.0] * len(REAL_NUTRIENTS))
        for i, v in enumerate(values):
            acc[i] = round(acc[i] + v, 2)
    d_rows = [["Date", *REAL_NUTRIENTS, "Completed"]]
    d_rows += [[day, *acc, "false"] for day, acc in sorted(totals.items())]
    return [_write(folder, "servings.csv", _csv_text(s_rows)),
            _write(folder, "dailysummary.csv", _csv_text(d_rows))]


def test_real_export_shape_is_complete_and_empties_the_right_day() -> None:
    db = FakeDB([_srow("2030-01-03", "test bar, chocolate"), _srow("2030-01-06", "test old")],
                [_drow("2030-01-03", 210.0), _drow("2030-01-06", 90.0)])
    with tempfile.TemporaryDirectory() as tmp:
        paths = _real_export(tmp, [("2030-01-03", "test bar, chocolate", 210.0),
                                   ("2030-01-03", "test bar, chocolate", 210.0),
                                   ("2030-01-04", 'test "quoted", food', 55.5),
                                   ("2030-01-08", "test late", 80.0)])
        with open(paths[0], "rb") as f:
            assert f.read(3) == b"\xef\xbb\xbf", "fixture must carry the BOM"
        scan = ci.scan_export_file(paths[0], "servings")
        assert scan.ok and scan.by_date == {"2030-01-03": 2, "2030-01-04": 1, "2030-01-08": 1}, scan
        assert scan.invalid_dates == frozenset(), "every nutrient cell of the fixture is a number"
        check = ci.check_trusted_export(WINDOW, *paths)
        assert check.complete and check.skip_dates == (), check.reason
        assert "2030-01-06" in check.empty_dates and check.servings_empty_dates == ()
        _two_looks(db, paths, window=WINDOW)
    assert _names(db, "2030-01-06") == [] and "2030-01-06" not in db.daily
    assert _names(db, "2030-01-03") == ["test bar, chocolate", "test bar, chocolate"]
    assert _names(db, "2030-01-04") == ['test "quoted", food']
    p = _calls(db, WINDOW_FN)[-1]
    assert sorted(r["calendar_date"] for r in p["p_daily_rows"]) == ["2030-01-03", "2030-01-04", "2030-01-08"]
    assert p["p_rows"][0]["food_category"] == "Snacks, Sweets"


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
    assert db.candidates == {}
    hb = [r for r in db.sync_logs if r["data_type"] == "servings"]
    assert len(hb) == 1 and hb[0]["status"] == "error"


def test_function_raising_mid_transaction_rolls_everything_back() -> None:
    servings, daily = _stored()
    db = FakeDB(servings, daily)
    db.candidates["2030-01-05"] = {"first_seen_at": db.now - timedelta(hours=LATER),
                                   "last_seen_at": db.now - timedelta(hours=LATER), "times_seen": 1}
    before = (_names(db), copy.deepcopy(db.daily), copy.deepcopy(db.candidates))
    bad_rows = [_srow("2030-01-02", "test oats"), _srow("2030-01-11", "test outside window")]
    try:
        ci.import_servings_window(bad_rows, [_drow("2030-01-02", 100.0)], WINDOW, ["2030-01-05"], [], 3,
                                  dry_run=False, sb=db)
    except FakeAPIError as e:
        assert "outside the window" in str(e)
    else:
        raise AssertionError("the function must refuse a row outside the window")
    assert (_names(db), db.daily, db.candidates) == before and db.cleared == []
    # A key the table does not have fails AFTER the empty day was removed: still nothing changes.
    try:
        ci.import_servings_window([{**_srow("2030-01-02", "test oats"), "serving_id": 1},
                                   _srow("2030-01-07", "test soup")],
                                  [_drow("2030-01-02", 100.0)], WINDOW, ["2030-01-05"], [], 3,
                                  dry_run=False, sb=db)
    except FakeAPIError as e:
        assert "not writable" in str(e)
    else:
        raise AssertionError("a serving_id key must be refused")
    assert (_names(db), db.daily, db.candidates) == before and db.cleared == []


def test_missing_functions_fall_back_to_the_date_set_replace() -> None:
    # Rollout: the code ships before the SQL. Both new functions live in one file, so
    # they are missing together: the window call, then the combined call, are refused
    # before they run, and the date-set function plus the usual daily upsert follow.
    servings, daily = _stored()
    db = FakeDB(servings, daily, missing={WINDOW_FN, COMBINED_FN})
    with tempfile.TemporaryDirectory() as tmp:
        assert _two_looks(db, _export(tmp, [("2030-01-02", "test oats", 100.0)]), window=WINDOW) == (1, 1)
        assert [fn for fn, _ in db.rpc_calls] == [WINDOW_FN, COMBINED_FN, LEGACY_FN] * 2
        assert db.direct_daily_upserts == 2, "the daily totals go the usual way"
        assert _names(db, "2030-01-02") == ["test oats"], "days with food were not replaced"
        assert _names(db, "2030-01-05") == ["test rice"] and db.cleared == [], "the fallback emptied a day"
        hb = _hb(db)
        assert hb["servings"]["status"] == "partial"
        assert ci.REPLACE_WINDOW_SQL in hb["servings"]["error_message"]
        assert ci.REPLACE_WINDOW_SQL in hb["daily"]["error_message"]
        # A manual import in the same state: the combined call, then the date-set function.
        db.rpc_calls.clear()
        _run(db, _export(tmp, [("2030-01-07", "test soup", 100.0)]))
    assert [fn for fn, _ in db.rpc_calls] == [COMBINED_FN, LEGACY_FN] and db.direct_daily_upserts == 3
    assert _hb(db)["servings"]["status"] == "success"


def test_missing_function_names_are_not_confused() -> None:
    def missing(name, args):
        return FakeAPIError("PGRST202", f"Could not find the function pds.{name}({args}) in the schema cache")

    errors = {LEGACY_FN: missing(LEGACY_FN, "p_dates, p_rows"),
              WINDOW_FN: missing(WINDOW_FN, "p_dates, p_empty_dates"),
              COMBINED_FN: missing(COMBINED_FN, "p_dates, p_daily_rows, p_rows")}
    for named, err in errors.items():
        for asked in errors:
            assert ci._is_missing_function(err, asked) == (named == asked), (named, asked)
    assert {ci.REPLACE_SERVINGS_RPC, ci.REPLACE_WINDOW_RPC, ci.REPLACE_IMPORT_RPC} == set(errors)
    # All three missing: the last fallback's own clear error names the legacy SQL file.
    db = FakeDB([_srow("2030-01-02", "x")], missing={WINDOW_FN, COMBINED_FN, LEGACY_FN})
    try:
        ci.import_servings_window([_srow("2030-01-02", "y")], [], WINDOW, [], [], 3, dry_run=False, sb=db)
    except RuntimeError as e:
        assert ci.REPLACE_SERVINGS_SQL in str(e) and "No servings were changed" in str(e)
    else:
        raise AssertionError("every function missing must raise")
    assert _names(db) == ["x"]


def test_reply_that_does_not_confirm_the_import_raises() -> None:
    good = {"inserted": 1, "daily_upserted": 0, "cleared_days": 0, "cleared_servings": 0,
            "cleared_daily": 0, "refused_days": 0, "pending_days": 0}
    for reply in (None, [], "ok", {**good, "inserted": 0}, {**good, "refused_days": "1"},
                  {k: v for k, v in good.items() if k != "cleared_days"}, {**good, "cleared_days": -1},
                  {**good, "daily_upserted": 1}, {k: v for k, v in good.items() if k != "daily_upserted"},
                  {k: v for k, v in good.items() if k != "pending_days"}, {**good, "pending_days": True}):
        db = FakeDB(reply=reply)
        try:
            ci.import_servings_window([_srow("2030-01-02", "a")], [], WINDOW, [], [], 3, dry_run=False, sb=db)
        except RuntimeError as e:
            assert "cannot be confirmed" in str(e)
        else:
            raise AssertionError(f"reply {reply!r} must not count as a confirmed import")
    for reply in (None, {"inserted": 1}, {"inserted": 1, "daily_upserted": 0},
                  {"inserted": "1", "daily_upserted": 1}, {"inserted": 1, "daily_upserted": False}):
        db = FakeDB(reply=reply)
        try:
            ci.import_servings_and_daily([_srow("2030-01-02", "a")], [_drow("2030-01-02", 1.0)], False, sb=db)
        except RuntimeError as e:
            assert "cannot be confirmed" in str(e)
        else:
            raise AssertionError(f"reply {reply!r} must not count as a confirmed manual import")


def test_nothing_to_do_makes_no_call() -> None:
    db = FakeDB()
    out = ci.import_servings_window([], [], WINDOW, [], [], 3, dry_run=False, sb=db)
    assert out["mode"] == "none" and db.rpc_calls == []
    assert ci.import_servings_and_daily([], [], False, sb=db) == (0, 0, "none") and db.rpc_calls == []


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
        assert type(start) is date and type(end) is date, "the window must be plain dates"
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
    d_kept, d_gone, d_after = ((today - timedelta(days=n)).isoformat() for n in (3, 2, 1))
    db = FakeDB([_srow(d_kept, "test oats"), _srow(d_gone, "test rice"), _srow(d_after, "test soup")],
                [_drow(d_kept, 100.0), _drow(d_gone, 100.0), _drow(d_after, 100.0)])

    def fake_export(_client, _token, generate, _start, _end):
        if generate == "servings":
            return ("﻿" + S_HEADER + f"\n{d_kept},8:00 AM,Breakfast,test oats,1.00 g,100.0,1.0"
                    f"\n{d_after},8:00 AM,Breakfast,test soup,1.00 g,100.0,1.0\n")
        return "﻿" + D_HEADER + f"\n{d_kept},Total,100.0,1.0,false\n{d_after},Total,100.0,1.0,false\n"

    saved = ci.create_client
    ci.create_client = lambda *_a, **_k: db
    try:
        with _Patch(etl, authenticate_session=_fake_auth, mint_token=lambda *a, **k: "TOKEN",
                    export_csv=fake_export, _save_session=lambda *a, **k: None):
            assert etl.fetch_and_import(days=30, dry_run=False) == (2, 2)
            assert _names(db, d_gone) == ["test rice"], "the first scheduled run only records the day"
            db.advance(LATER)                                  # the next scheduled run
            assert etl.fetch_and_import(days=30, dry_run=False) == (2, 2)
    finally:
        ci.create_client = saved
    assert _names(db, d_kept) == ["test oats"] and _names(db, d_gone) == []
    assert _names(db, d_after) == ["test soup"] and sorted(db.daily) == [d_kept, d_after]
    assert {c["calendar_date"] for c in db.cleared} == {d_gone}


# ---------------------------------------------------------------------------
# Static checks on the SQL the ship stage reviews and applies
# ---------------------------------------------------------------------------

def _code(path):
    raw = path.read_text(encoding="utf-8")
    code = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())   # drop comments
    return raw, re.sub(r"\s+", " ", code)


def _body(flat, name):
    start = flat.index(f"CREATE OR REPLACE FUNCTION pds.{name}(")
    end = flat.index("$function$;", start)
    return flat[start:end]


def _args(flat, name):
    sig = re.search(rf"FUNCTION pds\.{name}\(([^)]*)\) RETURNS", flat)
    assert sig, f"signature of {name} not found"
    return sorted(a.strip().split(" ")[0] for a in sig.group(1).split(","))


def test_window_sql_contract() -> None:
    raw, flat = _code(WINDOW_SQL)
    upper = flat.upper()
    assert ci.REPLACE_WINDOW_SQL == "sql/cronometer_replace_servings_window.sql" and WINDOW_SQL.is_file()

    # The argument names are the keys the importer sends (PostgREST matches by name).
    db = FakeDB()
    ci.import_servings_window([_srow("2030-01-02", "a"), _srow("2030-01-04", "c")], [_drow("2030-01-02", 100.0)],
                              WINDOW, ["2030-01-03"], [], 3, dry_run=False, sb=db)
    ci.import_servings_and_daily([_srow("2030-01-04", "b")], [_drow("2030-01-04", 1.0)], False, sb=db)
    assert _args(flat, WINDOW_FN) == sorted(db.rpc_calls[0][1]), db.rpc_calls[0][1].keys()
    assert _args(flat, COMBINED_FN) == sorted(db.rpc_calls[1][1]), db.rpc_calls[1][1].keys()
    assert _args(flat, "cronometer_upsert_daily") == ["p_daily_rows"]

    # The word the Supabase connector refuses never appears, not even in a comment.
    assert "DROP" not in raw.upper()
    for word in ("TRUNCATE", "SECURITY DEFINER", "INFORMATION_SCHEMA"):
        assert word not in upper, f"unexpected {word.strip()}"
    # The only UPDATEs are the two ON CONFLICT branches (daily upsert, candidate record).
    assert upper.count("UPDATE ") == 2
    assert "ON CONFLICT (calendar_date) DO UPDATE SET %s" in flat
    assert ("ON CONFLICT (calendar_date) DO UPDATE SET last_seen_at = now(), times_seen = c.times_seen + 1;"
            in flat)

    # Servings are replaced only through the unchanged date-set function, never here.
    assert "INSERT INTO pds.cronometer_servings" not in flat
    assert flat.count("pds.replace_cronometer_servings(") == 2

    # Exactly five deletes, each scoped to the dates it may touch.
    deletes = re.findall(r"DELETE FROM [^;]*?(?:;|RETURNING)", flat)
    assert len(deletes) == 5 and upper.count("DELETE ") == 5, deletes
    assert "DELETE FROM pds.cronometer_servings s WHERE s.calendar_date = ANY (v_confirmed) RETURNING" in flat
    assert ("DELETE FROM pds.cronometer_nutrition_daily n WHERE n.calendar_date = ANY (v_confirmed) "
            "AND n.calendar_date = ANY (v_empty) RETURNING") in flat
    assert ("DELETE FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY "
            "(v_arg_dates || v_daily_dates) AND NOT (c.calendar_date = ANY (v_sempty));") in flat
    assert ("DELETE FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY "
            "(v_empty || v_sempty) AND NOT (c.calendar_date = ANY (v_kept));") in flat
    assert ("DELETE FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY "
            "(p_dates || v_daily_dates);") in flat
    # Every empty-day delete feeds the backup table in the same statement.
    assert flat.count("INSERT INTO pds.cronometer_cleared_rows") == 2
    assert flat.count("RETURNING s.* ) INSERT INTO pds.cronometer_cleared_rows") == 1
    assert flat.count("RETURNING n.* ) INSERT INTO pds.cronometer_cleared_rows") == 1

    # The second look: only days an export at least 6 h earlier recorded, out of the stored ones.
    assert ci.EMPTY_CONFIRM_HOURS == 6
    assert ("FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY (v_stored) "
            "AND c.first_seen_at <= now() - interval '6 hours';") in flat
    # The limit counts every stored empty day, confirmed or not; a refusal keeps the record.
    assert "IF v_populated > p_max_cleared_days THEN v_refused := v_populated; v_kept := v_stored;" in flat
    assert ("SELECT u.d FROM unnest(v_sempty) AS u(d) WHERE EXISTS (SELECT 1 FROM pds.cronometer_servings s "
            "WHERE s.calendar_date = u.d)) AS x;") in flat

    # Window function order: lock, forget days with food, count, confirm, limit, empty,
    # record, replace (through the date-set function), daily totals; all under one lock.
    lock = "pg_advisory_xact_lock(hashtext('pds.replace_cronometer_servings'))"
    _legacy_raw, legacy_flat = _code(LEGACY_SQL)
    assert lock in legacy_flat and flat.count(lock) == 2, "every writer must share one lock"
    w = _body(flat, WINDOW_FN)
    order = [lock, "DELETE FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY (v_arg_dates",
             "INTO v_stored", "INTO v_confirmed", "IF v_populated > p_max_cleared_days",
             "DELETE FROM pds.cronometer_servings s", "INSERT INTO pds.cronometer_empty_day_candidates",
             "v_replace := pds.replace_cronometer_servings(v_arg_dates, p_rows);",
             "v_daily := pds.cronometer_upsert_daily(p_daily_rows);"]
    positions = [w.index(s) for s in order]
    assert positions == sorted(positions), list(zip(order, positions))

    # The manual writer: same lock, the date-set function, the daily upsert, and its one
    # delete forgets the empty-day record of every date it writes (Codex review),
    # under the lock; it never deletes a serving or a daily row.
    m = _body(flat, COMBINED_FN)
    assert lock in m and "pds.replace_cronometer_servings(p_dates, p_rows)" in m
    assert "pds.cronometer_upsert_daily(p_daily_rows)" in m and "this function never empties a day" in m
    reset = "DELETE FROM pds.cronometer_empty_day_candidates c WHERE c.calendar_date = ANY (p_dates || v_daily_dates);"
    assert m.upper().count("DELETE ") == 1 and reset in m
    assert "pds.cronometer_servings" not in m and "pds.cronometer_nutrition_daily" not in m, \
        "only the candidates are deleted; servings and daily rows only through the two functions"
    assert m.index(lock) < m.index(reset) < m.index("pds.replace_cronometer_servings(p_dates, p_rows)")

    # Coverage comes from dates: every empty date lies strictly between the first and
    # last date with servings in the same call, checked before anything is written.
    cover = ("SELECT min(u.d), max(u.d) INTO v_first, v_last FROM unnest(v_arg_dates) AS u(d); "
             "IF EXISTS (SELECT 1 FROM unnest(v_empty || v_sempty) AS u(d) "
             "WHERE v_first IS NULL OR u.d <= v_first OR u.d >= v_last) THEN")
    assert cover in w and w.index(cover) < w.index(lock), "the coverage rule must run before the lock"

    # The daily upsert: one row per day, same keys, writable columns from pg_attribute.
    u = _body(flat, "cronometer_upsert_daily")
    assert "a date appears twice in p_daily_rows" in u and "do not all carry the same keys" in u
    assert u.count("'pds.cronometer_nutrition_daily'::regclass") == 2 and "u.key = 'synced_at'" in u
    assert "IF v_done <> v_n THEN" in u

    # Bounded window and dates, same bound as the importer.
    assert f"(p_window_end - p_window_start) + 1 > {ci.MAX_WINDOW_DAYS}" in flat
    assert "p_window_end > current_date + 2" in flat
    assert "WHERE u.d < p_window_start OR u.d > p_window_end" in flat
    assert "(v_empty && v_arg_dates)" in flat and "(v_empty && v_sempty)" in flat
    assert "IF v_empty && v_daily_dates THEN" in flat and "IF NOT (v_sempty <@ v_daily_dates) THEN" in flat
    assert "v_row_dates IS DISTINCT FROM v_arg_dates" in flat

    # Caller's rights, fixed search_path, service_role only (functions and tables).
    assert upper.count("SECURITY INVOKER") == 3 and flat.count("SET search_path = pds, pg_temp") == 3
    for fsig in ("pds.replace_cronometer_servings_window(date, date, date[], jsonb, date[], date[], jsonb, integer)",
                 "pds.replace_cronometer_servings_and_daily(date[], jsonb, jsonb)",
                 "pds.cronometer_upsert_daily(jsonb)"):
        assert f"REVOKE ALL ON FUNCTION {fsig} FROM PUBLIC;" in flat, fsig
        assert f"REVOKE ALL ON FUNCTION {fsig} FROM anon, authenticated;" in flat, fsig
        assert f"GRANT EXECUTE ON FUNCTION {fsig} TO service_role;" in flat, fsig
    for table in ("pds.cronometer_cleared_rows", "pds.cronometer_empty_day_candidates"):
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;" in flat, table
        assert f"REVOKE ALL ON {table} FROM anon, authenticated;" in flat, table
        assert f"REVOKE ALL ON {table} FROM PUBLIC;" in flat, table
    grants = re.findall(r"GRANT [^;]*;", flat)
    assert grants and all(g.endswith("TO service_role;") for g in grants), grants
    assert not re.search(r"\b(TO|FOR\s+\w+\s+TO)\s+(anon|authenticated)\b", flat.replace("FROM anon", "")), \
        "nothing may be granted to anon or authenticated"


def test_legacy_function_is_unchanged_by_this_feature() -> None:
    _raw, flat = _code(LEGACY_SQL)
    assert "FUNCTION pds.replace_cronometer_servings(p_dates date[], p_rows jsonb)" in flat
    assert "replace_cronometer_servings_window" not in flat and "replace_cronometer_servings_and_daily" not in flat
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
