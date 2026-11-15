// Run: node --test tests/tax-plan.test.cjs
// Tax planning engine (lib/tax-plan.ts, lib/tax-tables.ts) and what-if levers (lib/cash-forecast-scenario.ts).
// SYNTHETIC DATA ONLY: invented salary, dates and amounts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const T = loadTs("lib/tax-plan.ts");
const TT = loadTs("lib/tax-tables.ts");
const S = loadTs("lib/cash-forecast-scenario.ts");

const base = {
  salaryAnnualCents: 12_000_000, // $120k
  employmentStart: "2030-01-01",
  oneOffs: [{ date: "2031-01-31", grossCents: 6_000_000, label: "Annual bonus" }],
  moveDate: null,
  ncWorkSharePct: 0,
  preTaxAnnualCents: 0,
  otherIncomeAnnualCents: 0,
  ytd: null,
  priorYear: null,
  estimatesPaid: [],
};

test("bracket tax", () => {
  const b = [{ upTo: 10_000, rate: 10 }, { upTo: null, rate: 20 }];
  assert.equal(TT.bracketTax(5_000, b), 500);
  assert.equal(TT.bracketTax(15_000, b), 2_000);
  assert.equal(TT.marginalRate(15_000, b), 20);
  assert.equal(TT.taxTables(2031).estimated !== null, true);
});

test("salary paid monthly from the start date, first month prorated", () => {
  const w = T.wagesFor({ ...base, employmentStart: "2030-04-16" }, 2030);
  assert.equal(w.length, 9);
  assert.equal(w[0].cents, Math.round((12_000_000 / 12) * (15 / 30)));
});

test("Georgia resident all year with NC withholding: Georgia owed, NC refunded, federal from the brackets", () => {
  const r = T.computeTaxYear(base, 2030, "2030-03-01");
  const j = Object.fromEntries(r.jurisdictions.map((x) => [x.jur, x]));
  const t = TT.taxTables(2030);
  assert.equal(j.federal.taxCents, Math.round(TT.bracketTax(120_000 - t.federal.standardDeduction, t.federal.single) * 100));
  assert.equal(j.GA.withheldCents, 0);
  assert.equal(j.GA.taxCents, Math.round((12_000_000 - 1_200_000) * (t.ga.rate / 100)));
  assert.equal(j.NC.taxCents, 0);
  assert.ok(j.NC.balanceCents < 0, "NC withholding comes back");
  assert.ok(r.payments.some((p) => p.jur === "GA" && p.cents < 0));
  assert.ok(r.payments.some((p) => p.jur === "NC" && p.kind === "refund" && p.cents > 0));
});

test("a January bonus before a March move is Georgia's; New York taxes the rest at the full-year rate", () => {
  const p = { ...base, moveDate: "2031-03-01" };
  const r = T.computeTaxYear(p, 2031, "2030-12-01");
  const j = Object.fromEntries(r.jurisdictions.map((x) => [x.jur, x]));
  const salary = 12_000_000 / 12;
  assert.equal(j.GA.incomeCents, Math.round(6_000_000 + 2 * salary));
  assert.equal(j.NY.incomeCents, Math.round(10 * salary));
  const t = TT.taxTables(2031);
  const nyFull = TT.bracketTax((r.agiCents - 800_000) / 100, t.ny.single) * 100;
  assert.ok(Math.abs(j.NY.taxCents - Math.round(nyFull * (j.NY.incomeCents / r.agiCents))) <= 1);
  assert.ok(j.NYC.taxCents > 0);
  // Georgia paid at the first due date (income concentrated early), New York spread over four.
  assert.equal(r.payments.filter((x) => x.jur === "GA").length, 1);
  assert.equal(r.payments.filter((x) => x.jur === "NY").length, 4);
});

test("working days in NC: NC taxes that share and Georgia credits it", () => {
  const r = T.computeTaxYear({ ...base, ncWorkSharePct: 50 }, 2030, "2030-03-01");
  const j = Object.fromEntries(r.jurisdictions.map((x) => [x.jur, x]));
  assert.ok(j.NC.taxCents > 0);
  const noNc = Object.fromEntries(T.computeTaxYear(base, 2030, "2030-03-01").jurisdictions.map((x) => [x.jur, x]));
  assert.ok(j.GA.taxCents < noNc.GA.taxCents);
});

test("pay stub year-to-date replaces the estimate up to its date; estimates paid reduce the balance", () => {
  const p = { ...base, ytd: { year: 2030, asOf: "2030-06-30", federalCents: 900_000, stateCents: 200_000 }, estimatesPaid: [{ year: 2030, jur: "GA", date: "2030-06-15", cents: 100_000 }] };
  const r = T.computeTaxYear(p, 2030, "2030-07-01");
  const j = Object.fromEntries(r.jurisdictions.map((x) => [x.jur, x]));
  const est = T.computeTaxYear(base, 2030, "2030-07-01").jurisdictions.find((x) => x.jur === "federal");
  assert.notEqual(j.federal.withheldCents, est.withheldCents);
  assert.equal(j.GA.estimatesPaidCents, 100_000);
});

