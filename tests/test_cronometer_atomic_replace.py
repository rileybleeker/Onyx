"""Offline tests for the atomic Cronometer servings replace (audit deepseek/F-005).

cronometer_import.import_servings used to clear the re-imported dates and then
insert the fresh rows as separate requests, so a reader (or a crash) in between
saw days with no servings. It now makes ONE call to
pds.replace_cronometer_servings (sql/cronometer_replace_servings.sql), which
does both in a single transaction.

Everything here is faked: no network, no database, no credentials, synthetic
rows only. The fake database applies the function's contract the way Postgres
does (validate, then replace everything or change nothing).

Run: python tests/test_cronometer_atomic_replace.py
     python tests/run_offline_tests.py tests/test_cronometer_atomic_replace.py
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import cronometer_import as ci  # noqa: E402

SQL_PATH = ROOT / "sql" / "cronometer_replace_servings.sql"


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
    """In-memory pds.cronometer_servings behind the one RPC the importer may use.

    Any direct read or write of cronometer_servings fails the test: the importer
    must go through the function and nothing else.
    """

    def __init__(self, stored=(), rpc_error=None, reply=_UNSET):
        self.stored = [dict(r) for r in stored]
        self.rpc_calls: list[tuple[str, dict]] = []
        self.sync_logs: list[dict] = []
        self.rpc_error = rpc_error
        self.reply = reply            # override the function's answer

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
        raise AssertionError(f"importer touched pds.{name} directly instead of the RPC")

    from_ = table


class _Rpc:
    def __init__(self, db, fn, params):
        self.db, self.fn, self.params = db, fn, params

    def execute(self):
        db = self.db
        db.rpc_calls.append((self.fn, self.params))
        if db.rpc_error is not None:
            raise db.rpc_error                      # transaction rolled back: nothing changes
        assert self.fn == "replace_cronometer_servings", self.fn
        assert set(self.params) == {"p_dates", "p_rows"}, self.params.keys()
        dates, rows = self.params["p_dates"], self.params["p_rows"]
        if not rows:
            raise FakeAPIError("22023", "replace_cronometer_servings: p_rows is empty")
        if sorted(set(dates)) != sorted({r["calendar_date"] for r in rows}):
            raise FakeAPIError("22023", "replace_cronometer_servings: p_dates is not the set "
                                        "of calendar_date values in p_rows")
        before = len(db.stored)
        db.stored = [r for r in db.stored if r["calendar_date"] not in dates] + [dict(r) for r in rows]
        deleted = before - (len(db.stored) - len(rows))
        if db.reply is not _UNSET:
            return _Result(db.reply)
        return _Result({"dates": len(set(dates)), "deleted": deleted, "inserted": len(rows)})


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


def _row(day, name, kcal=100.0):
    return {"calendar_date": day, "food_name": name, "calories": kcal, "event_time": None,
            "onyx_et_date": day, "onyx_behavioral_date": day, "onyx_local_date": day,
            "onyx_tz_source": "cronometer_csv_date", "raw_json": {"Day": day, "Food Name": name}}


STORED = [_row("2030-01-01", "old oats"), _row("2030-01-01", "old coffee"),
          _row("2030-01-02", "old rice"), _row("2029-12-20", "outside the window")]


def _names(db, day=None):
    return sorted(r["food_name"] for r in db.stored if day is None or r["calendar_date"] == day)


def _write_csv(folder, name, lines):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write("\n".join(lines) + "\n")
    return path


def _run_import(db, paths):
    saved = ci.create_client
    ci.create_client = lambda *_a, **_k: db
    try:
        return ci.run_import(paths)
    finally:
        ci.create_client = saved


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_one_rpc_call_per_import_however_many_rows() -> None:
    rows = [_row(f"2030-01-0{1 + i % 3}", f"food {i}") for i in range(1203)]   # > 2 old batches
    db = FakeDB(STORED)
    assert ci.import_servings(rows, dry_run=False, sb=db) == 1203
    assert len(db.rpc_calls) == 1, "the replace must be a single call (one transaction)"
    fn, params = db.rpc_calls[0]
    assert fn == "replace_cronometer_servings" and len(params["p_rows"]) == 1203


def test_dates_are_exactly_the_import_window() -> None:
    rows = [_row("2030-01-02", "new rice"), _row("2030-01-01", "new oats"),
            _row("2030-01-01", "new tea")]
    db = FakeDB(STORED)
    assert ci.import_servings(rows, dry_run=False, sb=db) == 3
    params = db.rpc_calls[0][1]
    assert params["p_dates"] == ["2030-01-01", "2030-01-02"], params["p_dates"]
    assert {r["calendar_date"] for r in params["p_rows"]} == set(params["p_dates"])
    assert _names(db, "2030-01-01") == ["new oats", "new tea"]
    assert _names(db, "2030-01-02") == ["new rice"]
    assert _names(db, "2029-12-20") == ["outside the window"], "a date not in the export was touched"


def test_empty_export_makes_no_call_and_wipes_nothing() -> None:
    db = FakeDB(STORED)
    assert ci.import_servings([], dry_run=False, sb=db) == 0
    assert db.rpc_calls == [] and len(db.stored) == len(STORED)
    # Through run_import with a header-only servings.csv (what a no-food window exports).
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_csv(tmp, "servings.csv", ["Day,Group,Food Name,Amount,Energy (kcal)"])
        assert _run_import(db, [path]) == (0, 0)
    assert db.rpc_calls == [] and _names(db) == _names(FakeDB(STORED))
    hb = {r["data_type"]: r for r in db.sync_logs}
    assert hb["servings"]["status"] == "success" and hb["servings"]["records_synced"] == 0


def test_dry_run_makes_no_call() -> None:
    db = FakeDB(STORED)
    assert ci.import_servings([_row("2030-01-01", "x")], dry_run=True, sb=db) == 1
    assert db.rpc_calls == [] and len(db.stored) == len(STORED)


def test_failure_leaves_data_untouched_and_there_is_no_fallback() -> None:
    db = FakeDB(STORED, rpc_error=FakeAPIError("22P02", "invalid input syntax for type numeric"))
    try:
        ci.import_servings([_row("2030-01-01", "new oats")], dry_run=False, sb=db)
    except FakeAPIError as e:
        assert "invalid input syntax" in str(e)
    else:
        raise AssertionError("a failed replace must raise")
    assert len(db.rpc_calls) == 1, "no retry, no second path"
    assert _names(db) == _names(FakeDB(STORED)), "stored servings changed after a failed import"
    # (FakeDB.table() raises on any direct cronometer_servings access, so reaching here
    #  also proves no separate delete / insert request was attempted.)


def test_failure_through_run_import_writes_an_error_heartbeat() -> None:
    db = FakeDB(STORED, rpc_error=FakeAPIError("57014", "canceling statement due to statement timeout"))
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_csv(tmp, "servings.csv", [
            "Day,Group,Food Name,Amount,Energy (kcal)",
            "2030-01-01,Breakfast,Test Oats,40.00 g,150.0",
        ])
        try:
            _run_import(db, [path])
        except FakeAPIError:
            pass
        else:
            raise AssertionError("run_import must re-raise")
    assert _names(db) == _names(FakeDB(STORED))
    hb = [r for r in db.sync_logs if r["data_type"] == "servings"]
    assert len(hb) == 1 and hb[0]["status"] == "error", hb
    assert "statement timeout" in hb[0]["error_message"]


def test_missing_function_is_a_clear_error_that_names_the_sql_file() -> None:
    missing = FakeAPIError(
        "PGRST202",
        "Could not find the function pds.replace_cronometer_servings(p_dates, p_rows) in the schema cache")
    db = FakeDB(STORED, rpc_error=missing)
    try:
        ci.import_servings([_row("2030-01-01", "new oats")], dry_run=False, sb=db)
    except RuntimeError as e:
        msg = str(e)
        assert "sql/cronometer_replace_servings.sql" in msg and "No servings were changed" in msg, msg
        assert e.__cause__ is missing
    else:
        raise AssertionError("a missing function must raise")
    assert len(db.rpc_calls) == 1 and _names(db) == _names(FakeDB(STORED))
    # Another function's PGRST202 or an unrelated error is not rewritten.
    assert not ci._is_missing_function(FakeAPIError("PGRST202", "Could not find the function pds.other()"))
    assert not ci._is_missing_function(FakeAPIError("23505", "duplicate key"))
    assert ci._is_missing_function(FakeAPIError(
        "42883", "function pds.replace_cronometer_servings(date[], jsonb) does not exist"))


def test_reply_that_does_not_confirm_every_row_raises() -> None:
    for reply in ({"dates": 1, "deleted": 2, "inserted": 1}, None, [], "ok"):
        db = FakeDB(STORED, reply=reply)
        try:
            ci.import_servings([_row("2030-01-01", "a"), _row("2030-01-01", "b")], dry_run=False, sb=db)
        except RuntimeError as e:
            assert "cannot be confirmed" in str(e)
        else:
            raise AssertionError(f"reply {reply!r} must not count as a confirmed import")


def test_run_import_end_to_end_with_a_synthetic_export() -> None:
    db = FakeDB(STORED)
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_csv(tmp, "servings.csv", [
            "Day,Time,Group,Food Name,Amount,Energy (kcal),Caffeine (mg),Protein (g)",
            "2030-01-01,8:05 AM,Breakfast,Test Oats,40.00 g,150.0,,5.0",
            "2030-01-01,8:10 AM,Breakfast,Test Coffee,1.00 cup,2.0,95.0,0.3",
            "2030-01-02,12:30 AM,Snacks,Test Late Snack,1.00 bar,210.0,,9.0",
        ])
        assert _run_import(db, [path]) == (3, 0)
    assert len(db.rpc_calls) == 1
    params = db.rpc_calls[0][1]
    assert params["p_dates"] == ["2030-01-01", "2030-01-02"]
    by_name = {r["food_name"]: r for r in params["p_rows"]}
    assert by_name["Test Coffee"]["caffeine_mg"] == 95.0 and by_name["Test Oats"]["caffeine_mg"] is None
    assert by_name["Test Late Snack"]["onyx_behavioral_date"] == "2030-01-01", "the -6h rule"
    assert isinstance(by_name["Test Oats"]["raw_json"], dict), "JSONB must be a dict, never json.dumps"
    assert not {"serving_id", "synced_at"} & set(by_name["Test Oats"]), "defaults belong to the database"
    assert _names(db, "2030-01-01") == ["Test Coffee", "Test Oats"]
    assert _names(db, "2029-12-20") == ["outside the window"]
    hb = {r["data_type"]: r for r in db.sync_logs}
    assert hb["servings"]["status"] == "success" and hb["servings"]["records_synced"] == 3
    assert hb["servings"]["date_range_start"] == "2030-01-01"
    assert hb["servings"]["date_range_end"] == "2030-01-02"


def test_importer_has_no_separate_delete_or_insert_left() -> None:
    src = (ROOT / "cronometer_import.py").read_text(encoding="utf-8")
    body = src[src.index("def import_servings("):src.index("def import_daily(")]
    assert ".delete(" not in body and ".insert(" not in body and ".upsert(" not in body, \
        "import_servings must only call the RPC"
    assert body.count(".rpc(") == 1


def test_sql_function_contract() -> None:
    """Static checks on the SQL the scrum master reviews and applies."""
    raw = SQL_PATH.read_text(encoding="utf-8")
    code = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())   # drop comments
    flat = re.sub(r"\s+", " ", code)
    upper = flat.upper()

    # Same name and argument names as the importer sends.
    assert f"FUNCTION pds.{ci.REPLACE_SERVINGS_RPC}(p_dates date[], p_rows jsonb)" in flat
    assert ci.REPLACE_SERVINGS_SQL == "sql/cronometer_replace_servings.sql" and SQL_PATH.is_file()

    # Exactly one delete, limited to the passed dates of this one table.
    assert upper.count("DELETE ") == 1, "exactly one DELETE statement"
    assert "DELETE FROM pds.cronometer_servings WHERE calendar_date = ANY (p_dates);" in flat
    for word in ("DROP ", "TRUNCATE", "ALTER ", "UPDATE "):
        assert word not in upper, f"unexpected {word.strip()} in the function file"
    assert upper.count("INSERT INTO") == 1 and "INSERT INTO pds.cronometer_servings" in flat

    # Runs with the caller's rights, fixed search_path, one import at a time.
    assert "SECURITY INVOKER" in upper and "SECURITY DEFINER" not in upper
    assert "SET search_path = pds, pg_temp" in flat
    assert "pg_advisory_xact_lock(" in flat

    # Refuses to clear days it has nothing to put back for.
    assert "p_rows is empty" in flat and "v_row_dates IS DISTINCT FROM v_arg_dates" in flat

    # service_role only.
    sig = "pds.replace_cronometer_servings(date[], jsonb)"
    assert f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC;" in flat
    assert f"REVOKE ALL ON FUNCTION {sig} FROM anon, authenticated;" in flat
    grants = re.findall(r"GRANT [^;]*;", flat)
    assert grants == [f"GRANT EXECUTE ON FUNCTION {sig} TO service_role;"], grants


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
    print("OK - cronometer atomic replace tests passed.")
