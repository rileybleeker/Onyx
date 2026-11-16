"""TZ derivation edge cases: date-only rows and journal entries (offline, synthetic only).

Roadmap row "TZ derivation edge-cases + centralize fallback labeling" (2026-11-14), audit
item HIST-TZ-01 (2026-11-16). Five SQL files are checked:

  sql/tz_derivation_edge_cases.sql         the migration (date-only + journal derivation)
  sql/rollback_tz_derivation_2026-11-16.sql  the live definitions it replaces, byte for byte
  sql/tz_derivation_preapply_counts.sql    the SELECT-only impact counts run before applying
  sql/tz_derivation_postdeploy_checks.sql  the SELECT-only checks run right after applying
  sql/tz_derivation_whoop_followups.sql    the WHOOP parts split out (not applied)

Three layers:

  1. Text checks on the migration, so a later edit cannot quietly undo a fix: no trigger
     body hand-rolls a noon-ET probe; the two fallback labels are written in exactly one
     function; garmin_hrv stays on Garmin's wake-up calendar_date (hrv_alignment.py does the
     one-day shift, so the database must not shift it too); journal_entries accepts the ET,
     local or behavioral date of notion_created_at; the file writes no stored row (no
     backfill) and leaves the frozen WHOOP journal alone; it stays sendable through the
     Supabase MCP (no DROP anywhere, AGENTS.md).
  2. A Python model of the old (live until applied) and new rules, run on synthetic
     boundary cases: date-only rows, far-east trips, a same-day landing, the post-midnight
     awake tail, backdated and retro-logged entries, both DST transitions, NULLs.
  3. Cross-checks between the files: the post-deploy check's expected values equal what
     the model computes, its body hashes equal the migration's bodies, and the rollback
     file holds every function the migration replaces.

No database, no network, no credentials, no real rows: every date and instant here is
made up. The behavioral cases run against the deployed functions only after deployment,
through sql/tz_derivation_postdeploy_checks.sql.

Run: python tests/test_tz_derivation_edge_cases.py
"""
from __future__ import annotations

import hashlib
import re
import sys
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
SQL_PATH = SQL_DIR / "tz_derivation_edge_cases.sql"
ROLLBACK_PATH = SQL_DIR / "rollback_tz_derivation_2026-11-16.sql"
CHECKS_PATH = SQL_DIR / "tz_derivation_postdeploy_checks.sql"
PREAPPLY_PATH = SQL_DIR / "tz_derivation_preapply_counts.sql"
FOLLOWUPS_PATH = SQL_DIR / "tz_derivation_whoop_followups.sql"
ALIGNMENT_PY = ROOT / "hrv_alignment.py"

# Trigger functions with a branch that has only a date, plus the journal helper.
DATE_ONLY_SITES = (
    "set_onyx_dates_habit_journal",
    "journal_entry_onyx_dates",
    "set_onyx_dates_meal_events",
    "set_onyx_dates_supplement_intake",
    "set_onyx_dates_cronometer_servings",
    "set_onyx_dates_garmin_hrv",
)
NEW_HELPERS = ("tz_log_resolve", "derive_onyx_dates_for_day", "journal_entry_onyx_dates")
REPLACED_LIVE = (
    "derive_onyx_dates",
    "set_onyx_dates_habit_journal",
    "set_onyx_dates_journal_entries",
    "set_onyx_dates_meal_events",
    "set_onyx_dates_supplement_intake",
    "set_onyx_dates_cronometer_servings",
    "set_onyx_dates_garmin_hrv",
)
FALLBACK_LABELS = ("'user_tz_log'", "'default_et_fallback'")


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _strip_literals(sql: str) -> str:
    """Empty every '...' string literal (run after the comments are gone), so words or
    semicolons inside COMMENT ON texts cannot look like statements."""
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


_FUNC_RE = re.compile(
    r"CREATE OR REPLACE FUNCTION pds\.(\w+)\s*\(.*?\$function\$(.*?)\$function\$", re.S
)


def _raw_bodies(sql: str) -> dict[str, str]:
    """name -> body exactly as Postgres stores it in pg_proc.prosrc."""
    out: dict[str, str] = {}
    for name, body in _FUNC_RE.findall(sql):
        assert name not in out, f"{name} is defined twice"
        out[name] = body
    return out


def _functions(sql: str) -> dict[str, str]:
    """name -> body with comments removed."""
    return {k: _strip_comments(v) for k, v in _raw_bodies(sql).items()}


def _outside_bodies(sql: str) -> str:
    """Everything but the function bodies, without comments or string literals."""
    return _strip_literals(_strip_comments(_FUNC_RE.sub("", sql)))


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


SQL = _read(SQL_PATH)
FUNCS = _functions(SQL)
ROLLBACK = _read(ROLLBACK_PATH)
CHECKS = _read(CHECKS_PATH)
PREAPPLY = _read(PREAPPLY_PATH)
FOLLOWUPS = _read(FOLLOWUPS_PATH)


# =============================================================================
# Python model of the rules (mirrors the SQL; NULL = None)
# =============================================================================
UTC = timezone.utc
ET_NAME = "America/New_York"
ET = ZoneInfo(ET_NAME)
SIX_H = timedelta(hours=6)


def at(iso: str) -> datetime:
    """An aware instant from an ISO string with an explicit offset, in UTC."""
    dt = datetime.fromisoformat(iso)
    assert dt.tzinfo is not None, iso
    return dt.astimezone(UTC)


def d(iso: str) -> date:
    return date.fromisoformat(iso)


def _offset(text: str) -> timedelta:
    sign = -1 if text.startswith("-") else 1
    hh, mm = text.lstrip("+-").split(":")
    return sign * timedelta(hours=int(hh), minutes=int(mm))


