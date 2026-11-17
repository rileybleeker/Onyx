"""Supplement dose-response keeps one unit class per compound (HIST-UNIT-01).

pds.supplement_intake_by_compound has one row per (day, compound, unit_class): 'mass' is every
mass unit converted to mg (Vitamin A / D / E IU with the vitamin's own factor), any other class is
the literal label unit. hrv_analysis.supplement_dose_response_rows must never add amounts of two
classes, must leave out (not zero-fill) a day whose total is unknown, must keep the literal unit of
an unconverted series, must keep unquantified intakes apart from unknown-unit ones, and must record
IU provenance. A compound in one class gives exactly the numbers of the pre-change code.

The rollup view filters out ingredients without a readable quantity, so those intakes are read from
the intakes + products (load_supplement_unquantified); the loader tests below build the rollup the
way the view does and run the whole path. A run that leaves no estimate stores an empty list, so a
previous run's rows never stay on the dashboard: also when the rollup itself is empty (a read of
nothing but amountless intakes), where the coverage still lists those compounds. When the
amountless-intake check cannot be read nothing is published at all (the stored rows of the last
complete run stay) and the run warns, so a failed read never turns into days read as 0.

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
EMPTY_CHECKED = pd.DataFrame(columns=["calendar_date", "ingredient_group"])  # a check that found nothing


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
    the dose-response decision (empty rollup, failed amountless-intake check) is made by
    supplement_dose_response_block, which has its own tests below; the call site must run it for every
    rollup (not only a non-empty one), merge what it returns and pass its warning on, and main() passes
    the loader's amountless-intake days in and turns the warning into the heartbeat."""
    src = Path(h.__file__).read_text(encoding="utf-8")
    body = src[src.index("def run_statistical_analysis("):src.index("# --- Nutrition Spearman correlation ---")]
    assert re.search(r"supplement_dose_response_block\(\s*supplements, hrv_valid, STAT_TARGET,\s*"
                     r"supplements_unquantified\)", body)
    assert "results.update(dose)" in body
    assert "results[SUPPLEMENT_DOSE_WARNING_KEY] = dose_warning" in body
    assert "supplements.empty" not in body[body.index("# --- Supplement dose-response"):]
    main = src[src.index("stat_results = run_statistical_analysis("):]
    assert 'supplements_unquantified=data.get("supplements_unquantified")' in main[:400]
    assert "stat_results.get(SUPPLEMENT_DOSE_WARNING_KEY)" in main[:900]
    assert "run_warning = " in main[:900]
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
    loader = src[src.index("def load_all_data("):src.index("def load_all_data(") + 20000]
    assert 'data["supplements_unquantified"] = load_supplement_unquantified()' in loader


# --- Intakes without a readable amount, from the loader through the analysis -----------------------

PRODUCTS = pd.DataFrame([
    {"product_id": "synthetic_a", "ingredients": [
        {"name": "Synthetic Mineral Salt", "ingredient_group": "Synthetic Mineral", "quantity": "100",
         "unit": "mg", "category": "mineral"},
        {"name": "Synthetic Filler", "ingredient_group": None, "quantity": None, "unit": None}]},
    # A blend that names the mineral without an amount: the view drops this ingredient row.
    {"product_id": "synthetic_b", "ingredients": [
        {"name": "Synthetic Mineral Blend", "ingredient_group": "Synthetic Mineral", "quantity": None,
         "unit": "mg", "category": "mineral"},
        {"name": "Synthetic Herb", "ingredient_group": "Synthetic Herb", "quantity": "proprietary",
         "unit": None, "category": "botanical"}]},
])
B_DAYS = (10, 11, 35)            # 10 and 11 with a quantified sibling the same day, 35 alone
A_DAYS = [d for d in range(N_DAYS) if d not in (35, 36, 37)]


def intakes_frame():
    rows = [{"intake_id": i, "intake_date": DATES[d], "product_id": "synthetic_a", "doses": d % 3 + 1}
            for i, d in enumerate(A_DAYS)]
    rows += [{"intake_id": 1000 + d, "intake_date": DATES[d], "product_id": "synthetic_b", "doses": 1}
             for d in B_DAYS]
    return pd.DataFrame(rows)


