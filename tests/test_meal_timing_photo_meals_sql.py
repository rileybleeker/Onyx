"""Sanity checks for sql/meal_timing_from_photo_meals.sql (text only, no DB).

The file must stay additive: no DROP statements (the Supabase MCP migration
connector declines destructive SQL, and the repo rule forbids it), and it must
actually build on pds.photo_meals.
"""
from pathlib import Path

SQL = Path(__file__).resolve().parent.parent / "sql" / "meal_timing_from_photo_meals.sql"


def test_file_exists_and_reads_photo_meals():
    text = SQL.read_text(encoding="utf-8")
    assert "pds.photo_meals" in text, "view must aggregate pds.photo_meals"
    assert "CREATE OR REPLACE VIEW pds.meal_timing_from_photo_meals" in text


def test_no_drop_statements():
    text = SQL.read_text(encoding="utf-8").upper()
    assert "DROP " not in text, "additive SQL: no DROP statements allowed"


def test_documents_matview_rule_and_priority():
    text = SQL.read_text(encoding="utf-8")
    assert "daily_health_matrix_behavioral_mat" in text, (
        "must document the matview drop+recreate rule for a later matrix migration"
    )
    assert "COALESCE" in text, "must state the Cronometer > meal_events > photo priority"
