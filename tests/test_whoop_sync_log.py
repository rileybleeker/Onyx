"""Offline tests for the WHOOP ETL's heartbeat and its record count.

whoop_etl.py used to carry its own copy of the pds.sync_log insert (audit
etl/deepseek/F-004). It now goes through sync_log_helper.log_sync like the other ETLs.
Pinned here, with a fake WHOOP and a fake Supabase (no network, no database, no
credentials, synthetic values only):

  1. whoop_etl.log_sync writes the same row shape through the shared helper, and no
     hand-written sync_log insert is left in the file.
  2. Every way a run can end still writes exactly one heartbeat: success, an endpoint
     failing (partial), the profile check failing (failed + exit 1), and an uncaught
     exception (failed, re-raised). `--auth` writes none (interactive bootstrap).
  3. records_synced comes from the rows PostgREST returns (audit etl/gpt-5/F-010). That
     is right as long as supabase-py asks for `return=representation`, which is its
     default; this test sends a real upsert through a stubbed HTTP layer and fails if
     a client upgrade ever changes that default.

Run: python tests/test_whoop_sync_log.py
     python tests/run_offline_tests.py tests/test_whoop_sync_log.py
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import types
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("WHOOP_CLIENT_ID", "stub-client-id")
os.environ.setdefault("WHOOP_CLIENT_SECRET", "stub-client-secret")

try:  # whoop_etl imports `requests` for the OAuth bootstrap only; never used here.
    import requests  # noqa: F401
except ImportError:  # pragma: no cover - depends on the CI image
    sys.modules["requests"] = types.ModuleType("requests")

import httpx  # noqa: E402
from supabase import create_client  # noqa: E402

import sync_log_helper  # noqa: E402
import whoop_etl as w  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeSupabase:
    """Records sync_log inserts; answers the matview-refresh rpc."""

    def __init__(self, fail_insert: bool = False):
        self.sync_logs: list[dict] = []
        self.rpcs: list[str] = []
        self.fail_insert = fail_insert
        self._pending = None

    def schema(self, name):
        assert name == "pds", name
        return self

    def table(self, name):
        assert name == "sync_log", f"unexpected table {name}"
        return self

    def insert(self, row):
        self._pending = dict(row)
        return self

    def rpc(self, name, _params):
        self.rpcs.append(name)
        self._pending = None
        return self

    def execute(self):
        if self._pending is not None:
            if self.fail_insert:
                raise RuntimeError("synthetic insert failure")
            self.sync_logs.append(self._pending)
            self._pending = None
        return types.SimpleNamespace(data=[])


class FakeWhoop:
    def __init__(self, profile_error: Exception | None = None):
        self.profile_error = profile_error

    def get_profile(self):
        if self.profile_error is not None:
            raise self.profile_error
        return {"first_name": "Test", "last_name": "User"}


class Harness:
    """Runs whoop_etl.main() / cli() against the fakes."""

    def __init__(self, counts=None, failing=(), profile_error=None, main_error=None):
        self.db = FakeSupabase()
        self.counts = counts or {"cycles": 7, "recovery": 7, "sleep": 8, "workouts": 3,
                                 "body_measurement": 1}
        self.failing = set(failing)
        self.profile_error, self.main_error = profile_error, main_error
        self.synced: list[str] = []
        self.subprocess_calls: list[list[str]] = []

    def _sync(self, name):
        def fn(*_a, **_k):
            self.synced.append(name)
            if name in self.failing:
                raise RuntimeError(f"synthetic {name} failure")
            return self.counts[name]
        return fn

    def _client(self):
        if self.main_error is not None:
            raise self.main_error
        return FakeWhoop(self.profile_error)

    @contextlib.contextmanager
    def patched(self, argv=("whoop_etl.py",)):
        def fake_subprocess_run(cmd, **_k):
            self.subprocess_calls.append(list(cmd))

        with contextlib.ExitStack() as stack:
            for name in self.counts:
                stack.enter_context(patch.object(w, f"sync_{name}", self._sync(name)))
            stack.enter_context(patch.object(w, "WhoopClient", self._client))
            stack.enter_context(patch.object(w, "get_supabase_client", lambda: self.db))
            stack.enter_context(patch.object(w.time, "sleep", lambda *_a: None))
            stack.enter_context(patch("subprocess.run", fake_subprocess_run))
            stack.enter_context(patch.object(sys, "argv", list(argv)))
            yield self


def _only_heartbeat(db: FakeSupabase) -> dict:
    assert len(db.sync_logs) == 1, db.sync_logs
    row = db.sync_logs[0]
    assert (row["source"], row["data_type"]) == ("whoop", "full_sync")
    start = datetime.fromisoformat(row["sync_start"])
    end = datetime.fromisoformat(row["sync_end"])
    assert start.tzinfo is not None and end >= start
    assert row["duration_seconds"] >= 0
    return row


# ---------------------------------------------------------------------------
# 1. The wrapper goes through the shared helper
# ---------------------------------------------------------------------------

def test_log_sync_writes_the_shared_row_shape() -> None:
    db = FakeSupabase()
    w.log_sync(db, "whoop", "full_sync", "success", records=26,
               date_start=date(2026, 1, 1), date_end=date(2026, 1, 8), duration=12.6)
    row = _only_heartbeat(db)
    assert row["status"] == "success" and row["records_synced"] == 26
    assert row["error_message"] is None
    assert row["date_range_start"] == "2026-01-01" and row["date_range_end"] == "2026-01-08"
    span = (datetime.fromisoformat(row["sync_end"]) -
            datetime.fromisoformat(row["sync_start"])).total_seconds()
    assert 12.5 <= span < 14, span                    # sync_start = now - duration
    assert row["duration_seconds"] in (12, 13), row["duration_seconds"]
    assert set(row) == {"source", "data_type", "status", "records_synced", "duration_seconds",
                        "error_message", "sync_start", "sync_end", "date_range_start",
                        "date_range_end"}


def test_log_sync_without_duration_or_dates() -> None:
    db = FakeSupabase()
    w.log_sync(db, "whoop", "full_sync", "failed", error="synthetic failure")
    row = _only_heartbeat(db)
    assert row["status"] == "failed" and row["records_synced"] == 0
    assert row["error_message"] == "synthetic failure" and row["duration_seconds"] == 0
    assert row["sync_start"] == row["sync_end"], "no start given: one clock reading for both"
    assert "date_range_start" not in row and "date_range_end" not in row


def test_log_sync_never_raises_when_the_insert_fails() -> None:
    db = FakeSupabase(fail_insert=True)
    w.log_sync(db, "whoop", "full_sync", "success", records=1, duration=1.0)
    assert db.sync_logs == []


def test_no_hand_written_sync_log_insert_is_left() -> None:
    source = (ROOT / "whoop_etl.py").read_text(encoding="utf-8")
    assert '"sync_log"' not in source and "'sync_log'" not in source
    assert w._shared_log_sync is sync_log_helper.log_sync


# ---------------------------------------------------------------------------
# 2. One heartbeat on every outcome
# ---------------------------------------------------------------------------

def test_successful_run_writes_one_success_heartbeat() -> None:
    h = Harness()
    with h.patched():
        w.main()
    row = _only_heartbeat(h.db)
    assert row["status"] == "success" and row["error_message"] is None
    assert row["records_synced"] == 26                 # 7 + 7 + 8 + 3 + 1
    assert row["date_range_start"] < row["date_range_end"]
    assert h.synced == ["cycles", "recovery", "sleep", "workouts", "body_measurement"]
    assert h.db.rpcs == ["refresh_materialized_views"]
    assert [c[1] for c in h.subprocess_calls] == ["whoop_tz_backfill.py"]


def test_one_failing_endpoint_is_partial_and_counts_the_rest() -> None:
    h = Harness(failing={"sleep"})
    with h.patched():
        w.main()
    row = _only_heartbeat(h.db)
    assert row["status"] == "partial" and row["records_synced"] == 18
    assert row["error_message"] == "1 endpoint(s) failed"


def test_profile_failure_writes_failed_heartbeat_and_exits_1() -> None:
    h = Harness(profile_error=RuntimeError("synthetic 401"))
    code = None
    with h.patched():
        try:
            w.cli()
        except SystemExit as exc:
            code = exc.code
    assert code == 1
    row = _only_heartbeat(h.db)                        # one row, not one per layer
    assert row["status"] == "failed" and row["records_synced"] == 0
    assert row["error_message"] == "WHOOP profile check failed: synthetic 401"
    assert h.synced == []


def test_uncaught_exception_writes_failed_heartbeat_and_still_raises() -> None:
    h = Harness(main_error=RuntimeError("synthetic token file missing"))
    raised = None
    with h.patched():
        try:
            w.cli()
        except RuntimeError as exc:
            raised = exc
    assert raised is not None
    row = _only_heartbeat(h.db)
    assert row["status"] == "failed"
    assert row["error_message"] == "Uncaught exception: synthetic token file missing"


def test_auth_run_writes_no_heartbeat() -> None:
    h = Harness()
    raised = None
    with h.patched(argv=("whoop_etl.py", "--auth")), \
            patch.object(w, "do_oauth_flow", side_effect=RuntimeError("synthetic: no browser")):
        try:
            w.cli()
        except RuntimeError as exc:
            raised = exc
    assert raised is not None and h.db.sync_logs == []


# ---------------------------------------------------------------------------
# 3. The record count
# ---------------------------------------------------------------------------

def test_upsert_count_uses_the_rows_postgrest_returns() -> None:
    sent: list[httpx.Request] = []

    def fake_send(_self, request, **_k):
        sent.append(request)
        return httpx.Response(201, json=json.loads(request.content), request=request)

    rows = [{"cycle_id": 1, "strain": 10.5}, {"cycle_id": 2, "strain": 4.0},
            {"cycle_id": 3, "strain": 7.25}]
    with patch.object(httpx.Client, "send", fake_send):
        sb = create_client("https://stub.supabase.co", "stub.stub.stub")
        assert w.upsert_to_supabase(sb, "whoop_cycles", rows, "cycle_id") == 3
        assert w.upsert_to_supabase(sb, "whoop_cycles", [], "cycle_id") == 0
    assert len(sent) == 1, "an empty batch must not send a request"
    prefer = sent[0].headers.get("prefer", "")
    assert "return=representation" in prefer, (
        f"supabase-py no longer asks PostgREST to return the written rows ({prefer!r}); "
        "every ETL that reports len(result.data) would log records_synced=0")
    assert sent[0].url.path.endswith("/whoop_cycles")
    assert sent[0].url.params.get("on_conflict") == "cycle_id"


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
    print("OK - whoop sync_log tests passed.")