def _log_tz_at(ts: datetime | None, log) -> str | None:
    """tz of the newest log row with effective_from <= ts (log = [(instant, tz), ...])."""
    if ts is None:
        return None
    hit = None
    for eff, tz in sorted(log):
        if eff <= ts:
            hit = tz
    return hit


def tz_log_resolve(ts, log):
    tz = _log_tz_at(ts, log)
    return (tz, "user_tz_log") if tz is not None else (ET_NAME, "default_et_fallback")


def _coalesce(a, b):
    return a if a is not None else b


def derive_onyx_dates(ts, tz_offset_text, tz_source_in, log, cycle_offset=None):
    """(et, behavioral, local, label) for an instant. cycle_offset(ts) -> '+HH:MM' | None
    stands in for pds.cycle_offset_for_instant (tier 2)."""
    if ts is None:
        return (None, None, None, None)
    et = ts.astimezone(ET).date()
    cyc = cycle_offset(ts) if cycle_offset else None
    if tz_offset_text:
        local = ts.astimezone(UTC).replace(tzinfo=None) + _offset(tz_offset_text)
        src = _coalesce(tz_source_in, "source_field")
    elif cyc:
        local = ts.astimezone(UTC).replace(tzinfo=None) + _offset(cyc)
        src = _coalesce(tz_source_in, "cycle_anchor")
    else:
        tz, label = tz_log_resolve(ts, log)
        local = ts.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
        src = _coalesce(tz_source_in, label)
    return (et, (local - SIX_H).date(), local.date(), src)


def end_of_et_day(day: date) -> datetime:
    """Last microsecond of the ET clock day (23 or 25 hours long on DST days)."""
    nxt = datetime.combine(day + timedelta(days=1), time(0), tzinfo=ET)
    return nxt.astimezone(UTC) - timedelta(microseconds=1)


def derive_onyx_dates_for_day(day, tz_source_in=None, log=()):
    if day is None:
        return (None, None, None, None)
    return (day, day, day, _coalesce(tz_source_in, tz_log_resolve(end_of_et_day(day), log)[1]))


def journal_entry_onyx_dates(entry_date, written_at, log=(), cycle_offset=None):
    realtime = False
    r = None
    if written_at is not None:
        r = derive_onyx_dates(written_at, None, None, log, cycle_offset)
        realtime = entry_date is not None and entry_date in (r[0], r[2], r[1])
    if not realtime:
        r = derive_onyx_dates_for_day(entry_date, None, log)
    return (r[0], entry_date, r[2], r[3])


def habit_dates(cycle_date, log=()):
    return derive_onyx_dates_for_day(cycle_date, None, log)


def garmin_hrv_dates(calendar_date, log=()):
    return derive_onyx_dates_for_day(calendar_date, "source_field", log)


def timed_or_day(day, instant, log=(), cycle_offset=None):
    """meal_events / supplement_intake: behavioral = the logged day; et/local/label from the
    instant when there is one."""
    r = (derive_onyx_dates(instant, None, None, log, cycle_offset) if instant is not None
         else derive_onyx_dates_for_day(day, None, log))
    return (r[0], day, r[2], r[3])


# --- the live rules this migration replaces (from the rollback file) -----------------------
def old_habit_dates(cycle_date, log=()):
    noon = datetime.combine(cycle_date, time(12), tzinfo=ET).astimezone(UTC)
    tz = _log_tz_at(noon, log)
    if tz is not None and tz != ET_NAME:
        return (cycle_date, cycle_date, noon.astimezone(ZoneInfo(tz)).date(), "user_tz_log")
    if tz == ET_NAME:
        return (cycle_date, cycle_date, cycle_date, "user_tz_log")
    return (cycle_date, cycle_date, cycle_date, "default_et_fallback")


def old_journal_dates(entry_date, written_at, log=(), cycle_offset=None):
    if written_at is not None and entry_date == written_at.astimezone(ET).date():
        r = derive_onyx_dates(written_at, None, None, log, cycle_offset)
        return (r[0], entry_date, r[2], r[3])
    return (entry_date, entry_date, entry_date, "default_et_fallback")


def old_garmin_hrv_dates(calendar_date, start_timestamp, log=(), cycle_offset=None):
    if start_timestamp is not None:
        return derive_onyx_dates(start_timestamp, None, None, log, cycle_offset)
    noon = datetime.combine(calendar_date, time(12), tzinfo=ET).astimezone(UTC)
    r = derive_onyx_dates(noon, None, "garmin_calendar_date", log, cycle_offset)
    return (r[0], r[1], calendar_date, "garmin_calendar_date")


# A made-up travel log (no real trip): home from an AFTERNOON first row, a Tokyo stay,
# home again, a Chicago week starting late on the fall-back day.
TRIP_LOG = [
    (at("2031-03-04T15:00:00-05:00"), "America/New_York"),
    (at("2031-04-10T16:00:00-04:00"), "Asia/Tokyo"),
    (at("2031-04-20T09:00:00+09:00"), "America/New_York"),
    (at("2031-11-02T23:30:00-05:00"), "America/Chicago"),
    (at("2031-11-10T00:30:00-06:00"), "America/New_York"),
]
NO_LOG: list = []


