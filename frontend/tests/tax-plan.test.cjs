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
  bracketIndexPct: 0, // the synthetic years use the built-in tables as they are
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
  const p2 = S.applyToProfile(base, params, "2030-12-01");
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
  assert.equal(S.applyToProfile(p, { bonusPct: 50 }, "2030-12-01").annualBonus.amountCents, 2_500_000);
});

test("tax rules are configurable: bracket indexing for unpublished years, state rates, employer withholding", () => {
  const p = { ...base, employmentStart: "2026-01-01", bracketIndexPct: undefined };
  const t28 = T.tablesFor(p, 2028);
  assert.equal(t28.federal.standardDeduction, Math.round((16_100 * Math.pow(1.027, 2)) / 50) * 50);
  assert.match(t28.estimated, /indexed 2\.7%/);
  assert.equal(T.tablesFor({ ...p, bracketIndexPct: 0 }, 2028).federal.standardDeduction, 16_100);
  assert.equal(T.tablesFor({ ...p, gaRatePct: 4.99 }, 2026).ga.rate, 4.99);
  const none = T.computeTaxYear({ ...p, employerStateWithholding: "none" }, 2026, "2026-03-01");
  assert.equal(none.jurisdictions.find((j) => j.jur === "NC").withheldCents, 0);
});

test("tax years by cash date: last year stays in after New Year until its lines are settled", () => {
  // Synthetic horizon: two years ahead, as the loader uses.
  assert.deepEqual(T.taxYearsFor("2030-12-31", "2032-12-30"), [2030, 2031, 2032]);
  assert.deepEqual(T.taxYearsFor("2031-01-01", "2032-12-31"), [2030, 2031, 2032], "the 2030 January estimate and April refund are still ahead");
  assert.deepEqual(T.taxYearsFor("2031-05-31", "2033-05-30"), [2030, 2031, 2032, 2033], "within the late-match window after the 2030 refund date");
  assert.deepEqual(T.taxYearsFor("2031-06-01", "2033-05-31"), [2031, 2032, 2033], "past the window: 2030 is done");
  assert.equal(T.taxYearLastCashDate(2030), "2031-04-30");
});

test("the prior year's January estimate and refund survive Dec 31 -> Jan 1 (real computeTaxYear / taxCashItems)", () => {
  const p = { ...base, employmentStart: "2030-01-01", oneOffs: [] };
  const lines = (today) => T.taxCashItems(p, T.taxYearsFor(today, "2032-12-30").map((y) => T.computeTaxYear(p, y, today)), today).filter((i) => i.id.startsWith("tax:2030:"));
  const dec31 = lines("2030-12-31");
  const jan1 = lines("2031-01-01");
  assert.ok(dec31.some((i) => i.id === "tax:2030:GA:2031-01-15" && i.amountCents < 0), "a Georgia payment is due on Jan 15");
  assert.ok(dec31.some((i) => i.id === "tax:2030:NC:2031-04-30" && i.amountCents > 0), "the NC withholding comes back");
  assert.deepEqual(jan1, dec31, "New Year changes nothing: nothing was paid or received");
  // After Jan 15 with nothing recorded, the Georgia balance is still owed: with the return on April 15.
  const jan20 = lines("2031-01-20");
  const ga = jan20.find((i) => i.id.startsWith("tax:2030:GA:"));
  assert.equal(ga.date, "2031-04-15");
  assert.equal(ga.amountCents, dec31.find((i) => i.id === "tax:2030:GA:2031-01-15").amountCents);
  // Recording the payment settles it.
  const paid = { ...p, estimatesPaid: [{ year: 2030, jur: "GA", date: "2031-01-15", cents: -ga.amountCents }] };
  const settled = T.taxCashItems(paid, [T.computeTaxYear(paid, 2030, "2031-01-20")], "2031-01-20");
  assert.ok(!settled.some((i) => i.id.startsWith("tax:2030:GA:")));
  // A line whose date passed is kept for the late-match window (the forecast settles it), then dropped.
  const keep = (today) => T.taxCashItems(p, [T.computeTaxYear(p, 2030, today)], today).map((i) => i.id);
  assert.ok(keep("2031-05-10").includes("tax:2030:NC:2031-04-30"));
  assert.ok(keep("2031-05-10").includes("tax:2030:GA:2031-04-15"));
  assert.ok(!keep("2031-06-01").includes("tax:2030:NC:2031-04-30"));
});

