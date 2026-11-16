// Run: node --test tests/supplement-units.test.cjs
// HIST-UNIT-01: the compound rollup keeps one row per compound AND unit class (mass = mg after conversion, any other
// unit as on the label). The /supplements table must key rows on that identity, so an mg and an mL row of one compound
// stay two rows through a refresh that reorders them; an unconverted row keeps its literal unit and says so; IU
// converted to mg says where it came from; ingredients with no readable amount are listed apart, never as a 0 or as
// an unknown unit; PersonalTable never hands React the same key twice. /analytics/hrv shows which compounds the
// dose-response left out and why, and each estimate's unit, IU provenance and left-out days.
// SYNTHETIC DATA ONLY: invented compound names, ids and amounts; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, withGlobals } = require("./helpers/hook-harness.cjs");

const units = loadTs("lib/supplement-units.ts");
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const MG = { compound_key: "SYNTH0UNII1", ingredient_group: "Synthetic Mineral", unii_code: "SYNTH0UNII1", unit_class: "mass", unit: "mg", source_units: ["mg"], total_amount: 200, total_doses: 1, source_product_count: 1, category: "mineral", ingredient_name: "Synthetic Mineral" };
const ML = { ...MG, unit_class: "mL", unit: "mL", source_units: ["mL"], total_amount: 5 };
const UNITLESS = { ...MG, compound_key: "Synthetic Blend", ingredient_group: "Synthetic Blend", unii_code: null, unit_class: "unitless", unit: "unitless", source_units: [null], total_amount: 2 };
const VIT_D = { ...MG, compound_key: "SYNTH0UNII2", ingredient_group: "Synthetic Vitamin D", unii_code: "SYNTH0UNII2", source_units: ["IU", "mcg"], total_amount: 0.05 };

test("lib: mg and mL siblings of one compound get different keys; the same row keeps its key", () => {
  assert.notEqual(units.compoundRowKey(MG), units.compoundRowKey(ML));
  assert.equal(units.compoundRowKey(MG), units.compoundRowKey({ ...MG, total_amount: 999 }), "the amount is not part of the identity");
  // A payload without unit_class (older cached copy) reads it from the unit, as the view writes it.
  const { unit_class: _a, ...mgNoClass } = MG;
  const { unit_class: _b, ...mlNoClass } = ML;
  assert.equal(units.compoundRowKey(mgNoClass), units.compoundRowKey(MG));
  assert.equal(units.compoundRowKey(mlNoClass), units.compoundRowKey(ML));
  assert.equal(units.unitClassOf({ unit: null }), "unitless");
  // Same compound_key, different ingredient_group (two names on one UNII): two rows too.
  assert.notEqual(units.compoundRowKey(MG), units.compoundRowKey({ ...MG, ingredient_group: "Synthetic Mineral Citrate" }));
  assert.equal(units.distinctCompoundCount([MG, ML, UNITLESS]), 2, "a compound shown in two units counts once");
});

test("lib: unit labels keep the literal unit of unconverted rows and record IU provenance", () => {
  assert.deepEqual(units.compoundUnitLabel(MG), { unit: "mg", converted: true, note: null, title: null });
  const ml = units.compoundUnitLabel(ML);
  assert.equal(ml.unit, "mL");
  assert.equal(ml.converted, false);
  assert.equal(ml.note, "not in mg");
  const none = units.compoundUnitLabel(UNITLESS);
  assert.equal(none.unit, "", "no invented unit");
  assert.equal(none.note, "no unit");
  const d = units.compoundUnitLabel(VIT_D);
  assert.equal(d.unit, "mg");
  assert.equal(d.note, "from IU");
  assert.match(d.title, /IU, mcg/);
  // IU the view could not map stays its own class and is labelled as such, never as mg.
  const iu = units.compoundUnitLabel({ ...MG, unit_class: "IU", unit: "IU", source_units: ["IU"] });
  assert.equal(iu.unit, "IU");
  assert.equal(iu.converted, false);
  assert.equal(units.isIuUnit("I.U."), true);
  assert.equal(units.isIuUnit("mIU"), false);
});