# =============================================================================
# 1. The migration file
# =============================================================================
class FileShape(unittest.TestCase):
    def test_no_drop_keyword_anywhere(self) -> None:
        # AGENTS.md: the Supabase MCP declines any migration whose text contains it,
        # comments included. The same goes for the rollback and the checks.
        for name, text in (("migration", SQL), ("rollback", ROLLBACK), ("checks", CHECKS),
                           ("preapply", PREAPPLY), ("followups", FOLLOWUPS)):
            self.assertIsNone(re.search(r"drop", text, re.I), name)

    def test_matrix_view_untouched(self) -> None:
        self.assertNotRegex(_strip_comments(SQL), r"(?i)create\s+(or\s+replace\s+)?(materialized\s+)?view")

    def test_every_call_site_is_redefined(self) -> None:
        for name in DATE_ONLY_SITES + NEW_HELPERS + REPLACED_LIVE:
            self.assertIn(name, FUNCS, name)

    def test_no_backfill_and_no_row_writes(self) -> None:
        # Future trigger runs only: no UPDATE / INSERT / row removal anywhere, and no
        # trigger (re)definition (the existing triggers keep their events).
        code = _strip_literals(_strip_comments(SQL))
        for kw in (r"\bUPDATE\s+pds\.", r"\bINSERT\s+INTO\b", r"\bDELETE\b", r"\bTRUNCATE\b",
                   r"\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b", r"\bALTER\b"):
            self.assertNotRegex(code, re.compile(kw, re.I), kw)

    def test_only_functions_and_comments_outside_bodies(self) -> None:
        rest = _outside_bodies(SQL)
        for stmt in [s.strip() for s in rest.split(";") if s.strip()]:
            self.assertRegex(stmt, r"^(CREATE OR REPLACE FUNCTION|COMMENT ON FUNCTION)",
                             stmt[:80])

    def test_frozen_whoop_journal_untouched(self) -> None:
        # Code only: the kept COMMENT text of derive_onyx_dates names whoop_journal.
        code = _strip_literals(_strip_comments(SQL))
        self.assertNotIn("whoop_journal", code)
        self.assertNotIn("whoop_cycles", code)
        self.assertNotIn("set_onyx_dates_whoop_journal", FUNCS)
        # The split-out parts live in the follow-up file, marked not applied.
        self.assertIn("set_onyx_dates_whoop_journal", _functions(FOLLOWUPS))
        self.assertIn("NOT applied", FOLLOWUPS)


class OnePlaceForFallbackLabels(unittest.TestCase):
    def test_labels_only_in_tz_log_resolve(self) -> None:
        for name, body in FUNCS.items():
            for label in FALLBACK_LABELS:
                if name == "tz_log_resolve":
                    self.assertIn(label, body)
                else:
                    self.assertNotIn(label, body, f"{name} writes {label} itself")

    def test_user_tz_log_read_only_in_tz_log_resolve(self) -> None:
        for name, body in FUNCS.items():
            if name != "tz_log_resolve":
                self.assertNotRegex(body, r"pds\.user_tz_log\b", name)

    def test_both_derivers_use_the_resolver(self) -> None:
        self.assertIn("pds.tz_log_resolve(ts)", FUNCS["derive_onyx_dates"])
        self.assertIn("pds.tz_log_resolve(", FUNCS["derive_onyx_dates_for_day"])

    def test_tz_source_in_still_overrides(self) -> None:
        self.assertIn("COALESCE(tz_source_in, resolved_source)", FUNCS["derive_onyx_dates"])
        self.assertIn("COALESCE(tz_source_in, r.tz_source)", FUNCS["derive_onyx_dates_for_day"])


def _norm(body: str) -> str:
    return re.sub(r"\s+", " ", _strip_comments(body)).strip()


class DeriveOnyxDatesUnchangedApartFromTier3And5(unittest.TestCase):
    """The refactor must not change tiers 1 and 2 or the tail (compared with the live body
    saved in the rollback file)."""

    def test_same_text_around_the_tier_3_block(self) -> None:
        old = _norm(_raw_bodies(ROLLBACK)["derive_onyx_dates"])
        new = _norm(_raw_bodies(SQL)["derive_onyx_dates"])
        old_head = old[old.index("BEGIN"):old.index("SELECT tz INTO log_tz")]
        new_head = new[new.index("BEGIN"):new.index("SELECT r.tz, r.tz_source")]
        self.assertEqual(old_head, new_head)
        tail = "local_instant := ts AT TIME ZONE resolved_tz;"
        self.assertEqual(old[old.index(tail):], new[new.index(tail):])


class DateOnlyRows(unittest.TestCase):
    def test_every_date_only_branch_uses_the_helper(self) -> None:
        for name in DATE_ONLY_SITES:
            self.assertIn("pds.derive_onyx_dates_for_day(", FUNCS[name], name)

    def test_journal_trigger_calls_the_helper(self) -> None:
        self.assertIn(
            "pds.journal_entry_onyx_dates(NEW.entry_date, NEW.notion_created_at)",
            FUNCS["set_onyx_dates_journal_entries"],
        )

    def test_no_noon_et_probe_or_log_zone_projection(self) -> None:
        for name, body in FUNCS.items():
            self.assertNotRegex(body, r"INTERVAL '12 hours'", name)
            self.assertNotRegex(body, r"AT TIME ZONE log_tz", name)

    def test_helper_keeps_the_date_and_reads_the_end_of_the_et_day(self) -> None:
        body = FUNCS["derive_onyx_dates_for_day"]
        self.assertRegex(body, r"SELECT\s+src_date,\s+src_date,\s+src_date,")
        self.assertIn("(src_date + 1)::timestamp AT TIME ZONE 'America/New_York'", body)
        self.assertIn("INTERVAL '1 microsecond'", body)