test("safe harbour uses last year's tax when entered", () => {
  const r = T.computeTaxYear({ ...base, priorYear: { year: 2029, federalTaxCents: 500_000, agiCents: 9_000_000 } }, 2030, "2030-03-01");
  assert.equal(r.safeHarbor.requiredCents, 500_000);
  assert.match(r.safeHarbor.basis, /100% of 2029/);
});

test("after-tax bonus and cash items", () => {
  const net = T.oneOffNetCents(base, base.oneOffs[0]);
  assert.ok(net < 6_000_000 * 0.7 && net > 6_000_000 * 0.6);
  const results = [T.computeTaxYear(base, 2030, "2030-03-01"), T.computeTaxYear(base, 2031, "2030-03-01")];
  const items = T.taxCashItems(base, results, "2030-03-01");
  assert.ok(items.some((i) => i.id.startsWith("pay:2031-01-31") && i.amountCents === net));
  assert.ok(items.every((i) => i.date > "2030-03-01"));
});

test("profile parsing rejects junk and normalizes", () => {
  assert.equal(T.parseTaxProfile({}), null);
  const p = T.parseTaxProfile({ salaryAnnualCents: 100, employmentStart: "2030-01-01", ncWorkSharePct: 500, estimatesPaid: [{ jur: "XX", date: "2030-01-01", cents: 1 }] });
  assert.equal(p.ncWorkSharePct, 100);
  assert.equal(p.estimatesPaid.length, 0);
});

test("what-if levers: parsed from the URL, applied to the profile, extra cash items", () => {
  const params = S.parseScenarioParams((k) => ({ bonusPct: "50", bonusShiftMonths: "2", moveDate: "2031-05-01", rentChange: "1500", movingCosts: "6000", spendChange: "-200", payoffCard: "card1", payoffAmount: "10000", payoffDate: "2031-02-01", junk: "x", preTax: "999999" })[k] ?? null);
  assert.equal(params.preTax, undefined); // out of range
  assert.equal(params.bonusPct, 50);
  const p2 = S.applyToProfile(base, params);
  assert.equal(p2.oneOffs[0].grossCents, 3_000_000);
  assert.equal(p2.oneOffs[0].date, "2031-03-31");
  assert.equal(p2.moveDate, "2031-05-01");
  const items = S.scenarioItems(params, p2, "2030-12-01");
  assert.ok(items.some((i) => i.id === "wi:rent" && i.amountCents === -150_000 && i.repeat.count === 24));
  assert.ok(items.some((i) => i.id === "wi:moving" && i.date === "2031-05-01"));
  assert.ok(items.some((i) => i.id === "wi:spend" && i.amountCents === 20_000));
  assert.deepEqual(S.scenarioCardPayments(params, "2030-12-01"), [{ account_key: "card1", date: "2031-02-01", cents: 1_000_000 }]);
  assert.equal(S.parseScenarioParams(() => null).bonusPct, undefined);
  assert.equal(S.hasLevers({}), false);
  assert.match(S.scenarioToQuery({ bonusPct: 50 }), /bonusPct=50/);
});

test("every year's bonus: generated each January, an explicit one wins, raises grow salary", () => {
  const p = { ...base, oneOffs: [{ date: "2031-01-31", grossCents: 6_000_000, label: "Annual bonus" }], annualBonus: { amountCents: 5_000_000, profitShareCents: 200_000, growthPct: 10, firstPlanYear: 2030 }, raisePct: 3 };
  const all = T.allOneOffs(p);
  // Pay year 2031 keeps the explicit bonus; 2032+ are generated with 10% growth per plan year.
  assert.equal(all.filter((o) => o.date.startsWith("2031-01") && /bonus/i.test(o.label)).length, 1);
  const b2032 = all.find((o) => o.date.startsWith("2032-01") && /Annual bonus/.test(o.label));
  assert.equal(b2032.grossCents, Math.round(5_000_000 * 1.1));
  assert.ok(all.some((o) => o.date.startsWith("2032-01") && /Profit share/.test(o.label)));
  assert.equal(T.salaryFor(p, 2032), Math.round(12_000_000 * Math.pow(1.03, 2)));
  const items = T.taxCashItems(p, [T.computeTaxYear(p, 2031, "2030-12-01")], "2030-12-01");
  assert.ok(items.some((i) => i.id.startsWith("pay:2032-01") && i.amountCents > 0), "future bonus reaches the cash forecast");
  const S = loadTs("lib/cash-forecast-scenario.ts");
  assert.equal(S.applyToProfile(p, { bonusPct: 50 }).annualBonus.amountCents, 2_500_000);
});
