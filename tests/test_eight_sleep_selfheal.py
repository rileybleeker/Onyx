"""Offline tests for the Eight Sleep temp self-heal step (eight_sleep_etl.self_heal_temps).

The /intervals collection endpoint only returns the 10 most recent sessions, so
a long pause leaves median_bed_temp / median_room_temp NULL on older trends
rows. self_heal_temps() recovers them via the per-ID endpoint, bounded per run,
idempotent, and never overwriting a non-NULL value.

Everything here is faked (no network, no database, no credentials).

Run: python tests/test_eight_sleep_selfheal.py
     python tests/run_offline_tests.py tests/test_eight_sleep_selfheal.py
"""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("EIGHTSLEEP_EMAIL", "stub@example.com")
os.environ.setdefault("EIGHTSLEEP_PASSWORD", "stub")
os.environ.setdefault("EIGHTSLEEP_CLIENT_ID", "stub")
os.environ.setdefault("EIGHTSLEEP_CLIENT_SECRET", "stub")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import eight_sleep_etl as es  # noqa: E402

TODAY = date(2026, 11, 11)
USERS = {"left": "u-left", "right": "u-right"}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    """In-memory pds.eight_sleep_trends with the query-builder surface the heal uses."""

    def __init__(self, rows, fail_select=False):
        self.rows = [dict(r) for r in rows]
        self.updates: list[dict] = []   # {"payload", "filters"} per UPDATE executed
        self.sync_logs: list[dict] = []
        self.fail_select = fail_select

    def schema(self, _name):
        return self

    def from_(self, table):
        assert table == "eight_sleep_trends", table
        return _Query(self)

    table = from_


class _Query:
    def __init__(self, db: FakeSupabase):
        self.db = db
        self.mode = "select"
        self.payload = None
        self.preds = []          # (kind, col, val)
        self._order_desc = False
        self._limit = None

    def select(self, _cols):
        self.mode = "select"
        return self

    def update(self, payload):
        self.mode = "update"
        self.payload = dict(payload)
        return self

    def gte(self, col, val):
        self.preds.append(("gte", col, val)); return self

    def lt(self, col, val):
        self.preds.append(("lt", col, val)); return self

    def eq(self, col, val):
        self.preds.append(("eq", col, val)); return self

    def is_(self, col, val):
        assert val == "null"
        self.preds.append(("isnull", col, None)); return self

    def or_(self, expr):
        assert expr == "median_bed_temp.is.null,median_room_temp.is.null", expr
        self.preds.append(("either_temp_null", None, None)); return self

    def order(self, col, desc=False):
        assert col == "calendar_date"
        self._order_desc = desc
        return self

    def limit(self, n):
        self._limit = n; return self

    def _match(self, row):
        for kind, col, val in self.preds:
            if kind == "gte" and not row[col] >= val: return False
            if kind == "lt" and not row[col] < val: return False
            if kind == "eq" and row[col] != val: return False
            if kind == "isnull" and row.get(col) is not None: return False
            if kind == "either_temp_null" and not (
                    row.get("median_bed_temp") is None
                    or row.get("median_room_temp") is None):
                return False
        return True

    def execute(self):
        if self.mode == "select":
            if self.db.fail_select:
                raise RuntimeError("select boom")
            out = [dict(r) for r in self.db.rows if self._match(r)]
            out.sort(key=lambda r: r["calendar_date"], reverse=self._order_desc)
            return _Result(out[: self._limit] if self._limit else out)
        hit = [r for r in self.db.rows if self._match(r)]
        for r in hit:
            r.update(self.payload)
        self.db.updates.append({"payload": self.payload, "n": len(hit),
                                "filters": list(self.preds)})
        return _Result(hit)


class FakeClient:
    """Stands in for EightSleepClient; records per-ID calls."""

    def __init__(self, intervals: dict[str, object]):
        self.intervals = intervals      # session_id -> interval dict | None | Exception
        self.calls: list[tuple[str, str]] = []

    def get_interval(self, user_id, session_id):
        self.calls.append((user_id, session_id))
        v = self.intervals.get(session_id)
        if isinstance(v, Exception):
            raise v
        return v


