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
  assert.equal(j.GA.taxCents, Math.round((12_000_000 - t.ga.standardDeduction * 100) * (t.ga.rate / 100)));
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
  // Full-year resident tax on all income (the recapture applies: NY AGI over $157,650), times the IT-203 income
  // percentage rounded to four decimals.
  const nyFull = Math.round(TT.nyResidentTax(r.agiCents / 100, (r.agiCents - 800_000) / 100, t.ny) * 100);
  assert.ok(Math.abs(j.NY.taxCents - Math.round(nyFull * TT.round4(j.NY.incomeCents / r.agiCents))) <= 1);
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
  // 2028 is indexed one year from the published 2027 figures, rounded down like the IRS ($50 / $25).
  assert.equal(t28.federal.standardDeduction, Math.floor((16_600 * 1.027) / 50) * 50);
  assert.equal(t28.federal.single[0].upTo, Math.floor((12_800 * 1.027) / 25) * 25);
  assert.match(t28.estimated, /indexed 2\.7%/);
  assert.equal(t28.federal.basis, "assumption");
  assert.equal(T.tablesFor({ ...p, bracketIndexPct: 0 }, 2028).federal.standardDeduction, 16_600);
  const entered28 = T.tablesFor({ ...p, bracketIndexPct: 0 }, 2028).federal;
  assert.equal(entered28.basis, "assumption", "an entered index does not make an unpublished year any less of an estimate");
  assert.match(entered28.note, /not published yet.*your entry/);
  assert.equal(T.tablesFor({ ...p, gaRatePct: 4.5 }, 2026).ga.rate, 4.5);
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

// ─── Published tables, assumptions and your entries ───────────────────────────────────────────
// Boundary fixtures are the "plus" amounts printed in the official schedules: IRS Rev. Proc. 2025-32 / 2026-35
// Table 3 (single), NY Tax Law 601(c)(1)(vii) / (viii) and the IT-2105-I (2026) tax computation worksheets.

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);

