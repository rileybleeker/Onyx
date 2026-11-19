"""Isolated PostgreSQL fixtures for the chat ledger purge (Codex #817 CHAT819-2).

sql/chat_ledger_retention.sql must write a pds.chat_retired_requests marker only for a request the same run
really deletes, and count what it really deleted. This file runs the real file against a throwaway database
that holds only synthetic copies of pds.chat_requests, pds.chat_operations and pds.chat_operation_tombstones
(the columns the purge reads, as in sql/chat_operations.sql) and checks:

  - an old idle request is deleted with its operations, leaves one marker, and the counts match the rows;
  - a dry run changes nothing;
  - a request whose operation was updated inside the window (a finished retry) or that has a tombstone is kept,
    with no marker;
  - concurrent renewal: a second session renews the lease and has not committed yet when the purge runs. The
    request is kept and gets NO marker, also after that session commits (the bug: the marker was inserted
    without a lock, the DELETE then skipped the renewed row, and the marker stayed);
  - concurrent retry: a second session updates one of the request's operations and commits while the purge
    waits on it. The purge re-checks after the wait, keeps the request and writes no marker.

Safety: every statement batch first refuses to run unless the database name ends in "_fixture" and its pds
schema is absent or carries this file's marker table (pds._chat_ledger_fixture), so it cannot touch a real
Onyx database. Only synthetic UUIDs are used.

The test starts its own throwaway cluster (initdb into a temporary folder, listening only on a Unix socket
there, clean environment, no credential read) and removes it afterwards. Without PostgreSQL binaries
(ONYX_PG_BIN, initdb on PATH, /usr/lib/postgresql/<n>/bin), or as root (initdb refuses), it is skipped, except
on a GitHub Actions Linux runner, where PostgreSQL is preinstalled: there a missing one is a failure, so this
coverage cannot vanish silently. ONYX_PG_FIXTURE_DSN (a disposable *_fixture database) replaces the throwaway
cluster, for a run as root. It runs in the scheduled suite (tests/run_offline_tests.py picks it up).

Run: python tests/test_chat_ledger_retention_pg.py
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PURGE = ROOT / "sql" / "chat_ledger_retention.sql"

GUARD = """DO $guard$
BEGIN
    IF current_database() !~ '_fixture$' THEN
        RAISE EXCEPTION 'refusing: % is not a disposable *_fixture database', current_database();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pds')
       AND to_regclass('pds._chat_ledger_fixture') IS NULL THEN
        RAISE EXCEPTION 'refusing: this pds schema was not made by this fixture';
    END IF;
END $guard$;
"""

SCHEMA = """
DROP SCHEMA IF EXISTS pds CASCADE;
DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;
CREATE SCHEMA pds;
CREATE TABLE pds._chat_ledger_fixture (x int);
CREATE TABLE pds.chat_requests (
    owner_id uuid NOT NULL, request_id uuid NOT NULL, conversation_sha text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), last_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_id uuid, lease_until timestamptz, PRIMARY KEY (owner_id, request_id));
CREATE TABLE pds.chat_operations (
    op_id uuid PRIMARY KEY, owner_id uuid NOT NULL, request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, request_id) REFERENCES pds.chat_requests (owner_id, request_id) ON DELETE CASCADE);
CREATE TABLE pds.chat_operation_tombstones (
    op_id uuid PRIMARY KEY REFERENCES pds.chat_operations (op_id) ON DELETE CASCADE,
    removed_at timestamptz NOT NULL DEFAULT now());
