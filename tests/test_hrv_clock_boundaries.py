"""Exercise the actual alignment clock helper without importing optional ML packages."""
import ast
from datetime import date, datetime, timedelta
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

source = ast.parse((Path(__file__).resolve().parents[1] / "hrv_alignment.py").read_text())
clock_nodes = [node for node in source.body if (
    isinstance(node, ast.FunctionDef) and node.name == "behavioral_today"
) or (
    isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {"ET", "BEHAVIORAL_DAY_OFFSET"} for t in node.targets)
)]
namespace = {"datetime": datetime, "date": date, "timedelta": timedelta, "ZoneInfo": ZoneInfo}
exec(compile(ast.Module(body=clock_nodes, type_ignores=[]), "hrv_alignment.py", "exec"), namespace)

class ClockBoundaries(unittest.TestCase):
    def test_et_clock_boundaries(self):
        for instant, expected in [
            ("2026-11-01T05:59:59-05:00", "2026-10-31"),
            ("2026-11-01T06:00:00-05:00", "2026-11-01"),
            ("2026-03-08T05:59:59-04:00", "2026-03-07"),
            ("2026-03-08T06:00:00-04:00", "2026-03-08"),
            ("2026-11-11T00:30:00+00:00", "2026-11-10"),
            ("2027-01-01T05:30:00+00:00", "2026-12-31"),
        ]:
            with self.subTest(instant=instant):
                self.assertEqual(str(namespace["behavioral_today"](datetime.fromisoformat(instant))), expected)

if __name__ == "__main__":
    unittest.main()
