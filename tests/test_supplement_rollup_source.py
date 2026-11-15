"""hrv_analysis.fetch_supplement_rollup: matview first, live view as the fallback.

sql/db_perf_2026_11.sql adds pds.supplement_intake_by_compound_mat (a 1:1 copy of
the live view, refreshed within ~5 minutes of a supplement write). The pipeline
reads it when it exists and falls back to the live view when it does not (not
applied yet) or errors. Both hold the same rows, so the fallback must return the
view's rows unchanged and never fail the run.

Synthetic data only. No network, no credentials.

Run: python tests/test_supplement_rollup_source.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pandas as pd  # noqa: E402

import hrv_analysis as h  # noqa: E402

SELECT = "calendar_date,ingredient_group,categories,unit,total_amount"
ROWS = pd.DataFrame([
    {"calendar_date": "2026-11-13", "ingredient_group": "Magnesium", "categories": ["mineral"],
     "unit": "mg", "total_amount": 200},
])


class _ApiError(Exception):
    def __init__(self, code):
        super().__init__(f"{code}: relation not found")
        self.code = code


def _fake_fetch(available: dict, calls: list):
    def fetch(table, select="*", **_kw):
        calls.append((table, select))
        result = available[table]
        if isinstance(result, Exception):
            raise result
        return result
    return fetch


def test_reads_matview_when_present():
    calls = []
    fetch = _fake_fetch({h.SUPPLEMENT_ROLLUP_MAT: ROWS, h.SUPPLEMENT_ROLLUP_VIEW: AssertionError("view read")}, calls)
    out = h.fetch_supplement_rollup(SELECT, fetch=fetch)
    assert out.equals(ROWS)
    assert calls == [(h.SUPPLEMENT_ROLLUP_MAT, SELECT)]


def test_falls_back_when_matview_missing():
    for code in ("PGRST205", "42P01"):
        calls = []
        fetch = _fake_fetch({h.SUPPLEMENT_ROLLUP_MAT: _ApiError(code), h.SUPPLEMENT_ROLLUP_VIEW: ROWS}, calls)
        out = h.fetch_supplement_rollup(SELECT, fetch=fetch)
        assert out.equals(ROWS)
        assert calls == [(h.SUPPLEMENT_ROLLUP_MAT, SELECT), (h.SUPPLEMENT_ROLLUP_VIEW, SELECT)]


def test_falls_back_on_any_other_matview_error():
    calls = []
    fetch = _fake_fetch({h.SUPPLEMENT_ROLLUP_MAT: RuntimeError("timeout"), h.SUPPLEMENT_ROLLUP_VIEW: ROWS}, calls)
    assert h.fetch_supplement_rollup(SELECT, fetch=fetch).equals(ROWS)
    assert [t for t, _ in calls] == [h.SUPPLEMENT_ROLLUP_MAT, h.SUPPLEMENT_ROLLUP_VIEW]


def test_view_error_still_raises():
    """If the live view fails too, the run fails as it did before (no silent empty frame)."""
    calls = []
    fetch = _fake_fetch({h.SUPPLEMENT_ROLLUP_MAT: _ApiError("PGRST205"),
                         h.SUPPLEMENT_ROLLUP_VIEW: RuntimeError("view down")}, calls)
    try:
        h.fetch_supplement_rollup(SELECT, fetch=fetch)
    except RuntimeError as e:
        assert "view down" in str(e)
    else:
        raise AssertionError("expected the live-view error to propagate")


def test_loader_uses_the_rollup_helper():
    src = Path(h.__file__).read_text(encoding="utf-8")
    assert 'data["supplements"] = fetch_supplement_rollup(' in src
    assert 'fetch_all(\n        "supplement_intake_by_compound"' not in src


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