class GarminHrvWakeDay(unittest.TestCase):
    def test_keyed_by_calendar_date_with_a_d6_label(self) -> None:
        body = FUNCS["set_onyx_dates_garmin_hrv"]
        self.assertIn("pds.derive_onyx_dates_for_day(NEW.calendar_date, 'source_field')", body)
        self.assertNotIn("start_timestamp", body)
        self.assertNotIn("garmin_calendar_date", body)
        self.assertNotRegex(body, r"calendar_date\s*-\s*(1|INTERVAL)")

    def test_alignment_layer_still_owns_the_one_day_shift(self) -> None:
        # The reason the DB keeps the wake-up day: the analysis moves garmin_hrv_* itself.
        text = ALIGNMENT_PY.read_text(encoding="utf-8")
        m = re.search(r"^PREVIOUS_NIGHT_PREFIXES\s*=\s*\((.*?)\)", text, re.M)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).count('"garmin_hrv_"'), 1)

    def test_one_shift_end_to_end(self) -> None:
        # Trigger key + hrv_alignment.realign_matrix = the night is scored on the
        # behavioral day it closes (wake-up day - 1), exactly one day earlier.
        try:
            import pandas as pd
            sys.path.insert(0, str(ROOT))
            import hrv_alignment as al
        except ImportError as e:  # pragma: no cover - CI has pandas
            self.skipTest(f"pandas / hrv_alignment not importable: {e}")
        wake = d("2031-04-15")
        sleep_onset = at("2031-04-14T23:40:00+09:00")  # the night before the wake-up day

        def row_after_realign(key: date) -> str:
            days = [wake - timedelta(days=k) for k in (3, 2, 1, 0)] + [wake + timedelta(days=1)]
            df = pd.DataFrame({
                "calendar_date": [x.isoformat() for x in days],
                "garmin_hrv_last_night": [42.0 if x == key else None for x in days],
            })
            out = al.realign_matrix(df)
            hit = out.loc[out["garmin_hrv_last_night"].notna(), "calendar_date"].tolist()
            self.assertEqual(len(hit), 1)
            return hit[0]

        new_key = garmin_hrv_dates(wake, TRIP_LOG)[1]
        self.assertEqual(new_key, wake)
        self.assertEqual(row_after_realign(new_key), (wake - timedelta(days=1)).isoformat())
        # The removed live branch keyed a row with start_timestamp by the sleep onset; the
        # alignment layer would then move it a second day.
        old_key = old_garmin_hrv_dates(wake, sleep_onset, TRIP_LOG)[1]
        self.assertEqual(old_key, wake - timedelta(days=1))
        self.assertEqual(row_after_realign(old_key), (wake - timedelta(days=2)).isoformat())


class JournalEntriesBackdating(unittest.TestCase):
    def test_real_time_test_uses_derived_dates(self) -> None:
        body = FUNCS["journal_entry_onyx_dates"]
        self.assertRegex(
            body,
            r"p_entry_date IN \(d\.onyx_et_date, d\.onyx_local_date, d\.onyx_behavioral_date\)",
        )
        self.assertNotIn("AT TIME ZONE 'America/New_York')::date", body)
        self.assertRegex(body, r"RETURN QUERY SELECT d\.onyx_et_date, p_entry_date,")


# =============================================================================
# 2. Boundary cases on the model (synthetic)
# =============================================================================
class ModelDateOnly(unittest.TestCase):
    def test_date_only_keeps_the_date_everywhere(self) -> None:
        start = d("2031-03-01")
        for k in range(320):
            day = start + timedelta(days=k)
            for fn in (habit_dates, garmin_hrv_dates):
                r = fn(day, TRIP_LOG)
                self.assertEqual(r[:3], (day, day, day), (fn.__name__, day))

    def test_null_date(self) -> None:
        self.assertEqual(derive_onyx_dates_for_day(None, None, TRIP_LOG), (None,) * 4)
        self.assertEqual(derive_onyx_dates_for_day(None, "source_field", TRIP_LOG), (None,) * 4)

    def test_far_east_habit_row_no_longer_moves_a_day(self) -> None:
        day = d("2031-04-15")  # in Tokyo
        self.assertEqual(old_habit_dates(day, TRIP_LOG)[2], day + timedelta(days=1))
        self.assertEqual(habit_dates(day, TRIP_LOG), (day, day, day, "user_tz_log"))

    def test_same_day_landing_counts_for_the_label(self) -> None:
        # The first log row starts at 15:00 ET: the noon probe missed it.
        day = d("2031-03-04")
        self.assertEqual(old_habit_dates(day, TRIP_LOG)[3], "default_et_fallback")
        self.assertEqual(habit_dates(day, TRIP_LOG)[3], "user_tz_log")
        self.assertEqual(habit_dates(day - timedelta(days=1), TRIP_LOG)[3], "default_et_fallback")

    def test_end_of_day_spring_forward(self) -> None:
        # 2031-03-09 has 23 hours. A row at 00:30 EDT the next day must not count for it;
        # "midnight + 24 h" would reach 01:00 EDT and count it.
        log = [(at("2031-03-10T00:30:00-04:00"), "America/New_York")]
        self.assertEqual(derive_onyx_dates_for_day(d("2031-03-09"), None, log)[3], "default_et_fallback")
        self.assertEqual(derive_onyx_dates_for_day(d("2031-03-10"), None, log)[3], "user_tz_log")
        self.assertEqual(end_of_et_day(d("2031-03-09")),
                         at("2031-03-10T04:00:00+00:00") - timedelta(microseconds=1))

    def test_end_of_day_fall_back(self) -> None:
        # 2031-11-02 has 25 hours. A row at 23:30 EST that day counts for it; "midnight +
        # 24 h" would stop at 23:00 EST and miss it.
        day = d("2031-11-02")
        only = [(at("2031-11-02T23:30:00-05:00"), "America/Chicago")]
        self.assertEqual(derive_onyx_dates_for_day(day, None, only)[3], "user_tz_log")
        self.assertEqual(derive_onyx_dates_for_day(day - timedelta(days=1), None, only)[3],
                         "default_et_fallback")
        self.assertEqual(end_of_et_day(day), at("2031-11-03T05:00:00+00:00") - timedelta(microseconds=1))

    def test_label_override(self) -> None:
        self.assertEqual(derive_onyx_dates_for_day(d("2031-04-15"), "source_field", TRIP_LOG)[3],
                         "source_field")
        self.assertEqual(garmin_hrv_dates(d("2030-01-01"), NO_LOG)[3], "source_field")

    def test_label_without_any_log(self) -> None:
        self.assertEqual(habit_dates(d("2031-04-15"), NO_LOG)[3], "default_et_fallback")


