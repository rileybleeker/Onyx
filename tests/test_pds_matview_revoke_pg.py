"""Isolated PostgreSQL fixtures for the pds matview revoke (SEC-01-B phase 2).

tests/test_pds_matview_revoke.py pins the text of sql/pds_matview_revoke_authenticated.sql; this file
runs the real migration against a throwaway database built only from synthetic objects (six one-row
matviews named like the real ones, each holding the number 1, plus the objects of each case) and checks
what it does:

  - clean database: the revoke succeeds, no browser role can read a matview, service_role still can,
    and a second run (no direct grant left) succeeds and changes nothing;
  - a private definer view over a matview with a browser-readable view over THAT one (two hops): aborts;
  - the same chain created AFTER a successful revoke, then a re-run: aborts (the graph is checked even
    when no direct grant is left);
  - a column-only grant on a view over a matview: aborts;
  - a SECURITY DEFINER function reading a matview that authenticated may call: aborts;
  - a browser-readable view over a private definer function that reads a matview: aborts;
  - a browser-callable definer function calling a private function that reads a matview: aborts;
  - a row-security policy that queries a matview: aborts;
  - a trigger function that reads a matview: aborts;
  - a void SECURITY DEFINER refresh function no browser role may call: passes; the same function left
    callable by PUBLIC: aborts (fail closed, nothing changed).
Every aborted run must leave the grants exactly as they were (the migration is one atomic statement).

Safety: each case is ONE transaction that ends in ROLLBACK, and its first statement refuses to run
unless the database name ends in "_fixture" and has no pds schema, so it cannot touch a real Onyx
database. Nothing is printed but synthetic fixture output.

Needs psql on PATH and ONYX_PG_FIXTURE_DSN naming a disposable database, for example:

    docker run --rm -d -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust \\
        -e POSTGRES_DB=onyx_matview_fixture postgres:17
    ONYX_PG_FIXTURE_DSN=postgresql://postgres@localhost:55432/onyx_matview_fixture \\
        python tests/test_pds_matview_revoke_pg.py

Without both it prints SKIP and passes (the offline runner has no database).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORWARD = ROOT / "sql" / "pds_matview_revoke_authenticated.sql"

SIX = (
    "daily_health_matrix_behavioral_mat",
    "hrv_prediction_gaps_mat",
    "hrv_residuals_mat",
    "recovery_vs_pace_mat",
    "spotify_daily_signature_mat",
    "tz_log_gaps_mat",
)

RELATION_ABORT = "A browser-readable relation reads a matview"
POLICY_ABORT = "A row-security policy reads a matview"
FUNCTION_ABORT = "A function browser roles can reach reads a matview"

GUARD = """DO $guard$
BEGIN
    IF current_database() !~ '_fixture$' THEN
        RAISE EXCEPTION 'refusing: % is not a disposable *_fixture database', current_database();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pds') THEN
        RAISE EXCEPTION 'refusing: schema pds already exists in this database';
    END IF;
END
$guard$;"""

ROLES = """DO $roles$
DECLARE r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END
$roles$;"""

MIGRATE = "\\i '" + FORWARD.as_posix() + "'"

# The migration is expected to raise: keep going so the script can check that nothing changed.
MIGRATE_EXPECTING_ABORT = "\n".join([
    "\\set ON_ERROR_STOP off",
    "\\set ON_ERROR_ROLLBACK on",
    MIGRATE,
    "\\set ON_ERROR_ROLLBACK off",
    "\\set ON_ERROR_STOP on",
])


def _setup() -> str:
    lines = ["\\set ON_ERROR_STOP on", "BEGIN;", GUARD, ROLES,
             "CREATE SCHEMA pds;",
             "GRANT USAGE ON SCHEMA pds TO anon, authenticated, service_role;"]
    for name in SIX:
        lines += [
            "CREATE MATERIALIZED VIEW pds." + name + " AS SELECT 1 AS k;",
            "CREATE UNIQUE INDEX " + name + "_k ON pds." + name + " (k);",
            # The state the facade shipped with: service_role and authenticated may read each one.
            "GRANT SELECT ON pds." + name + " TO service_role, authenticated;",
        ]
    return "\n".join(lines)


def _assert_grants(authenticated_reads: bool) -> str:
    want = "true" if authenticated_reads else "false"
    return """DO $assert$
DECLARE bad text;
BEGIN
    IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pds' AND c.relkind = 'm') <> 6 THEN
        RAISE EXCEPTION 'fixture: expected six matviews';
    END IF;
    SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND c.relkind = 'm'
      AND (has_table_privilege('authenticated', c.oid, 'SELECT') <> """ + want + """
           OR has_table_privilege('anon', c.oid, 'SELECT')
           OR NOT has_table_privilege('service_role', c.oid, 'SELECT'));
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'fixture: unexpected grants on %', bad;
    END IF;
