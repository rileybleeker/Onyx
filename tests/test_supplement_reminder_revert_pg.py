"""PostgreSQL concurrency fixture for the supplement reminder revert (Codex #834 SUP833-1).

Tap A's intake insert is refused, so A calls pds.revert_supplement_reminder (sql/supplement_reminder_safe_revert.sql):
it locks the reminder row, finds no intake yet, and sets the row back to its old status. Tap B's insert commits in
that window, then B re-asserts 'logged' with the success update from frontend/src/lib/supplement-reminders.ts.
PostgreSQL only locks rows an UPDATE's WHERE matches. With the old success filter (prompted, skipped) B sees the
committed 'logged', matches nothing, does not wait, and A then commits 'prompted' over B's saved intake. With
SUCCESS_RECONCILE_FROM (which includes 'logged', read from the TypeScript source so the two cannot drift) B waits
on A's lock, re-checks the row after A commits, and the reminder ends 'logged'. This file checks:

  - a refused tap alone reverts; a revert that finds intake changes nothing;
  - the race with the current success filter ends 'logged', for both earlier states (prompted and skipped), and
    B really waited on A's lock;
  - the race with the old filter (prompted, skipped) loses: the reminder ends non-logged over saved intake (so
    this test exercises the real window);
  - lost-response recovery: B's success reply is lost and B repeats the success update; the row stays 'logged'.

Safety: every statement batch first refuses to run unless the database name ends in "_fixture" and its pds schema
is absent or carries this file's marker table, so it cannot touch a real Onyx database. Synthetic ids only.

The throwaway cluster, skip and CI rules are the same as tests/test_chat_ledger_retention_pg.py: initdb into a
temporary folder on a Unix socket; skipped without PostgreSQL binaries or as root, except on a GitHub Actions Linux
runner, where that is a failure. ONYX_PG_FIXTURE_DSN (a disposable *_fixture database) replaces the cluster.

Run: python tests/test_supplement_reminder_revert_pg.py
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REVERT = ROOT / "sql" / "supplement_reminder_safe_revert.sql"
LIB = ROOT / "frontend" / "src" / "lib" / "supplement-reminders.ts"

GUARD = """DO $guard$
BEGIN
    IF current_database() !~ '_fixture$' THEN
        RAISE EXCEPTION 'refusing: % is not a disposable *_fixture database', current_database();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pds')
       AND to_regclass('pds._supp_reminder_fixture') IS NULL THEN
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
CREATE TABLE pds._supp_reminder_fixture (x int);
CREATE TABLE pds.supplement_stack_reminder (
    stack_id bigint NOT NULL, behavioral_date date NOT NULL, status text NOT NULL,
    prompted_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz,
    PRIMARY KEY (stack_id, behavioral_date));
CREATE TABLE pds.supplement_intake (
    intake_id bigserial PRIMARY KEY, stack_id bigint, intake_date date NOT NULL,
    client_event_key text, client_event_line int);
