"""PostgreSQL fixture for the atomic Rewards settings merge (Codex #838 REW842-2).

PUT /api/rewards/settings calls pds.rewards_settings_merge (sql/rewards_settings_merge.sql) through
saveSettings() in frontend/src/lib/rewards-server.ts. The merge must be ONE statement so two overlapping saves of
different fields of the same row both persist. frontend/tests/rewards-settings-save.test.cjs models that merge in
JavaScript; this file executes the real SQL against a throwaway PostgreSQL:

  - a first save inserts the row; a second save of another field merges (jsonb ||) instead of replacing;
  - same-row overlap: save A holds the row (uncommitted), save B of a different field waits on A's lock and, after
    A commits, both fields are stored (run for an existing row and for a brand-new key, where both saves race the
    INSERT and ON CONFLICT turns the loser into the merge);
  - the read-merge-write pattern the function replaced loses one field in the same interleaving (so this test
    exercises the real window);
  - p_merge = false replaces the value (discover_quarter, apple_boosted), and a non-object stored or patched value
    is replaced, never merged;
  - grants: service_role may execute it; public, anon and authenticated may not;
  - the keys saveSettings() merges (valuations, credits) are still the ones read from the TypeScript source.

Safety: every statement batch first refuses to run unless the database name ends in "_fixture" and its pds schema
is absent or carries this file's marker table, so it cannot touch a real Onyx database. Synthetic values only.

The throwaway cluster, skip and CI rules are the same as tests/test_supplement_reminder_revert_pg.py: initdb into a
temporary folder on a Unix socket; skipped without PostgreSQL binaries or as root, except on a GitHub Actions Linux
runner, where that is a failure. ONYX_PG_FIXTURE_DSN (a disposable *_fixture database) replaces the cluster.

Run: python tests/test_rewards_settings_merge_pg.py
"""
from __future__ import annotations

import glob
import json
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
MERGE = ROOT / "sql" / "rewards_settings_merge.sql"
LIB = ROOT / "frontend" / "src" / "lib" / "rewards-server.ts"

GUARD = """DO $guard$
BEGIN
    IF current_database() !~ '_fixture$' THEN
        RAISE EXCEPTION 'refusing: % is not a disposable *_fixture database', current_database();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pds')
       AND to_regclass('pds._rewards_settings_fixture') IS NULL THEN
        RAISE EXCEPTION 'refusing: this pds schema was not made by this fixture';
    END IF;
END $guard$;
"""

# The pds.rewards_settings definition from sql/rewards_schema.sql (the table only; the other tables are not used).
SCHEMA = """
DROP SCHEMA IF EXISTS pds CASCADE;
DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;
CREATE SCHEMA pds;
GRANT USAGE ON SCHEMA pds TO anon, authenticated, service_role;
CREATE TABLE pds._rewards_settings_fixture (x int);
CREATE TABLE pds.rewards_settings (
    key text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.:-]{1,60}$'),
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE pds.rewards_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.rewards_settings FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.rewards_settings TO service_role;
"""


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
    port = "55437"
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
    sh(str(bindir / "createdb"), "-h", folder, "-p", port, "-U", "postgres", "onyx_rewards_fixture")
    DSN = f"postgresql://postgres@/onyx_rewards_fixture?host={folder}&port={port}"


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


def setup() -> None:
    run(SCHEMA)
    run(MERGE.read_text())


def merge_sql(key: str, patch: object, merge: bool = True) -> str:
    lit = json.dumps(patch).replace("'", "''")
    return f"SELECT pds.rewards_settings_merge('{key}', '{lit}'::jsonb, {'true' if merge else 'false'});"


def stored(key: str) -> object:
    out = run(f"SELECT value FROM pds.rewards_settings WHERE key = '{key}';")
    return json.loads(out) if out else None


class Session:
    """Save A: a connection whose transaction stays open (holding the settings row) until commit()."""

    def __init__(self, sql: str):
        self.p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=_env())
        self.p.stdin.write(GUARD + "BEGIN;\n" + sql + "\n\\echo ready\n")
        self.p.stdin.flush()
        lines = []
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise AssertionError(f"save A did not start: {lines!r} {self.p.stderr.read()}")
            if line.strip() == "ready":
                break
            lines.append(line.strip())
        self.result = "\n".join(x for x in lines if x)

    def commit(self) -> None:
        _out, err = self.p.communicate("COMMIT;\n", timeout=30)
        if self.p.returncode != 0:
            raise AssertionError(f"save A failed: {err}")


def in_background(sql: str) -> subprocess.Popen:
    p = subprocess.Popen(_psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, env=_env())
    p.stdin.write(GUARD + sql + "\n")
    p.stdin.close()
    p.stdin = None
    return p