def _trend_row(cal, side="left", sid=None, bed=None, room=None, raw="auto"):
    if raw == "auto":
        raw = {"mainSessionId": sid or f"s-{cal}-{side}", "sessionIds": [sid or f"s-{cal}-{side}"]}
    return {"calendar_date": cal, "bed_side": side, "raw_json": raw,
            "median_bed_temp": bed, "median_room_temp": room}


def _interval(bed=(24.0, 26.0, 25.0), room=(19.0, 21.0, 20.0)):
    mk = lambda vals: [[f"t{i}", v] for i, v in enumerate(vals)] if vals else []
    return {"timeseries": {"tempBedC": mk(bed), "tempRoomC": mk(room)}}


def _heal(sb, client, **kw):
    kw.setdefault("delay_s", 0)
    return es.self_heal_temps(client, sb, USERS, TODAY, **kw)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_gap_row_is_healed_with_medians() -> None:
    sb = FakeSupabase([_trend_row("2026-11-01", sid="S1")])
    client = FakeClient({"S1": _interval()})
    stats = _heal(sb, client)
    assert stats["healed"] == 1 and stats["attempted"] == 1 and stats["failed"] == 0, stats
    assert client.calls == [("u-left", "S1")]
    row = sb.rows[0]
    assert row["median_bed_temp"] == 25.0 and row["median_room_temp"] == 20.0, row
    # The UPDATE re-checks IS NULL on every column it writes.
    kinds = {(k, c) for k, c, _ in sb.updates[0]["filters"]}
    assert ("isnull", "median_bed_temp") in kinds and ("isnull", "median_room_temp") in kinds


def test_non_null_values_are_never_overwritten() -> None:
    # bed already set (22.5); only room is NULL. Interval would give bed=25.0.
    sb = FakeSupabase([_trend_row("2026-11-01", sid="S1", bed=22.5, room=None)])
    client = FakeClient({"S1": _interval()})
    stats = _heal(sb, client)
    assert stats["healed"] == 1, stats
    assert sb.rows[0]["median_bed_temp"] == 22.5, "non-null bed temp was overwritten"
    assert sb.rows[0]["median_room_temp"] == 20.0
    assert set(sb.updates[0]["payload"]) == {"median_room_temp"}, sb.updates[0]
    # Rows with both temps present are not even candidates (no API call).
    sb2 = FakeSupabase([_trend_row("2026-11-02", sid="S2", bed=22.5, room=18.0)])
    client2 = FakeClient({"S2": _interval()})
    stats2 = _heal(sb2, client2)
    assert stats2["candidates"] == 0 and client2.calls == [] and sb2.updates == [], stats2


def test_idempotent_second_run_makes_no_calls() -> None:
    sb = FakeSupabase([_trend_row("2026-11-01", sid="S1")])
    client = FakeClient({"S1": _interval()})
    first = _heal(sb, client)
    second = _heal(sb, client)
    assert first["healed"] == 1
    assert second["candidates"] == 0 and second["healed"] == 0
    assert len(client.calls) == 1 and len(sb.updates) == 1


def test_per_run_cap_is_respected_newest_first() -> None:
    dates = [f"2026-11-0{d}" for d in range(1, 10)]          # 9 gap rows
    sb = FakeSupabase([_trend_row(d, sid=f"S{d}") for d in dates])
    client = FakeClient({f"S{d}": _interval() for d in dates})
    stats = _heal(sb, client, max_rows=3)
    assert stats["attempted"] == 3 and stats["healed"] == 3, stats
    assert stats["candidates"] == 9
    assert len(client.calls) == 3
    healed_dates = sorted(r["calendar_date"] for r in sb.rows if r["median_bed_temp"] is not None)
    assert healed_dates == ["2026-11-07", "2026-11-08", "2026-11-09"], healed_dates
    # The remaining gaps are picked up on later runs.
    again = _heal(sb, client, max_rows=3)
    assert again["healed"] == 3
    # max_rows=0 disables the step entirely.
    sb0 = FakeSupabase([_trend_row("2026-11-01", sid="S1")])
    c0 = FakeClient({"S1": _interval()})
    assert _heal(sb0, c0, max_rows=0)["attempted"] == 0 and c0.calls == []


