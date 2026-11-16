"""Offline contract tests for the pds matview revoke (SEC-01-B phase 2).

A materialized view has no row security, so an authenticated SELECT grant on a pds *_mat let any
signed-in account read every row through the Data API. Phase 1 moved every browser read behind the
owner-only facade GET /api/derived/<name>; sql/pds_matview_revoke_authenticated.sql takes the grant
away. These tests pin the migration's contract without a database: what it revokes and from whom,
that every check runs before the revoke inside one atomic statement, that a re-run is harmless, that
the rollback restores exactly the old grant and nothing wider, that the post-apply check is read-only
and probes both the owner and another account, and that no repo SQL hands a matview to a browser role
again (recreate recipes, PART 1 of sql/pds_owner_only_read.sql).

The live behaviour (owner and another account refused with 42501, service_role still reads) is
checked after the migration is applied by sql/checks/verify_matview_revoke.sql.

Run: python tests/test_pds_matview_revoke.py
     python tests/run_offline_tests.py tests/test_pds_matview_revoke.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORWARD = ROOT / "sql" / "pds_matview_revoke_authenticated.sql"
ROLLBACK = ROOT / "sql" / "pds_matview_revoke_authenticated_rollback.sql"
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
        if p in (FORWARD, ROLLBACK, VERIFY):
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
        "'pg_rewrite'::regclass",                                     # no view / matview over one
        "'pg_policy'::regclass",                                      # no row-security policy over one
        "has_function_privilege('authenticated', p.oid, 'EXECUTE')",  # no callable function over one
        "pg_trigger",                                                 # no invoker trigger function over one
    ):
        assert needle in before, needle
    assert before.count("RAISE EXCEPTION") >= 7
    # The post-check undoes the statement if a browser role can still read any pds matview.
    assert "Still readable by a browser role after the revocation" in after
    assert "has_any_column_privilege('authenticated', c.oid, 'SELECT')" in after
    assert "service_role lost SELECT" in after
    assert "lock_timeout" in before


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
    for path in (FORWARD, ROLLBACK, VERIFY):
        raw = path.read_text(encoding="utf-8")
        for word in ("drop", "truncate", "delete"):
            assert not re.search(rf"\b{word}", raw, re.I), f"{path.name}: {word}"


# --------------------------------------------------------------------------------------------------
# Rollback
# --------------------------------------------------------------------------------------------------

def test_rollback_restores_only_authenticated_select_on_the_six() -> None:
    code = _code(ROLLBACK)
    assert set(_expected_array(code)) == SIX
    grants = _statements(code, "GRANT")
    assert grants == ["GRANT SELECT ON TABLE pds.%I TO authenticated"], grants
    assert _statements(code, "REVOKE") == []
    low = code.lower()
    assert "anon" not in low and "public" not in low  # never anon / PUBLIC
    for wider in (r"\bGRANT\s+ALL\b", r"\bINSERT\b", r"\bUPDATE\b", r"ON\s+ALL\s+TABLES", r"DEFAULT\s+PRIVILEGES"):
        assert not re.search(wider, code, re.I), wider
    # Each target is checked to be a pds matview before anything is granted.
    assert code.index("RAISE EXCEPTION") < code.index("EXECUTE format('GRANT")


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
    assert "Other pds matviews readable by a browser role" in code
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
    offenders = [f"{p.relative_to(ROOT)}: {hit}" for p in _repo_sql_files() if p != ROLLBACK
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
