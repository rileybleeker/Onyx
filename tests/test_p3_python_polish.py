"""Python half of the 2026-06-07 re-audit P3 polish (Notion row 'Remaining P3 code polish').

Covers, offline (fakes only, no network, no database, no credentials):
  1. gps_tz_backfill.tz_for_instant_via_pg normalizes whatever shape the scalar RPC returns
     (string, one-element list, list of one-key row dicts, dict, empty) to a plain TZ string.
  2. cronometer_watcher writes its empty-inbox heartbeat at most once per interval, not on every
     10s poll (and still writes one on the first empty poll); a failing import still moves the
     file to cronometer_error/ (guard for the already-landed behavior).
  3. Guards for the already-landed heartbeats: garmin --backfill-laps / --sync-workouts and
     spotify --refresh-genres each write their sync_log row.

Run: python tests/test_p3_python_polish.py
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for _key, _value in (("SUPABASE_URL", "https://stub.supabase.co"), ("SUPABASE_SERVICE_ROLE_KEY", "stub"),
                     ("SPOTIFY_CLIENT_ID", "stub"), ("SPOTIFY_CLIENT_SECRET", "stub"),
                     ("GARMIN_EMAIL", "stub@example.invalid"), ("GARMIN_PASSWORD", "stub")):
    os.environ.setdefault(_key, _value)

# Third-party modules that may be absent on a bare runner (timezonefinder is not in requirements-ci.txt).
for _name, _attrs in (("dotenv", {"load_dotenv": lambda *a, **k: None}),
                      ("garminconnect", {"Garmin": object}),
                      ("timezonefinder", {"TimezoneFinder": lambda *a, **k: MagicMock()}),
                      ("supabase", {"create_client": lambda *a, **k: MagicMock(), "Client": object})):
    if importlib.util.find_spec(_name) is None:
        sys.modules[_name] = types.SimpleNamespace(**_attrs)

# cronometer_import builds ZoneInfo("America/New_York") at import time (needs system tzdata, absent on a bare
# Windows box) and the watcher tests only need run_import as a patch target, so stub the module.
sys.modules.setdefault("cronometer_import", types.SimpleNamespace(run_import=lambda files: (0, 0)))

import cronometer_watcher as cw  # noqa: E402
import garmin_etl as g  # noqa: E402
import gps_tz_backfill as gps  # noqa: E402
import spotify_etl  # noqa: E402

logging.disable(logging.CRITICAL)


# ---- 1. gps_tz_backfill RPC normalization ---------------------------------------------------

def test_normalize_rpc_scalar_shapes():
    n = gps._normalize_rpc_scalar
    assert n("America/Chicago") == "America/Chicago"
    assert n(["America/Chicago"]) == "America/Chicago"
    assert n([{"tz_for_instant": "America/Chicago"}]) == "America/Chicago"
    assert n({"tz_for_instant": "America/Chicago"}) == "America/Chicago"
    assert n(None) is None and n([]) is None and n("") is None and n("  ") is None and n([{}]) is None


def _fake_supa(payload):
    supa = MagicMock()
    supa.schema.return_value.rpc.return_value.execute.return_value = types.SimpleNamespace(data=payload)
    return supa


def test_tz_for_instant_via_pg_always_returns_str():
    for payload, want in (("Europe/Paris", "Europe/Paris"),
                          (["Europe/Paris"], "Europe/Paris"),
                          ([{"tz_for_instant": "Europe/Paris"}], "Europe/Paris"),
                          ([], gps.DEFAULT_TZ), (None, gps.DEFAULT_TZ)):
        with patch.object(gps, "supa", _fake_supa(payload)):
            got = gps.tz_for_instant_via_pg("2026-02-08T05:00:00+00:00")
        assert isinstance(got, str) and got == want, (payload, got)


# ---- 2. cronometer_watcher ------------------------------------------------------------------

def _empty_inbox_polls(n: int) -> list:
    calls: list = []
    sb = MagicMock()
    with tempfile.TemporaryDirectory() as tmp, \
            patch.object(cw, "INBOX", tmp), \
            patch.object(cw, "_last_heartbeat_at", None), \
            patch.object(cw, "get_supabase", return_value=sb), \
            patch.object(cw, "log_sync", side_effect=lambda *a, **k: calls.append((a, k))):
        for _ in range(n):
            assert cw.process_inbox() == 0
    return calls


def test_watcher_empty_poll_heartbeat_is_throttled():
    calls = _empty_inbox_polls(5)
    assert len(calls) == 1, f"expected 1 heartbeat for 5 rapid empty polls, got {len(calls)}"
    args, _ = calls[0]
    assert args[1:4] == ("cronometer", "watcher", "success")


def test_watcher_heartbeat_resumes_after_interval():
    calls: list = []
    with tempfile.TemporaryDirectory() as tmp, \
            patch.object(cw, "INBOX", tmp), \
            patch.object(cw, "_last_heartbeat_at", None), \
            patch.object(cw, "get_supabase", return_value=MagicMock()), \
            patch.object(cw, "log_sync", side_effect=lambda *a, **k: calls.append(1)), \
            patch.object(cw.time, "monotonic", side_effect=[1000.0, 1001.0, 1000.0 + cw.HEARTBEAT_INTERVAL_S + 1]):
        for _ in range(3):
            cw.process_inbox()
    assert len(calls) == 2, calls


def test_watcher_failed_import_moves_file_to_error_dir():
    with tempfile.TemporaryDirectory() as tmp:
        inbox, err, arch = (os.path.join(tmp, d) for d in ("in", "err", "arch"))
        for d in (inbox, err, arch):
            os.makedirs(d)
        f = os.path.join(inbox, "servings.csv")
        Path(f).write_text("x\n")
        with patch.object(cw, "INBOX", inbox), patch.object(cw, "ERROR_DIR", err), \
                patch.object(cw, "ARCHIVE", arch), patch.object(cw, "_wait_until_stable"), \
                patch.object(cw, "run_import", side_effect=RuntimeError("boom")):
            assert cw.process_inbox() == 0
        assert not os.path.exists(f) and len(os.listdir(err)) == 1 and not os.listdir(arch)


# ---- 3. guards for already-landed heartbeats --------------------------------------------------

def _run_garmin_main(flag: str):
    rows: list = []
    with patch.object(sys, "argv", ["garmin_etl.py", flag]), \
            patch.object(g, "get_garmin_client", return_value=MagicMock()), \
            patch.object(g, "get_supabase_client", return_value=MagicMock()), \
            patch.object(g, "backfill_laps", return_value=7), \
            patch.object(g, "sync_workout_definitions", return_value=3), \
            patch.object(g, "log_sync", side_effect=lambda *a, **k: rows.append((a, k))):
        g.main()
    return rows


def test_garmin_backfill_laps_writes_heartbeat():
    rows = _run_garmin_main("--backfill-laps")
    assert len(rows) == 1 and rows[0][0][1:4] == ("garmin", "lap_backfill", "success") and rows[0][1]["records"] == 7


def test_garmin_sync_workouts_writes_heartbeat():
    rows = _run_garmin_main("--sync-workouts")
    assert len(rows) == 1 and rows[0][0][1:4] == ("garmin", "workout_sync", "success") and rows[0][1]["records"] == 3


def _refresh_genres(artists: list, enriched: int) -> list:
    rows: list = []
    sb = MagicMock()
    sb.schema.return_value.table.return_value.select.return_value.execute.return_value = \
        types.SimpleNamespace(data=artists)
    with patch.object(spotify_etl, "get_supabase", return_value=sb), \
            patch.object(spotify_etl, "enrich_genres_via_musicbrainz", return_value=enriched), \
            patch.object(spotify_etl, "log_sync_entry", side_effect=lambda *a, **k: rows.append(k)):
        spotify_etl.run_refresh_genres()
    return rows


def test_spotify_refresh_genres_writes_heartbeat_noop_and_real():
    noop = _refresh_genres([{"artist_id": "a", "name": "A", "genres": ["rock"]}], 0)
    assert len(noop) == 1 and noop[0]["data_type"] == "genre_refresh" and noop[0]["records"] == 0
    real = _refresh_genres([{"artist_id": "a", "name": "A", "genres": []}], 1)
    assert len(real) == 1 and real[0]["data_type"] == "genre_refresh" and real[0]["records"] == 1


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    sys.exit(1 if failures else 0)