def test_api_error_leaves_row_null_and_is_counted() -> None:
    import httpx
    sb = FakeSupabase([
        _trend_row("2026-11-05", sid="BAD"),
        _trend_row("2026-11-04", sid="OK"),
    ])
    boom = httpx.HTTPStatusError(
        "500", request=httpx.Request("GET", "http://x"),
        response=httpx.Response(500, request=httpx.Request("GET", "http://x")))
    client = FakeClient({"BAD": boom, "OK": _interval()})
    stats = _heal(sb, client)
    by_date = {r["calendar_date"]: r for r in sb.rows}
    assert by_date["2026-11-05"]["median_bed_temp"] is None, "errored row must stay NULL"
    assert by_date["2026-11-04"]["median_bed_temp"] == 25.0, "one failure must not stop the others"
    assert stats["failed"] == 1 and stats["healed"] == 1 and stats["attempted"] == 2, stats
    assert "failed=1" in es._selfheal_summary(stats, 20)


def test_missing_session_unknown_side_and_empty_timeseries() -> None:
    sb = FakeSupabase([
        _trend_row("2026-11-06", sid="NOTFOUND"),                       # 404 -> None
        _trend_row("2026-11-05", sid="NOTEMP"),                         # interval w/o temps
        _trend_row("2026-11-04", raw=None),                             # no raw_json
        _trend_row("2026-11-03", raw={"foo": 1}),                       # no session ids
        _trend_row("2026-11-02", side="center", sid="ORPHAN"),          # unknown side
    ])
    client = FakeClient({"NOTFOUND": None, "NOTEMP": {"timeseries": {}}, "ORPHAN": _interval()})
    stats = _heal(sb, client)
    assert stats["not_found"] == 1 and stats["no_temp"] == 1 and stats["skipped"] == 3, stats
    assert stats["healed"] == 0 and stats["failed"] == 0
    assert stats["attempted"] == 2, "skipped rows must not consume the per-run cap"
    assert sb.updates == []
    assert all(r["median_bed_temp"] is None for r in sb.rows)


def test_session_id_parsing_handles_json_string_and_sessionids_fallback() -> None:
    assert es._session_id_from_raw('{"mainSessionId": "A"}') == "A"
    assert es._session_id_from_raw({"sessionIds": ["B", "C"]}) == "B"
    assert es._session_id_from_raw({"mainSessionId": None, "sessionIds": []}) is None
    assert es._session_id_from_raw("not json") is None
    assert es._session_id_from_raw(None) is None
    sb = FakeSupabase([_trend_row("2026-11-01", raw='{"mainSessionId": "S1"}')])  # double-encoded
    assert _heal(sb, FakeClient({"S1": _interval()}))["healed"] == 1


def test_today_and_stale_rows_are_out_of_scope() -> None:
    sb = FakeSupabase([
        _trend_row("2026-11-11", sid="TODAY"),       # today: session may still be processing
        _trend_row("2026-08-01", sid="OLD"),         # older than the lookback window
    ])
    client = FakeClient({"TODAY": _interval(), "OLD": _interval()})
    stats = _heal(sb, client)
    assert stats["candidates"] == 0 and client.calls == [], stats


def test_candidate_query_failure_is_reported_not_raised() -> None:
    sb = FakeSupabase([_trend_row("2026-11-01", sid="S1")], fail_select=True)
    stats = _heal(sb, FakeClient({"S1": _interval()}))
    assert stats["scan_error"] and "select boom" in stats["scan_error"], stats
    assert stats["healed"] == 0
    assert "candidate query failed" in es._selfheal_summary(stats, 20)


def test_client_get_interval_maps_404_to_none_and_raises_other_errors() -> None:
    import httpx

    def make(status):
        def handler(request):
            return httpx.Response(status, json={"id": "S1"}, request=request)
        c = es.EightSleepClient("e", "p", "America/New_York")
        c.token = "t"
        c.http = httpx.Client(transport=httpx.MockTransport(handler))
        return c

    assert make(200).get_interval("u", "S1") == {"id": "S1"}
    assert make(404).get_interval("u", "S1") is None
    try:
        make(403).get_interval("u", "S1")
    except httpx.HTTPStatusError:
        pass
    else:
        raise AssertionError("403 must propagate so the heal counts it as failed")