test("other income what-if: dated receipts, taxed in the year received, nothing for income the profile already has", () => {
  const today = "2030-11-14";
  // Default start: next month; one twelfth at each month end.
  const ch = S.otherIncomeChange({ otherIncome: 12_000 }, 0, today);
  assert.deepEqual(ch, { annualCents: 1_200_000, from: "2030-12-01" });
  assert.deepEqual(T.otherIncomeReceiptDates(ch.from, 2030), ["2030-12-31"]);
  assert.equal(T.otherIncomeReceiptDates(ch.from, 2031).length, 12);
  assert.deepEqual(S.otherIncomeChange({ otherIncome: 12_000, otherIncomeStart: "2031-03-10" }, 0, today).from, "2031-03-10");
  assert.equal(S.otherIncomeChange({ otherIncome: 12_000, otherIncomeStart: "2030-01-01" }, 0, today).from, "2030-12-01", "a past start counts from next month");
  assert.equal(S.otherIncomeChange({ otherIncome: 5_000 }, 500_000, today), null, "the same figure as the profile: no change");
  assert.equal(S.otherIncomeChange({}, 0, today), null);

  const sp = S.applyToProfile(base, { otherIncome: 12_000 }, today);
  assert.equal(sp.otherIncomeAnnualCents, 0, "the profile's own figure is kept");
  assert.equal(T.otherIncomeFor(sp, 2030), 100_000, "one December receipt is taxed in 2030");
  assert.equal(T.otherIncomeFor(sp, 2031), 1_200_000);
  const items = S.scenarioItems({ otherIncome: 12_000 }, sp, today).filter((i) => i.id.startsWith("wi:other:"));
  assert.equal(items.length, 26);
  assert.ok(items.every((i) => i.amountCents === 100_000 && i.date > today));
  for (const y of [2030, 2031]) assert.equal(items.filter((i) => i.date.startsWith(`${y}-`)).reduce((s, i) => s + i.amountCents, 0), T.otherIncomeFor(sp, y), `cash and tax agree for ${y}`);
  // The profile already has $5k a year (in the history): $12k adds only $7k of receipts and $7k of income.
  const withBase = { ...base, otherIncomeAnnualCents: 500_000 };
  const sp2 = S.applyToProfile(withBase, { otherIncome: 12_000 }, today);
  const items2 = S.scenarioItems({ otherIncome: 12_000 }, sp2, today).filter((i) => i.id.startsWith("wi:other:"));
  assert.equal(items2[0].amountCents, Math.round(700_000 / 12));
  assert.equal(T.otherIncomeFor(sp2, 2031), 500_000 + 12 * Math.round(700_000 / 12));
  // Less than the profile: the receipts are negative and the income goes down.
  const less = S.scenarioItems({ otherIncome: 2_000 }, S.applyToProfile(withBase, { otherIncome: 2_000 }, today), today).filter((i) => i.id.startsWith("wi:other:"));
  assert.ok(less.length > 0 && less.every((i) => i.amountCents === -25_000 && /less other income/.test(i.label)));
  // Parsed from the URL; the start only travels with an amount.
  assert.deepEqual(S.parseScenarioParams((k) => ({ otherIncome: "12000", otherIncomeStart: "2031-03-10" })[k] ?? null), { otherIncome: 12_000, otherIncomeStart: "2031-03-10" });
  assert.deepEqual(S.parseScenarioParams((k) => ({ otherIncomeStart: "2031-03-10" })[k] ?? null), {});
});
