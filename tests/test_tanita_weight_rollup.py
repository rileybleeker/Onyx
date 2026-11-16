"""Offline tests for the Tanita -> pds.weight_log rollup precedence (audit PIPE-05).

tanita_etl.rollup_weight_log used to read which days had a manual row and then
upsert the Tanita value for every other day in a second request, so a manual
save from the Log weight form landing between the two was overwritten. The ETL
now makes ONE call per chunk to pds.upsert_tanita_weight_days
(sql/weight_log_tanita_rollup.sql), whose single INSERT ... ON CONFLICT ...
WHERE source = 'tanita' decides the precedence inside the database.

Everything here is faked: no network, no database, no credentials, synthetic
rows only (dates in 2030, made-up weights). The fake database applies the
function's contract the way the SQL does (validate everything, then write the
Tanita-owned or empty days and leave every other day alone). The SQL file
itself is checked statically at the end.

Run: python tests/test_tanita_weight_rollup.py
     python tests/run_offline_tests.py tests/test_tanita_weight_rollup.py
"""
from __future__ import annotations

import logging
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import tanita_etl as te  # noqa: E402

SQL_PATH = ROOT / "sql" / "weight_log_tanita_rollup.sql"
ET = ZoneInfo("America/New_York")


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
ACCEPTED_KEYS = {"log_date", "weight_kg", "logged_at"}


def _wl(weight, source, at, notes=None):
    """A stored pds.weight_log row (value side; the key is the log_date)."""
    return {"weight_kg": round(float(weight), 3), "source": source,
            "logged_at": datetime.fromisoformat(at), "notes": notes, "writes": 0}


