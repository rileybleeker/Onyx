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
    callable by PUBLIC: aborts (fail closed, nothing changed);
  - an unusable unique index: a matview whose only unique index is an expression index, or whose
    unique index is invalid (indisvalid = false, superuser fixture only): aborts with the readiness
    message and changes nothing.
  - SQL the graph cannot read (SEC01B-R3): a callable definer function that builds the matview name at
    run time ('pds.' || 'hrv_' || 'residuals_mat'): aborts, also when it is added after a successful
    revoke and the migration is re-run; a callable definer calling an invoker function with dynamic
    SQL: aborts; a SQL-standard body calling query_to_xml on an assembled name: aborts; a definer
    trigger function with dynamic SQL that nobody may call directly: aborts; a definer with dynamic
    SQL that no browser role may call and nothing uses (like the perf refresh function): passes, and a
    re-run passes; a callable definer naming a matview with a Unicode escape (U&"..."): aborts.
  - Review round 2: a callable definer reading PDS.HRV_RESIDUALS_MAT in upper case (PostgreSQL folds
    it to the lower-case name): aborts, on the first run and on a re-run after the revoke; a callable
    definer calling a private function by its upper-case name: aborts; a callable definer with dynamic
    SQL whose owner holds SELECT on only one column of a matview: aborts, first run and re-run.
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
DYNAMIC_ABORT = "A SECURITY DEFINER function browser roles can reach runs SQL the graph cannot read"

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


# SEC01B-R3: SQL assembled at run time names no object, so the graph cannot see it; step 3d fails closed.
ASSEMBLED = """CREATE FUNCTION pds.fixture_assembled() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY EXECUTE 'SELECT k FROM ' || 'pds.' || 'hrv_' || 'residuals_mat'; END $f$;"""


def test_definer_function_with_an_assembled_matview_name_aborts() -> None:
    _expect_abort(ASSEMBLED, DYNAMIC_ABORT, "fixture_assembled")


def test_assembled_name_function_added_after_the_revoke_aborts_the_rerun() -> None:
    _expect_abort(ASSEMBLED, DYNAMIC_ABORT, "fixture_assembled", revoke_first=True)


def test_callable_definer_calling_an_invoker_function_with_dynamic_sql_aborts() -> None:
    # The invoker function runs as the definer's owner when the definer calls it.
    _expect_abort("""CREATE FUNCTION pds.fixture_dyn_inner() RETURNS SETOF integer LANGUAGE plpgsql
AS $f$ BEGIN RETURN QUERY EXECUTE format('SELECT k FROM pds.%I', 'recovery_' || 'vs_pace_mat'); END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_dyn_inner() FROM PUBLIC;
CREATE FUNCTION pds.fixture_dyn_outer() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT * FROM pds.fixture_dyn_inner(); END $f$;""", DYNAMIC_ABORT, "fixture_dyn_outer")


def test_sql_standard_body_with_a_query_string_builtin_aborts() -> None:
    _expect_abort("""CREATE FUNCTION pds.fixture_xml() RETURNS xml LANGUAGE sql SECURITY DEFINER
BEGIN ATOMIC
    SELECT query_to_xml('SELECT k FROM pds.' || 'tz_log_' || 'gaps_mat', true, false, '');
END;""", DYNAMIC_ABORT, "fixture_xml")


def test_trigger_definer_with_dynamic_sql_aborts_even_when_not_callable() -> None:
    _expect_abort("""CREATE TABLE pds.fixture_t3 (k integer);
CREATE FUNCTION pds.fixture_dyn_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN EXECUTE 'SELECT 1 FROM pds.' || 'spotify_daily_' || 'signature_mat'; RETURN NEW; END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_dyn_trg() FROM PUBLIC;
CREATE TRIGGER fixture_dyn_trg BEFORE INSERT ON pds.fixture_t3 FOR EACH ROW EXECUTE FUNCTION pds.fixture_dyn_trg();""",
                  DYNAMIC_ABORT, "fixture_dyn_trg")