def view_rollup(products: pd.DataFrame, intakes: pd.DataFrame) -> pd.DataFrame:
    """pds.supplement_intake_by_compound for mg ingredients only: quantity must read as digits and
    dots, anything else is filtered out (sql/supplement_iu_conversion.sql)."""
    by_pid = dict(zip(products["product_id"], products["ingredients"]))
    acc: dict = {}
    for _, i in intakes.iterrows():
        for ing in by_pid[i["product_id"]]:
            q = ing.get("quantity")
            if not (isinstance(q, str) and q and all(ch in "0123456789." for ch in q)):
                continue
            key = (i["intake_date"], ing["ingredient_group"])
            acc[key] = acc.get(key, 0.0) + float(q) * i["doses"]
    return pd.DataFrame([{"calendar_date": d, "ingredient_group": g, "unit_class": "mass", "unit": "mg",
                          "source_units": ["mg"], "total_amount": a, "category": "mineral"}
                         for (d, g), a in sorted(acc.items())])


class _FakeFetch:
    def __init__(self, tables, fail=None):
        self.tables, self.fail, self.calls = tables, fail, []

    def __call__(self, table, select="*", order=None, **_):
        self.calls.append((table, select, order))
        if table == self.fail:
            raise RuntimeError("synthetic failure")
        frame_ = self.tables[table]
        return frame_[select.split(",")].copy() if not frame_.empty else pd.DataFrame()


def test_quantity_rule_matches_the_view_filter():
    for q in ("100", "0.5", "0", 100, 0.5, 0):
        assert h._supplement_quantity_readable(q), q
    for q in (None, "", "blend", "1,000", "-1", True, -1, float("nan"), float("inf"), ["100"]):
        assert not h._supplement_quantity_readable(q), q


def test_loader_finds_intakes_the_view_filters_out():
    fetch = _FakeFetch({"supplement_products": PRODUCTS, "supplement_intake": intakes_frame()})
    days = h.load_supplement_unquantified(fetch)
    assert [c[0] for c in fetch.calls] == ["supplement_products", "supplement_intake"]
    assert fetch.calls[1][2] == "intake_id"  # paged in a fixed order
    got = set(zip(days["calendar_date"], days["ingredient_group"]))
    assert got == {(DATES[d], g) for d in B_DAYS for g in ("Synthetic Mineral", "Synthetic Herb")}
    # A null ingredient_group is not a dose-response compound (the analysis drops it too).
    assert days["ingredient_group"].notna().all()


def test_loader_skips_the_intake_read_when_every_amount_is_readable():
    products = pd.DataFrame([{"product_id": "synthetic_a", "ingredients": [PRODUCTS["ingredients"].iloc[0][0]]}])
    fetch = _FakeFetch({"supplement_products": products, "supplement_intake": intakes_frame()})
    days = h.load_supplement_unquantified(fetch)
    assert days.empty and list(days.columns) == ["calendar_date", "ingredient_group"]
    assert [c[0] for c in fetch.calls] == ["supplement_products"]


def test_loader_failure_is_reported_not_treated_as_none_found():
    for failing in ("supplement_products", "supplement_intake"):
        fetch = _FakeFetch({"supplement_products": PRODUCTS, "supplement_intake": intakes_frame()}, fail=failing)
        assert h.load_supplement_unquantified(fetch) is None
    supp = view_rollup(PRODUCTS, intakes_frame())
    _, coverage = h.supplement_dose_response_rows(supp, TRACKED, "y", None)
    assert coverage["unquantified_check"] == "unavailable"


