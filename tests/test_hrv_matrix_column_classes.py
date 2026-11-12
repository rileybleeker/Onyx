"""Every matrix column measured from a sleep must be classed as same-sleep (offline).

hrv_alignment.py decides which matrix columns the forecast may use (`forecast_can_use`)
and which ones are other measurements of the outcome night (`OUTCOME_TWINS`, left out of
the published driver ranking). It decides by name, so a new or oddly named column can slip
through. That happened (dot's review, 2026-11-11, findings 1 and 2):

* `garmin_light_sleep_sec` and `garmin_awake_sec` come from the Garmin sleep row of the
  outcome night but match none of the same-sleep prefixes, so the forecast trained on them
  (train/serve leakage: they are unknown on the evening the forecast is made).
* `garmin_hrv_factor` (Garmin training status) matches the `garmin_hrv_` prefix, so
  `realign_matrix` moves it onto the outcome night like the other Garmin HRV columns, but it
  was not in OUTCOME_TWINS, so it could rank as an HRV "driver".

This test reads the column aliases straight from the matrix view SQL, so it covers every
column the view selects from a sleep or recovery table, not a hand-picked list.

Run: python tests/test_hrv_matrix_column_classes.py
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hrv_alignment as al  # noqa: E402

MATRIX_SQL = [
    ROOT / "sql" / "adr_0001_08_daily_health_matrix_behavioral.sql",
    ROOT / "sql" / "daily_health_matrix_behavioral_main_session.sql",
]

# Table aliases in the matrix view whose columns all describe the outcome sleep of row D
# (after realign_matrix): Garmin sleep, Garmin HRV, WHOOP recovery, WHOOP sleep, Eight Sleep.
SLEEP_TABLE_ALIASES = ("gs", "ghrv", "wr", "ws", "es")

ALIAS_RE = re.compile(r"\b([a-z_]+)\.[a-z0-9_]+\s+AS\s+([a-z0-9_]+)", re.IGNORECASE)


def aliases_from(table_aliases):
    found = {}
    for path in MATRIX_SQL:
        for tbl, col in ALIAS_RE.findall(path.read_text()):
            if tbl in table_aliases:
                found.setdefault(col, f"{path.name} {tbl}.")
    return found


class MatrixColumnClasses(unittest.TestCase):
    def test_sql_parsing_finds_the_sleep_columns(self):
        cols = aliases_from(SLEEP_TABLE_ALIASES)
        # Sanity: the parser sees the view; if the SQL moves, fail loudly instead of passing.
        for known in ("garmin_sleep_score", "garmin_hrv_last_night", "whoop_recovery_score",
                      "whoop_sleep_duration_milli", "eight_sleep_hrv", al.TARGET):
            self.assertIn(known, cols)

    def test_every_sleep_column_is_same_sleep_and_not_a_forecast_input(self):
        cols = aliases_from(SLEEP_TABLE_ALIASES)
        leaks = sorted(c for c in cols if al.forecast_can_use(c) or not al.is_same_sleep(c))
        self.assertEqual(leaks, [], "outcome-night columns the forecast may use: "
                         + ", ".join(f"{c} ({cols[c]})" for c in leaks))

    def test_rekeyed_garmin_hrv_columns_are_outcome_twins_or_same_sleep(self):
        # Everything realign_matrix moves onto the outcome night is a measurement of it.
        moved = [c for c in aliases_from(("gs", "ghrv", "gts", "wr", "ws", "es", "gds"))
                 if c.startswith(al.PREVIOUS_NIGHT_PREFIXES)]
        self.assertIn("garmin_hrv_factor", moved)
        for c in moved:
            with self.subTest(col=c):
                self.assertFalse(al.forecast_can_use(c))
        self.assertIn("garmin_hrv_factor", al.OUTCOME_TWINS)

    def test_lags_of_sleep_columns_stay_usable(self):
        # The fix must not take away earlier nights: a lag of a same-sleep column is known.
        for c in ("garmin_light_sleep_sec_lag1", "garmin_awake_sec_lag1"):
            with self.subTest(col=c):
                self.assertTrue(al.forecast_can_use(c))


if __name__ == "__main__":
    unittest.main()