"""

OWNER = "00000000-0000-4000-8000-000000000001"
SHA = "a" * 64


def req(n: int) -> str:
    return f"00000000-0000-4000-8000-0000000001{n:02d}"


def op(n: int, k: int) -> str:
    return f"00000000-0000-4000-8000-0000000{n:02d}0{k:02d}"


def old_request(n: int, ops: int = 1) -> str:
    sql = (f"INSERT INTO pds.chat_requests VALUES ('{OWNER}', '{req(n)}', '{SHA}', now() - interval '200 days', "
           f"now() - interval '200 days', NULL, now() - interval '199 days');\n")
    for k in range(1, ops + 1):
        sql += (f"INSERT INTO pds.chat_operations VALUES ('{op(n, k)}', '{OWNER}', '{req(n)}', "
                f"now() - interval '200 days', now() - interval '200 days');\n")
    return sql


DSN = ""
_CLUSTER: dict[str, str] = {}


def _bin_dir() -> Path | None:
    dirs = []
    if os.environ.get("ONYX_PG_BIN"):
        dirs.append(Path(os.environ["ONYX_PG_BIN"]))
    if shutil.which("initdb"):
        dirs.append(Path(shutil.which("initdb")).resolve().parent)
    dirs += sorted((Path(x) for x in glob.glob("/usr/lib/postgresql/*/bin")), key=lambda p: p.parent.name, reverse=True)
    for d in dirs:
        if all((d / n).is_file() for n in ("initdb", "pg_ctl", "psql", "createdb")):
            return d
    return None


def _env() -> dict[str, str]:
    """A clean environment: no PG* variable from the caller can point a client anywhere else."""
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR") if k in os.environ}
    env.update(LC_ALL="C", LANG="C", PGCONNECT_TIMEOUT="10", PGTZ="UTC", PGCLIENTENCODING="UTF8")
    return env


def setUpModule() -> None:  # noqa: N802 (unittest hook)
    global DSN
    if os.environ.get("ONYX_PG_FIXTURE_DSN"):
        DSN = os.environ["ONYX_PG_FIXTURE_DSN"]
        return
    required = os.environ.get("GITHUB_ACTIONS") == "true" and sys.platform.startswith("linux")
    bindir = _bin_dir()
    problem = None
    if bindir is None:
        problem = "no PostgreSQL binaries found (ONYX_PG_BIN = the folder with initdb, pg_ctl and psql)"
    elif hasattr(os, "geteuid") and os.geteuid() == 0:
        problem = "initdb cannot run as root"
    if problem:
        if required:
            raise RuntimeError(f"{problem}. GitHub's Linux runners have PostgreSQL preinstalled; this test must run there.")
        raise unittest.SkipTest(problem)
    folder = tempfile.mkdtemp(prefix="onyxpg", dir="/tmp" if os.path.isdir("/tmp") else None)
    data, log = os.path.join(folder, "data"), os.path.join(folder, "server.log")
    port = "55433"
    _CLUSTER.update(bin=str(bindir), dir=folder, data=data)

    def sh(*cmd: str) -> None:
        p = subprocess.run(list(cmd), env=_env(), capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
        if p.returncode != 0:
            raise RuntimeError(f"{cmd[0]} failed: {p.stdout}{p.stderr}")

    sh(str(bindir / "initdb"), "-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C")
    opts = (f"-c port={port} -c listen_addresses='' -c unix_socket_directories='{folder}' -c fsync=off "
            "-c max_connections=20 -c shared_buffers=16MB")
    sh(str(bindir / "pg_ctl"), "-D", data, "-l", log, "-o", opts, "-w", "-t", "60", "start")
    _CLUSTER["started"] = "1"
    sh(str(bindir / "createdb"), "-h", folder, "-p", port, "-U", "postgres", "onyx_chat_fixture")
    DSN = f"postgresql://postgres@/onyx_chat_fixture?host={folder}&port={port}"


def tearDownModule() -> None:  # noqa: N802 (unittest hook)
    if _CLUSTER.get("started"):
        subprocess.run([os.path.join(_CLUSTER["bin"], "pg_ctl"), "-D", _CLUSTER["data"], "-m", "immediate", "-w",
                        "stop"], env=_env(), capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
    if _CLUSTER.get("dir"):
        shutil.rmtree(_CLUSTER["dir"], ignore_errors=True)


def _psql_args() -> list[str]:
    psql = os.path.join(_CLUSTER["bin"], "psql") if _CLUSTER.get("bin") else (shutil.which("psql") or "psql")
    return [psql, "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "-v", "ON_ERROR_STOP=1", DSN]


def run(sql: str) -> str:
    p = subprocess.run(_psql_args(), input=GUARD + sql, capture_output=True, text=True, timeout=60, env=_env())
    if p.returncode != 0:
        raise AssertionError(f"psql failed: {p.stderr}")
    return p.stdout.strip()


def setup(*requests: str) -> None:
    run(SCHEMA)
    run(PURGE.read_text())
    run("".join(requests))


def purge(dry: bool = False) -> dict[str, tuple[int, int]]:
    out = run(f"SELECT table_name, would_delete, deleted FROM pds.chat_ledger_purge(180, {'true' if dry else 'false'});")
    rows = {}
    for line in out.splitlines():
        name, would, did = line.split("|")
        rows[name] = (int(would), int(did))
    return rows


def count(sql: str) -> int:
    return int(run(f"SELECT count(*) FROM {sql};"))


def markers(n: int) -> int:
    return count(f"pds.chat_retired_requests WHERE request_id = '{req(n)}'")


def requests_left(n: int) -> int:
    return count(f"pds.chat_requests WHERE request_id = '{req(n)}'")


class Session:
    """A second connection whose transaction stays open until commit()."""

    def __init__(self, sql: str):
        self.p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=_env())
        self.p.stdin.write(GUARD + "BEGIN;\n" + sql + "\n\\echo ready\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline().strip()
        if line != "ready":
            raise AssertionError(f"second session did not start: {line!r} {self.p.stderr.read()}")

    def commit(self) -> None:
        out, err = self.p.communicate("COMMIT;\n", timeout=30)
        if self.p.returncode != 0:
            raise AssertionError(f"second session failed: {err}")


def purge_in_background() -> subprocess.Popen:
    sql = GUARD + "SELECT table_name, would_delete, deleted FROM pds.chat_ledger_purge(180, false);\n"
    p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, env=_env())
    p.stdin.write(sql)
    p.stdin.close()
    return p


def wait_blocked_or_done(p: subprocess.Popen, seconds: float = 10.0) -> bool:
    """True once the purge waits on a lock, False once it finished without waiting."""
    end = time.time() + seconds
    while time.time() < end:
        if p.poll() is not None:
            return False
        if count("pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%chat_ledger_purge%'") > 0:
            return True
        time.sleep(0.1)
    raise AssertionError("purge neither finished nor waited on a lock")


def finish(p: subprocess.Popen) -> dict[str, tuple[int, int]]:
    out, err = p.communicate(timeout=30)
    if p.returncode != 0:
        raise AssertionError(f"purge failed: {err}")
    rows = {}
    for line in out.strip().splitlines():
        name, would, did = line.split("|")
        rows[name] = (int(would), int(did))
    return rows


class ChatLedgerPurge(unittest.TestCase):
    def test_old_idle_request_is_deleted_with_one_marker_and_exact_counts(self):
        setup(old_request(1, ops=2))
        rows = purge()
        self.assertEqual(rows["chat_requests"], (1, 1))
        self.assertEqual(rows["chat_operations"], (2, 2))
        self.assertEqual(rows["chat_retired_requests"], (1, 1))
        self.assertEqual(requests_left(1), 0)
        self.assertEqual(count("pds.chat_operations"), 0)
        self.assertEqual(markers(1), 1)

    def test_dry_run_changes_nothing(self):
        setup(old_request(1, ops=2))
        rows = purge(dry=True)
        self.assertEqual(rows["chat_requests"], (1, 0))
        self.assertEqual(requests_left(1), 1)
        self.assertEqual(count("pds.chat_retired_requests"), 0)

    def test_recent_operation_or_tombstone_keeps_the_request_without_a_marker(self):
        setup(old_request(1), old_request(2), old_request(3),
              f"UPDATE pds.chat_operations SET updated_at = now() WHERE request_id = '{req(1)}';\n"
              f"INSERT INTO pds.chat_operation_tombstones (op_id) VALUES ('{op(2, 1)}');\n")
        rows = purge()
        self.assertEqual(rows["chat_requests"], (1, 1))
        self.assertEqual((requests_left(1), markers(1)), (1, 0))
        self.assertEqual((requests_left(2), markers(2)), (1, 0))
        self.assertEqual((requests_left(3), markers(3)), (0, 1))

    def test_lease_renewed_by_a_concurrent_claim_leaves_no_marker(self):
        setup(old_request(1, ops=2), old_request(2))
        claim = Session(f"UPDATE pds.chat_requests SET lease_until = now() + interval '5 minutes', "
                        f"last_attempt_at = now() WHERE request_id = '{req(1)}';")
        p = purge_in_background()
        try:
            wait_blocked_or_done(p)
        finally:
            claim.commit()
        rows = finish(p)
        self.assertEqual((requests_left(1), markers(1)), (1, 0))  # kept, and never retired
        self.assertEqual((requests_left(2), markers(2)), (0, 1))  # the other one still goes
        self.assertEqual(rows["chat_requests"][1], 1)
        self.assertEqual(rows["chat_operations"][1], 1)
        self.assertEqual(rows["chat_retired_requests"][1], 1)
        purge()  # a later run sees the live lease
        self.assertEqual((requests_left(1), markers(1)), (1, 0))

    def test_retry_finishing_while_the_purge_waits_keeps_the_request(self):
        setup(old_request(1, ops=2), old_request(2))
        retry = Session(f"UPDATE pds.chat_operations SET updated_at = now() WHERE op_id = '{op(1, 2)}';")
        p = purge_in_background()
        try:
            self.assertTrue(wait_blocked_or_done(p))  # it must wait for the retry, not decide on the old rows
        finally:
            retry.commit()
        rows = finish(p)
        self.assertEqual((requests_left(1), markers(1)), (1, 0))
        self.assertEqual(count(f"pds.chat_operations WHERE request_id = '{req(1)}'"), 2)
        self.assertEqual((requests_left(2), markers(2)), (0, 1))
        self.assertEqual(rows["chat_requests"][1], 1)
        self.assertEqual(rows["chat_operations"][1], 1)


if __name__ == "__main__":
    unittest.main()
