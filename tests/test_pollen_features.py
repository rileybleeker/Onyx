"""Pollen: the HRV-pipeline merge (hrv_analysis.merge_pollen_features) + wiring.

Covers
  * row placement: the count published on count_date P lands on matrix row P - 1
    (the count describes the 24 h before that morning), never on P or P - 2;
  * ordinal levels: low/medium/high/extreme -> 0..3, case-insensitive; a missing
    level, an unrecognised word or a numeric stays NaN;
  * missing is missing: days with no published row stay NaN, never zero; a
    published 0 is a real 0;
  * fail-open: None / empty / malformed frames return the matrix untouched;
  * wiring: NOT_FORECAST_PREFIXES (yes), CONTROLLABLE_FEATURE_PREFIXES (no),
    labels, the causal treatment registration.

Synthetic data only. No network, no credentials.

Run: python tests/test_pollen_features.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import causal_inference as ci  # noqa: E402
import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402


def _matrix():
    days = pd.date_range("2026-04-01", "2026-04-07").strftime("%Y-%m-%d")
    return pd.DataFrame({"calendar_date": days, "whoop_hrv_rmssd": np.arange(7.0)})


def _pollen():
    def row(published, total, tree=None, grass=None, weed=None, mold=None):
        return {"count_date": published, "total_count": total, "tree_level": tree,
                "grass_level": grass, "weed_level": weed, "mold_level": mold}
    return pd.DataFrame([
        row("2026-04-02", 120, tree="high", grass="low", weed="low", mold="medium"),
        row("2026-04-03", 300, tree="extreme", grass="low", weed="low", mold="low"),
        row("2026-04-05", 0, tree="low", grass=None, weed="low", mold="low"),   # published 0 is real
        row("2026-04-06", 40, tree="Low", grass="medium", weed="none", mold="low"),
        row("2026-04-10", 999, tree="low"),                                     # outside the matrix
    ])


def test_published_date_moves_one_day_earlier():
    out = h.merge_pollen_features(_matrix(), _pollen())
    by = out.set_index("calendar_date")
    assert len(out) == 7
    # the count published on P describes day P - 1: it sits on row P - 1, not P or P - 2
    assert by.loc["2026-04-01", "pollen_total"] == 120
    assert by.loc["2026-04-02", "pollen_total"] == 300
    assert by.loc["2026-04-04", "pollen_total"] == 0, "a published 0 is a real 0"
    assert by.loc["2026-04-05", "pollen_total"] == 40
    # nothing on the published day itself: 04-03 has no count published for it
    assert np.isnan(by.loc["2026-04-03", "pollen_total"])
    assert np.isnan(by.loc["2026-04-06", "pollen_total"])
    # nothing else on the matrix moved
    assert out["whoop_hrv_rmssd"].tolist() == _matrix()["whoop_hrv_rmssd"].tolist()


def test_level_ordinals():
    out = h.merge_pollen_features(_matrix(), _pollen())
    by = out.set_index("calendar_date")
    assert by.loc["2026-04-01", "pollen_tree_level_ord"] == 2.0, "high -> 2"
    assert by.loc["2026-04-02", "pollen_tree_level_ord"] == 3.0, "extreme -> 3"
    assert by.loc["2026-04-05", "pollen_tree_level_ord"] == 0.0, "case-insensitive"
    assert by.loc["2026-04-01", "pollen_mold_level_ord"] == 1.0, "medium -> 1"
    # a missing level and a word outside the vocabulary are unknown, never a number
    assert np.isnan(by.loc["2026-04-04", "pollen_grass_level_ord"]), "None level stays NaN"
    assert np.isnan(by.loc["2026-04-05", "pollen_weed_level_ord"]), "'none' is not a level word"
    # days with no published row have no ordinal either
    for day in ("2026-04-03", "2026-04-06", "2026-04-07"):
        assert np.isnan(by.loc[day, "pollen_tree_level_ord"])


def test_missing_days_stay_nan_never_zero():
    out = h.merge_pollen_features(_matrix(), _pollen())
    by = out.set_index("calendar_date")
    # 2026-04-03 and 06/07 have no published count for the day before: unknown, not 0
    for day in ("2026-04-03", "2026-04-06", "2026-04-07"):
        assert np.isnan(by.loc[day, "pollen_total"])
    levels = [c for c in h.POLLEN_COLS if c != "pollen_total"]
    for day in ("2026-04-06", "2026-04-07"):
        assert all(np.isnan(by.loc[day, c]) for c in levels)
    # the only real 0 in the frame is the published one
    assert (out["pollen_total"].fillna(-1) == 0).sum() == 1


def test_merge_is_idempotent_and_handles_duplicates_and_date_types():
    pollen = _pollen()
    pollen = pd.concat([pollen, pollen.iloc[[0]]], ignore_index=True)      # duplicate day
    pollen["count_date"] = pd.to_datetime(pollen["count_date"])           # datetime not text
    once = h.merge_pollen_features(_matrix(), pollen)
    twice = h.merge_pollen_features(once, pollen)
    assert len(once) == 7 and once.equals(twice)
    assert once.loc[once["calendar_date"] == "2026-04-01", "pollen_total"].iloc[0] == 120


def test_numeric_strings_from_postgrest_are_coerced():
    pollen = _pollen().astype({"total_count": str})
    out = h.merge_pollen_features(_matrix(), pollen)
    assert out.set_index("calendar_date").loc["2026-04-01", "pollen_total"] == 120.0
    assert out.set_index("calendar_date").loc["2026-04-04", "pollen_total"] == 0.0


def test_fail_open():
    m = _matrix()
    assert h.merge_pollen_features(m, None) is m
    assert h.merge_pollen_features(m, pd.DataFrame()) is m
    bad = pd.DataFrame([{"count_date": "2026-04-02"}])                    # columns missing
    out = h.merge_pollen_features(m, bad)
    assert out.equals(m)
    assert not any(c.startswith("pollen_") for c in out.columns)
    undated = pd.DataFrame([{"count_date": None, "total_count": 5}])      # undatable row only
    assert h.merge_pollen_features(m, undated).equals(m)


def test_alignment_and_forecast_rules():
    for col in h.POLLEN_COLS:
        assert not al.is_same_sleep(col), "pre-sleep exposure, not measured from the outcome sleep"
        assert col not in al.NEEDS_SLEEP_ONSET
        assert col.startswith(h.NOT_FORECAST_PREFIXES), f"{col} would reach the forecast with a NaN newest row"
    assert "pollen_" in h.NOT_FORECAST_PREFIXES
    assert "pollen_" not in h.CONTROLLABLE_FEATURE_PREFIXES, "nothing Riley does changes the pollen"
    for col in h.POLLEN_COLS:
        assert col in h.FEATURE_LABELS


def test_causal_treatment_registered_as_exploratory_behavior_family():
    match = next((c, f) for c, f, *_ in ci.CONTINUOUS_TREATMENTS if c == "pollen_total")
    assert match == ("pollen_total", "behavior")
    df = pd.DataFrame({"pollen_total": [1.0, 2.0], "hrv_lag1": [50.0, 51.0]})
    specs = {s.name: s for s in ci._enumerate_continuous_treatments(df)}
    assert specs["pollen_total"].kind == "continuous_median_split"
    assert specs["pollen_total"].unit == "grains/m³"
    assert "pollen_total" not in {s.name for s in ci._enumerate_continuous_treatments(pd.DataFrame({"hrv_lag1": [1.0]}))}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