def test_shared_sync_log_helper_replaces_bespoke_writer() -> None:
    import sync_log_helper
    assert es.log_sync is sync_log_helper.log_sync
    captured = {}

    class SB:
        def schema(self, _): return self
        def table(self, _): return self
        def insert(self, row): captured.update(row); return self
        def execute(self): return None

    es.log_sync(SB(), "eight_sleep", "temp_selfheal", "success", records=4,
                started_at=0.0, date_range_start=date(2026, 9, 12), date_range_end=TODAY)
    assert captured["source"] == "eight_sleep" and captured["data_type"] == "temp_selfheal"
    assert captured["records_synced"] == 4
    assert captured["sync_start"] and captured["sync_end"], "helper must set both timestamps"


def test_main_runs_heal_after_sync_and_logs_healed_count() -> None:
    """main(): heal runs after the normal sync, its count lands in sync_log."""
    import time as _time

    class MainDB(FakeSupabase):
        def table(self, name):
            if name == "sync_log":
                return _SyncLogSink(self)
            return super().from_(name)

        def from_(self, name):
            return self.table(name)

        def rpc(self, *_a, **_k):
            return self

        def execute(self):
            return _Result(None)

    class _SyncLogSink:
        def __init__(self, db): self.db = db
        def insert(self, row): self.db.sync_logs.append(row); return self
        def execute(self): return _Result(None)

    sb = MainDB([_trend_row("2026-11-01", sid="S1"), _trend_row("2026-11-02", sid="S2")])
    client = FakeClient({"S1": _interval(), "S2": _interval()})
    client.close = lambda: None
    client.authenticate = lambda: None
    saved = (es.EightSleepClient, es.get_supabase_client, es.discover_users,
             es.sync_user, sys.argv, _time.sleep)
    es.EightSleepClient = lambda *a, **k: client
    es.get_supabase_client = lambda: sb
    es.discover_users = lambda c: {"left": "u-left"}
    es.sync_user = lambda *a, **k: 5
    sys.argv = ["eight_sleep_etl.py", "--days", "7", "--selfheal-max", "1"]
    es.time.sleep = lambda *_: None
    try:
        es.main()
    finally:
        (es.EightSleepClient, es.get_supabase_client, es.discover_users,
         es.sync_user, sys.argv, es.time.sleep) = saved
    by_type = {r["data_type"]: r for r in sb.sync_logs}
    assert by_type["trends"]["records_synced"] == 5 and by_type["trends"]["status"] == "success"
    heal_row = by_type["temp_selfheal"]
    assert heal_row["source"] == "eight_sleep" and heal_row["records_synced"] == 1, heal_row
    assert heal_row["status"] == "success" and heal_row["error_message"] is None
    assert heal_row["sync_start"] and heal_row["sync_end"]
    assert len(client.calls) == 1, "--selfheal-max 1 must cap per-ID calls"
    # --selfheal-max 0 -> no heal, no extra sync_log row.
    sb2 = MainDB([_trend_row("2026-11-01", sid="S1")])
    es.get_supabase_client = lambda: sb2
    es.EightSleepClient = lambda *a, **k: client
    es.discover_users = lambda c: {"left": "u-left"}
    es.sync_user = lambda *a, **k: 0
    sys.argv = ["eight_sleep_etl.py", "--selfheal-max", "0"]
    es.time.sleep = lambda *_: None
    try:
        es.main()
    finally:
        (es.EightSleepClient, es.get_supabase_client, es.discover_users,
         es.sync_user, sys.argv, es.time.sleep) = saved
    assert [r["data_type"] for r in sb2.sync_logs] == ["trends"], sb2.sync_logs


def test_upsert_requests_representation_and_counts_rows() -> None:
    seen = {}

    class SB:
        def schema(self, _): return self
        def table(self, _): return self
        def upsert(self, rows, **kw):
            seen.update(kw); self._n = len(rows); return self
        def execute(self): return _Result([{}] * self._n)

    assert es.upsert_to_supabase(SB(), "eight_sleep_trends", [{"a": 1}, {"a": 2}],
                                 "calendar_date,bed_side") == 2
    assert seen.get("returning") == "representation", seen
    assert seen.get("on_conflict") == "calendar_date,bed_side"
    assert es.upsert_to_supabase(SB(), "eight_sleep_trends", [], "x") == 0


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
    print("OK - eight_sleep self-heal tests passed.")