test("lib: unquantified ingredients follow the view's own filter and are listed apart", () => {
  for (const q of [0, 5, 0.25, "5", "0.5"]) assert.equal(units.isQuantified(q), true, `quantified: ${q}`);
  for (const q of [null, undefined, "", " 5", "1,000", "<1", "blend", -1, Number.NaN, true, {}]) {
    assert.equal(units.isQuantified(q), false, `not quantified: ${String(q)}`);
  }
  const list = units.unquantifiedIngredients([
    { product_id: "p-a", ingredients: [{ ingredient_group: "Synthetic Mineral", quantity: 200, unit: "mg" }, { ingredient_group: "Synthetic Herb", quantity: "blend", unit: "mg" }] },
    { product_id: "p-b", ingredients: [{ name: "Synthetic Herb", quantity: null }, { name: "Synthetic Amino", unit: "mg" }] },
    { product_id: "p-a", ingredients: [{ ingredient_group: "Synthetic Herb", quantity: null }] },
    { product_id: "p-c", ingredients: null },
  ]);
  assert.deepEqual(list, [
    { name: "Synthetic Amino", label: null, product_count: 1 },
    { name: "Synthetic Herb", label: "blend", product_count: 2 },
  ]);
  assert.deepEqual(units.unquantifiedIngredients([]), []);
});

test("lib: dose-response coverage says which compounds have no estimate and why", () => {
  const cov = units.parseDoseCoverage({
    version: 2, analyzed: 1, with_excluded_days: 1, unquantified_check: "checked",
    excluded: [
      { compound: "Synthetic Extract", reason: "mixed_unconverted_units", unit_classes: ["capsule", "mL"], n_days: 9 },
      { compound: "Synthetic Herb", reason: "unquantified", unit_classes: [], n_days: 3 },
      { compound: "Synthetic Blend", reason: "unknown_unit", unit_classes: ["unitless"], n_days: 4 },
      { compound: "Synthetic Mineral", reason: "too_few_comparable_days", unit_classes: ["mass"], n_days: 2 },
      { reason: "unquantified" },
    ],
  });
  assert.equal(cov.excluded.length, 4, "an entry without a compound name is dropped");
  assert.equal(units.doseLeftOutLabel(cov.excluded[0]), "Synthetic Extract (units that cannot be compared: capsule, mL)");
  assert.equal(units.doseLeftOutLabel(cov.excluded[1]), "Synthetic Herb (no amount on the label)");
  assert.equal(units.doseLeftOutLabel(cov.excluded[2]), "Synthetic Blend (amounts without a unit)");
  assert.equal(units.doseLeftOutLabel(cov.excluded[3]), "Synthetic Mineral (too few comparable days)");
  const lines = units.doseCoverageLines(cov);
  assert.match(lines[0], /^No estimate: Synthetic Extract \(units that cannot be compared: capsule, mL\) · Synthetic Herb/);
  assert.equal(lines[1], "1 estimate leaves out days logged in another unit or without an amount.");
  assert.equal(lines.length, 2, "the amount check ran: no extra line");
  const capped = units.doseCoverageLines({ ...cov, excluded: [...cov.excluded, ...cov.excluded] }, 3);
  assert.match(capped[0], / · 5 more$/);
  // A run that could not check intakes without an amount says so.
  const unchecked = units.parseDoseCoverage({ analyzed: 2, excluded: [], unquantified_check: "unavailable" });
  assert.deepEqual(units.doseCoverageLines(unchecked), ["Intakes without a readable amount were not checked on this run."]);
  assert.deepEqual(units.doseCoverageLines(null), []);
  assert.equal(units.parseDoseCoverage([]), null);
  assert.equal(units.parseDoseCoverage("x"), null);
  // The card shows when estimates remain OR compounds were left out; never for nothing at all.
  assert.equal(units.showDoseResponseCard([], cov), true, "no estimate left, but the reason is shown");
  assert.equal(units.showDoseResponseCard([{}], null), true);
  assert.equal(units.showDoseResponseCard([], null), false);
  assert.equal(units.showDoseResponseCard([], unchecked), false);
});

test("lib: a dose-response row names its unit, its IU provenance and the days it left out", () => {
  assert.equal(units.doseRowUnit({ unit: "mg", converted: true, converted_from_iu: false }), "mg");
  assert.equal(units.doseRowUnit({ unit: "mg", converted: true, converted_from_iu: true }), "mg, from IU");
  assert.equal(units.doseRowUnit({ unit: "mL", converted: false, converted_from_iu: false }), "mL, not in mg");
  assert.equal(units.doseRowUnit({ unit: "mg" }), "mg", "an older row without the new fields keeps its unit");
  assert.equal(units.doseRowUnit({ unit: null }), null);
  assert.equal(units.doseRowLeftOutDays({ excluded_days: { other_unit: 3, unquantified: 1 } }),
    "3 days in another unit and 1 day without an amount left out");
  assert.equal(units.doseRowLeftOutDays({ excluded_days: { other_unit: 0, unquantified: 2 } }), "2 days without an amount left out");
  assert.equal(units.doseRowLeftOutDays({ excluded_days: { other_unit: 0, unquantified: 0 } }), null);
  assert.equal(units.doseRowLeftOutDays({}), null);
});