def test_unreachable_definer_with_dynamic_sql_passes_and_reruns() -> None:
    # Like the perf refresh function: dynamic SQL, but no browser role may call it and nothing uses it.
    _expect_success("""CREATE FUNCTION pds.fixture_dyn_refresh() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY pds.%I', 'hrv_' || 'residuals_mat'); END $f$;""",
                    "REVOKE EXECUTE ON FUNCTION pds.fixture_dyn_refresh() FROM PUBLIC, anon, authenticated;",
                    MIGRATE, _assert_grants(False), MIGRATE, _assert_grants(False))


def test_definer_naming_a_matview_with_a_unicode_escape_aborts() -> None:
    # U&"..." spells hrv_residuals_mat with \005f for the underscores: no source text names it.
    _expect_abort("""CREATE FUNCTION pds.fixture_uescape() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT k FROM pds.U&"hrv\005fresiduals\005fmat"; END $f$;""",
                  DYNAMIC_ABORT, "fixture_uescape")


# Review round 2 (Codex): PostgreSQL folds unquoted names, so the source text may spell them in any case.
UPPER_CASE = """CREATE FUNCTION pds.fixture_upper() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT K FROM PDS.HRV_RESIDUALS_MAT; END $f$;"""


def test_upper_case_matview_name_in_a_callable_definer_aborts() -> None:
    _expect_abort(UPPER_CASE, FUNCTION_ABORT, "fixture_upper")


def test_upper_case_matview_name_added_after_the_revoke_aborts_the_rerun() -> None:
    _expect_abort(UPPER_CASE, FUNCTION_ABORT, "fixture_upper", revoke_first=True)


def test_callable_definer_calling_a_private_function_in_upper_case_aborts() -> None:
    _expect_abort("""CREATE FUNCTION pds.fixture_inner_uc() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT k FROM pds.hrv_prediction_gaps_mat; END $f$;
REVOKE EXECUTE ON FUNCTION pds.fixture_inner_uc() FROM PUBLIC;
CREATE FUNCTION pds.fixture_caller_uc() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY SELECT * FROM PDS.FIXTURE_INNER_UC(); END $f$;""", FUNCTION_ABORT, "fixture_caller_uc")


# Review round 2 (Codex): an owner holding SELECT on a single column can still read that column.
COLUMN_ONLY_OWNER = """DO $colowner$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fixture_colowner') THEN
        CREATE ROLE fixture_colowner NOLOGIN;
    END IF;
END
$colowner$;
GRANT USAGE ON SCHEMA pds TO fixture_colowner;
GRANT SELECT (k) ON pds.hrv_residuals_mat TO fixture_colowner;
CREATE FUNCTION pds.fixture_colowner_fn() RETURNS SETOF integer LANGUAGE plpgsql SECURITY DEFINER
AS $f$ BEGIN RETURN QUERY EXECUTE 'SELECT k FROM ' || 'pds.' || 'hrv_' || 'residuals_mat'; END $f$;
ALTER FUNCTION pds.fixture_colowner_fn() OWNER TO fixture_colowner;"""


def test_column_only_owner_definer_with_dynamic_sql_aborts() -> None:
    _expect_abort(COLUMN_ONLY_OWNER, DYNAMIC_ABORT, "fixture_colowner_fn")


def test_column_only_owner_definer_added_after_the_revoke_aborts_the_rerun() -> None:
    _expect_abort(COLUMN_ONLY_OWNER, DYNAMIC_ABORT, "fixture_colowner_fn", revoke_first=True)


# Review round 4 (Codex): a callable definer that selects a VIEW whose definition builds the matview name at
# run time. The function's source names no matview and no function with dynamic SQL; the view carries it.
ASSEMBLED_VIEW = """CREATE VIEW pds.fixture_xml_view AS
SELECT query_to_xml('SELECT k FROM pds.' || 'hrv_' || 'residuals_mat', true, false, '') AS x;
REVOKE ALL ON pds.fixture_xml_view FROM PUBLIC, anon, authenticated;
CREATE FUNCTION pds.fixture_via_view() RETURNS SETOF xml LANGUAGE sql SECURITY DEFINER
AS $f$ SELECT x FROM pds.fixture_xml_view $f$;"""


