"""Supplement dose-response keeps one unit class per compound (HIST-UNIT-01).

pds.supplement_intake_by_compound has one row per (day, compound, unit_class): 'mass' is every
mass unit converted to mg (Vitamin A / D / E IU with the vitamin's own factor), any other class is
the literal label unit. hrv_analysis.supplement_dose_response_rows must never add amounts of two
classes, must leave out (not zero-fill) a day whose total is unknown, must keep the literal unit of
an unconverted series, must keep unquantified intakes apart from unknown-unit ones, and must record
IU provenance. A compound in one class gives exactly the numbers of the pre-change code.

Synthetic data only: invented compound names, dates and amounts. No network, no credentials.

Run: python tests/test_supplement_dose_units.py
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

import hrv_analysis as h  # noqa: E402

N_DAYS = 40
DATES = pd.date_range("2030-01-01", periods=N_DAYS).strftime("%Y-%m-%d").tolist()
_rng = np.random.default_rng(11)
TRACKED = pd.DataFrame({"calendar_date": DATES, "y": _rng.normal(60, 8, N_DAYS)})
DOSES = [100.0, 200.0, 300.0]


def row(day, group, amount, unit_class="mass", unit=None, source_units=None, category="mineral"):
    if unit is None:
        unit = "mg" if unit_class == "mass" else unit_class
    if source_units is None:
        source_units = ["mg"] if unit_class == "mass" else [unit_class if unit_class != "unitless" else None]
    return {"calendar_date": DATES[day], "ingredient_group": group, "unit_class": unit_class, "unit": unit,
            "source_units": source_units, "total_amount": amount, "category": category}


def mass_series(group="Synthetic Mineral", days=range(N_DAYS), **kw):
    return [row(d, group, DOSES[d % 3], **kw) for d in days]


def frame(rows):
    return pd.DataFrame(rows)


def expected_spearman(amount_by_day: dict, keep_days):
    """Spearman on the given days, a missing day = 0 (no intake)."""
    sub = TRACKED[TRACKED["calendar_date"].isin([DATES[d] for d in keep_days])]
    amounts = [amount_by_day.get(d, 0.0) for d in sub["calendar_date"]]
    res = stats.spearmanr(sub["y"], amounts)
    return float(res.statistic if hasattr(res, "statistic") else res[0]), len(sub)


def old_dose_response(supp: pd.DataFrame, tracked: pd.DataFrame, target: str) -> list[dict]:
    """The pre-HIST-UNIT-01 loop, copied for the compatibility check (sums every row of a group)."""
    out = []
    supp = supp.dropna(subset=["ingredient_group", "calendar_date", "total_amount"])
    for compound, comp_rows in supp.groupby("ingredient_group"):
        distinct_doses = comp_rows["total_amount"].dropna().unique()
        if len(distinct_doses) < 3:
            continue
        amt_by_date = comp_rows.groupby("calendar_date")["total_amount"].sum()
        merged = tracked.merge(amt_by_date.rename("amount").reset_index(), on="calendar_date", how="left")
        merged["amount"] = merged["amount"].fillna(0.0)
        if merged["amount"].nunique() < 3 or len(merged) < 20:
            continue
        res = stats.spearmanr(merged[target], merged["amount"])
        unit = comp_rows["unit"].dropna().iloc[0]
        out.append({"compound": str(compound), "unit": unit,
                    "spearman_r": float(res.statistic if hasattr(res, "statistic") else res[0]),
                    "p_value": float(res.pvalue if hasattr(res, "pvalue") else res[1]),
                    "n": int(len(merged)), "n_distinct_doses": int(len(distinct_doses))})
    return out


def only(rows, compound):
    found = [r for r in rows if r["compound"] == compound]
    assert len(found) == 1, f"one row for {compound}: {found}"
    return found[0]


def test_mg_and_ml_siblings_never_add_up():
    mass = mass_series()
    ml = [row(d, "Synthetic Mineral", 5.0, unit_class="mL") for d in range(5)]
    rows, coverage = h.supplement_dose_response_rows(frame(mass + ml), TRACKED, "y")
    r = only(rows, "Synthetic Mineral")
    assert r["unit"] == "mg" and r["unit_class"] == "mass" and r["converted"] is True
    assert r["excluded_units"] == ["mL"]
    assert r["excluded_days"] == {"other_unit": 5, "unquantified": 0}
    # The five mL days have an unknown mg total: left out, neither summed (105 / 205 / 305) nor read as 0.
    by_day = {DATES[d]: DOSES[d % 3] for d in range(N_DAYS)}
    rho, n = expected_spearman(by_day, range(5, N_DAYS))
    assert r["n"] == n == N_DAYS - 5
    assert abs(r["spearman_r"] - rho) < 1e-12
    assert coverage["analyzed"] == 1 and coverage["with_excluded_days"] == 1 and coverage["excluded"] == []


def test_row_order_and_a_new_source_do_not_change_the_unit():
    mass = mass_series()
    before, _ = h.supplement_dose_response_rows(frame(mass), TRACKED, "y")
    assert only(before, "Synthetic Mineral")["unit"] == "mg"
    # A later product of the same compound in mL, listed first: the estimate stays in mg and says what it left out.
    ml = [row(d, "Synthetic Mineral", float(d + 1), unit_class="mL") for d in range(30, 34)]
    after, _ = h.supplement_dose_response_rows(frame(ml + mass), TRACKED, "y")
    r = only(after, "Synthetic Mineral")
    assert r["unit"] == "mg" and r["excluded_units"] == ["mL"]
    shuffled, _ = h.supplement_dose_response_rows(frame(mass + ml).sample(frac=1, random_state=3), TRACKED, "y")
    assert shuffled == after


def test_single_literal_unit_keeps_its_unit_and_is_marked_unconverted():
    ml = [row(d, "Synthetic Tincture", [1.0, 2.0, 3.0][d % 3], unit_class="mL") for d in range(N_DAYS)]
    rows, _ = h.supplement_dose_response_rows(frame(ml), TRACKED, "y")
    r = only(rows, "Synthetic Tincture")
    assert r["unit"] == "mL" and r["unit_class"] == "mL"
    assert r["converted"] is False and r["converted_from_iu"] is False
    assert r["source_units"] == ["mL"]


def test_unknown_unit_only_is_excluded_with_coverage():
    unitless = [row(d, "Synthetic Blend", [1.0, 2.0, 3.0][d % 3], unit_class="unitless", unit="unitless")
                for d in range(N_DAYS)]
    rows, coverage = h.supplement_dose_response_rows(frame(unitless), TRACKED, "y")
    assert rows == []
    assert coverage["excluded"] == [{"compound": "Synthetic Blend", "reason": "unknown_unit",
                                     "unit_classes": ["unitless"], "n_days": N_DAYS}]


def test_two_literal_units_without_mass_are_excluded():
    ml = [row(d, "Synthetic Extract", 2.0 + d % 3, unit_class="mL") for d in range(0, N_DAYS, 2)]
    caps = [row(d, "Synthetic Extract", 1.0 + d % 3, unit_class="capsule") for d in range(1, N_DAYS, 2)]
    rows, coverage = h.supplement_dose_response_rows(frame(ml + caps), TRACKED, "y")
    assert rows == []
    (entry,) = coverage["excluded"]
    assert entry["reason"] == "mixed_unconverted_units"
    assert entry["unit_classes"] == ["capsule", "mL"]
    assert entry["n_days"] == N_DAYS


def test_unquantified_days_are_kept_apart_from_unknown_units():
    mass = mass_series()
    unquantified = [row(d, "Synthetic Mineral", None) for d in (10, 11)]
    unitless = [row(d, "Synthetic Mineral", 4.0, unit_class="unitless", unit="unitless") for d in (20, 21, 22)]
    rows, _ = h.supplement_dose_response_rows(frame(mass + unquantified + unitless), TRACKED, "y")
    r = only(rows, "Synthetic Mineral")
    assert r["excluded_days"] == {"other_unit": 3, "unquantified": 2}
    assert r["excluded_units"] == ["unitless"]
    assert r["n"] == N_DAYS - 5
    # A compound logged only without an amount gets no estimate and its own reason.
    rows2, coverage = h.supplement_dose_response_rows(
        frame([row(d, "Synthetic Herb", None) for d in range(6)]), TRACKED, "y")
    assert rows2 == []
    assert coverage["excluded"][0]["reason"] == "unquantified"
    assert coverage["excluded"][0]["unit_classes"] == []


def test_mapped_iu_records_provenance_and_unmapped_iu_stays_apart():
    vit = [row(d, "Synthetic Vitamin D", DOSES[d % 3] / 1000, source_units=["IU"] if d % 2 else ["mcg"],
               category="vitamin") for d in range(N_DAYS)]
    rows, _ = h.supplement_dose_response_rows(frame(vit), TRACKED, "y")
    r = only(rows, "Synthetic Vitamin D")
    assert r["unit"] == "mg" and r["converted_from_iu"] is True
    assert r["source_units"] == ["IU", "mcg"]
    # IU the view could not map stays its own class: never added to the mg series.
    oil = mass_series("Synthetic Oil") + [row(d, "Synthetic Oil", 1000.0, unit_class="IU") for d in (3, 4)]
    rows, _ = h.supplement_dose_response_rows(frame(oil), TRACKED, "y")
    r = only(rows, "Synthetic Oil")
    assert r["excluded_units"] == ["IU"] and r["converted_from_iu"] is False
    assert r["excluded_days"]["other_unit"] == 2


def test_frame_without_unit_class_column_is_read_from_unit():
    mass = mass_series()
    ml = [row(d, "Synthetic Mineral", 5.0, unit_class="mL") for d in range(5)]
    with_cls, _ = h.supplement_dose_response_rows(frame(mass + ml), TRACKED, "y")
    without, _ = h.supplement_dose_response_rows(frame(mass + ml).drop(columns=["unit_class"]), TRACKED, "y")
    assert with_cls == without
    no_sources, _ = h.supplement_dose_response_rows(
        frame(mass).drop(columns=["unit_class", "source_units"]), TRACKED, "y")
    assert only(no_sources, "Synthetic Mineral")["source_units"] == []


def test_single_class_compound_matches_the_previous_code():
    supp = frame(mass_series("Synthetic Mineral") + mass_series("Synthetic Amino", category="amino_acid")
                 + [row(d, "Synthetic Tincture", [1.0, 2.0, 3.0][d % 3], unit_class="mL") for d in range(N_DAYS)])
    new, _ = h.supplement_dose_response_rows(supp, TRACKED, "y")
    old = old_dose_response(supp, TRACKED, "y")
    assert len(new) == len(old) == 3
    for o in old:
        n = only(new, o["compound"])
        for key in ("unit", "spearman_r", "p_value", "n", "n_distinct_doses"):
            assert n[key] == o[key], (o["compound"], key, n[key], o[key])


def test_run_statistical_analysis_calls_the_unit_rule():
    """run_statistical_analysis(skip=False) also draws plots, so the call site is checked in the source:
    the dose-response comes from supplement_dose_response_rows and its coverage is kept for storage."""
    src = Path(h.__file__).read_text(encoding="utf-8")
    body = src[src.index("def run_statistical_analysis("):src.index("# --- Nutrition Spearman correlation ---")]
    assert re.search(r"supplement_dose_response_rows\(\s*supplements, tracked, STAT_TARGET\)", body)
    assert 'results["supplement_dose_response_coverage"] = dose_coverage' in body
    assert 'supp.groupby("ingredient_group")' in body  # the Yes/No block only (taken / not taken)
    assert body.count('supp.groupby("ingredient_group")') == 1, "the dose-response no longer groups by name alone"


class _FakeTable:
    def __init__(self, sink):
        self.sink = sink

    def upsert(self, row, on_conflict=None):
        self.sink.append((row, on_conflict))
        return self

    def execute(self):
        return None


class _FakeSupa:
    def __init__(self):
        self.upserts = []

    def schema(self, _name):
        return self

    def from_(self, _table):
        return _FakeTable(self.upserts)


def test_coverage_is_stored_next_to_the_dose_response():
    fake = _FakeSupa()
    real = h.supa
    h.supa = fake
    try:
        cov = {"version": 1, "analyzed": 0, "excluded": [{"compound": "Synthetic Blend", "reason": "unknown_unit",
                                                          "unit_classes": ["unitless"], "n_days": 3}]}
        h.store_analysis_results({"supplement_dose_response": [], "supplement_dose_response_coverage": cov}, {})
    finally:
        h.supa = real
    stored = {(r["result_type"], r["result_key"]): r for r, _ in fake.upserts}
    assert ("supplement_impact", "dose_response") in stored
    got = stored[("supplement_impact", "dose_response_coverage")]
    assert got["result_json"] == cov
    assert all(conflict == "result_type,result_key" for _, conflict in fake.upserts)


def test_loader_reads_unit_class_and_source_units():
    src = Path(h.__file__).read_text(encoding="utf-8")
    assert 'select="calendar_date,ingredient_group,categories,unit,unit_class,source_units,total_amount"' in src


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
