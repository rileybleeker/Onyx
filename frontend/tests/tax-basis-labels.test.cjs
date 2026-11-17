// Run: node --test tests/tax-basis-labels.test.cjs
// Pins the per-year tax-table basis (published / assumption / override) that the /financials/forecast
// tax section shows per jurisdiction (TaxAndWhatIf.tsx BASIS_LABEL: "published", "assumption",
// "your entry"). Synthetic years and amounts only; update together with the December
// TAX-REFRESH table refresh.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const T = loadTs("lib/tax-plan.ts");
const TT = loadTs("lib/tax-tables.ts");

const JURS = ["federal", "ga", "nc", "ny", "nyc"];

/** Every basis string the tables can produce: exactly the keys the UI's BASIS_LABEL map renders. */
const KNOWN_BASES = ["published", "assumption", "override"];

const basisOf = (tables) =>
  Object.fromEntries(JURS.map((j) => [j, tables[j].basis]));

const profile = {
  salaryAnnualCents: 0,
  employmentStart: "2030-01-01",
  oneOffs: [],
  moveDate: null,
  ncWorkSharePct: 0,
  preTaxAnnualCents: 0,
  otherIncomeAnnualCents: 0,
  ytd: null,
  priorYear: null,
  estimatesPaid: [],
};

test("the only basis values are the three the UI has labels for", () => {
  // published = official table or enacted law; assumption = planning figure carried forward / indexed;
  // override = a rate Riley entered in the tax profile. If a fourth value appears, TaxAndWhatIf's
  // BASIS_LABEL must gain a label for it.
  for (const year of [2024, 2026, 2027, 2028, 2030, 2033, 2035, 2040]) {
    const t = TT.taxTables(year);
    for (const j of JURS) assert.ok(KNOWN_BASES.includes(t[j].basis), `${year} ${j}: unknown basis ${t[j].basis}`);
  }
});

test("2026: every jurisdiction is published", () => {
  const t = TT.taxTables(2026);
  assert.deepEqual(basisOf(t), { federal: "published", ga: "published", nc: "published", ny: "published", nyc: "published" });
  assert.equal(t.estimated, null, "no assumption notes on a fully published year");
});

test("2027: federal and NY are published; Georgia is an assumption (HB 463 step not entered yet)", () => {
  const t = TT.taxTables(2027);
  assert.deepEqual(basisOf(t), { federal: "published", ga: "assumption", nc: "published", ny: "published", nyc: "published" });
  assert.ok(t.ga.note.includes("HB 463"), "the Georgia assumption names HB 463");
});

test("past the last published federal year: federal becomes an assumption, NY stays published through 2032", () => {
  const firstAssumed = TT.lastPublishedFederalYear() + 1;
  const t = TT.taxTables(firstAssumed);
  assert.deepEqual(basisOf(t), { federal: "assumption", ga: "assumption", nc: "published", ny: "published", nyc: "published" });
  assert.ok(t.federal.staleAfter, "an unpublished federal year has a staleAfter date");
  assert.equal(t.federal.staleAfter, `${firstAssumed - 1}-11-30`);

  // NY's enacted 2027-2032 table is published for each of those years, an assumption after 2032.
  assert.equal(TT.taxTables(2032).ny.basis, "published");
  assert.equal(TT.taxTables(2033).ny.basis, "assumption");
  // NC's enacted S.L. 2026-41 schedule is published through 2034, an assumption from 2035.
  assert.equal(TT.taxTables(2034).nc.basis, "published");
  assert.equal(TT.taxTables(2035).nc.basis, "assumption");
});

test("years before the tables: everything but NYC (current law, no change enacted) is an assumption", () => {
  const t = TT.taxTables(2024);
  assert.deepEqual(basisOf(t), { federal: "assumption", ga: "assumption", nc: "assumption", ny: "assumption", nyc: "published" });
});

test("tablesFor: an entered Georgia or NC rate is an override for every year; others keep their basis", () => {
  const p = { ...profile, gaRatePct: 4.5, ncRatePct: 2.9 };
  for (const year of [2026, 2027, 2030]) {
    const t = T.tablesFor(p, year);
    assert.equal(t.ga.basis, "override");
    assert.equal(t.nc.basis, "override");
    assert.equal(t.federal.basis, TT.taxTables(year).federal.basis);
    assert.equal(t.ny.basis, TT.taxTables(year).ny.basis);
    assert.equal(t.nyc.basis, "published");
    assert.ok(t.ga.note.includes("your entry"), "the override note names the entry");
  }
});

test("tablesFor: an entered bracket index keeps an unpublished federal year an assumption, with a note naming the entry", () => {
  const year = TT.lastPublishedFederalYear() + 1;
  const t = T.tablesFor({ ...profile, bracketIndexPct: 3.5 }, year);
  assert.equal(t.federal.basis, "assumption");
  assert.ok(t.federal.note.includes("3.5%"), "the note names the entered index");
  assert.ok(t.federal.note.includes("your entry"), "the note says the index is the entry");
  // The default index (no entry) says it is the plan's default instead.
  const d = T.tablesFor(profile, year);
  assert.equal(d.federal.basis, "assumption");
  assert.ok(d.federal.note.includes("default index"));
  // A published year is never re-indexed.
  assert.equal(T.tablesFor({ ...profile, bracketIndexPct: 3.5 }, 2026).federal.basis, "published");
});

test("taxRuleStatus passes the basis, figures and staleness through for the page", () => {
  const year = TT.lastPublishedFederalYear() + 1;
  const t = T.tablesFor({ ...profile, gaRatePct: 4.5 }, year);
  for (const jur of ["federal", "GA", "NC", "NY", "NYC"]) {
    const r = T.taxRuleStatus(t, jur, `${year - 1}-06-01`);
    assert.ok(KNOWN_BASES.includes(r.basis));
    assert.ok(r.figures.length > 0, `${jur} has a figures line`);
    // Before staleAfter (Nov 30 of the year before) nothing is stale.
    assert.equal(r.stale, null);
  }
  assert.equal(T.taxRuleStatus(t, "GA", `${year - 1}-06-01`).basis, "override");
  // The federal assumption goes stale once its staleAfter date has passed.
  const fed = T.taxRuleStatus(t, "federal", `${year}-12-01`);
  assert.ok(fed.stale && fed.stale.includes("assumption"), "a stale federal assumption is flagged after staleAfter");
  // A published jurisdiction never goes stale.
  assert.equal(T.taxRuleStatus(TT.taxTables(2027), "NY", "2030-01-01").stale, null);
});