def test_amountless_intake_days_are_left_out_end_to_end():
    intakes = intakes_frame()
    supp = view_rollup(PRODUCTS, intakes)
    # The view keeps day 10's quantified sibling and has no row at all for day 35.
    assert DATES[10] in set(supp["calendar_date"]) and DATES[35] not in set(supp["calendar_date"])
    fetch = _FakeFetch({"supplement_products": PRODUCTS, "supplement_intake": intakes})
    unquantified = h.load_supplement_unquantified(fetch)
    rows, coverage = h.supplement_dose_response_rows(supp, TRACKED, "y", unquantified)
    r = only(rows, "Synthetic Mineral")
    assert r["excluded_days"] == {"other_unit": 0, "unquantified": 3}
    # Days 10 / 11 (partial total) and 35 (amount unknown, not 0) are left out; 36 / 37 are real zeros.
    by_day = {DATES[d]: 100.0 * (d % 3 + 1) for d in A_DAYS}
    rho, n = expected_spearman(by_day, [d for d in range(N_DAYS) if d not in B_DAYS])
    assert r["n"] == n == N_DAYS - 3
    assert abs(r["spearman_r"] - rho) < 1e-12
    assert coverage["unquantified_check"] == "checked" and coverage["with_excluded_days"] == 1
    # Without the blend in the catalogue the same rollup reads day 35 as 0 and keeps the partial days.
    blind, _ = h.supplement_dose_response_rows(supp, TRACKED, "y", h.load_supplement_unquantified(
        _FakeFetch({"supplement_products": PRODUCTS.iloc[[0]], "supplement_intake": intakes})))
    assert only(blind, "Synthetic Mineral")["n"] == N_DAYS
    # The herb only ever appears without an amount: no estimate, listed with its own reason.
    herb = [e for e in coverage["excluded"] if e["compound"] == "Synthetic Herb"]
    assert herb == [{"compound": "Synthetic Herb", "reason": "unquantified", "unit_classes": [],
                     "n_days": len(B_DAYS)}]


def test_too_few_comparable_days_is_recorded_not_dropped_silently():
    mass = mass_series(days=range(0, 24))
    unq = pd.DataFrame({"calendar_date": [DATES[d] for d in range(0, 24)],
                        "ingredient_group": "Synthetic Mineral"})
    rows, coverage = h.supplement_dose_response_rows(frame(mass), TRACKED, "y", unq)
    assert rows == []
    (entry,) = coverage["excluded"]
    assert entry["reason"] == "too_few_comparable_days" and entry["unit_classes"] == ["mass"]
    # A constant-dose compound with nothing left out is the Yes/No chart's case: not listed.
    flat = [row(d, "Synthetic Flat", 50.0) for d in range(N_DAYS)]
    rows, coverage = h.supplement_dose_response_rows(frame(flat), TRACKED, "y", unq.iloc[0:0])
    assert rows == [] and coverage["excluded"] == []


def test_a_run_with_no_estimate_replaces_the_stored_rows():
    hrv_valid = TRACKED.copy()
    first = h.supplement_dose_response_results(frame(mass_series()), hrv_valid, "y", EMPTY_CHECKED)
    assert len(first["supplement_dose_response"]) == 1
    # Next run: the compound is logged in mL and in capsules, no mass: the unit rule leaves no estimate.
    mixed = frame([row(d, "Synthetic Mineral", 5.0, unit_class="mL") for d in range(N_DAYS)]
                  + [row(d, "Synthetic Mineral", 1.0 + d % 3, unit_class="capsule") for d in range(N_DAYS)])
    second = h.supplement_dose_response_results(mixed, hrv_valid, "y", EMPTY_CHECKED)
    assert second["supplement_dose_response"] == []
    assert second["supplement_dose_response_coverage"]["excluded"][0]["reason"] == "mixed_unconverted_units"
    fake = _FakeSupa()
    real = h.supa
    h.supa = fake
    try:
        h.store_analysis_results(second, {})
    finally:
        h.supa = real
    stored = {(r["result_type"], r["result_key"]): r for r, _ in fake.upserts}
    assert stored[("supplement_impact", "dose_response")]["result_json"] == []
    assert stored[("supplement_impact", "dose_response_coverage")]["result_json"]["analyzed"] == 0