def test_definer_selecting_a_view_with_an_assembled_name_aborts() -> None:
    _expect_abort(ASSEMBLED_VIEW, DYNAMIC_ABORT, "fixture_via_view")


def test_assembled_name_view_behind_a_definer_added_after_the_revoke_aborts_the_rerun() -> None:
    _expect_abort(ASSEMBLED_VIEW, DYNAMIC_ABORT, "fixture_via_view", revoke_first=True)


def test_definer_over_a_view_of_a_view_with_an_assembled_name_aborts() -> None:
    _expect_abort("""CREATE VIEW pds.fixture_xml_inner AS
SELECT query_to_xml('SELECT k FROM pds.' || 'tz_log_' || 'gaps_mat', true, false, '') AS x;
CREATE VIEW pds.fixture_xml_outer AS SELECT x FROM pds.fixture_xml_inner;
REVOKE ALL ON pds.fixture_xml_inner, pds.fixture_xml_outer FROM PUBLIC, anon, authenticated;
CREATE FUNCTION pds.fixture_via_two_views() RETURNS SETOF xml LANGUAGE sql SECURITY DEFINER
AS $f$ SELECT x FROM pds.fixture_xml_outer $f$;""", DYNAMIC_ABORT, "fixture_via_two_views")


def test_assembled_name_view_nobody_can_reach_passes_and_reruns() -> None:
    # The same view with no callable definer in front of it reaches no browser role.
    _expect_success("""CREATE VIEW pds.fixture_xml_idle AS
SELECT query_to_xml('SELECT k FROM pds.' || 'hrv_' || 'residuals_mat', true, false, '') AS x;
REVOKE ALL ON pds.fixture_xml_idle FROM PUBLIC, anon, authenticated;""",
                    MIGRATE, _assert_grants(False), MIGRATE, _assert_grants(False))


# The readiness check must refuse an index REFRESH ... CONCURRENTLY cannot use: unique and
# non-partial is not enough when the index is an expression index (indexprs) or is invalid /
# not ready, so those cases abort with the readiness message, grants unchanged.
INDEX_ABORT = "has no usable unique non-partial index"


def test_expression_unique_index_aborts() -> None:
    # The only unique index on the matview is an expression index ((k + 0)): indisunique and
    # indpred IS NULL pass, but a concurrent refresh cannot use it.
    _expect_abort("""DROP INDEX pds.hrv_residuals_mat_k;
CREATE UNIQUE INDEX hrv_residuals_mat_expr ON pds.hrv_residuals_mat ((k + 0));""",
                  INDEX_ABORT, "hrv_residuals_mat")


def test_invalid_unique_index_aborts() -> None:
    # pg_index.indisvalid is only writable by a superuser; skip with a clear reason rather than
    # faking the case when the fixture user is not one.
    res = _run("\n".join([
        _setup(),
        """DO $invalid$
BEGIN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION 'SKIP: fixture user % is not a superuser; cannot make an invalid index', current_user;
    END IF;
    UPDATE pg_index SET indisvalid = false
    WHERE indrelid = 'pds.tz_log_gaps_mat'::regclass AND indisunique;
END
$invalid$;""",
        MIGRATE_EXPECTING_ABORT, _assert_grants(True),
        "SELECT 'FIXTURE_ABORTED_UNCHANGED';", "ROLLBACK;"]))
    if "SKIP:" in res.stderr:
        print(f"SKIP test_invalid_unique_index_aborts: {res.stderr.strip().splitlines()[-1]}")
        return
    assert res.returncode == 0, res.stderr[-2000:]
    assert "FIXTURE_ABORTED_UNCHANGED" in res.stdout, res.stderr[-2000:]
    assert INDEX_ABORT in res.stderr, res.stderr[-2000:]
    assert "tz_log_gaps_mat" in res.stderr, res.stderr[-2000:]


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