class ModelInstants(unittest.TestCase):
    def test_awake_tail_boundary(self) -> None:
        for iso, beh in (("2031-06-16T00:30:00-04:00", "2031-06-15"),
                         ("2031-06-16T05:59:59-04:00", "2031-06-15"),
                         ("2031-06-16T06:00:00-04:00", "2031-06-16")):
            r = derive_onyx_dates(at(iso), None, None, NO_LOG)
            self.assertEqual(r, (d("2031-06-16"), d(beh), d("2031-06-16"), "default_et_fallback"), iso)

    def test_both_dst_transitions(self) -> None:
        cases = (
            # spring forward 2031-03-09: 02:00 EST -> 03:00 EDT
            ("2031-03-09T03:30:00-04:00", "2031-03-08"),
            ("2031-03-09T05:59:59-04:00", "2031-03-08"),
            ("2031-03-09T06:00:00-04:00", "2031-03-09"),
            # fall back 2031-11-02: 02:00 EDT -> 01:00 EST (01:30 happens twice)
            ("2031-11-02T01:30:00-04:00", "2031-11-01"),
            ("2031-11-02T01:30:00-05:00", "2031-11-01"),
            ("2031-11-02T05:59:59-05:00", "2031-11-01"),
            ("2031-11-02T06:00:00-05:00", "2031-11-02"),
        )
        for iso, beh in cases:
            ts = at(iso)
            r = derive_onyx_dates(ts, None, None, NO_LOG)
            self.assertEqual(r[1], d(beh), iso)
            self.assertEqual(r[0], r[2], iso)  # ET = local with no log row

    def test_far_east_and_far_west_source_offsets(self) -> None:
        r = derive_onyx_dates(at("2031-06-15T23:00:00+00:00"), "+09:00", None, NO_LOG)
        self.assertEqual(r, (d("2031-06-15"), d("2031-06-16"), d("2031-06-16"), "source_field"))
        r = derive_onyx_dates(at("2031-06-15T12:00:00+00:00"), "+13:00", None, NO_LOG)
        self.assertEqual(r, (d("2031-06-15"), d("2031-06-15"), d("2031-06-16"), "source_field"))
        r = derive_onyx_dates(at("2031-06-16T09:00:00+00:00"), "-10:00", None, NO_LOG)
        self.assertEqual(r, (d("2031-06-16"), d("2031-06-15"), d("2031-06-15"), "source_field"))

    def test_log_zone_and_cycle_anchor(self) -> None:
        ts = at("2031-04-15T08:00:00+09:00")  # in Tokyo per the log
        self.assertEqual(derive_onyx_dates(ts, None, None, TRIP_LOG),
                         (d("2031-04-14"), d("2031-04-15"), d("2031-04-15"), "user_tz_log"))
        # A WHOOP cycle offset (tier 2) wins over the log.
        self.assertEqual(derive_onyx_dates(ts, None, None, TRIP_LOG, lambda _t: "-04:00"),
                         (d("2031-04-14"), d("2031-04-14"), d("2031-04-14"), "cycle_anchor"))

    def test_timed_rows_keep_their_logged_day(self) -> None:
        # Retro-logged supplement dose: intake_time is "now", the day is the logged one.
        day = d("2031-04-12")
        r = timed_or_day(day, at("2031-04-18T12:00:00+09:00"), TRIP_LOG)
        self.assertEqual(r[1], day)
        self.assertEqual(r[0], d("2031-04-17"))
        # Backdated dose without a time: date-only, label from the log.
        self.assertEqual(timed_or_day(day, None, TRIP_LOG), (day, day, day, "user_tz_log"))