test("dashboard: the coverage row is fetched in the bounded batch and rendered with the dose-response", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const q = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "queries-hrv.ts"), "utf8");
  assert.match(q, /\["supplement_impact", "dose_response"\], \["supplement_impact", "dose_response_coverage"\]/);
  assert.match(q, /panel\("supplement_impact", "dose_response"\),\s*panel\("supplement_impact", "dose_response_coverage"\),/);
  assert.match(q, /supplementDoseCoverage: parsedObject\(suppDoseCov\),/);
  const c = fs.readFileSync(path.join(__dirname, "..", "src", "app", "analytics", "hrv", "HrvAnalysisClient.tsx"), "utf8");
  assert.match(c, /useState<any \| null>\(initial\?\.supplementDoseCoverage \?\? null\)/);
  assert.match(c, /setSupplementDoseCoverage\(\(prev: any\) => sameJson\(prev, d\.supplementDoseCoverage\) \? prev : d\.supplementDoseCoverage\)/);
  assert.match(c, /showDoseResponseCard\(supplementDoseResponse, parseDoseCoverage\(supplementDoseCoverage\)\)/);
  assert.match(c, /data-testid="dose-response-coverage"/);
  assert.match(c, /displayLabel: `.*\$\{unit \? ` \(\$\{unit\}\)` : ""\}`/);
});

test("PersonalTable: unique keys pass through unchanged; a repeat never reaches React twice", () => {
  const { uniqueRowKeys } = loadTs("components/personalize/PersonalTable.tsx", {
    "@/lib/personalize-layout": { EMPTY_LAYOUT: {}, resolveColumns: () => [] },
    "@/lib/personalize-store": { editorSnapshot: () => null, isEditing: () => false, layoutSnapshot: () => ({}), subscribe: () => () => {} },
    "./PartGrid": { useGridContext: () => null },
  });
  assert.deepEqual(uniqueRowKeys([{ key: "a" }, { key: "b" }]), ["a", "b"]);
  const keys = uniqueRowKeys([{ key: "a" }, { key: "a" }, { key: "a#2" }, { key: "a" }]);
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(keys, ["a", "a#3", "a#2", "a#4"], "a suffix never takes a key a row was given");
  assert.deepEqual(uniqueRowKeys([]), []);
});

test("route: today's answer lists unquantified ingredients and orders unit siblings; no ingredient JSON per intake", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "app", "api", "supplements", "today", "route.ts"), "utf8");
  assert.match(src, /supplement_products\(brand_name,full_name,ingredients\)/);
  assert.match(src, /\.order\("ingredient_group"\)\s*\.order\("unit_class"\)\s*\.order\("compound_key"\)/);
  assert.match(src, /const unquantified = unquantifiedIngredients\(labelled\);/);
  assert.match(src, /return \{ \.\.\.i, brand_name: p\?\.brand_name \?\? null, full_name: p\?\.full_name \?\? null \};/);
  assert.match(src, /compounds,\s*unquantified,\s*reminders,/);
});

function mountPage(t, todayAnswers) {
  const captured = [];
  let todayGets = 0;
  withGlobals(t, {
    confirm: () => true,
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "DELETE") return response({ ok: true });
      if (method !== "GET") return response({ ok: true });
      if (url === "/api/behavioral-today") return response({ behavioral_today: TODAY });
      if (url === "/api/supplements/products") return response({ products: [] });
      if (url === "/api/supplements/today") { todayGets++; return response(todayAnswers[Math.min(todayGets, todayAnswers.length) - 1]); }
      if (url.startsWith("/api/supplements/history")) return response({ rows: [] });
      if (url === "/api/supplements/stacks") return response({ stacks: [] });
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });
  const none = { __esModule: true, default: () => null };
  const passthrough = (p) => ({ type: "section", props: { children: [p.title, " ", p.subtitle, p.children] } });
  const StatCard = { __esModule: true, default: (p) => ({ type: "div", props: { children: [p.label, ": ", String(p.value)] } }) };
  const h = mountClient("app/supplements/SupplementsClient.tsx", {
    stubs: {
      "next/dynamic": { __esModule: true, default: () => () => null },
      "lucide-react": { Check: () => null, X: () => null },
      "@/lib/queries": { rangeDays: () => 30, rangeLabel: () => "30 days" },
      "@/lib/client-cache": { clientCache: { peek: () => undefined, read: async () => undefined, put: () => true } },
      "@/components/StatCard": StatCard,
      "@/components/RangeFilter": none,
      "@/components/LogLink": none,
      "@/components/EditIntakeModal": none,
      "@/components/StackEditorModal": none,
      "@/components/CustomSupplementFlow": none,
      "@/components/ChartCard": { __esModule: true, default: passthrough },
      "@/components/personalize/PartGrid": { PartGrid: ({ children }) => children, PartGroup: ({ children }) => children, Part: ({ children }) => children },
      "@/components/personalize/PersonalTable": { __esModule: true, default: (p) => { captured.push(p.rows); return null; } },
    },
  });
  t.after(() => h.unmount());
  return { ...h, captured, todayGets: () => todayGets };
}