def apply_rollup(weight_log: dict, p_rows: list) -> dict:
    """What pds.upsert_tanita_weight_days does, in memory.

    Validation runs first and raises before anything changes (one transaction).
    Then per day: no row -> insert as tanita; tanita-owned and different ->
    update value + instant; tanita-owned and the same -> no write; any other
    source -> untouched.
    """
    if not isinstance(p_rows, list):
        raise FakeAPIError("22023", "upsert_tanita_weight_days: p_rows must be a JSON array")
    for r in p_rows:
        if not isinstance(r, dict):
            raise FakeAPIError("22023", "upsert_tanita_weight_days: every element must be an object")
        if set(r) - ACCEPTED_KEYS:
            raise FakeAPIError("22023", "upsert_tanita_weight_days: p_rows has keys that are not accepted")
        if any(r.get(k) in (None, "") for k in ACCEPTED_KEYS):
            raise FakeAPIError("22023", "upsert_tanita_weight_days: a row is missing a value")
    if len({r["log_date"] for r in p_rows}) != len(p_rows):
        raise FakeAPIError("22023", "upsert_tanita_weight_days: send one row per log_date")
    for r in p_rows:
        if datetime.fromisoformat(r["logged_at"]).astimezone(ET).date().isoformat() != r["log_date"]:
            raise FakeAPIError("22023", "upsert_tanita_weight_days: logged_at is not on its log_date")
        if not 0 < float(r["weight_kg"]) < 500:
            raise FakeAPIError("22023", "upsert_tanita_weight_days: a weight outside 0..500 kg")

    counts = {"rows": len(p_rows), "inserted": 0, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    for r in p_rows:
        day = r["log_date"]
        weight = round(float(r["weight_kg"]), 3)
        at = datetime.fromisoformat(r["logged_at"])
        cur = weight_log.get(day)
        if cur is None:
            weight_log[day] = {"weight_kg": weight, "source": "tanita", "logged_at": at,
                               "notes": None, "writes": 1}
            counts["inserted"] += 1
        elif cur["source"] == "tanita":
            if (cur["weight_kg"], cur["logged_at"]) != (weight, at):
                cur.update(weight_kg=weight, logged_at=at)
                cur["writes"] += 1
                counts["updated"] += 1
            else:
                counts["unchanged"] += 1
        else:
            counts["skipped_manual"] += 1
    return counts


class FakeDB:
    """pds.tanita_measurements + pds.weight_log + sync_log behind the calls the ETL may make.

    Any direct read or write of pds.weight_log fails the test: the precedence
    must be decided by the function, never by a read in Python first.
    """

    def __init__(self, weight_log=None, rpc_error=None, reply=_UNSET, before_apply=None):
        self.weight_log = {d: dict(r) for d, r in (weight_log or {}).items()}
        self.measurements: dict[str, dict] = {}
        self.rpc_calls: list[tuple[str, dict]] = []
        self.sync_logs: list[dict] = []
        self.rpc_error = rpc_error
        self.reply = reply                  # override the function's answer
        self.before_apply = before_apply    # a save that commits just before the statement runs

    def schema(self, name):
        assert name == "pds", name
        return self

    def rpc(self, fn, params):
        return _Rpc(self, fn, params)

    def table(self, name):
        if name == "sync_log":
            return _Sink(self.sync_logs)
        if name == "tanita_measurements":
            return _Measurements(self)
        raise AssertionError(f"ETL touched pds.{name} directly instead of the rollup function")

    from_ = table


class _Rpc:
    def __init__(self, db, fn, params):
        self.db, self.fn, self.params = db, fn, params

    def execute(self):
        db = self.db
        db.rpc_calls.append((self.fn, self.params))
        assert self.fn == "upsert_tanita_weight_days", self.fn
        assert set(self.params) == {"p_rows"}, self.params.keys()
        if db.before_apply is not None:
            db.before_apply(db)
        if db.rpc_error is not None:
            raise db.rpc_error              # transaction rolled back: nothing changes
        counts = apply_rollup(db.weight_log, self.params["p_rows"])
        return _Result(counts if db.reply is _UNSET else db.reply)


class _Measurements:
    def __init__(self, db):
        self.db = db
        self._rows = None

    def upsert(self, rows, on_conflict=None):
        assert on_conflict == "measured_at", on_conflict
        self._rows = rows
        return self

    def execute(self):
        for r in self._rows or []:
            self.db.measurements[r["measured_at"]] = dict(r)
        return _Result(self._rows)

    def delete(self, *_a, **_k):
        raise AssertionError("raw Tanita measurements must never be removed")


class _Sink:
    def __init__(self, sink):
        self.sink = sink
        self._row = None

    def insert(self, row):
        self._row = row
        return self

    def execute(self):
        self.sink.append(self._row)
        return _Result(None)


def _meas(local: str, weight=None, body_fat=None) -> dict:
    """A parsed measurement row (the shape parse_measurements returns)."""
    return {"measured_at": datetime.fromisoformat(local).replace(tzinfo=ET).isoformat(),
            "weight_kg": weight, "body_fat_pct": body_fat, "model": "TESTSCALE",
            "raw_json": {}, "synced_at": "2030-01-20T00:00:00+00:00"}


def _items(local_compact: str, weight: str, body_fat: str | None = None) -> list[dict]:
    """Synthetic Health Planet innerscan items for one weigh-in."""
    out = [{"date": local_compact, "keydata": weight, "model": "TESTSCALE", "tag": "6021"}]
    if body_fat is not None:
        out.append({"date": local_compact, "keydata": body_fat, "model": "TESTSCALE", "tag": "6022"})
    return out


def _at(local: str) -> str:
    return datetime.fromisoformat(local).replace(tzinfo=ET).isoformat()


class _FakeClient:
    items: list[dict] = []

    def __init__(self, _tokens):
        pass

    def innerscan(self, _from, _to):
        return list(self.items)


def _run_etl(db, items):
    """Run te.run_etl against the fake with no tokens, no network and no sleep."""
    saved = (te.get_supabase, te.load_tokens, te.ensure_fresh_tokens, te.TanitaClient)
    _FakeClient.items = items
    te.get_supabase = lambda: db
    te.load_tokens = lambda: {"access_token": "synthetic"}
    te.ensure_fresh_tokens = lambda t: t
    te.TanitaClient = _FakeClient
    records: list[str] = []

    class _Grab(logging.Handler):
        def emit(self, record):
            records.append(self.format(record))

    handler = _Grab()
    te.log.addHandler(handler)
    exit_code = None
    try:
        te.run_etl(days=14)
    except SystemExit as e:
        exit_code = e.code
    finally:
        te.log.removeHandler(handler)
        te.get_supabase, te.load_tokens, te.ensure_fresh_tokens, te.TanitaClient = saved
    return exit_code, "\n".join(records)


# ---------------------------------------------------------------------------
# The rollup rule itself (unchanged): earliest measurement per ET day
# ---------------------------------------------------------------------------

def test_earliest_measurement_per_et_day_with_its_own_instant() -> None:
    rows = [
        _meas("2030-01-15T21:40", 81.20),
        _meas("2030-01-15T07:05", 80.50),          # the morning weigh-in wins
        _meas("2030-01-15T06:30", None, 18.0),     # body fat only: never a weight row
        _meas("2030-01-16T23:30", 80.90),          # late evening stays on its own ET day
        _meas("2030-01-17T00:10", 80.70),          # just after midnight ET = the next day
    ]
    out = te.daily_rollup_rows(rows)
    assert [r["log_date"] for r in out] == ["2030-01-15", "2030-01-16", "2030-01-17"]
    by_day = {r["log_date"]: r for r in out}
    assert by_day["2030-01-15"] == {"log_date": "2030-01-15", "weight_kg": 80.50,
                                    "logged_at": _at("2030-01-15T07:05")}
    assert by_day["2030-01-16"]["logged_at"] == _at("2030-01-16T23:30")
    assert by_day["2030-01-17"]["logged_at"] == _at("2030-01-17T00:10")
    for r in out:
        assert set(r) == ACCEPTED_KEYS, "the caller never sends source, notes or created_at"


def test_nothing_to_roll_up_makes_no_call() -> None:
    db = FakeDB()
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T06:30", None, 18.0)])
    assert counts == {"inserted": 0, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    assert db.rpc_calls == []
    assert te.rollup_weight_log(db, []) == counts and db.rpc_calls == []


# ---------------------------------------------------------------------------
# Precedence: manual rows are never overwritten
# ---------------------------------------------------------------------------

def test_one_call_and_no_direct_weight_log_read_or_write() -> None:
    db = FakeDB()
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-16T07:00", 80.6)])
    assert len(db.rpc_calls) == 1, "one conditional upsert, no separate read first"
    assert counts == {"inserted": 2, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    # (FakeDB.table("weight_log") raises, so reaching here proves no read-then-write.)


def test_existing_manual_and_other_source_days_are_left_alone() -> None:
    db = FakeDB({
        "2030-01-15": _wl(70.0, "manual", "2030-01-15T12:00:00+00:00", notes="synthetic note"),
        "2030-01-16": _wl(71.0, "another_scale", "2030-01-16T12:00:00+00:00"),
    })
    before = {d: dict(r) for d, r in db.weight_log.items()}
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-16T07:00", 80.6),
                                       _meas("2030-01-17T07:00", 80.7)])
    assert counts == {"inserted": 1, "updated": 0, "unchanged": 0, "skipped_manual": 2}
    assert db.weight_log["2030-01-15"] == before["2030-01-15"]
    assert db.weight_log["2030-01-16"] == before["2030-01-16"]
    assert db.weight_log["2030-01-17"]["source"] == "tanita"


def test_manual_save_landing_during_the_run_is_kept() -> None:
    """The PIPE-05 race: a manual save commits after the ETL built its payload.

    The old code had already read "no manual row" and upserted over it. Now
    nothing is read first, and the database decides at write time.
    """
    def manual_save(db):
        db.weight_log["2030-01-15"] = _wl(70.0, "manual", "2030-01-15T13:00:00+00:00")

    db = FakeDB(before_apply=manual_save)
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-16T07:00", 80.6)])
    assert db.weight_log["2030-01-15"]["source"] == "manual"
    assert db.weight_log["2030-01-15"]["weight_kg"] == 70.0
    assert db.weight_log["2030-01-16"]["source"] == "tanita"
    assert counts == {"inserted": 1, "updated": 0, "unchanged": 0, "skipped_manual": 1}


def test_manual_relog_of_a_tanita_day_during_the_run_is_kept() -> None:
    """The update variant: the day was Tanita's when the run started."""
    def relog(db):
        db.weight_log["2030-01-15"].update(weight_kg=70.0, source="manual")

    db = FakeDB({"2030-01-15": _wl(80.4, "tanita", _at("2030-01-15T07:00"))}, before_apply=relog)
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5)])
    assert db.weight_log["2030-01-15"]["source"] == "manual"
    assert db.weight_log["2030-01-15"]["weight_kg"] == 70.0
    assert counts["skipped_manual"] == 1 and counts["updated"] == 0


