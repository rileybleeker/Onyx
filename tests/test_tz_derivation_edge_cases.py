"""TZ derivation edge cases + one place for fallback labeling (offline, reads the SQL text).

Roadmap row "TZ derivation edge-cases + centralize fallback labeling" (2026-11-14).
sql/tz_derivation_edge_cases.sql moves every "no instant, only a date" branch of the
onyx-date triggers onto pds.derive_onyx_dates_for_day, and makes pds.tz_log_resolve the
only code that decides the 'user_tz_log' / 'default_et_fallback' labels. These checks keep
it that way, and pin the fixes so a later edit cannot quietly undo them:

  * no trigger body hand-rolls a noon-ET probe or projects a date through a log zone
    (that pushed onyx_local_date a day forward on far-east trips);
  * the two fallback labels are written in exactly one function;
  * garmin_hrv stays keyed by Garmin's wake-up calendar_date with a D6 label, because
    hrv_alignment.py re-keys garmin_hrv_* one day earlier (PREVIOUS_NIGHT_PREFIXES);
  * journal_entries accepts the ET, local or behavioral date of notion_created_at;
  * whoop_journal: no dead COALESCE, local date = cycle_date;
  * the transition-flag triggers cover moved and removed cycles without a cascade;
  * the file stays sendable through the Supabase MCP (no DROP anywhere, AGENTS.md) and does
    not touch the behavioral matrix view (that needs a matview rebuild).

Synthetic only: no database, no network, no credentials.

Run: python tests/test_tz_derivation_edge_cases.py
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "sql" / "tz_derivation_edge_cases.sql"
ALIGNMENT_PY = ROOT / "hrv_alignment.py"

DATE_ONLY_SITES = (
    "set_onyx_dates_habit_journal",
    "set_onyx_dates_whoop_journal",
    "set_onyx_dates_journal_entries",
    "set_onyx_dates_meal_events",
    "set_onyx_dates_supplement_intake",
    "set_onyx_dates_cronometer_servings",
    "set_onyx_dates_garmin_hrv",
)
FALLBACK_LABELS = ("'user_tz_log'", "'default_et_fallback'")


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _functions(sql: str) -> dict[str, str]:
    """name -> body (between the $function$ quotes), comments removed."""
    out: dict[str, str] = {}
    pattern = re.compile(
        r"CREATE OR REPLACE FUNCTION pds\.(\w+)\s*\(.*?\$function\$(.*?)\$function\$",
        re.S,
    )
    for name, body in pattern.findall(sql):
        assert name not in out, f"{name} is defined twice in {SQL_PATH.name}"
        out[name] = _strip_comments(body)
    return out


SQL = SQL_PATH.read_text(encoding="utf-8")
FUNCS = _functions(SQL)


class FileShape(unittest.TestCase):
    def test_no_drop_keyword_anywhere(self) -> None:
        # AGENTS.md: the Supabase MCP declines any migration whose text contains it,
        # comments included.
        self.assertIsNone(re.search(r"drop", SQL, re.I))

    def test_matrix_view_untouched(self) -> None:
        code = _strip_comments(SQL)
        self.assertNotRegex(code, r"(?i)create\s+(or\s+replace\s+)?(materialized\s+)?view")

    def test_every_call_site_is_redefined(self) -> None:
        for name in DATE_ONLY_SITES + (
            "tz_log_resolve",
            "derive_onyx_dates_for_day",
            "derive_onyx_dates",
            "set_whoop_cycles_transition_flag",
            "refresh_next_transition_day",
            "recompute_whoop_transition_flags",
        ):
            self.assertIn(name, FUNCS, name)


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


class DateOnlyRows(unittest.TestCase):
    def test_every_date_only_branch_uses_the_helper(self) -> None:
        for name in DATE_ONLY_SITES:
            self.assertIn("pds.derive_onyx_dates_for_day(", FUNCS[name], name)

    def test_no_noon_et_probe_or_log_zone_projection(self) -> None:
        for name, body in FUNCS.items():
            self.assertNotRegex(body, r"::timestamp\s*\+\s*INTERVAL '12 hours'", name)
            self.assertNotRegex(body, r"calendar_date\s*\+\s*INTERVAL '12 hours'", name)
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
        self.assertIn('"garmin_hrv_"', m.group(1))


class JournalEntriesBackdating(unittest.TestCase):
    def test_real_time_test_uses_derived_dates(self) -> None:
        body = FUNCS["set_onyx_dates_journal_entries"]
        self.assertRegex(
            body,
            r"NEW\.entry_date IN \(d\.onyx_et_date, d\.onyx_local_date, d\.onyx_behavioral_date\)",
        )
        self.assertNotIn("AT TIME ZONE 'America/New_York')::date", body)
        self.assertIn("NEW.onyx_behavioral_date := NEW.entry_date", body)


class WhoopJournal(unittest.TestCase):
    def test_no_dead_coalesce_and_local_is_cycle_date(self) -> None:
        body = FUNCS["set_onyx_dates_whoop_journal"]
        self.assertNotIn("COALESCE(NEW.behaviors_date", body)
        self.assertIn("NEW.onyx_behavioral_date := NEW.behaviors_date", body)
        self.assertIn("NEW.onyx_local_date := NEW.cycle_date", body)


class TransitionFlag(unittest.TestCase):
    def test_before_trigger_skips_its_own_row(self) -> None:
        self.assertIn("cycle_id <> NEW.cycle_id", FUNCS["set_whoop_cycles_transition_flag"])

    def test_after_trigger_covers_moved_and_removed_rows(self) -> None:
        body = FUNCS["refresh_next_transition_day"]
        self.assertIn("TG_OP = 'DELETE'", body)
        self.assertIn("OLD.start_time IS DISTINCT FROM NEW.start_time", body)
        self.assertIn("pg_trigger_depth() > 1", body)
        self.assertRegex(
            _strip_comments(SQL),
            r"CREATE OR REPLACE TRIGGER whoop_cycles_refresh_next_transition_day\s+"
            r"AFTER INSERT OR UPDATE OF timezone_offset, start_time OR DELETE",
        )

    def test_refresh_writes_only_the_flag(self) -> None:
        # A write to start_time / timezone_offset would re-fire the triggers (the old O(N^2)).
        for name in ("refresh_next_transition_day", "recompute_whoop_transition_flags"):
            sets = re.findall(r"\bSET\s+(\w+)\s*=", FUNCS[name])
            self.assertEqual(sets, ["onyx_is_transition_day"], name)

    def test_repair_function_is_not_public(self) -> None:
        self.assertIn(
            "REVOKE ALL ON FUNCTION pds.recompute_whoop_transition_flags() FROM PUBLIC, anon, authenticated;",
            SQL,
        )


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
