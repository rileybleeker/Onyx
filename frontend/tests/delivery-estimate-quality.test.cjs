// Run: node --test tests/delivery-estimate-quality.test.cjs
// Quality gate for model-estimated delivery dishes (lib/delivery-estimate-quality.ts): a
// plausible-looking but wrong estimate is never stored. SYNTHETIC DATA ONLY: generic dish names
// and invented numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const Q = loadTs("lib/delivery-estimate-quality.ts");
const estimateQuality = Q.estimateQuality;

const row = (over) => ({
  kind: "food",
  kcal: 800,
  protein_g: 30,
  carbs_g: 80,
  fat_g: 30,
  alcohol_g: 0,
  ...over,
});

test("a good food estimate passes", () => {
  const r = estimateQuality(row({}));
  assert.equal(r.usable, true);
  assert.equal(r.reason, "ok");
});

test("a food estimate with all-zero macros fails", () => {
  const r = estimateQuality(row({ kcal: 700, protein_g: 0, carbs_g: 0, fat_g: 0 }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "food_without_macros");
});

test("macro energy far from kcal fails for food", () => {
  // 4*10 + 4*10 + 9*5 = 125 vs kcal 900: way outside the 35% band.
  const r = estimateQuality(row({ kcal: 900, protein_g: 10, carbs_g: 10, fat_g: 5 }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "macro_energy_mismatch");
});

test("alcohol with alcohol_g 0 fails", () => {
  const r = estimateQuality(row({ kind: "alcohol", kcal: 200, protein_g: 0, carbs_g: 10, fat_g: 0, alcohol_g: 0 }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "alcohol_without_alcohol");
});

test("alcohol with alcohol_g above 0 passes", () => {
  const r = estimateQuality(row({ kind: "alcohol", kcal: 200, protein_g: 0, carbs_g: 10, fat_g: 0, alcohol_g: 14 }));
  assert.equal(r.usable, true);
});

test("a wildly out-of-range kcal fails (negative control)", () => {
  const r = estimateQuality(row({ kcal: 9000 }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "kcal_out_of_range");
});

test("non-finite kcal fails", () => {
  const r = estimateQuality(row({ kcal: NaN }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "kcal_out_of_range");
});

test("a drink with zero macros but kcal over 1000 fails", () => {
  const r = estimateQuality(row({ kind: "drink", kcal: 1500, protein_g: 0, carbs_g: 0, fat_g: 0 }));
  assert.equal(r.usable, false);
  assert.equal(r.reason, "drink_kcal_too_high");
});

test("a small zero-macro drink passes", () => {
  const r = estimateQuality(row({ kind: "drink", kcal: 5, protein_g: 0, carbs_g: 0, fat_g: 0 }));
  assert.equal(r.usable, true);
});

test("food or drink carrying alcohol_g fails (only kind alcohol may)", () => {
  for (const kind of ["food", "drink"]) {
    const r = estimateQuality(row({ kind, alcohol_g: 10 }));
    assert.equal(r.usable, false, kind);
    assert.equal(r.reason, "alcohol_on_non_alcohol_kind");
  }
});

test("non_food is always usable with zeros", () => {
  const r = estimateQuality(row({ kind: "non_food", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }));
  assert.equal(r.usable, true);
});