# ---------------------------------------------------------------------------
# Tanita-owned days: idempotent updates, and manual removal hands a day back
# ---------------------------------------------------------------------------

def test_rerun_is_idempotent_and_writes_nothing_the_second_time() -> None:
    rows = [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-16T07:00", 80.6)]
    db = FakeDB()
    first = te.rollup_weight_log(db, rows)
    second = te.rollup_weight_log(db, rows)
    assert first == {"inserted": 2, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    assert second == {"inserted": 0, "updated": 0, "unchanged": 2, "skipped_manual": 0}
    assert all(r["writes"] == 1 for r in db.weight_log.values()), "a re-run rewrote an unchanged day"


def test_tanita_day_follows_a_new_earliest_reading() -> None:
    db = FakeDB({"2030-01-15": _wl(80.9, "tanita", _at("2030-01-15T09:00"))})
    counts = te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-15T09:00", 80.9)])
    assert counts == {"inserted": 0, "updated": 1, "unchanged": 0, "skipped_manual": 0}
    row = db.weight_log["2030-01-15"]
    assert (row["weight_kg"], row["logged_at"], row["source"]) == (80.5, datetime.fromisoformat(_at("2030-01-15T07:05")), "tanita")


def test_removing_a_manual_row_lets_the_scale_value_back() -> None:
    db = FakeDB({"2030-01-15": _wl(70.0, "manual", "2030-01-15T13:00:00+00:00")})
    rows = [_meas("2030-01-15T07:05", 80.5)]
    assert te.rollup_weight_log(db, rows)["skipped_manual"] == 1
    db.weight_log.pop("2030-01-15")          # Riley removes the manual entry (DELETE /api/weight)
    assert te.rollup_weight_log(db, rows) == {"inserted": 1, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    assert db.weight_log["2030-01-15"]["source"] == "tanita" and db.weight_log["2030-01-15"]["weight_kg"] == 80.5


def test_day_handed_back_to_tanita_by_undo_is_maintained_again() -> None:
    # The Log form's Undo PATCHes source back to 'tanita'; the ETL owns the day again.
    db = FakeDB({"2030-01-15": _wl(80.4, "tanita", _at("2030-01-15T07:00"))})
    assert te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5)])["updated"] == 1