def test_results_without_any_quantified_amount_do_not_raise():
    supp = frame([row(d, "Synthetic Herb", None) for d in range(6)])
    out = h.supplement_dose_response_results(supp, TRACKED, "y", EMPTY_CHECKED)
    assert out["supplement_dose_response"] == []
    assert out["supplement_dose_response_coverage"]["excluded"][0]["reason"] == "unquantified"


# --- The caller: an empty rollup, and a check that could not be read ------------------------------

def _stored_by_key(results: dict) -> dict:
    """What store_analysis_results writes for these stat results, by (result_type, result_key)."""
    fake = _FakeSupa()
    real = h.supa
    h.supa = fake
    try:
        h.store_analysis_results(results, {})
    finally:
        h.supa = real
    return {(r["result_type"], r["result_key"]): r for r, _ in fake.upserts}


def _amountless_only_days():
    """The loader's answer when the only intakes are of a blend that gives no amount: the rollup view
    has no row for any of them (so its read is an empty frame with no columns)."""
    products = pd.DataFrame([PRODUCTS.iloc[1].to_dict()])
    intakes = pd.DataFrame([{"intake_id": 1000 + d, "intake_date": DATES[d], "product_id": "synthetic_b", "doses": 1}
                            for d in B_DAYS])
    return h.load_supplement_unquantified(_FakeFetch({"supplement_products": products, "supplement_intake": intakes}))


def test_empty_rollup_with_amountless_intakes_stores_an_empty_result_and_its_coverage():
    unquantified = _amountless_only_days()
    assert unquantified is not None and len(unquantified) == 2 * len(B_DAYS)
    results, warning = h.supplement_dose_response_block(pd.DataFrame(), TRACKED, "y", unquantified)
    assert warning is None
    assert results["supplement_dose_response"] == []
    cov = results["supplement_dose_response_coverage"]
    assert cov["unquantified_check"] == "checked" and cov["analyzed"] == 0
    assert sorted((e["compound"], e["reason"], e["n_days"]) for e in cov["excluded"]) == [
        ("Synthetic Herb", "unquantified", len(B_DAYS)), ("Synthetic Mineral", "unquantified", len(B_DAYS))]
    # Both keys are written, so an earlier run's rows are replaced, not left on the dashboard.
    stored = _stored_by_key(results)
    assert stored[("supplement_impact", "dose_response")]["result_json"] == []
    assert stored[("supplement_impact", "dose_response_coverage")]["result_json"] == cov


def test_empty_rollup_and_nothing_amountless_is_an_empty_result_not_an_error():
    for empty in (pd.DataFrame(), pd.DataFrame(columns=["calendar_date", "ingredient_group", "total_amount"]),
                  h._supplement_rollup_frame(None)):
        results, warning = h.supplement_dose_response_block(empty, TRACKED, "y", EMPTY_CHECKED)
        assert warning is None
        assert results["supplement_dose_response"] == []
        cov = results["supplement_dose_response_coverage"]
        assert cov["analyzed"] == 0 and cov["excluded"] == [] and cov["unquantified_check"] == "checked"
        assert _stored_by_key(results)[("supplement_impact", "dose_response")]["result_json"] == []


def test_a_failed_amount_check_publishes_nothing_and_warns():
    # The loader's own failure (the intakes read) is the input, not a hand-made None.
    failed = h.load_supplement_unquantified(
        _FakeFetch({"supplement_products": PRODUCTS, "supplement_intake": intakes_frame()}, fail="supplement_intake"))
    assert failed is None
    supp = view_rollup(PRODUCTS, intakes_frame())
    for supplements in (supp, pd.DataFrame()):
        results, warning = h.supplement_dose_response_block(supplements, TRACKED, "y", failed)
        assert results == {}
        assert warning == h.SUPPLEMENT_DOSE_CHECK_WARNING
        # Nothing reaches storage: the rows of the last complete run stay.
        stored = _stored_by_key(results)
        assert ("supplement_impact", "dose_response") not in stored
        assert ("supplement_impact", "dose_response_coverage") not in stored
    # The same rollup with a readable check publishes: the failure, not the data, withheld it.
    readable = h.load_supplement_unquantified(
        _FakeFetch({"supplement_products": PRODUCTS, "supplement_intake": intakes_frame()}))
    results, warning = h.supplement_dose_response_block(supp, TRACKED, "y", readable)
    assert warning is None and len(results["supplement_dose_response"]) == 1
    # A rollup that was not read at all says nothing either way.
    assert h.supplement_dose_response_block(None, TRACKED, "y", failed) == ({}, None)
    assert h.supplement_dose_response_block(None, TRACKED, "y", EMPTY_CHECKED) == ({}, None)