"""

STACK, DAY = 4, "2026-11-11"


def success_from() -> list[str]:
    """SUCCESS_RECONCILE_FROM as written in the TypeScript source."""
    m = re.search(r"SUCCESS_RECONCILE_FROM\s*:\s*ReminderStatus\[\]\s*=\s*\[([^\]]*)\]", LIB.read_text())
    if not m:
        raise AssertionError("SUCCESS_RECONCILE_FROM not found in supplement-reminders.ts")
    return re.findall(r'"([a-z]+)"', m.group(1))


def success_update(statuses: list[str]) -> str:
    """The PostgREST call transition('logged', statuses, now) as SQL."""
    listed = ", ".join(f"'{s}'" for s in statuses)
    return (f"UPDATE pds.supplement_stack_reminder SET status = 'logged', responded_at = now() "
            f"WHERE stack_id = {STACK} AND behavioral_date = '{DAY}' AND status IN ({listed}) RETURNING stack_id;")


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
    port = "55434"
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
    sh(str(bindir / "createdb"), "-h", folder, "-p", port, "-U", "postgres", "onyx_supp_fixture")
    DSN = f"postgresql://postgres@/onyx_supp_fixture?host={folder}&port={port}"


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


def setup(previous: str = "prompted") -> None:
    run(SCHEMA)
    run(REVERT.read_text())
    # Tap A won the claim: the row moved from `previous` to 'logged'; nothing is saved yet.
    run(f"INSERT INTO pds.supplement_stack_reminder (stack_id, behavioral_date, status) VALUES ({STACK}, '{DAY}', 'logged');")


def status() -> str:
    return run(f"SELECT status FROM pds.supplement_stack_reminder WHERE stack_id = {STACK} AND behavioral_date = '{DAY}';")


def intake() -> int:
    return int(run(f"SELECT count(*) FROM pds.supplement_intake WHERE stack_id = {STACK} AND intake_date = '{DAY}';"))


def revert_sql(previous: str) -> str:
    return f"SELECT pds.revert_supplement_reminder({STACK}, '{DAY}', '{previous}', NULL);"


class Session:
    """Tap A: a connection whose transaction stays open (holding the reminder row lock) until commit()."""

    def __init__(self, sql: str):
        self.p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=_env())
        self.p.stdin.write(GUARD + "BEGIN;\n" + sql + "\n\\echo ready\n")
        self.p.stdin.flush()
        first = self.p.stdout.readline().strip()
        line = first if first == "ready" else self.p.stdout.readline().strip()
        if line != "ready":
            raise AssertionError(f"tap A did not start: {first!r} {line!r} {self.p.stderr.read()}")
        self.result = first if first != "ready" else ""

    def commit(self) -> None:
        out, err = self.p.communicate("COMMIT;\n", timeout=30)
        if self.p.returncode != 0:
            raise AssertionError(f"tap A failed: {err}")


def in_background(sql: str) -> subprocess.Popen:
    p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, env=_env())
    p.stdin.write(GUARD + sql + "\n")
    p.stdin.close()
    p.stdin = None
    return p


def waited_on_lock(p: subprocess.Popen, seconds: float = 10.0) -> bool:
    """True once the statement waits on a lock, False once it finished without waiting."""
    end = time.time() + seconds
    while time.time() < end:
        if p.poll() is not None:
            return False
        n = run("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                "AND query LIKE '%UPDATE pds.supplement_stack_reminder%';")
        if int(n) > 0:
            return True
        time.sleep(0.1)
    raise AssertionError("the success update neither finished nor waited on a lock")


def finish(p: subprocess.Popen) -> str:
    out, err = p.communicate(timeout=30)
    if p.returncode != 0:
        raise AssertionError(f"tap B failed: {err}")
    return out.strip()


def race(previous: str, statuses: list[str]) -> tuple[bool, str]:
    """A locks and reverts (uncommitted); B commits its intake, then runs the success update; A commits."""
    setup(previous)
    a = Session(revert_sql(previous))
    try:
        if a.result != "t":
            raise AssertionError(f"tap A's revert should revert (no intake yet), got {a.result!r}")
        run(f"INSERT INTO pds.supplement_intake (stack_id, intake_date, client_event_key, client_event_line) "
            f"VALUES ({STACK}, '{DAY}', 'k', 0), ({STACK}, '{DAY}', 'k', 1);")  # B's keyed write commits
        b = in_background(success_update(statuses))
        waited = waited_on_lock(b)
    finally:
        a.commit()
    finish(b)
    return waited, status()


class SupplementReminderRevertRace(unittest.TestCase):
    def test_success_filter_in_the_source_includes_logged(self):
        self.assertEqual(success_from(), ["prompted", "skipped", "logged"])

    def test_a_refused_tap_alone_reverts(self):
        setup("prompted")
        self.assertEqual(run(revert_sql("prompted")), "t")
        self.assertEqual(status(), "prompted")

    def test_a_revert_that_finds_intake_changes_nothing(self):
        setup("prompted")
        run(f"INSERT INTO pds.supplement_intake (stack_id, intake_date) VALUES ({STACK}, '{DAY}');")
        self.assertEqual(run(revert_sql("prompted")), "f")
        self.assertEqual(status(), "logged")

    def test_success_waits_for_an_in_flight_revert_and_ends_logged(self):
        for previous in ("prompted", "skipped"):
            with self.subTest(previous=previous):
                waited, final = race(previous, success_from())
                self.assertTrue(waited, "the success update must wait on the revert's row lock")
                self.assertEqual(final, "logged")
                self.assertEqual(intake(), 2)

    def test_the_old_success_filter_loses_the_race(self):
        # The bug Codex #834 SUP833-1 describes: no lock wait, and the revert commits over saved intake.
        for previous in ("prompted", "skipped"):
            with self.subTest(previous=previous):
                waited, final = race(previous, ["prompted", "skipped"])
                self.assertFalse(waited)
                self.assertEqual(final, previous)
                self.assertEqual(intake(), 2)

    def test_lost_response_retry_keeps_the_row_logged(self):
        race("prompted", success_from())
        # B's reply was lost; the retry finds its rows (already_logged) or repeats the success update: still logged.
        self.assertEqual(run(success_update(success_from())), str(STACK))
        self.assertEqual(run(revert_sql("prompted")), "f")  # a late revert from A's retry changes nothing
        self.assertEqual(status(), "logged")


if __name__ == "__main__":
    unittest.main()
