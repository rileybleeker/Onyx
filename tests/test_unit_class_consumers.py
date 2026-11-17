"""Static checks for sql/unit_class_consumers_2026_11.sql (no database).

The migration re-creates two views whose mass totals previously summed
pds.supplement_intake_by_compound.total_amount by ingredient group without
looking at unit_class. total_amount is milligrams only when unit_class =
'mass'; any other unit_class is a raw literal unit (IU, mL, Calorie) and was
being added into a mass total.

These tests read the migration file and the two history files it replaces and
check, purely as text:
  1. every mass-based sum filters unit_class = 'mass';
  2. the melatonin WHERE keeps the parenthesized (UNII OR name) match so a
     non-mass row neither adds to the dose nor makes the day look dosed;
  3. each view's output column list and order are byte-identical to the old
     definition, and the conversion factors are unchanged;
  4. the file contains no destructive statement (the Supabase MCP refuses
     them) and states that Riley must apply it and the matview refresh
     function must be checked.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEW = ROOT / "sql" / "unit_class_consumers_2026_11.sql"
MELATONIN_OLD = ROOT / "sql" / "melatonin_unified.sql"
MICRO_OLD = ROOT / "sql" / "db_perf_2026_11.sql"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _view_body(text: str, view: str) -> str:
    """Text of one CREATE OR REPLACE VIEW statement (up to the next ; at line end)."""
    m = re.search(
        r"CREATE OR REPLACE VIEW " + re.escape(view) + r" AS\b(.*)",
        text,
        re.DOTALL,
    )
    assert m, f"view {view} not found"
    return m.group(1)


def _outer_select(body: str, start_marker: str, end_marker: str) -> str:
    i = body.index(start_marker)
    j = body.index(end_marker, i)
    return body[i:j]


def _aliases(select_text: str):
    return re.findall(r"AS ([a-z0-9_]+)\b", select_text)


def _sum_filters(cte_text: str):
    """(full sum text, has unit_class='mass') per FILTER sum in the CTE.

    The clause is matched up to ') AS <alias>'; nested parens inside the
    FILTER (the B5 ARRAY literal) make a non-greedy stop at the first ')'
    wrong, but they never precede ') AS'.
    """
    out = []
    for m in re.finditer(
        r"sum\((.+?)\) FILTER \(WHERE (.+?)\) AS (\w+)", cte_text, re.DOTALL
    ):
        out.append((m.group(0), "unit_class = 'mass'" in m.group(2)))
    return out


class MelatoninViewTest(unittest.TestCase):
    def setUp(self):
        self.new = _view_body(_read(NEW), "pds.melatonin_unified")
        self.old = _view_body(_read(MELATONIN_OLD), "pds.melatonin_unified")

    def test_dose_sum_filters_mass(self):
        cte = self.new[self.new.index("s AS (") :]
        self.assertIn("SUM(total_amount) AS dose_mg", cte)
        # The s CTE has a plain WHERE, not FILTER: both the compound match and
        # the unit_class condition must be in it.
        where = re.search(r"WHERE (.+?)\n    GROUP BY", cte, re.DOTALL).group(1)
        self.assertIn(
            "(unii_code = 'JL5DK93RCL' OR ingredient_group ILIKE 'melatonin')",
            where,
        )
        self.assertIn("unit_class = 'mass'", where)
        # A non-mass-only day must not look dosed: the WHERE (not FILTER)
        # means the s CTE produces no row for it, so the FULL OUTER JOIN falls
        # back to the journal answer and source_flag stays 'journal'. That is
        # covered structurally: dose_mg comes only from this CTE.

    def test_match_keeps_unii_or_name_grouping(self):
        # The compound match must stay parenthesized so unit_class applies to
        # both branches (AND binds tighter than OR otherwise).
        self.assertIn(
            "WHERE (unii_code = 'JL5DK93RCL' OR ingredient_group ILIKE 'melatonin')",
            self.new,
        )
        self.assertIn("AND unit_class = 'mass'", self.new)

    def test_columns_unchanged(self):
        # Same columns, same order: the final SELECT's aliases must match the
        # applied history definition exactly.
        def outer(body):
            return _outer_select(body, "COALESCE(j.calendar_date", "FROM j")

        self.assertEqual(_aliases(outer(self.old)), _aliases(outer(self.new)))
        self.assertEqual(
            _aliases(outer(self.old)),
            ["calendar_date", "melatonin_present", "melatonin_dose_mg", "source_flag"],
        )


class MicronutrientViewTest(unittest.TestCase):
    def setUp(self):
        self.new = _view_body(_read(NEW), "pds.daily_micronutrient_totals")
        self.old = _view_body(_read(MICRO_OLD), "pds.daily_micronutrient_totals")
        # The supp CTE: from "WITH supp AS (" to the outer SELECT marker.
        self.new_cte = self.new[: self.new.index("SELECT COALESCE(cn.onyx_behavioral_date")]
        self.old_cte = self.old[: self.old.index("SELECT COALESCE(cn.onyx_behavioral_date")]

    def test_every_mass_sum_filters_unit_class(self):
        sums = _sum_filters(self.new_cte)
        self.assertEqual(len(sums), 25, "expected 25 supplement sums (vitamins A-K, B1-B12, folate, 10 minerals, omega-3/EPA/DHA)")
        for clause, has_mass in sums:
            self.assertTrue(has_mass, f"sum without unit_class filter: {clause[:80]}")

    def test_old_sums_had_no_unit_class_filter(self):
        # Guards the test itself: the history file is the un-fixed definition.
        for _, has_mass in _sum_filters(self.old_cte):
            self.assertFalse(has_mass)

    def test_conversion_factors_unchanged(self):
        for token in ("* 1000::numeric", "* 40000::numeric", "/ 1000.0"):
            self.assertEqual(
                self.old_cte.count(token),
                self.new_cte.count(token),
                f"conversion factor count changed for {token}",
            )

    def test_still_reads_matview(self):
        self.assertIn("pds.supplement_intake_by_compound_mat", self.new_cte)

    def test_columns_unchanged(self):
        def outer(body):
            return _outer_select(
                body, "SELECT COALESCE(cn.onyx_behavioral_date", "ORDER BY"
            )

        self.assertEqual(_aliases(outer(self.old)), _aliases(outer(self.new)))
        self.assertEqual(len(_aliases(outer(self.new))), 76)


class MigrationFileTest(unittest.TestCase):
    def setUp(self):
        self.text = _read(NEW)

    def test_no_destructive_statements(self):
        lowered = self.text.lower()
        self.assertNotRegex(lowered, r"\bdrop\b")
        self.assertNotRegex(lowered, r"\btruncate\b")
        self.assertNotRegex(lowered, r"\bdelete\b")
        self.assertNotRegex(lowered, r"\balter\b")

    def test_header_states_riley_must_apply_and_matview_check(self):
        self.assertIn("MUST BE APPLIED BY RILEY", self.text)
        self.assertIn("refresh_supplement_intake_by_compound_mat", self.text)


if __name__ == "__main__":
    unittest.main()