class ModelJournal(unittest.TestCase):
    def test_awake_tail_entry_is_real_time(self) -> None:
        entry, written = d("2031-06-15"), at("2031-06-16T00:30:00-04:00")
        self.assertEqual(old_journal_dates(entry, written, NO_LOG),
                         (entry, entry, entry, "default_et_fallback"))
        self.assertEqual(journal_entry_onyx_dates(entry, written, NO_LOG),
                         (d("2031-06-16"), entry, d("2031-06-16"), "default_et_fallback"))

    def test_next_morning_is_backdated(self) -> None:
        entry = d("2031-06-15")
        for iso in ("2031-06-16T06:00:00-04:00", "2031-06-16T09:00:00-04:00"):
            self.assertEqual(journal_entry_onyx_dates(entry, at(iso), NO_LOG),
                             (entry, entry, entry, "default_et_fallback"), iso)

    def test_far_east_real_time_entry(self) -> None:
        # 08:00 in Tokyo on the 15th is 19:00 ET on the 14th: the old ET-only check
        # called it backdated and dropped the instant's label.
        entry, written = d("2031-04-15"), at("2031-04-15T08:00:00+09:00")
        self.assertEqual(old_journal_dates(entry, written, TRIP_LOG),
                         (entry, entry, entry, "default_et_fallback"))
        self.assertEqual(journal_entry_onyx_dates(entry, written, TRIP_LOG),
                         (d("2031-04-14"), entry, entry, "user_tz_log"))

    def test_far_east_awake_tail_unchanged(self) -> None:
        entry, written = d("2031-04-15"), at("2031-04-16T01:30:00+09:00")
        expected = (d("2031-04-15"), entry, d("2031-04-16"), "user_tz_log")
        self.assertEqual(old_journal_dates(entry, written, TRIP_LOG), expected)
        self.assertEqual(journal_entry_onyx_dates(entry, written, TRIP_LOG), expected)

    def test_west_of_et_late_evening_entry(self) -> None:
        # 23:30 in Chicago on the 5th is 00:30 ET on the 6th.
        entry, written = d("2031-11-05"), at("2031-11-05T23:30:00-06:00")
        self.assertEqual(old_journal_dates(entry, written, TRIP_LOG)[3], "default_et_fallback")
        self.assertEqual(journal_entry_onyx_dates(entry, written, TRIP_LOG),
                         (d("2031-11-06"), entry, entry, "user_tz_log"))

    def test_backdated_and_forward_dated(self) -> None:
        written = at("2031-04-18T12:00:00+09:00")
        for entry in (d("2031-04-12"), d("2031-04-25")):
            self.assertEqual(journal_entry_onyx_dates(entry, written, TRIP_LOG),
                             (entry, entry, entry, "user_tz_log"), entry)

    def test_no_written_at(self) -> None:
        entry = d("2031-04-15")
        self.assertEqual(journal_entry_onyx_dates(entry, None, TRIP_LOG),
                         (entry, entry, entry, "user_tz_log"))

    def test_behavioral_is_always_entry_date(self) -> None:
        # The HRV pipeline groups journal entries by entry_date; the trigger must agree.
        base = at("2031-03-08T00:00:00-05:00")
        for h in range(0, 24 * 250, 7):
            written = base + timedelta(hours=h)
            for lag in (-1, 0, 1, 2):
                entry = written.astimezone(ET).date() - timedelta(days=lag)
                self.assertEqual(journal_entry_onyx_dates(entry, written, TRIP_LOG)[1], entry)

    def test_travel_check_entries(self) -> None:
        # The post-deploy journal_travel_* checks: for an instant abroad, entry = local date
        # and entry = local behavioral date are real time; entry = local date - 3 never is
        # (it is never the ET, local or behavioral date of the instant), so it is date-only.
        base = at("2031-06-01T00:00:00+00:00")
        for off_h in range(-12, 15):
            off = f"{'-' if off_h < 0 else '+'}{abs(off_h):02d}:00"

            def cyc(_ts, o=off):  # tier 2 resolves every instant to this offset
                return o

            for h in range(0, 48):
                ts = base + timedelta(hours=h)
                local = ts.replace(tzinfo=None) + _offset(off)
                et, loc, beh = ts.astimezone(ET).date(), local.date(), (local - SIX_H).date()
                self.assertEqual(journal_entry_onyx_dates(loc, ts, NO_LOG, cyc),
                                 (et, loc, loc, "cycle_anchor"), (off, h))
                self.assertEqual(journal_entry_onyx_dates(beh, ts, NO_LOG, cyc),
                                 (et, beh, loc, "cycle_anchor"), (off, h))
                back = loc - timedelta(days=3)
                self.assertNotIn(back, (et, loc, beh))
                self.assertEqual(journal_entry_onyx_dates(back, ts, NO_LOG, cyc),
                                 (back, back, back, "default_et_fallback"), (off, h))

    def test_real_time_dates_come_from_the_instant(self) -> None:
        base = at("2031-03-08T00:00:00-05:00")
        for h in range(0, 24 * 250, 5):
            written = base + timedelta(hours=h)
            inst = derive_onyx_dates(written, None, None, TRIP_LOG)
            for entry in {inst[0], inst[1], inst[2]}:
                r = journal_entry_onyx_dates(entry, written, TRIP_LOG)
                self.assertEqual((r[0], r[2], r[3]), (inst[0], inst[2], inst[3]))


# =============================================================================
# 3. The rollback file and the post-deploy checks agree with the migration
# =============================================================================
class RollbackFile(unittest.TestCase):
    def test_holds_every_replaced_function(self) -> None:
        bodies = _raw_bodies(ROLLBACK)
        self.assertEqual(set(bodies), set(REPLACED_LIVE))

    def test_bodies_match_their_recorded_hashes(self) -> None:
        # Each header line records md5(prosrc) of the live body saved below it.
        recorded = dict(re.findall(r"^-- (\w+)\s+body md5 ([0-9a-f]{32})$", ROLLBACK, re.M))
        bodies = _raw_bodies(ROLLBACK)
        self.assertEqual(set(recorded), set(bodies))
        for name, body in bodies.items():
            self.assertEqual(hashlib.md5(body.encode("utf-8")).hexdigest(), recorded[name], name)

    def test_restores_the_old_rules_and_calls_no_new_helper(self) -> None:
        bodies = _functions(ROLLBACK)
        for name, body in bodies.items():
            for helper in NEW_HELPERS:
                self.assertNotIn(f"pds.{helper}(", body, name)
        self.assertIn("'garmin_calendar_date'", bodies["set_onyx_dates_garmin_hrv"])
        self.assertIn("noon_et", bodies["set_onyx_dates_habit_journal"])

    def test_writes_no_rows(self) -> None:
        rest = _outside_bodies(ROLLBACK)
        for stmt in [s.strip() for s in rest.split(";") if s.strip()]:
            self.assertRegex(stmt, r"^(CREATE OR REPLACE FUNCTION|COMMENT ON FUNCTION)", stmt[:80])


def _values_rows(cte: str) -> list[list[object]]:
    """Parse the VALUES rows of one CTE in the checks file into Python values."""
    m = re.search(rf"\n{cte} \([^)]*\) AS \(VALUES\n(.*?)\n\)", CHECKS, re.S)
    assert m, cte
    rows = []
    for line in m.group(1).splitlines():
        line = line.strip().rstrip(",")
        assert line.startswith("(") and line.endswith(")"), line
        items = re.findall(r"(DATE '[^']*'|TIMESTAMPTZ '[^']*'|NULL(?:::\w+)?|'[^']*'(?:::\w+)?)",
                           line[1:-1])
        vals: list[object] = []
        for tok in items:
            if tok.startswith("NULL"):
                vals.append(None)
            elif tok.startswith("DATE "):
                vals.append(date.fromisoformat(tok[6:-1]))
            elif tok.startswith("TIMESTAMPTZ "):
                vals.append(datetime.fromisoformat(tok[13:-1]).astimezone(UTC))
            else:
                vals.append(tok.split("'")[1])
        rows.append(vals)
    return rows


