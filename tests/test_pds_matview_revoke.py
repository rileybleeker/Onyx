"""Offline contract tests for the pds matview revoke (SEC-01-B phase 2).

A materialized view has no row security, so an authenticated SELECT grant on a pds *_mat let any
signed-in account read every row through the Data API. Phase 1 moved every browser read behind the
owner-only facade GET /api/derived/<name>; sql/pds_matview_revoke_authenticated.sql takes the grant
away. These tests pin the migration's contract without a database: what it revokes and from whom,
that every check runs before the revoke inside one atomic statement, that the reachability checks walk
the whole dependency graph from all six on every run (a re-run included), that a re-run is harmless,
that there is no rollback granting a browser role again, that the post-apply check is read-only, walks
the same graph and probes both the owner and another account, and that no repo SQL hands a matview to
a browser role again (recreate recipes, PART 1 of sql/pds_owner_only_read.sql).

What the migration does on a real PostgreSQL (two-hop definer chain, re-run after the revoke, column
grants, function paths) is in tests/test_pds_matview_revoke_pg.py (needs a disposable database). The
live behaviour (owner and another account refused with 42501, service_role still reads) is checked
after the migration is applied by sql/checks/verify_matview_revoke.sql.

Run: python tests/test_pds_matview_revoke.py
     python tests/run_offline_tests.py tests/test_pds_matview_revoke.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORWARD = ROOT / "sql" / "pds_matview_revoke_authenticated.sql"
VERIFY = ROOT / "sql" / "checks" / "verify_matview_revoke.sql"
OWNER_ONLY = ROOT / "sql" / "pds_owner_only_read.sql"

# The six matviews that carried authenticated=r when the facade shipped (docs/owner-view-access.md).
SIX = {
    "daily_health_matrix_behavioral_mat",
    "hrv_prediction_gaps_mat",
    "hrv_residuals_mat",
    "recovery_vs_pace_mat",
    "spotify_daily_signature_mat",
    "tz_log_gaps_mat",
}
BROWSER_ROLES = {"anon", "authenticated", "public"}


def _code(path: Path) -> str:
    """The file without -- comments (none of these files has -- inside a string)."""
    return "\n".join(line.split("--", 1)[0] for line in path.read_text(encoding="utf-8").splitlines())


def _expected_array(code: str) -> list[str]:
    m = re.search(r"expected\s+constant\s+text\[\]\s*:=\s*ARRAY\[(.*?)\]", code, re.S)
    assert m, "expected constant text[] := ARRAY[...] not found"
    return re.findall(r"'([a-z_]+)'", m.group(1))


def _statements(code: str, verb: str) -> list[str]:
    """Every GRANT / REVOKE in the code, including those built with format('...')."""
    return [s.strip() for s in re.findall(rf"\b{verb}\b[^;']*", code, re.I)]


def _repo_sql_files() -> list[Path]:
    files: list[Path] = []
    for base in (ROOT / "sql", ROOT / "supabase" / "migrations"):
        if base.is_dir():
            files += [p for p in base.rglob("*.sql") if "deprecated" not in p.parts]
    return sorted(files)


_GRANT_ON_MAT = re.compile(r"\bGRANT\b.*?\bON\s+(?:TABLE\s+)?pds\.([a-z_]+_mat)\b.*?\bTO\b(.*)", re.I | re.S)


def _browser_mat_grants(text: str) -> list[tuple[str, list[str]]]:
    """(matview, browser roles) for every GRANT on a pds.*_mat to anon / authenticated / PUBLIC.

    Each statement of the code counts (split on ';', so a GRANT over several lines is seen), and so
    does each comment line on its own: the recreate recipes live in comments and get copied into
    migrations.
    """
    lines = text.splitlines()
    code = "\n".join(line.split("--", 1)[0] for line in lines)
    comments = [line.split("--", 1)[1] for line in lines if "--" in line]
    hits = []
    for chunk in code.split(";") + comments:
        m = _GRANT_ON_MAT.search(chunk)
        if m:
            roles = sorted(set(re.findall(r"[a-z_]+", m.group(2).lower())) & BROWSER_ROLES)
            if roles:
                hits.append((m.group(1), roles))
    return hits


# --------------------------------------------------------------------------------------------------
# Forward migration
# --------------------------------------------------------------------------------------------------

def test_forward_targets_exactly_the_six_browser_matviews() -> None:
    names = _expected_array(_code(FORWARD))
    assert len(names) == len(set(names)), "duplicate matview name"
    assert set(names) == SIX
    # Every name is a matview the repo's other SQL names (a typo would make the live check raise).
    named: set[str] = set()
    for p in _repo_sql_files():
        if p in (FORWARD, VERIFY):
            continue
        named |= set(re.findall(r"\bpds\.([a-z_]+_mat)\b", p.read_text(encoding="utf-8")))
    assert SIX <= named, sorted(SIX - named)


def test_forward_revokes_everything_from_every_browser_role_and_touches_nothing_else() -> None:
    code = _code(FORWARD)
    revokes = _statements(code, "REVOKE")
    assert revokes == ["REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated"], revokes
    assert "service_role" not in " ".join(revokes)
    assert _statements(code, "GRANT") == [], "the forward migration must not grant anything"
    for forbidden in (r"ALTER\s+DEFAULT\s+PRIVILEGES", r"ALTER\s+MATERIALIZED\s+VIEW", r"\bREFRESH\b",
                      r"CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|VIEW|MATERIALIZED|INDEX|POLICY)",
                      r"\bINSERT\b", r"\bUPDATE\b", r"\bALTER\s+TABLE\b", r"\bALTER\s+POLICY\b"):
        assert not re.search(forbidden, code, re.I), forbidden


def test_forward_is_one_atomic_statement_and_every_check_precedes_the_revoke() -> None:
    code = _code(FORWARD)
    blocks = re.findall(r"DO \$migration\$(.*?)\$migration\$;", code, re.S)
    assert len(blocks) == 1, "exactly one DO statement"
    outside = re.sub(r"DO \$migration\$.*?\$migration\$;", "", code, flags=re.S)
    assert outside.strip() == "", f"statements outside the atomic DO: {outside.strip()[:80]!r}"
    body = blocks[0]
    revoke_at = body.index("EXECUTE format('REVOKE")
    before, after = body[:revoke_at], body[revoke_at:]
    # The preconditions, each a RAISE before the first REVOKE.
    for needle in (
        "c.relkind = 'm'",                                            # the six are matviews
        "has_table_privilege('service_role', rel, 'SELECT')",         # the facade keeps working
        "i.indisunique AND i.indpred IS NULL",                        # CONCURRENTLY refresh keeps its index
        "Unreviewed pds matview",                                     # nothing but the reviewed six
        "WITH RECURSIVE reach(cls, obj)",                             # the whole dependency graph
        "'pg_rewrite'::regclass",                                     # no view / matview over one
        "has_any_column_privilege('authenticated', c.oid, 'SELECT')", # ... readable on a single column
        "'pg_policy'::regclass",                                      # no row-security policy over one
        "has_function_privilege('authenticated', p.oid, 'EXECUTE')",  # no callable function over one
        "pg_trigger",                                                 # no trigger function over one
    ):
        assert needle in before, needle
    assert before.count("RAISE EXCEPTION") >= 7
    # The post-check undoes the statement if a browser role can still read any pds matview.
    assert "Still readable by a browser role after the revocation" in after
    assert "has_any_column_privilege('authenticated', c.oid, 'SELECT')" in after
    assert "service_role lost SELECT" in after
    assert "lock_timeout" in before


def _graph(code: str) -> str:
    m = re.search(r"WITH RECURSIVE reach\(cls, obj\).*?FROM reach;", code, re.S)
    assert m, "dependency graph query not found"
    return m.group(0)


def test_reachability_graph_starts_from_all_six_on_every_run() -> None:
    body = re.findall(r"DO \$migration\$(.*?)\$migration\$;", _code(FORWARD), re.S)[0]
    # Step 1 collects the six it verified; the graph starts from them, never from the matviews that
    # still carry a grant (that list is empty on a re-run, which would skip every check).
    assert "six := six || rel;" in body
    checks = body[body.index("WITH RECURSIVE reach(cls, obj)"):body.index("EXECUTE format('REVOKE")]
    assert "unnest(six)" in checks
    assert "targets" not in checks, "a reachability check uses the grant list instead of all six"
    graph = _graph(body)
    # Recursive: views over views (two hops and more), functions with a recorded dependency on a
    # node or on a matview's row type, functions whose source names a node (relations by relname,
    # functions by proname, so a function calling a function is followed).
    for needle in ("FROM reach cur", "CROSS JOIN LATERAL", "d.classid = 'pg_rewrite'::regclass", "w.ev_class",
                   "d.classid = 'pg_proc'::regclass", "d.refclassid = 'pg_type'::regclass", "c.reltype",
                   "p.prosrc ~*", "c.relname FROM pg_class", "q.proname FROM pg_proc",
                   "regexp_replace("):
        assert needle in graph, needle
    # Case-insensitive (SEC01B round 2): PostgreSQL folds an unquoted PDS.HRV_RESIDUALS_MAT to the
    # lower-case name, so a case-sensitive match would miss it. No case-sensitive name match is left.
    assert not re.search(r"prosrc ~ \(", graph), "case-sensitive name match in the graph"
    # What is checked on the graph: every relation but the six (table AND column privileges, both
    # browser roles), every policy over a relation or function of it, every function of it.
    for needle in ("c.oid = ANY (reach_rels) AND NOT c.oid = ANY (six)",
                   "has_table_privilege('anon', c.oid, 'SELECT')",
                   "has_any_column_privilege('anon', c.oid, 'SELECT')",
                   "has_any_column_privilege('authenticated', c.oid, 'SELECT')",
                   "d.refobjid = ANY (reach_rels)", "d.refobjid = ANY (reach_fns)",
                   "has_function_privilege('anon', p.oid, 'EXECUTE')",
                   "'event_trigger'::regtype", "pg_event_trigger",
                   "d.classid NOT IN ('pg_proc'::regclass, 'pg_rewrite'::regclass, 'pg_policy'::regclass)"):
        assert needle in checks, needle
    # Fail closed: a void refresh function is NOT exempt; it passes only while no browser role may
    # call it (sql/matview_refresh_concurrently.sql functions are SECURITY DEFINER).
    assert "'void'::regtype" not in checks


def test_verify_check_walks_the_same_graph_as_the_migration() -> None:
    assert _graph(_code(VERIFY)) == _graph(_code(FORWARD))


def _dynamic_check(code: str) -> str:
    """Step 3d: the query over SECURITY DEFINER functions whose SQL the graph cannot read."""
    m = re.search(r"WITH RECURSIVE fn AS \(.*?INTO (?:blocker|leaked)\n.*?\);", code, re.S)
    assert m, "dynamic-SQL definer check (step 3d) not found"
    return m.group(0).replace("INTO leaked", "INTO blocker")


def _reviewed(code: str) -> list[str]:
    m = re.search(r"reviewed_opaque\s+constant\s+text\[\]\s*:=\s*ARRAY\[(.*?)\];", code, re.S)
    assert m, "reviewed_opaque list not found"
    return re.findall(r"'([^']*)'", m.group(1))


def test_dynamic_sql_definers_fail_closed_before_the_revoke() -> None:
    # SEC01B-R3: 'pds.' || 'hrv_' || 'residuals_mat' built at run time names no object, so the graph
    # cannot find it. Step 3d fails closed on every reachable SECURITY DEFINER function whose own or
    # callees' SQL is opaque, unless the whole closure is on the reviewed list with the same hash.
    body = re.findall(r"DO \$migration\$(.*?)\$migration\$;", _code(FORWARD), re.S)[0]
    check = _dynamic_check(body)
    assert body.index(check) < body.index("EXECUTE format('REVOKE")
    for needle in (
        "f.prosecdef",                                                # definer functions only ...
        "unnest(reach_rels)",                                         # ... whose owner reads the graph
        "has_any_column_privilege(f.proowner, g, 'SELECT')",          # (a column-only owner too)
        "calls(root, fn)", "FROM calls c",                            # ... plus everything they call
        r"'\m' || regexp_replace(p.proname, '([^[:alnum:]_])', '\\\1', 'g') || '\M' AS pat",
        "cur.src ~* q.pat",                                           # names matched in any case
        "d.refclassid = 'pg_proc'::regclass",                           # calls found by dependency,
        "pg_get_viewdef(c.oid)", "c.relkind IN ('v', 'm')",           # views are nodes too (SEC01B-R3 round 4)
        "d.classid = 'pg_rewrite'::regclass",                         # a view's own dependencies are followed
        "bool_or(q.kind = 'v'", "r.opaque_view",                      # an opaque view is never waved through
        "FILTER (WHERE q.kind = 'f')",                                # the reviewed hash covers functions only
        "pg_get_function_sqlbody",                                    # SQL-standard bodies are read too
        "q.lanname NOT IN ('sql', 'plpgsql')",                        # other languages are opaque
        r"q.src ~* '\mexecute\M'",                                    # dynamic EXECUTE is opaque
        "_to_xml|ts_stat|ts_rewrite|dblink",                          # query-string builtins are opaque
        "u&[",                                                        # Unicode-escaped names are opaque
        "md5(string_agg(", "= ANY (reviewed_opaque)",                 # reviewed closures, by hash
        "has_function_privilege('anon', f.oid, 'EXECUTE')",           # reachable: callable,
        "has_function_privilege('authenticated', f.oid, 'EXECUTE')",
        "pg_trigger t WHERE t.tgfoid = f.oid",                        # a trigger,
        "pg_event_trigger e WHERE e.evtfoid = f.oid",                 # an event trigger,
        "d.refobjid = f.oid",                                         # used by any object,
        "o.src ~* f.pat",                                             # or named by another function
    ):
        assert needle in check, needle
    # No case-sensitive name match and no table-only owner test is left (SEC01B round 2).
    assert not re.search(r"src ~ [(q]", check), "case-sensitive name match in step 3d"
    assert "has_table_privilege(f.proowner" not in check
    after = body[body.index(check):]
    assert after.index("IF blocker IS NOT NULL") < after.index("RAISE EXCEPTION 'A SECURITY DEFINER function")
    assert "targets" not in check


def test_verify_check_runs_the_same_dynamic_sql_check_and_list() -> None:
    assert _dynamic_check(_code(VERIFY)) == _dynamic_check(_code(FORWARD))
    assert _reviewed(_code(VERIFY)) == _reviewed(_code(FORWARD))
    assert "dynamic_sql_definers_reviewed" in _code(VERIFY)


def test_reviewed_list_entries_are_exact_signature_hash_pairs() -> None:
    entries = _reviewed(_code(FORWARD))
    assert entries, "the reviewed list must name what it exempts"
    for entry in entries:
        assert re.fullmatch(r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\([^)]*\)=[0-9a-f]{32}", entry), entry
    # Nothing under pds is exempted by hand: a pds definer with dynamic SQL is made unreachable or
    # rewritten, not waved through.
    assert not [e for e in entries if e.startswith("pds.")], entries


def test_forward_rerun_after_success_is_a_harmless_no_op() -> None:
    code = _code(FORWARD)
    # FOREACH over a NULL array raises, so an empty target list must be an empty array, not NULL.
    assert "coalesce(array_agg(c.oid ORDER BY c.relname), '{}'::oid[])" in code
    # No precondition demands that the grant still exists (it is gone after the first run).
    assert not re.search(r"NOT\s+has_table_privilege\('(authenticated|anon)'", code)
    # Column-level grants count as a target too, so a leftover column grant is also taken away.
    assert "aclexplode(att.attacl)" in code


def test_forward_drift_list_covers_public_anon_and_authenticated() -> None:
    m = re.search(r"browser_roles\s+constant\s+oid\[\]\s*:=\s*ARRAY\[(.*?)\];", _code(FORWARD), re.S)
    assert m
    roles = m.group(1)
    assert "0::oid" in roles and "'anon'::regrole" in roles and "'authenticated'::regrole" in roles


def test_no_file_contains_a_statement_that_removes_anything() -> None:
    # The Supabase MCP connector refuses (or asks to confirm) a migration whose text holds the word,
    # comments included; and none of these files may remove data or objects.
    for path in (FORWARD, VERIFY):
        raw = path.read_text(encoding="utf-8")
        for word in ("drop", "truncate", "delete"):
            assert not re.search(rf"\b{word}", raw, re.I), f"{path.name}: {word}"


# --------------------------------------------------------------------------------------------------
# Recovery keeps the grants revoked
# --------------------------------------------------------------------------------------------------

def _prose(text: str) -> str:
    return " ".join(text.replace("--", " ").split())


def test_there_is_no_rollback_that_grants_a_browser_role_again() -> None:
    # SEC-01-B: recovery keeps broad grants revoked (fix the caller through the facade or a
    # service-role server read, or turn its panel off); a matview grant would show every row to every
    # signed-in account. So no file restores the grant, and the docs say what to do instead.
    assert not (ROOT / "sql" / "pds_matview_revoke_authenticated_rollback.sql").exists()
    header = _prose(FORWARD.read_text(encoding="utf-8").split("DO $migration$", 1)[0])
    assert "no rollback that grants a browser role again" in header
    assert "GRANT SELECT ON pds.<name>_mat TO service_role" in header
    doc = (ROOT / "docs" / "owner-view-access.md").read_text(encoding="utf-8")
    assert "There is no rollback that grants a browser role again" in _prose(doc)
    assert "keep the grants revoked" in _prose(doc)
    for path in [ROOT / "AGENTS.md", ROOT / "docs" / "owner-view-access.md", *_repo_sql_files()]:
        assert "pds_matview_revoke_authenticated_rollback" not in path.read_text(encoding="utf-8"), path


# --------------------------------------------------------------------------------------------------
# Post-apply verification
# --------------------------------------------------------------------------------------------------

def test_verify_check_is_read_only_and_probes_owner_and_another_account() -> None:
    raw = VERIFY.read_text(encoding="utf-8")
    code = _code(VERIFY)
    lines = [line for line in code.splitlines() if line.strip()]
    assert lines[0].strip() == "BEGIN READ ONLY;"
    assert lines[-1].strip() == "ROLLBACK;"
    m = re.search(r"mat_names\s+constant\s+text\[\]\s*:=\s*ARRAY\[(.*?)\];", code, re.S)
    assert m
    assert {n.removeprefix("pds.") for n in re.findall(r"'([a-z_.]+)'", m.group(1))} == SIX
    for verb in ("GRANT", "REVOKE", "INSERT", "UPDATE", "CREATE", "ALTER"):
        assert not re.search(rf"\b{verb}\b", code), verb
    # Role authenticated must be REFUSED (42501) with the owner's claims and with a synthetic other
    # account's claims; a successful read fails the check.
    assert "SET LOCAL ROLE authenticated" in code
    assert "EXCEPTION WHEN insufficient_privilege" in code
    assert "ARRAY[owner_id::text, '00000000-0000-0000-0000-000000000001']" in code
    assert "Role authenticated can still read" in code
    # service_role keeps reading, the unique index stays, no other pds matview is open.
    assert "SET LOCAL ROLE service_role" in code
    assert "i.indisunique AND i.indpred IS NULL" in code
    assert "relispopulated" in code
    assert "Other pds matviews readable by a browser role" in code
    assert "has_any_column_privilege('authenticated', c.oid, 'SELECT')" in code
    # The dependency graph is closed to browser roles (same query as the migration's step 3).
    for needle in ("Browser-readable relation reaches a matview", "Row-security policy reaches a matview",
                   "Function a browser role can reach reads a matview", "graph_closed_to_browser_roles"):
        assert needle in code, needle
    # Output is counts and booleans only, never a row.
    assert "jsonb_build_object(" in code and "SELECT * FROM %s LIMIT 0" in code
    assert "row_to_json" not in raw and "to_jsonb(" not in raw


# --------------------------------------------------------------------------------------------------
# The grant must not come back
# --------------------------------------------------------------------------------------------------

def test_part1_of_owner_only_read_never_grants_a_matview() -> None:
    # The first c.relkind filter in the code is PART 1's loop over the relations it grants.
    m = re.search(r"c\.relkind\s+IN\s*\(([^)]*)\)", _code(OWNER_ONLY))
    assert m, "PART 1 relkind filter not found"
    kinds = set(re.findall(r"'([a-z])'", m.group(1)))
    assert "m" not in kinds, kinds
    assert {"r", "p", "v"} <= kinds


def test_no_repo_sql_grants_a_matview_to_a_browser_role() -> None:
    offenders = [f"{p.relative_to(ROOT)}: {hit}" for p in _repo_sql_files()
                 for hit in _browser_mat_grants(p.read_text(encoding="utf-8"))]
    assert offenders == [], offenders


def test_recreate_recipes_end_with_the_service_role_only_grants() -> None:
    matrix = (ROOT / "sql" / "perf_matrix_matview.sql").read_text(encoding="utf-8")
    assert "REVOKE ALL ON pds.daily_health_matrix_behavioral_mat FROM PUBLIC, anon, authenticated;" in matrix
    assert "GRANT SELECT ON pds.daily_health_matrix_behavioral_mat TO service_role;" in matrix
    tier2 = (ROOT / "sql" / "perf_tier2_matviews.sql").read_text(encoding="utf-8")
    assert "REVOKE ALL ON pds.<name>_mat FROM PUBLIC, anon, authenticated;" in tier2
    assert "GRANT SELECT ON pds.<name>_mat TO service_role;" in tier2


# --------------------------------------------------------------------------------------------------
# Self-checks of the helpers on synthetic SQL (so a broken regex cannot make the guards vacuous)
# --------------------------------------------------------------------------------------------------

def test_grant_guard_catches_synthetic_regrants() -> None:
    bad = [
        "GRANT SELECT ON pds.example_mat TO anon, authenticated;",
        "grant select on table pds.example_mat to authenticated;",
        "--   GRANT SELECT ON pds.example_mat TO PUBLIC;",
        "GRANT SELECT\n  ON pds.example_mat\n  TO service_role, authenticated;",
    ]
    for text in bad:
        assert _browser_mat_grants(text), text
    good = [
        "GRANT SELECT ON pds.example_mat TO service_role;",
        "GRANT SELECT ON pds.example_view TO authenticated;",
        "REVOKE ALL ON pds.example_mat FROM PUBLIC, anon, authenticated;",
        # A comment that only mentions a grant, then an unrelated statement, is not a hit.
        "-- the default privileges would grant authenticated again\nSELECT 1 FROM pds.example_mat;",
    ]
    for text in good:
        assert not _browser_mat_grants(text), text


def test_statement_helper_sees_format_built_statements() -> None:
    code = "EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated', rel::regclass);"
    assert _statements(code, "REVOKE") == ["REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated"]
    assert _statements("GRANT SELECT ON pds.x TO authenticated;", "GRANT") == ["GRANT SELECT ON pds.x TO authenticated"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