def test_unrelated_dates_are_never_touched() -> None:
    db = FakeDB({
        "2030-01-01": _wl(79.0, "tanita", _at("2030-01-01T07:00")),
        "2030-01-02": _wl(69.0, "manual", "2030-01-02T12:00:00+00:00"),
    })
    before = {d: dict(r) for d, r in db.weight_log.items()}
    te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5)])
    sent = {r["log_date"] for _fn, p in db.rpc_calls for r in p["p_rows"]}
    assert sent == {"2030-01-15"}
    assert db.weight_log["2030-01-01"] == before["2030-01-01"]
    assert db.weight_log["2030-01-02"] == before["2030-01-02"]


def test_large_backfill_is_chunked_and_counts_add_up() -> None:
    start = datetime(2030, 1, 1, 7, 0)
    rows = [_meas((start + timedelta(days=i)).isoformat(), 80.0 + (i % 10) / 10) for i in range(2500)]
    db = FakeDB()
    counts = te.rollup_weight_log(db, rows)
    assert [len(p["p_rows"]) for _fn, p in db.rpc_calls] == [1000, 1000, 500]
    assert counts == {"inserted": 2500, "updated": 0, "unchanged": 0, "skipped_manual": 0}
    dates = [r["log_date"] for _fn, p in db.rpc_calls for r in p["p_rows"]]
    assert len(dates) == len(set(dates)) == 2500, "each day sent exactly once"


# ---------------------------------------------------------------------------
# Failures: no fallback, nothing half-written, raw measurements kept
# ---------------------------------------------------------------------------