class PostDeployChecks(unittest.TestCase):
    def test_select_only(self) -> None:
        code = _strip_comments(CHECKS).strip()
        self.assertTrue(code.startswith("WITH"))
        self.assertEqual(code.count(";"), 1)
        for kw in (r"\bUPDATE\b", r"\bINSERT\b", r"\bDELETE\b", r"\bCREATE\b", r"\bALTER\b",
                   r"\bGRANT\b", r"\bTRUNCATE\b"):
            self.assertNotRegex(code, re.compile(kw, re.I), kw)

    def test_synthetic_inputs_predate_any_real_row(self) -> None:
        # The fixed expectations rely on 1990 having no log row and no WHOOP cycle; the
        # query checks that precondition itself.
        self.assertIn("effective_from < TIMESTAMPTZ '1991-01-01 00:00+00'", CHECKS)
        for cte in ("day_cases", "inst_cases", "journal_cases"):
            for row in _values_rows(cte):
                for v in row[1:]:
                    if isinstance(v, (date, datetime)):
                        self.assertEqual(v.year, 1990, (cte, row[0]))

    def test_day_expectations_match_the_model(self) -> None:
        rows = _values_rows("day_cases")
        self.assertGreaterEqual(len(rows), 5)
        for name, day, src_in, *expected in rows:
            self.assertEqual(derive_onyx_dates_for_day(day, src_in, NO_LOG), tuple(expected), name)

    def test_instant_expectations_match_the_model(self) -> None:
        rows = _values_rows("inst_cases")
        names = {r[0] for r in rows}
        for needed in ("inst_awake_tail_0030", "inst_dst_spring_0330_edt", "inst_dst_fall_0130_est",
                       "inst_far_east_plus09", "inst_far_west_minus10", "inst_null"):
            self.assertIn(needed, names)
        for name, ts, off, src_in, *expected in rows:
            self.assertEqual(derive_onyx_dates(ts, off, src_in, NO_LOG), tuple(expected), name)

    def test_journal_expectations_match_the_model(self) -> None:
        rows = _values_rows("journal_cases")
        names = {r[0] for r in rows}
        for needed in ("journal_awake_tail_0030", "journal_next_morning_backdated",
                       "journal_backdated_days", "journal_dst_spring_awake_tail",
                       "journal_dst_fall_awake_tail", "journal_no_written_at"):
            self.assertIn(needed, names)
        for name, entry, written, *expected in rows:
            self.assertEqual(journal_entry_onyx_dates(entry, written, NO_LOG), tuple(expected), name)

    def test_body_hashes_match_the_migration(self) -> None:
        # If this fails after editing the migration, put the new md5 of that function's
        # body (the text between the $function$ quotes) into the checks file.
        recorded = dict(re.findall(r"\('(\w+)', '([0-9a-f]{32})'\)",
                                   CHECKS[CHECKS.index("bodies (fname"):CHECKS.index("untouched (fname")]))
        bodies = _raw_bodies(SQL)
        self.assertEqual(set(recorded), set(bodies))
        for name, body in bodies.items():
            self.assertEqual(hashlib.md5(body.encode("utf-8")).hexdigest(), recorded[name], name)

    def test_untouched_list_is_not_redefined(self) -> None:
        block = CHECKS[CHECKS.index("untouched (fname"):CHECKS.index("bindings (tbl")]
        untouched = set(re.findall(r"\('(\w+)', '[0-9a-f]{32}'\)", block))
        self.assertIn("set_onyx_dates_whoop_journal", untouched)
        self.assertIn("block_whoop_journal_archive_writes", untouched)
        self.assertIn("block_frozen_whoop_era_writes", untouched)
        self.assertFalse(untouched & set(FUNCS))

    def test_every_replaced_trigger_function_is_bound(self) -> None:
        block = CHECKS[CHECKS.index("bindings (tbl"):CHECKS.index("live_body AS")]
        bound = set(re.findall(r"'(set_onyx_dates_\w+)'\)", block))
        self.assertEqual({n for n in REPLACED_LIVE if n.startswith("set_onyx_dates_")} - bound, set())