def waited_on_lock(p: subprocess.Popen, needle: str, seconds: float = 10.0) -> bool:
    """True once the background statement waits on a lock, False once it finished without waiting."""
    end = time.time() + seconds
    while time.time() < end:
        if p.poll() is not None:
            return False
        n = run("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                f"AND query LIKE '%{needle}%' AND pid <> pg_backend_pid();")
        if int(n) > 0:
            return True
        time.sleep(0.1)
    raise AssertionError("save B neither finished nor waited on a lock")


def finish(p: subprocess.Popen) -> str:
    out, err = p.communicate(timeout=30)
    if p.returncode != 0:
        raise AssertionError(f"save B failed: {err}")
    return out.strip()


def overlap(key: str, a: dict, b: dict) -> bool:
    """A merges (uncommitted), B merges a different field of the same row, then A commits."""
    s = Session(merge_sql(key, a))
    try:
        bg = in_background(merge_sql(key, b))
        waited = waited_on_lock(bg, "rewards_settings_merge")
    finally:
        s.commit()
    finish(bg)
    return waited


# The application-level read-merge-upsert that pds.rewards_settings_merge replaced (#842), as two statements.
def old_read(key: str) -> str:
    return f"SELECT coalesce((SELECT value FROM pds.rewards_settings WHERE key = '{key}'), '{{}}'::jsonb);"


def old_write(key: str, value: object) -> str:
    lit = json.dumps(value).replace("'", "''")
    return (f"INSERT INTO pds.rewards_settings (key, value) VALUES ('{key}', '{lit}'::jsonb) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();")


class RewardsSettingsMerge(unittest.TestCase):
    def setUp(self) -> None:
        setup()

    def test_merged_keys_in_the_source(self):
        m = re.search(r'const merge = ([^;]+);', LIB.read_text())
        self.assertIsNotNone(m, "saveSettings() merge rule not found in rewards-server.ts")
        self.assertEqual(sorted(re.findall(r'patch\.key === "([a-z_]+)"', m.group(1))), ["credits", "valuations"])
        self.assertIn('db.rpc("rewards_settings_merge", { p_key: patch.key, p_patch: patch.value, p_merge: merge })',
                      LIB.read_text())

    def test_first_save_inserts_and_second_field_merges(self):
        self.assertEqual(json.loads(run(merge_sql("valuations", {"amex_mr": 2.0}))), {"amex_mr": 2.0})
        out = json.loads(run(merge_sql("valuations", {"delta_skymiles": 1.1})))
        self.assertEqual(out, {"amex_mr": 2.0, "delta_skymiles": 1.1})
        self.assertEqual(stored("valuations"), out)
        # The same field again: the newer value wins, the other field stays.
        run(merge_sql("valuations", {"amex_mr": 1.8}))
        self.assertEqual(stored("valuations"), {"amex_mr": 1.8, "delta_skymiles": 1.1})

    def test_overlapping_saves_of_one_existing_row_both_persist(self):
        run(merge_sql("valuations", {"hilton_honors": 0.4}))
        waited = overlap("valuations", {"amex_mr": 2.0}, {"delta_skymiles": 1.1})
        self.assertTrue(waited, "save B must wait on save A's row lock")
        self.assertEqual(stored("valuations"), {"hilton_honors": 0.4, "amex_mr": 2.0, "delta_skymiles": 1.1})

    def test_overlapping_first_saves_of_a_new_key_both_persist(self):
        # Both saves race the INSERT; the loser waits on the winner's uncommitted key, then ON CONFLICT merges.
        waited = overlap("credits", {"resy": {"hidden": True}}, {"uber": {"hidden": False}})
        self.assertTrue(waited, "save B must wait on save A's uncommitted insert")
        self.assertEqual(stored("credits"), {"resy": {"hidden": True}, "uber": {"hidden": False}})

    def test_the_old_read_merge_write_loses_a_field(self):
        # The pattern #842 replaced: both saves read before either writes, so the later write drops A's field.
        run(old_write("valuations", {"hilton_honors": 0.4}))
        a_read = json.loads(run(old_read("valuations")))
        b_read = json.loads(run(old_read("valuations")))
        run(old_write("valuations", {**a_read, "amex_mr": 2.0}))
        run(old_write("valuations", {**b_read, "delta_skymiles": 1.1}))
        self.assertNotIn("amex_mr", stored("valuations"))

    def test_merge_false_replaces(self):
        run(merge_sql("discover_quarter", {"categories": ["gas", "transit"], "quarter": "2026Q4"}, merge=False))
        run(merge_sql("discover_quarter", {"categories": ["groceries"]}, merge=False))
        self.assertEqual(stored("discover_quarter"), {"categories": ["groceries"]})

    def test_non_object_values_are_replaced_not_merged(self):
        run(merge_sql("apple_boosted", ["apple", "uber"], merge=False))
        run(merge_sql("apple_boosted", {"x": 1}))  # stored array, object patch: replaced
        self.assertEqual(stored("apple_boosted"), {"x": 1})
        run(merge_sql("apple_boosted", ["nike"]))  # stored object, array patch: replaced
        self.assertEqual(stored("apple_boosted"), ["nike"])

    def test_only_service_role_may_execute(self):
        sig = "pds.rewards_settings_merge(text, jsonb, boolean)"
        rows = run("SELECT r, has_function_privilege(r, '" + sig + "', 'EXECUTE') FROM "
                   "unnest(array['service_role','anon','authenticated']) r ORDER BY r;")
        self.assertEqual(rows.splitlines(), ["anon|f", "authenticated|f", "service_role|t"])
        public = run("SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
                     "WHERE p.oid = '" + sig + "'::regprocedure AND a.grantee = 0;")
        self.assertEqual(public, "0", "PUBLIC must not keep EXECUTE")

    def test_rerunning_the_sql_file_is_idempotent(self):
        run(merge_sql("valuations", {"amex_mr": 2.0}))
        run(MERGE.read_text())
        self.assertEqual(stored("valuations"), {"amex_mr": 2.0})
        self.assertEqual(run("SELECT count(*) FROM pg_proc WHERE proname = 'rewards_settings_merge';"), "1")


if __name__ == "__main__":
    unittest.main()