def test_missing_function_is_a_clear_error_and_there_is_no_fallback() -> None:
    missing = FakeAPIError(
        "PGRST202",
        "Could not find the function pds.upsert_tanita_weight_days(p_rows) in the schema cache")
    db = FakeDB({"2030-01-15": _wl(70.0, "manual", "2030-01-15T13:00:00+00:00")}, rpc_error=missing)
    before = {d: dict(r) for d, r in db.weight_log.items()}
    try:
        te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5)])
    except RuntimeError as e:
        msg = str(e)
        assert "sql/weight_log_tanita_rollup.sql" in msg and "weight_log was not changed" in msg, msg
        assert e.__cause__ is missing
    else:
        raise AssertionError("a missing function must raise")
    assert len(db.rpc_calls) == 1, "no retry, no plain-upsert fallback"
    assert db.weight_log == before
    # Another function's PGRST202 or an unrelated error is not rewritten.
    assert not te._is_missing_rollup_function(FakeAPIError("PGRST202", "Could not find the function pds.other()"))
    assert not te._is_missing_rollup_function(FakeAPIError("23505", "duplicate key"))
    assert te._is_missing_rollup_function(FakeAPIError(
        "42883", "function pds.upsert_tanita_weight_days(jsonb) does not exist"))


def test_refused_payload_changes_nothing() -> None:
    db = FakeDB({"2030-01-15": _wl(80.4, "tanita", _at("2030-01-15T07:00"))})
    before = {d: dict(r) for d, r in db.weight_log.items()}
    bad = [{"log_date": "2030-01-15", "weight_kg": 80.5, "logged_at": _at("2030-01-15T07:05"), "source": "manual"}]
    try:
        db.rpc("upsert_tanita_weight_days", {"p_rows": bad}).execute()
    except FakeAPIError as e:
        assert e.code == "22023"
    else:
        raise AssertionError("a caller-chosen source must be refused")
    wrong_day = [{"log_date": "2030-01-14", "weight_kg": 80.5, "logged_at": _at("2030-01-15T07:05")}]
    try:
        db.rpc("upsert_tanita_weight_days", {"p_rows": wrong_day}).execute()
    except FakeAPIError:
        pass
    else:
        raise AssertionError("an instant on another ET day must be refused")
    assert db.weight_log == before


def test_reply_that_does_not_confirm_every_day_raises() -> None:
    replies = (
        {"rows": 2, "inserted": 1, "updated": 0, "unchanged": 0, "skipped_manual": 0},   # one missing
        {"rows": 3, "inserted": 2, "updated": 0, "unchanged": 0, "skipped_manual": 0},   # wrong total
        {"inserted": True, "updated": 1, "unchanged": 0, "skipped_manual": 0},
        {"inserted": -1, "updated": 3, "unchanged": 0, "skipped_manual": 0},
        None, [], "ok",
    )
    for reply in replies:
        db = FakeDB(reply=reply)
        try:
            te.rollup_weight_log(db, [_meas("2030-01-15T07:05", 80.5), _meas("2030-01-16T07:00", 80.6)])
        except RuntimeError as e:
            assert "cannot be confirmed" in str(e)
            assert "80.5" not in str(e) and "2030-01-15" not in str(e), "the error must carry counts only"
        else:
            raise AssertionError(f"reply {reply!r} must not count as a confirmed rollup")


def test_run_etl_end_to_end_logs_counts_only() -> None:
    db = FakeDB({"2030-01-16": _wl(70.0, "manual", "2030-01-16T13:00:00+00:00")})
    items = (_items("203001150705", "80.50", "18.0") + _items("203001152140", "81.20")
             + _items("203001160700", "80.60"))
    code, logs = _run_etl(db, items)
    assert code is None, logs
    assert len(db.measurements) == 3, "every raw measurement is stored"
    assert db.weight_log["2030-01-15"]["weight_kg"] == 80.5
    assert db.weight_log["2030-01-16"]["source"] == "manual"
    hb = [r for r in db.sync_logs if r["source"] == "tanita" and r["data_type"] == "weight"]
    assert len(hb) == 1 and hb[0]["status"] == "success" and hb[0]["records_synced"] == 3
    assert "1 inserted" in logs and "1 kept as manual" in logs, logs
    for private in ("2030-01-15", "2030-01-16", "80.5", "81.2", "70.0"):
        assert private not in logs, f"the log printed {private!r}; counts only"


def test_run_etl_failure_keeps_measurements_and_writes_a_failed_heartbeat() -> None:
    missing = FakeAPIError("PGRST202", "Could not find the function pds.upsert_tanita_weight_days(p_rows)")
    db = FakeDB({"2030-01-15": _wl(70.0, "manual", "2030-01-15T13:00:00+00:00")}, rpc_error=missing)
    before = {d: dict(r) for d, r in db.weight_log.items()}
    code, logs = _run_etl(db, _items("203001150705", "80.50"))
    assert code == 1, "a failed rollup must fail the run (red on Actions)"
    assert len(db.measurements) == 1, "raw measurements are stored before the rollup and kept"
    assert db.weight_log == before
    hb = [r for r in db.sync_logs if r["source"] == "tanita"]
    assert len(hb) == 1 and hb[0]["status"] == "failed", hb
    assert "sql/weight_log_tanita_rollup.sql" in hb[0]["error_message"]
    assert "2030-01-15" not in logs and "80.5" not in logs