def test_a_warning_never_carries_data():
    for text in (h.SUPPLEMENT_DOSE_CHECK_WARNING, h.SUPPLEMENT_DOSE_FAILED_WARNING):
        assert text.startswith("Supplement dose-response not updated") and "synthetic" not in text.lower()


# --- pivot_supplements: one feature column per (compound, unit class) ---

def test_pivot_keeps_mass_and_literal_unit_rows_apart():
    # One day, one compound: a 1 mg row and a 1 mL row. Two columns, no summed value of 2.
    supp = frame([
        row(0, "Synthetic Mineral", 1.0, unit_class="mass"),
        row(0, "Synthetic Mineral", 1.0, unit_class="mL"),
    ])
    wide, start, unknown = h.pivot_supplements(supp)
    assert list(wide.columns) == ["calendar_date", "supplement_synthetic_mineral_amount",
                                 "supplement_synthetic_mineral_amount_ml"]
    day = wide.iloc[0]
    assert day["supplement_synthetic_mineral_amount"] == 1.0
    assert day["supplement_synthetic_mineral_amount_ml"] == 1.0
    assert start == DATES[0] and unknown == {}


def test_pivot_marks_unknown_days_and_never_zeroes_them():
    # An unreadable amount makes the compound's day unknown in every column it has
    # (the same rule as the dose-response); an unknown-unit row does the same and
    # produces no column of its own.
    supp = frame([
        row(0, "Synthetic Mineral", 1.0, unit_class="mass"),
        row(1, "Synthetic Mineral", 2.0, unit_class="mass"),
        row(1, "Synthetic Mineral", float("nan"), unit_class="mass"),
        row(2, "Synthetic Tincture", 3.0, unit_class="mass"),
        row(2, "Synthetic Tincture", 4.0, unit_class="unitless"),
    ])
    wide, _start, unknown = h.pivot_supplements(supp)
    assert wide.loc[wide["calendar_date"] == DATES[1], "supplement_synthetic_mineral_amount"].isna().all()
    assert unknown == {
        "supplement_synthetic_mineral_amount": {DATES[1]},
        "supplement_synthetic_tincture_amount": {DATES[2]},
    }
    assert not any(c.endswith("_amount_unitless") for c in wide.columns)


def test_pivot_mass_only_matches_the_old_behaviour_exactly():
    # (b) parity: a frame with only mass rows gives the same numbers and column
    # names as the pre-change grouping (the unit_class column absent).
    mass = frame(mass_series() + mass_series(group="Synthetic Tincture", unit_class="mass"))
    old_input = mass.drop(columns=["unit_class", "source_units"])
    old_wide, old_start, old_unknown = h.pivot_supplements(old_input)
    new_wide, new_start, new_unknown = h.pivot_supplements(mass)
    assert list(new_wide.columns) == list(old_wide.columns)
    pd.testing.assert_frame_equal(new_wide, old_wide)
    assert new_start == old_start and new_unknown == {} and old_unknown == {}
    # A literal-unit-only compound keeps its own suffixed column and never
    # touches the mass name.
    only_ml = frame([row(d, "Synthetic Tincture", float(d + 1), unit_class="mL") for d in range(3)])
    wide, _start, unknown = h.pivot_supplements(only_ml)
    assert list(wide.columns) == ["calendar_date", "supplement_synthetic_tincture_amount_ml"]
    assert unknown == {}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
