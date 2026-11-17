"""Screen Time export completeness (PIPE-11): static checks on sql/phone_usage_completeness.sql.

No database here. The behaviour (watchdog stop, missing chunk, inconsistent chunks, a complete run, a
repeat, the verified snapshot, stale items, ownership) is checked against a real Postgres by
sql/checks/verify_phone_usage_completeness_branch.sql, run on a Supabase branch after the file is
applied. This file keeps a later edit from quietly undoing the rules that check relies on:

  * the file is additive and sendable through the Supabase MCP (no DROP; ADD COLUMN IF NOT EXISTS,
    nullable; CREATE TABLE IF NOT EXISTS),
  * the new tables are service-role only (RLS on, nothing granted to anon / authenticated),
  * the finalization refuses a watchdog stop, a missing chunk and disagreeing chunks before it
    verifies anything, locks the hours it may change before it decides, verifies only closed whole
    hours the run still owns that ended by the run's coverage end (the earlier of the export time and
    Apple's own last update: a clean stream from a stale cache never certifies the hours after it),
    and removes only items of an hour it verifies or replaces and the staged copies of settled or
    old runs,
  * the item guard locks the hour (FOR SHARE) before it reads whether it is verified or who owns it,
    so an item write and a finalization are one after the other,
  * a run is never settled while one of its staged replacements is incomplete (a repeated delivery of an
    acknowledged chunk empties the staged items before it stores them again): the check runs after the hour
    locks and before anything is verified, replaced, removed or deleted,
  * a verified hour is a snapshot an ordinary upload cannot change; a newer run's upload is staged and
    replaces the snapshot only when that run finalizes complete,
  * the view keeps every existing column, in order, and appends the five completeness columns,
  * every reader asks the view for columns that exist.

Run: python tests/test_phone_usage_completeness_sql.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "sql" / "phone_usage_completeness.sql"
BASE = ROOT / "sql" / "phone_usage_schema.sql"
CHECK = ROOT / "sql" / "checks" / "verify_phone_usage_completeness_branch.sql"
APPENDED = ["hours_verified", "export_complete", "completeness", "pre_sleep_complete", "during_sleep_complete"]


def _sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _no_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _function(sql: str, name: str) -> str:
    start = sql.index(f"CREATE OR REPLACE FUNCTION pds.{name}(")
    end = sql.index("$$;", sql.index("AS $$", start))
    return sql[start:end]


def _view_select_columns(sql: str) -> list[str]:
    """Output column names of the final SELECT of pds.phone_usage_daily, in order."""
    body = sql[sql.index("CREATE OR REPLACE VIEW pds.phone_usage_daily"):]
    body = _no_comments(body)
    select = body[body.rindex("\nSELECT\n") + len("\nSELECT\n"):body.index("\nFROM agg a")]
    cols, depth, cur = [], 0, ""
    for ch in select:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            cols.append(cur)
            cur = ""
        else:
            cur += ch
    cols.append(cur)
    names = []
    for c in cols:
        c = " ".join(c.split())
        m = re.search(r"\bAS\s+(\w+)$", c)
        names.append(m.group(1) if m else c.split(".")[-1])
    return names


def test_additive_and_sendable():
    for path in (MIGRATION, CHECK):
        assert "drop" not in _sql(path).lower(), f"{path.name} must not contain the word (Supabase MCP refuses it)"
    sql = _no_comments(_sql(MIGRATION))
    assert "TRUNCATE" not in sql.upper()
    for col in ("last_run_id", "last_run_item_count", "last_export_at", "verified_at", "verified_run_id",
                "verified_export_at"):
        assert re.search(rf"ADD COLUMN IF NOT EXISTS {col}\s+\w+[,;]\n", sql), col
    for col in ("source_updated_at", "coverage_end"):
        assert re.search(rf"ADD COLUMN IF NOT EXISTS {col}\s+TIMESTAMPTZ[,;]\n", sql), col
    assert not re.search(r"ADD COLUMN[^\n]*NOT NULL", sql), "new columns on existing tables stay nullable"
    for table in ("phone_usage_sync_chunks", "phone_usage_sync_runs", "phone_usage_pending_hours"):
        assert f"CREATE TABLE IF NOT EXISTS pds.{table}" in sql, table
    # The only removals are inside the finalization: items of an hour it verifies or replaces, and staged copies.
    deletes = re.findall(r"DELETE FROM (pds\.\w+)", sql)
    assert set(deletes) == {"pds.phone_usage_items", "pds.phone_usage_pending_hours"}, deletes
    finalize = _no_comments(_function(_sql(MIGRATION), "finalize_phone_usage_run"))
    assert len(deletes) == len(re.findall(r"DELETE FROM", finalize)) == 4, "every removal is inside the finalization"
    assert "DELETE FROM pds.phone_usage_items i\n             USING owned o" in sql


def test_new_tables_are_service_role_only():
    sql = _no_comments(_sql(MIGRATION))
    for table in ("phone_usage_sync_chunks", "phone_usage_sync_runs", "phone_usage_pending_hours"):
        assert f"ALTER TABLE pds.{table}" in sql and "ENABLE ROW LEVEL SECURITY" in sql
    assert ("REVOKE ALL ON pds.phone_usage_sync_chunks, pds.phone_usage_sync_runs, pds.phone_usage_pending_hours "
            "FROM PUBLIC, anon, authenticated;") in sql
    assert not re.search(r"GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b", sql, re.I), "nothing is granted to a browser role"
    assert "TO authenticated USING" not in sql
    for fn in ("finalize_phone_usage_run(TEXT, UUID)", "phone_usage_window_complete(TIMESTAMPTZ, TIMESTAMPTZ)",
               "phone_usage_segments_guard()", "phone_usage_items_guard()"):
        assert f"REVOKE ALL ON FUNCTION pds.{fn} FROM PUBLIC, anon, authenticated;" in sql, fn
    assert "SECURITY DEFINER" not in sql


def test_finalization_refuses_unsupported_runs_before_verifying():
    fn = _no_comments(_function(_sql(MIGRATION), "finalize_phone_usage_run"))
    assert "SECURITY INVOKER" in fn
    assert "pg_advisory_xact_lock" in fn, "one finalization per run at a time"
    order = [fn.index(s) for s in ("v_status := 'inconsistent'", "v_status := 'stream_open'",
                                   "v_status := 'receiving'", "v_status := 'complete'")]
    assert order == sorted(order)
    assert "ELSIF NOT c.ended_all THEN" in fn, "a watchdog stop is never complete"
    assert "ELSIF c.chunks < c.chunk_count THEN" in fn, "a missing chunk is never complete"
    assert "c.segments_received <> c.segment_total" in fn
    # Coverage: the earlier of the export time and Apple's own last update; no source time covers nothing,
    # and chunks that disagree on it are one inconsistent run.
    assert "v_cover := LEAST(c.window_end, COALESCE(c.source_updated, c.window_start));" in fn
    assert "c.source_updated IS DISTINCT FROM c.source_updated_max" in fn
    assert "c.source_known NOT IN (0, c.n)" in fn
    verify = fn[fn.index("IF v_status = 'complete' THEN"):fn.index("INSERT INTO pds.phone_usage_sync_runs")]
    for rule in ("s.last_run_id = p_run_id", "s.verified_at IS NULL", "s.segment_end <= v_cover",
                 "s.segment_end - s.segment_start >= INTERVAL '1 hour'", "s.last_run_item_count IS NOT NULL",
                 "i.last_run_id IS DISTINCT FROM p_run_id"):
        assert rule in verify, rule
    assert verify.index("set_config('onyx.phone_usage_verified_write', 'on', true)") < verify.index("UPDATE pds.phone_usage_segments")
    assert "set_config('onyx.phone_usage_verified_write', 'off', true)" in verify
    # Lock the hours first, decide second: no concurrent upload can slip between the check and the marking.
    assert "ORDER BY s.segment_start\n           FOR UPDATE;" in verify
    assert verify.index("FOR UPDATE") < verify.index("WITH owned AS")
    assert "AND s.last_run_id = p_run_id AND s.verified_at IS NULL\n            RETURNING 1" in verify, "the marking rechecks ownership"
    # A later complete export replaces the snapshot of an hour an earlier run verified, only from its own staged copy.
    fix = verify[verify.index("SELECT COALESCE(array_agg"):verify.index("DELETE FROM pds.phone_usage_pending_hours h WHERE h.device")]
    for rule in ("h.run_id = p_run_id", "s.verified_at IS NOT NULL", "s.verified_export_at < v_cover",
                 "(h.segment ->> 'segment_end')::timestamptz <= v_cover", ">= INTERVAL '1 hour'",
                 "(h.segment ->> 'last_run_item_count')::int = (SELECT count(*) FROM jsonb_object_keys(h.items))",
                 "verified_run_id        = p_run_id"):
        assert rule in fix, rule
    # Usage rows are touched only inside the complete branch.
    outside = fn.replace(verify, "")
    assert "UPDATE pds.phone_usage_segments" not in outside and "DELETE FROM" not in outside
    # A complete run answers again without changing anything.
    assert "'already', true" in fn


def test_run_is_not_settled_while_a_staged_replacement_is_incomplete():
    fn = _no_comments(_function(_sql(MIGRATION), "finalize_phone_usage_run"))
    lock = fn.index("FOR UPDATE;")
    check = fn.index("INTO v_staged_incomplete")
    settle = fn.index("IF v_staged_incomplete > 0 THEN\n            v_status := 'receiving';")
    work = fn.index("WITH owned AS")
    enable = fn.index("set_config('onyx.phone_usage_verified_write', 'on', true)")
    # Locks first, then the staged-completeness read, then (only if still complete) the work.
    assert lock < check < settle < enable < work
    block = fn[check - 60:settle]
    assert "FROM pds.phone_usage_pending_hours h" in block and "h.run_id = p_run_id" in block
    # Incomplete = the item count the staged hour claims differs from the items staged for it (a NULL claim too).
    assert "(h.segment ->> 'last_run_item_count')::int" in block and "IS DISTINCT FROM (SELECT count(*) FROM jsonb_object_keys(h.items))" in block
    # Nothing that changes usage rows or deletes a staged copy sits between the check and the status decision.
    before_work = fn[:enable]
    assert "DELETE FROM" not in before_work and "UPDATE pds.phone_usage" not in before_work
    # The staged copies are deleted only after the work, i.e. only when the run is settled.
    assert fn.rindex("DELETE FROM pds.phone_usage_pending_hours h WHERE h.device = p_device AND h.run_id = p_run_id") > work
    # Every answer carries the count, so a caller and the branch check can tell why a run stayed 'receiving'.
    assert fn.count("'staged_incomplete'") == 3


def test_guards_keep_the_snapshot_and_the_ownership():
    sql = _sql(MIGRATION)
    seg = _no_comments(_function(sql, "phone_usage_segments_guard"))
    # A verified hour is never changed by an upload: a NEWER run's copy is staged, anything else ignored.
    verified = seg[seg.index("IF OLD.verified_at IS NOT NULL THEN"):seg.index("IF OLD.last_export_at IS NOT NULL")]
    assert "NEW.last_run_id IS NOT NULL" in verified and "NEW.last_export_at > OLD.verified_export_at" in verified
    assert "INSERT INTO pds.phone_usage_pending_hours" in verified
    assert "RETURN NULL;" in verified and "RETURN NEW" not in verified
    assert "NEW.last_export_at < OLD.last_export_at" in seg
    for col in ("verified_at", "verified_run_id", "verified_export_at"):
        assert f"NEW.{col}" in seg and ":= NULL" in seg, col
    items = _no_comments(_function(sql, "phone_usage_items_guard"))
    verified_items = items[items.index("IF parent_verified IS NOT NULL THEN"):items.index("parent_run IS DISTINCT FROM NEW.last_run_id")]
    assert "NEW.last_run_id IS DISTINCT FROM parent_verified_run" in verified_items
    assert "UPDATE pds.phone_usage_pending_hours" in verified_items
    assert "RETURN NULL;" in verified_items and "RETURN NEW" not in verified_items, "a verified hour's items never change directly"
    # An item applies only while the upload that wrote it owns the hour: a run's item while that run owns it,
    # an item without a run id only while no run does.
    assert "IF parent_run IS DISTINCT FROM NEW.last_run_id THEN\n        RETURN NULL;" in items
    # The hour is locked BEFORE it is read and the lock lasts to the end of the transaction (past the item
    # write), so a finalization that verifies the hour cannot slip in between the check and the write.
    locked_read = items[items.index("SELECT s.verified_at, s.last_run_id, s.verified_run_id"):items.index("IF NOT FOUND THEN")]
    assert "FOR SHARE OF s" in locked_read, "the item guard must lock its hour while it reads it"
    assert items.index("FOR SHARE OF s") < items.index("IF parent_verified IS NOT NULL THEN")
    assert "BEFORE INSERT OR UPDATE ON pds.phone_usage_segments" in sql
    assert "BEFORE INSERT OR UPDATE ON pds.phone_usage_items" in sql
    # Postgres fires BEFORE triggers in name order: the guard must come before the date trigger so a
    # skipped row skips both.
    assert "phone_usage_segments_guard" < "phone_usage_segments_set_onyx_dates"


def test_view_keeps_its_columns_and_appends_completeness():
    base, new = _view_select_columns(_sql(BASE)), _view_select_columns(_sql(MIGRATION))
    assert base[-1] == "synced_at" and len(base) == 16
    assert new[:len(base)] == base, "existing columns unchanged and in order"
    assert new[len(base):] == APPENDED
    # The CTEs that compute the existing columns are copied verbatim.
    def ctes(sql):
        body = sql[sql.index("CREATE OR REPLACE VIEW pds.phone_usage_daily"):]
        return body[body.index("WITH seg AS ("):body.index("agg AS (")]
    assert ctes(_sql(BASE)) == ctes(_sql(MIGRATION))
    view = _sql(MIGRATION)[_sql(MIGRATION).index("CREATE OR REPLACE VIEW pds.phone_usage_daily"):]
    assert "WITH (security_invoker = true)" in view
    assert "WHEN a.no_run_metadata THEN 'unknown'" in view
    assert "pds.phone_usage_window_complete(a.sleep_start - INTERVAL '60 minutes', a.sleep_start)" in view


def test_window_check_needs_a_complete_run_and_no_unverified_hour():
    fn = _no_comments(_function(_sql(MIGRATION), "phone_usage_window_complete"))
    assert "COALESCE(p_from < p_to, false)" in fn, "a missing bound is never complete"
    assert "r.status = 'complete' AND r.window_start <= p_from AND r.coverage_end >= p_to" in fn
    assert "s.verified_at IS NULL AND s.segment_start < p_to AND s.segment_end > p_from" in fn


def _columns(text: str) -> list[str]:
    return [c.strip() for c in re.split(r"[,\s]+", text) if c.strip()]


def test_every_reader_asks_for_columns_the_view_has():
    view = set(_view_select_columns(_sql(MIGRATION)))
    lib = (ROOT / "frontend/src/lib/screen-time.ts").read_text(encoding="utf-8")
    m = re.search(r"SCREEN_TIME_COLUMNS =\s*((?:\"[^\"]*\"\s*\+?\s*)+);", lib)
    readers = {"lib/screen-time.ts": "".join(re.findall(r"\"([^\"]*)\"", m.group(1)))}
    gate = (ROOT / "frontend/src/lib/checkin-screen.ts").read_text(encoding="utf-8")
    readers["lib/checkin-screen.ts"] = re.search(r"CHECKIN_SCREEN_COLUMNS =\s*\"([^\"]*)\"", gate).group(1)
    route = (ROOT / "frontend/src/app/api/screen-time/usage/route.ts").read_text(encoding="utf-8")
    m = re.search(r"SETUP_CHECK_DAILY_COLUMNS =((?:\s*(?://[^\n]*)?\s*\"[^\"]*\"\s*\+?)+);", route)
    readers["usage route setup check"] = "".join(re.findall(r"\"([^\"]*)\"", m.group(1)))
    hrv = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
    block = hrv[hrv.index('"phone_usage_daily",'):hrv.index("phone_usage_daily load failed")]
    readers["hrv_analysis loader"] = "".join(re.findall(r"\"([^\"]*)\"", block.split("select=", 1)[1].split(")", 1)[0]))
    rep = (ROOT / "experiment_report.py").read_text(encoding="utf-8")
    block = rep[rep.index("def screen_rows"):rep.index("def set_status")]
    readers["experiment_report.screen_rows"] = "".join(re.findall(r"\"([^\"]*)\"", block.split(".select(", 1)[1].split(").gte", 1)[0]))
    for name, cols in readers.items():
        missing = [c for c in _columns(cols) if c not in view]
        assert not missing, f"{name} reads columns the view does not have: {missing}"
    # The setup check lists every column of the view.
    assert set(_columns(readers["usage route setup check"])) == view
    for name in ("lib/screen-time.ts", "hrv_analysis loader"):
        assert {"export_complete", "pre_sleep_complete", "during_sleep_complete"} <= set(_columns(readers[name])), name
    for name in ("lib/checkin-screen.ts", "experiment_report.screen_rows"):
        assert {"export_complete", "pre_sleep_complete"} <= set(_columns(readers[name])), name


def test_branch_check_is_rolled_back_and_refuses_real_data():
    sql = _sql(CHECK)
    body = _no_comments(sql)
    assert body.lstrip().startswith("BEGIN;")
    assert body.rstrip().endswith("ROLLBACK;")
    assert "COMMIT" not in body.upper()
    assert "IF EXISTS (SELECT 1 FROM pds.phone_usage_segments) THEN\n        RAISE EXCEPTION 'refusing to run" in body
    for case in ("'stream_open'", "'receiving'", "'inconsistent'", "'complete'", "'unknown'", "'partial'",
                 "items_removed", "'already'", "hours_replaced", "pds.phone_usage_pending_hours",
                 "later_complete_export_replaces_snapshot", "later_incomplete_export_keeps_snapshot",
                 "older_export_not_staged", "stale_source_limits_coverage", "legacy_item_refused",
                 "source_updated_at", "coverage_end", "staged_replacement_not_settled_early",
                 "repeated_delivery_converges", "'staged_incomplete')::int <> 1"):
        assert case in body, case
    # Case 18 runs the interleaving in order: hour repeat (staged items emptied), original finalization (refused),
    # then the repeat's items, acknowledgement and finalization (settled).
    c18 = body[body.index("snapshot setup"):]
    order = [c18.index(m) for m in ("repeat setup: the repeated hour write", "a run was settled while a staged replacement was incomplete",
                                    "the repeat did not settle the run", "the corrected hour did not converge")]
    assert order == sorted(order)


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"ok  {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if failed else 0)