# ---------------------------------------------------------------------------
# Static checks on the Python writer and the SQL function
# ---------------------------------------------------------------------------

def test_rollup_has_no_read_then_write_left() -> None:
    src = (ROOT / "tanita_etl.py").read_text(encoding="utf-8")
    body = src[src.index("def rollup_weight_log("):src.index("# Runners")]
    for call in (".table(", ".from_(", ".upsert(", ".select(", ".delete(", ".insert("):
        assert call not in body, f"rollup_weight_log must only call the function, found {call}"
    assert body.count(".rpc(") == 1
    assert ".delete(" not in src, "the Tanita ETL removes nothing"


def test_sql_function_contract() -> None:
    raw = SQL_PATH.read_text(encoding="utf-8")
    # The Supabase MCP refuses any migration text containing this word, comments included.
    assert "DROP" not in raw.upper(), "no DROP anywhere in the file"
    code = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())   # drop comments
    flat = re.sub(r"\s+", " ", code)
    upper = flat.upper()

    # Same name and argument as the ETL sends.
    assert f"FUNCTION pds.{te.WEIGHT_ROLLUP_RPC}(p_rows jsonb)" in flat
    assert te.WEIGHT_ROLLUP_SQL == "sql/weight_log_tanita_rollup.sql" and SQL_PATH.is_file()

    # Exactly the keys the ETL builds, and the source is the function's own literal.
    m = re.search(r"WHERE k\.key NOT IN \(([^)]*)\)", flat)
    assert m, "accepted-key list not found"
    accepted = {k.strip().strip("'") for k in m.group(1).split(",")}
    assert accepted == ACCEPTED_KEYS == set(te.daily_rollup_rows([_meas("2030-01-15T07:05", 80.5)])[0])
    assert "SELECT i.log_date, i.weight_kg, 'tanita', i.logged_at FROM incoming AS i" in flat

    # The precedence lives in the one write statement.
    assert upper.count("INSERT INTO") == 1 and "INSERT INTO pds.weight_log AS w" in flat
    assert "ON CONFLICT (log_date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg, logged_at = EXCLUDED.logged_at" \
           " WHERE w.source = 'tanita' AND (w.weight_kg, w.logged_at) IS DISTINCT FROM" \
           " (EXCLUDED.weight_kg, EXCLUDED.logged_at)" in flat
    assert len(re.findall(r"\bUPDATE\b", code)) == 1, "the only UPDATE is the guarded DO UPDATE"
    for word in ("DELETE", "TRUNCATE", "ALTER "):
        assert word not in upper, f"unexpected {word.strip()} in the function file"
    assert "tanita_measurements" not in code, "raw measurements are not read or changed"

    # The ET-day rule and the weight range are checked before the write.
    assert "AT TIME ZONE 'America/New_York')::date <> (e.elem ->> 'log_date')::date" in flat
    assert "send one row per log_date" in flat
    assert flat.index("a weight outside 0..500 kg") < flat.index("INSERT INTO pds.weight_log")

    # Caller's rights, fixed search_path, service_role only.
    assert "SECURITY INVOKER" in upper and "SECURITY DEFINER" not in upper
    assert "SET search_path = pds, pg_temp" in flat
    sig = "pds.upsert_tanita_weight_days(jsonb)"
    assert f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC;" in flat
    assert f"REVOKE ALL ON FUNCTION {sig} FROM anon, authenticated;" in flat
    grants = re.findall(r"GRANT [^;]*;", flat)
    assert grants == [f"GRANT EXECUTE ON FUNCTION {sig} TO service_role;"], grants

    # The reply carries exactly the counts the ETL checks.
    for key in ("'rows'",) + tuple(f"'{k}'" for k in te.ROLLUP_COUNT_KEYS):
        assert key in flat, f"reply key {key} missing"


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
    print("OK - tanita weight rollup tests passed.")