const intake = (intake_id) => ({ intake_id, intake_date: TODAY, intake_time: null, product_id: "p-a", doses: 1, notes: null, brand_name: null, full_name: "Synthetic Product" });

test("page: mg and mL rows of one compound stay distinct through a refresh that reorders them", async (t) => {
  const first = { date: TODAY, intakes: [intake(1), intake(2)], compounds: [MG, ML], unquantified: [] };
  const second = { date: TODAY, intakes: [intake(2)], compounds: [ML, MG], unquantified: [] };
  const h = mountPage(t, [first, second]);
  await h.flush();
  const before = h.captured.at(-1);
  assert.equal(before.length, 2);
  assert.notEqual(before[0].key, before[1].key, "two rows, two keys");
  const unitOf = (rows) => Object.fromEntries(rows.map((r) => [r.key, h.text(r.cells.amount)]));
  const a = unitOf(before);
  assert.match(a[units.compoundRowKey(MG)], /^200 mg$/);
  assert.match(a[units.compoundRowKey(ML)], /^5 mL · not in mg$/);
  assert.match(h.text(), /Distinct Compounds: 1/, "one compound, shown in two units");
  // A delete schedules a silent refresh; the server now lists the mL row first.
  await h.click("delete");
  await new Promise((r) => setTimeout(r, 450));
  await h.flush();
  assert.equal(h.todayGets(), 2);
  const after = h.captured.at(-1);
  assert.deepEqual(after.map((r) => r.key), [units.compoundRowKey(ML), units.compoundRowKey(MG)]);
  assert.deepEqual(unitOf(after), a, "each key still carries its own unit and amount");
});

test("page: an unconverted unit, IU provenance and unquantified ingredients are each shown as such", async (t) => {
  const day = {
    date: TODAY,
    intakes: [intake(1)],
    compounds: [VIT_D, UNITLESS],
    unquantified: [{ name: "Synthetic Herb", label: "blend", product_count: 1 }],
  };
  const h = mountPage(t, [day]);
  await h.flush();
  const rows = h.captured.at(-1);
  const amount = Object.fromEntries(rows.map((r) => [r.key, h.text(r.cells.amount)]));
  assert.match(amount[units.compoundRowKey(VIT_D)], /^0\.05 mg · from IU$/);
  assert.match(amount[units.compoundRowKey(UNITLESS)], /^2 · no unit$/, "no unit is invented for a bare number");
  assert.match(h.text(), /No amount on the label \(not counted\): Synthetic Herb \(blend\)/);
  assert.doesNotMatch(h.text(), /No intakes logged today yet/);
});

test("page: a day whose only ingredients have no amount lists them instead of 'No intakes logged today yet'", async (t) => {
  const h = mountPage(t, [{ date: TODAY, intakes: [intake(1)], compounds: [], unquantified: [{ name: "Synthetic Herb", label: null, product_count: 1 }] }]);
  await h.flush();
  assert.match(h.text(), /No amount on the label \(not counted\): Synthetic Herb/);
  assert.doesNotMatch(h.text(), /No intakes logged today yet/);
  assert.equal(h.captured.length, 0, "no table without compound rows");
});

test("page: an older cached answer without the new fields still renders", async (t) => {
  const { unit_class: _c, source_units: _s, ...oldMg } = MG;
  const h = mountPage(t, [{ date: TODAY, intakes: [intake(1)], compounds: [oldMg] }]);
  await h.flush();
  const rows = h.captured.at(-1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, units.compoundRowKey(MG));
  assert.match(h.text(rows[0].cells.amount), /^200 mg$/);
});