def _baseline_predicates(text: str) -> dict[str, str]:
    """check name -> the NOT EXISTS (...) predicate of each baseline row, whitespace-normalised."""
    code = _strip_comments(text)
    out: dict[str, str] = {}
    for m in re.finditer(r"SELECT '(\w+)', 'baseline',", code):
        i = code.index("NOT EXISTS (", m.end())
        depth, k = 0, i + len("NOT EXISTS ")
        while True:
            if code[k] == "(":
                depth += 1
            elif code[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        out[m.group(1)] = re.sub(r"\s+", " ", code[i:k + 1])
    return out


class PreApplyCounts(unittest.TestCase):
    CODE = _strip_comments(PREAPPLY).strip()

    def test_select_only(self) -> None:
        self.assertTrue(self.CODE.startswith("WITH"))
        self.assertEqual(self.CODE.count(";"), 1)
        for kw in (r"\bUPDATE\b", r"\bINSERT\b", r"\bDELETE\b", r"\bCREATE\b", r"\bALTER\b",
                   r"\bGRANT\b", r"\bTRUNCATE\b"):
            self.assertNotRegex(self.CODE, re.compile(kw, re.I), kw)

    def test_runs_before_the_migration(self) -> None:
        # It must work on the current database, so it may not call a function the
        # migration adds.
        for helper in NEW_HELPERS:
            self.assertNotIn(f"pds.{helper}(", self.CODE, helper)

    def test_covers_every_date_only_table(self) -> None:
        for table in ("garmin_hrv", "habit_journal", "journal_entries", "supplement_intake",
                      "meal_events", "cronometer_servings"):
            self.assertIn(f"pds.{table}", self.CODE, table)

    def test_inline_rules_match_the_migration(self) -> None:
        # Day label at the last instant of the ET day, as derive_onyx_dates_for_day reads it.
        self.assertIn("+ 1)::timestamp AT TIME ZONE 'America/New_York')", self.CODE)
        self.assertIn("INTERVAL '1 microsecond'", self.CODE)
        self.assertIn("INTERVAL '1 microsecond'", FUNCS["derive_onyx_dates_for_day"])
        # The journal real-time test, as in journal_entry_onyx_dates.
        self.assertIn("pds.derive_onyx_dates(je.notion_created_at, NULL, NULL)", self.CODE)
        self.assertIn("je.entry_date IN (i.onyx_et_date, i.onyx_local_date, i.onyx_behavioral_date)",
                      self.CODE)
        self.assertIn("p_entry_date IN (d.onyx_et_date, d.onyx_local_date, d.onyx_behavioral_date)",
                      FUNCS["journal_entry_onyx_dates"])
        # garmin_hrv: calendar_date + 'source_field', as the new trigger.
        self.assertIn("'source_field'", self.CODE)
        self.assertIn("derive_onyx_dates_for_day(NEW.calendar_date, 'source_field')",
                      FUNCS["set_onyx_dates_garmin_hrv"])

    def test_frozen_whoop_era_not_counted(self) -> None:
        self.assertIn("WHERE NOT (h.source = 'whoop' AND h.cycle_date <= DATE '2026-06-08')", self.CODE)
        self.assertNotIn("whoop_journal", self.CODE)

    def test_gate_column_on_every_impact_row(self) -> None:
        impacts = re.findall(r"SELECT '(\w+)'(?: \|\| t\.tbl)?, 'impact',", self.CODE)
        self.assertGreaterEqual(len(impacts), 5)
        self.assertIn("outside_intended", self.CODE)

    def test_baseline_predicates_identical_in_both_files(self) -> None:
        pre, post = _baseline_predicates(PREAPPLY), _baseline_predicates(CHECKS)
        self.assertGreaterEqual(len(pre), 3)
        self.assertEqual(pre, post)


class PostDeployKinds(unittest.TestCase):
    def test_every_check_has_a_gated_kind(self) -> None:
        code = _strip_comments(CHECKS)
        kinds = set(re.findall(r"^\s+SELECT [^\n]*?, '(\w+)',\s*$", code, re.M))
        self.assertEqual(kinds, {"definition", "synthetic", "live_context", "rederived", "baseline"})
        self.assertNotIn("'data'", CHECKS)

    def test_journal_travel_uses_the_helper_zone_lookup(self) -> None:
        # Two arguments: the helper resolves the zone itself (WHOOP cycle, then user_tz_log).
        self.assertIn("pds.journal_entry_onyx_dates(e.entry_date, c.ts)", CHECKS)
        self.assertIn("pds.cycle_offset_for_instant(c.start_time + make_interval(hours => g.k))"
                      " = c.timezone_offset", CHECKS)
        self.assertIn("pds.cycle_offset_for_instant(u.effective_from + make_interval(hours => g.k))"
                      " IS NULL", CHECKS)
        self.assertIn("(VALUES ('cycle_anchor'), ('user_tz_log')) AS tr (tier)", CHECKS)

    def test_rederived_compares_with_both_rules(self) -> None:
        self.assertIn("pds.journal_entry_onyx_dates(je.entry_date, je.notion_created_at)", CHECKS)
        self.assertIn("WHERE je.archived IS NOT TRUE", CHECKS)
        self.assertIn("(je.notion_created_at AT TIME ZONE 'America/New_York')::date", CHECKS)


# =============================================================================
# 4. The split-out WHOOP follow-ups keep their staged fixes (not applied)
# =============================================================================
class WhoopFollowups(unittest.TestCase):
    F = _functions(FOLLOWUPS)

    def test_whoop_journal_no_dead_coalesce_and_local_is_cycle_date(self) -> None:
        body = self.F["set_onyx_dates_whoop_journal"]
        self.assertNotIn("COALESCE(NEW.behaviors_date", body)
        self.assertIn("NEW.onyx_behavioral_date := NEW.behaviors_date", body)
        self.assertIn("NEW.onyx_local_date := NEW.cycle_date", body)

    def test_before_trigger_skips_its_own_row(self) -> None:
        self.assertIn("cycle_id <> NEW.cycle_id", self.F["set_whoop_cycles_transition_flag"])

    def test_after_trigger_covers_moved_and_removed_rows(self) -> None:
        body = self.F["refresh_next_transition_day"]
        self.assertIn("TG_OP = 'DELETE'", body)
        self.assertIn("OLD.start_time IS DISTINCT FROM NEW.start_time", body)
        self.assertIn("pg_trigger_depth() > 1", body)
        self.assertRegex(
            _strip_comments(FOLLOWUPS),
            r"CREATE OR REPLACE TRIGGER whoop_cycles_refresh_next_transition_day\s+"
            r"AFTER INSERT OR UPDATE OF timezone_offset, start_time OR DELETE",
        )

    def test_refresh_writes_only_the_flag(self) -> None:
        # A write to start_time / timezone_offset would re-fire the triggers (the old O(N^2)).
        for name in ("refresh_next_transition_day", "recompute_whoop_transition_flags"):
            sets = re.findall(r"\bSET\s+(\w+)\s*=", self.F[name])
            self.assertEqual(sets, ["onyx_is_transition_day"], name)

    def test_repair_function_is_not_public(self) -> None:
        self.assertIn(
            "REVOKE ALL ON FUNCTION pds.recompute_whoop_transition_flags() FROM PUBLIC, anon, authenticated;",
            FOLLOWUPS,
        )


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