test("federal 2026 and 2027 are the published tables: every bracket edge matches the revenue procedure", () => {
  const edges = {
    2026: [[12_400, 1_240], [50_400, 5_800], [105_700, 17_966], [201_775, 41_024], [256_225, 58_448], [640_600, 192_979.25]],
    2027: [[12_800, 1_280], [52_025, 5_987], [109_125, 18_549], [208_325, 42_357], [264_550, 60_349], [661_375, 199_237.75]],
  };
  for (const [year, list] of Object.entries(edges)) {
    const t = TT.taxTables(Number(year));
    assert.equal(t.federal.basis, "published");
    assert.equal(t.federal.staleAfter, null);
    for (const [edge, tax] of list) near(TT.bracketTax(edge, t.federal.single), tax, 0.01, `${year} tax at $${edge}`);
    assert.ok(t.federal.sources.every((s) => /^https:\/\//.test(s.url) && /^\d{4}-\d{2}-\d{2}$/.test(s.retrieved) && s.effective.length > 0));
  }
  assert.equal(TT.taxTables(2026).federal.standardDeduction, 16_100);
  assert.equal(TT.taxTables(2027).federal.standardDeduction, 16_600);
  assert.equal(TT.taxTables(2026).federal.ssWageBase, 184_500);
  assert.equal(TT.taxTables(2027).federal.ssWageBase, 192_300);
  assert.equal(TT.lastPublishedFederalYear(), 2027);
});

test("2027 federal figures replace the extrapolation; 2028 and later stay explicit estimates", () => {
  const p = { ...base, employmentStart: "2026-01-01", bracketIndexPct: undefined };
  const t27 = T.tablesFor(p, 2027);
  assert.deepEqual(t27.federal.single, TT.taxTables(2027).federal.single, "no indexing of a published year");
  assert.equal(t27.federal.basis, "published");
  assert.equal(T.tablesFor({ ...p, bracketIndexPct: 9 }, 2027).federal.standardDeduction, 16_600, "an entered index never touches a published year");
  const r28 = T.computeTaxYear(p, 2028, "2027-06-01");
  const fed = r28.rules.find((r) => r.jur === "federal");
  assert.equal(fed.basis, "assumption");
  assert.match(fed.note, /not published yet/);
  assert.equal(fed.stale, null, "not stale before the IRS normally publishes");
  // After the date the 2028 figures are normally out, the plan says the table needs updating.
  const late = T.computeTaxYear(p, 2028, "2027-12-01");
  assert.ok(late.rules.find((r) => r.jur === "federal").stale);
  assert.ok(late.stale.some((s) => /Federal 2028/.test(s)));
  // An entered index stays an estimate (the year is not published) and the note says the index is your entry.
  const entered = T.computeTaxYear({ ...p, bracketIndexPct: 3 }, 2028, "2027-06-01").rules.find((r) => r.jur === "federal");
  assert.equal(entered.basis, "assumption");
  assert.match(entered.note, /your entry/);
  assert.ok(T.computeTaxYear({ ...p, bracketIndexPct: 3 }, 2028, "2027-12-01").rules.find((r) => r.jur === "federal").stale, "still stale once the IRS normally publishes");
  assert.doesNotMatch(late.stale.join(" "), /lib\/tax-tables/, "the warning asks for an update, not for a file edit");
});

test("Georgia 2026 is 4.99% with a $15,000 standard deduction (HB 463); an entered rate is your entry", () => {
  const t = TT.taxTables(2026);
  assert.equal(t.ga.rate, 4.99);
  assert.equal(t.ga.standardDeduction, 15_000);
  assert.equal(t.ga.basis, "published");
  // Synthetic full-year Georgia resident on the 2026 tables: 4.99% of income above $15,000.
  const p = { ...base, employmentStart: "2026-01-01", bracketIndexPct: undefined, oneOffs: [] };
  const r26 = T.computeTaxYear(p, 2026, "2026-02-01");
  assert.equal(r26.jurisdictions.find((j) => j.jur === "GA").taxCents, Math.round((12_000_000 - 1_500_000) * 0.0499));
  const rule = r26.rules.find((r) => r.jur === "GA");
  assert.equal(rule.basis, "published");
  assert.match(rule.figures, /4\.99% flat, standard deduction \$15,000/);
  // 2027 depends on the December 1 revenue report: an assumption at 2026's figures, stale once the report is due.
  const t27 = TT.taxTables(2027);
  assert.equal(t27.ga.basis, "assumption");
  assert.equal(t27.ga.rate, 4.99);
  assert.equal(t27.ga.standardDeduction, 15_000);
  assert.match(t27.ga.note, /December 1/);
  assert.equal(T.computeTaxYear(p, 2027, "2026-11-20").rules.find((r) => r.jur === "GA").stale, null);
  assert.ok(T.computeTaxYear(p, 2027, "2026-12-20").rules.find((r) => r.jur === "GA").stale);
  // Your entry replaces the rate for every year and says what the table had.
  const entered = T.computeTaxYear({ ...p, gaRatePct: 4.5 }, 2026, "2026-02-01");
  const er = entered.rules.find((r) => r.jur === "GA");
  assert.equal(er.basis, "override");
  assert.match(er.note, /your entry \(the table has 4\.99% published for 2026\)/);
  assert.equal(entered.jurisdictions.find((j) => j.jur === "GA").taxCents, Math.round((12_000_000 - 1_500_000) * 0.045));
});

test("North Carolina follows the enacted schedule (S.L. 2026-41) with withholding at the rate + 0.10", () => {
  const rates = { 2026: [3.99, 4.09], 2027: [3.49, 3.59], 2029: [3.49, 3.59], 2030: [3.24, 3.34], 2033: [2.99, 3.09] };
  for (const [y, [rate, wh]] of Object.entries(rates)) {
    const nc = TT.taxTables(Number(y)).nc;
    assert.equal(nc.rate, rate, `${y} rate`);
    assert.equal(nc.supplementalRate, wh, `${y} withholding`);
    assert.equal(nc.standardDeduction, 12_750);
    assert.equal(nc.basis, "published");
    if (Number(y) > 2026) assert.match(nc.note, /derived as the rate \+ 0\.10/, `${y} withholding is derived until its NC-30 is issued`);
    else assert.equal(nc.note, null);
  }
  assert.equal(TT.taxTables(2035).nc.basis, "assumption", "the 2035+ triggers are not modeled");
});

test("New York schedules: the statute's dollar amounts at every bracket edge, 2026 and 2027", () => {
  const statute = {
    2026: [[8_500, 332], [11_700, 473], [13_900, 586], [80_650, 4_191], [215_400, 12_141], [1_077_550, 71_198], [5_000_000, 449_714], [25_000_000, 2_509_714]],
    2027: [[8_500, 323], [11_700, 461], [13_900, 572], [80_650, 4_110], [215_400, 11_926], [1_077_550, 70_983], [5_000_000, 449_499], [25_000_000, 2_509_499]],
  };
  for (const [y, list] of Object.entries(statute)) {
    const ny = TT.taxTables(Number(y)).ny;
    assert.equal(ny.basis, "published");
    assert.equal(ny.standardDeduction, 8_000);
    // The statute rounds each step to whole dollars, so the exact schedule is within $2 of its amounts.
    for (const [edge, tax] of list) near(TT.bracketTax(edge, ny.single), tax, 2, `NY ${y} at $${edge}`);
  }
  assert.equal(TT.taxTables(2032).ny.single[4].rate, 5.8);
  assert.equal(TT.taxTables(2033).ny.basis, "assumption", "after 2032 the statute changes the top rates");
});

test("New York recapture: worksheet amounts of IT-2105-I (2026) and each worksheet's rule", () => {
  const ny = TT.taxTables(2026).ny;
  // Worksheets 8, 9, 10 (single): recapture base and incremental benefit.
  const published = [[5, 567, 2_047], [6, 2_614, 30_172], [7, 32_786, 32_500]];
  for (const [k, rb, inc] of published) {
    const a = TT.nyRecaptureAmounts(ny.single, k);
    near(a.base, rb, 2, `worksheet base, bracket ${k}`);
    near(a.incremental, inc, 2, `worksheet incremental, bracket ${k}`);
  }
  const sched = (ti) => TT.bracketTax(ti, ny.single);
  // At or below $107,650 of NY AGI: the schedule.
  assert.equal(TT.nyResidentTax(107_650, 99_650, ny), sched(99_650));
  // Worksheet 7: NY AGI $157,650 or more and taxable income up to $215,400 = 5.90% of all of it.
  near(TT.nyResidentTax(160_000, 152_000, ny), 152_000 * 0.059, 0.01, "worksheet 7, fully phased in");
  // Halfway through the phase-in ($132,650 of NY AGI): half the benefit is taken back.
  const ti = 124_650;
  near(TT.nyResidentTax(132_650, ti, ny), sched(ti) + (ti * 0.059 - sched(ti)) * 0.5, 0.01, "worksheet 7, halfway");
  // Worksheet 8 fully phased in = 6.85% of all taxable income; over $25,000,000 = 10.9% (worksheet 11).
  near(TT.nyResidentTax(300_000, 292_000, ny), 292_000 * 0.0685, 0.01, "worksheet 8, fully phased in");
  near(TT.nyResidentTax(30_000_000, 29_992_000, ny), 29_992_000 * 0.109, 0.01, "worksheet 11");
  // The recapture never lowers the tax.
  for (const agi of [110_000, 140_000, 200_000, 240_000, 1_100_000]) assert.ok(TT.nyResidentTax(agi, agi - 8_000, ny) >= sched(agi - 8_000) - 1e-9);
});

test("part-year allocation: the IT-203 income percentage and the IT-360.1 NYC months", () => {
  // IT-203-I line 45 example: $12,000 / $36,000 = 0.3333.
  assert.equal(TT.round4(12_000 / 36_000), 0.3333);
  // IT-360.1-I examples: moved in April 1 = 9 months; September 4 = 4 months. Half a month or less does not count.
  assert.equal(T.cityResidentMonths("2031-04-01", 2031), 9);
  assert.equal(T.cityResidentMonths("2031-09-04", 2031), 4);
  assert.equal(T.cityResidentMonths("2031-09-16", 2031), 3, "15 of 30 days is not more than half");
  assert.equal(T.cityResidentMonths("2031-09-15", 2031), 4, "16 of 30 days");
  assert.equal(T.cityResidentMonths("2030-07-01", 2031), 12);
  assert.equal(T.cityResidentMonths("2032-01-10", 2031), 0);
  assert.equal(T.cityResidentMonths(null, 2031), 0);
  // NYC tax: resident-period income less the prorated standard deduction (9 months = $6,000 on the chart).
  const p = { ...base, oneOffs: [], moveDate: "2031-04-01" };
  const r = T.computeTaxYear(p, 2031, "2030-12-01");
  const ny = r.jurisdictions.find((j) => j.jur === "NY");
  const nyc = r.jurisdictions.find((j) => j.jur === "NYC");
  const t = TT.taxTables(2031);
  assert.equal(nyc.taxCents, Math.round(TT.bracketTax(ny.incomeCents / 100 - 6_000, t.nyc.single) * 100));
  const nyFull = Math.round(TT.nyResidentTax(r.agiCents / 100, r.agiCents / 100 - 8_000, t.ny) * 100);
  assert.equal(ny.taxCents, Math.round(nyFull * TT.round4(ny.incomeCents / r.agiCents)));
});

test("cash-payment timing: estimated tax due dates move like the official Form 1040-ES dates", () => {
  // 2022 and 2023 Form 1040-ES (April 15 on a weekend + DC Emancipation Day; January 15 on a Sunday / on MLK Day).
  assert.deepEqual(T.taxDueDates(2022), ["2022-04-18", "2022-06-15", "2022-09-15", "2023-01-17"]);
  assert.deepEqual(T.taxDueDates(2023), ["2023-04-18", "2023-06-15", "2023-09-15", "2024-01-16"]);
  // 2026 (IT-2105-I (2026) lists the same four dates).
  assert.deepEqual(T.taxDueDates(2026), ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"]);
  // January 15, 2028 is a Saturday and the Monday is MLK Day.
  assert.deepEqual(T.taxDueDates(2027), ["2027-04-15", "2027-06-15", "2027-09-15", "2028-01-18"]);
  assert.equal(T.taxDueDate("2028-04-15"), "2028-04-18", "Saturday, then Emancipation Day observed on Monday");
  // The cash lines use the moved dates, including "due with the return" once no estimate date is left.
  const p = { ...base, employmentStart: "2027-01-01", oneOffs: [] };
  const r = T.computeTaxYear(p, 2027, "2027-03-01");
  assert.deepEqual(r.payments.filter((x) => x.jur === "GA").map((x) => x.date), ["2027-04-15", "2027-06-15", "2027-09-15", "2028-01-18"]);
  const after = T.computeTaxYear(p, 2027, "2028-01-20").payments.find((x) => x.jur === "GA");
  assert.equal(after.date, "2028-04-18");
  assert.ok(T.taxCashItems(p, [r], "2027-03-01").some((i) => i.id === "tax:2027:GA:2028-01-18"));
});

test("the result names its tables, what is stale and what is left out", () => {
  const r = T.computeTaxYear({ ...base, moveDate: "2031-03-01" }, 2031, "2030-12-01");
  assert.deepEqual(r.rules.map((x) => x.jur), r.jurisdictions.map((j) => j.jur));
  assert.ok(r.rules.every((x) => ["published", "assumption", "override"].includes(x.basis) && x.figures.length > 0));
  assert.ok(r.limitations.length > 0 && r.limitations.some((l) => /recapture/.test(l)));
  assert.equal(r.tablesChecked, TT.TABLES_CHECKED);
  // A year after the last check, the plan asks for the tables to be checked again.
  assert.equal(T.tablesReviewMessage("2027-11-16", "2026-11-16"), null);
  assert.match(T.tablesReviewMessage("2027-11-17", "2026-11-16"), /last checked/);
  const old = T.computeTaxYear(base, 2030, "2030-03-01");
  assert.match(old.tablesReview, /last checked/, "one page-level line");
  assert.ok(!old.stale.some((s) => /last checked/.test(s)), "not repeated in every year's list");
  assert.equal(T.computeTaxYear(base, 2026, "2026-11-20").tablesReview, null);
});

test("a late-month move: other income received after it is New York's, though the NYC month rounds to zero", () => {
  // December 20: 12 of 31 days is not over half a month, so 0 NYC resident months (no NYC standard deduction), but
  // December's other income is received on December 31, after the move. Synthetic $12k a year = $1k a month.
  const p = { ...base, oneOffs: [], moveDate: "2031-12-20", otherIncomeAnnualCents: 1_200_000 };
  assert.equal(T.cityResidentMonths(p.moveDate, 2031), 0);
  assert.equal(T.nyOtherIncomeCents(p, 2031, 1_200_000), 100_000);
  const r = T.computeTaxYear(p, 2031, "2031-06-01");
  const j = Object.fromEntries(r.jurisdictions.map((x) => [x.jur, x]));
  const salary = 12_000_000 / 12;
  assert.equal(j.GA.incomeCents, Math.round(11 * salary + 1_100_000));
  assert.equal(j.NY.incomeCents, Math.round(salary + 100_000), "December's salary and other income");
  assert.equal(j.GA.incomeCents + j.NY.incomeCents, r.agiCents);
  // NYC taxes the resident-period income with no deduction (0 months on the IT-360.1 chart).
  assert.equal(j.NYC.taxCents, Math.round(TT.bracketTax(j.NY.incomeCents / 100, TT.taxTables(2031).nyc.single) * 100));
  // Receipt dates, not rounded months: a move on the 1st of a month and later in it give the same income split.
  assert.equal(T.nyOtherIncomeCents({ ...p, moveDate: "2031-04-01" }, 2031, 1_200_000), 900_000);
  assert.equal(T.nyOtherIncomeCents({ ...p, moveDate: "2031-04-20" }, 2031, 1_200_000), 900_000);
  assert.equal(T.nyOtherIncomeCents({ ...p, moveDate: "2030-07-01" }, 2031, 1_200_000), 1_200_000, "resident all year");
  assert.equal(T.nyOtherIncomeCents({ ...p, moveDate: "2032-01-10" }, 2031, 1_200_000), 0, "moves next year");
  assert.equal(T.nyOtherIncomeCents({ ...p, moveDate: null }, 2031, 1_200_000), 0);
  // A what-if change counts on its own receipt dates: $12k more from March 10, move on November 20.
  const w = { ...p, moveDate: "2031-11-20", otherIncomeAnnualCents: 0, otherIncomeChange: { annualCents: 1_200_000, from: "2031-03-10" } };
  const other = T.otherIncomeFor(w, 2031);
  assert.equal(other, 1_000_000, "March to December receipts");
  assert.equal(T.nyOtherIncomeCents(w, 2031, other), 200_000, "November and December");
});