END
$assert$;"""


def _dsn() -> str:
    dsn = os.environ.get("ONYX_PG_FIXTURE_DSN", "").strip()
    if not dsn or not shutil.which("psql"):
        raise unittest.SkipTest("no ONYX_PG_FIXTURE_DSN or no psql (needs a disposable *_fixture database)")
    return dsn


def _run(script: str) -> subprocess.CompletedProcess:
    dsn = _dsn()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "case.sql"
        path.write_text(script + "\n", encoding="utf-8")
        return subprocess.run(
            ["psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align",
             "-v", "ON_ERROR_STOP=1", "-d", dsn, "-f", str(path)],
            capture_output=True, text=True, timeout=120,
        )


def _expect_success(*steps: str) -> None:
    res = _run("\n".join([_setup(), *steps, "SELECT 'FIXTURE_OK';", "ROLLBACK;"]))
    assert res.returncode == 0 and "FIXTURE_OK" in res.stdout, res.stderr[-2000:]


def _expect_abort(objects: str, message: str, culprit: str, *, revoke_first: bool = False) -> None:
    """Create `objects`, run the migration, and require it to abort with `message` naming `culprit`
    while the grants stay exactly as they were before that run."""
    steps = [_setup()]
    if revoke_first:
        steps += [MIGRATE, _assert_grants(False)]
    steps += [objects, MIGRATE_EXPECTING_ABORT, _assert_grants(not revoke_first),
              "SELECT 'FIXTURE_ABORTED_UNCHANGED';", "ROLLBACK;"]
    res = _run("\n".join(steps))
    assert res.returncode == 0, res.stderr[-2000:]
    assert "FIXTURE_ABORTED_UNCHANGED" in res.stdout, res.stderr[-2000:]
    assert message in res.stderr, res.stderr[-2000:]
    assert culprit in res.stderr, res.stderr[-2000:]


TWO_HOP_CHAIN = """CREATE VIEW pds.fixture_private AS SELECT k FROM pds.{mat};
CREATE VIEW pds.fixture_outer AS SELECT k FROM pds.fixture_private;
GRANT SELECT ON pds.fixture_outer TO authenticated;"""


# --------------------------------------------------------------------------------------------------


def test_clean_database_revokes_and_a_rerun_changes_nothing() -> None:
    _expect_success(MIGRATE, _assert_grants(False), MIGRATE, _assert_grants(False))


def test_two_hop_definer_chain_aborts() -> None:
    _expect_abort(TWO_HOP_CHAIN.format(mat="hrv_residuals_mat"), RELATION_ABORT, "fixture_outer")


def test_rerun_after_the_revoke_still_checks_the_graph() -> None:
    _expect_abort(TWO_HOP_CHAIN.format(mat="tz_log_gaps_mat"), RELATION_ABORT, "fixture_outer",
                  revoke_first=True)


def test_column_only_grant_on_a_view_over_a_matview_aborts() -> None:
    _expect_abort("""CREATE VIEW pds.fixture_cols AS SELECT k FROM pds.spotify_daily_signature_mat;
GRANT SELECT (k) ON pds.fixture_cols TO authenticated;""", RELATION_ABORT, "fixture_cols")


def test_callable_definer_function_aborts() -> None:
    # Functions are executable by PUBLIC unless revoked.
    _expect_abort("""CREATE FUNCTION pds.fixture_leak() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT k FROM pds.recovery_vs_pace_mat; END $f$;""", FUNCTION_ABORT, "fixture_leak")


def test_readable_view_over_a_private_definer_function_aborts() -> None:
    _expect_abort("""CREATE FUNCTION pds.fixture_private_fn() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT k FROM pds.daily_health_matrix_behavioral_mat; END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_private_fn() FROM PUBLIC;
CREATE VIEW pds.fixture_fn_view AS SELECT t.k FROM pds.fixture_private_fn() AS t(k);
GRANT SELECT ON pds.fixture_fn_view TO authenticated;""", RELATION_ABORT, "fixture_fn_view")


def test_callable_function_calling_a_private_function_aborts() -> None:
    _expect_abort("""CREATE FUNCTION pds.fixture_inner() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT k FROM pds.hrv_prediction_gaps_mat; END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_inner() FROM PUBLIC;
CREATE FUNCTION pds.fixture_caller() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT * FROM pds.fixture_inner(); END $f$;""", FUNCTION_ABORT, "fixture_caller")


def test_policy_over_a_matview_aborts() -> None:
    _expect_abort("""CREATE TABLE pds.fixture_t (k integer);
ALTER TABLE pds.fixture_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_p ON pds.fixture_t FOR SELECT USING (EXISTS (SELECT 1 FROM pds.tz_log_gaps_mat));""",
                  POLICY_ABORT, "fixture_p")


def test_trigger_function_over_a_matview_aborts() -> None:
    _expect_abort("""CREATE TABLE pds.fixture_t2 (k integer);
CREATE FUNCTION pds.fixture_trg() RETURNS trigger LANGUAGE plpgsql
AS $f$ BEGIN PERFORM 1 FROM pds.recovery_vs_pace_mat; RETURN NEW; END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_trg() FROM PUBLIC;
CREATE TRIGGER fixture_trg BEFORE INSERT ON pds.fixture_t2 FOR EACH ROW EXECUTE FUNCTION pds.fixture_trg();""",
                  FUNCTION_ABORT, "fixture_trg")


REFRESH_FN = """CREATE FUNCTION pds.fixture_refresh() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN REFRESH MATERIALIZED VIEW CONCURRENTLY pds.daily_health_matrix_behavioral_mat; END $f$;"""


def test_refresh_function_no_browser_role_may_call_passes() -> None:
    _expect_success(REFRESH_FN,
                    "REVOKE EXECUTE ON FUNCTION pds.fixture_refresh() FROM PUBLIC, anon, authenticated;",
                    MIGRATE, _assert_grants(False))


def test_refresh_function_callable_by_public_aborts_without_changing_anything() -> None:
    _expect_abort(REFRESH_FN, FUNCTION_ABORT, "fixture_refresh")


if __name__ == "__main__":
    try:
        _dsn()
    except unittest.SkipTest as skip:
        print(f"SKIP: {skip}")
        raise SystemExit(0)
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
