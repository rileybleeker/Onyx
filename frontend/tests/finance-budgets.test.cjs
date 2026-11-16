// Run: node --test tests/finance-budgets.test.cjs
// Budgets, category fixes and money alerts (lib/finance-budgets.ts, lib/finance-categories.ts,
// lib/finance-alerts.ts). SYNTHETIC DATA ONLY: invented merchants, amounts and dates.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const B = loadTs("lib/finance-budgets.ts");
const C = loadTs("lib/finance-categories.ts");
const A = loadTs("lib/finance-alerts.ts");

const TODAY = "2030-06-15";
let n = 0;
const tx = (txn_date, amount_cents, name, category, over = {}) => ({
  txn_key: `k${n++}`, account_key: "card", txn_date, name, custom_name: null, amount_cents, currency: "USD", category, ignored_from: null, ...over,
});
function world() {
  const rows = [];
  for (const m of ["2030-03", "2030-04", "2030-05"]) {
    rows.push(tx(`${m}-05`, 20_000, "DEMO DINER", "Dining & Drinks"), tx(`${m}-20`, 20_000, "DEMO BISTRO", "Dining & Drinks"));
    rows.push(tx(`${m}-10`, 30_000, "DEMO GROCER", "Groceries"));
    rows.push(tx(`${m}-28`, -500_000, "DEMO EMPLOYER", "Income"));
    rows.push(tx(`${m}-25`, 100_000, "DEMO CARD PAYMENT", "Credit Card Payment"));
  }
  rows.push(tx("2030-06-03", 30_000, "DEMO DINER", "Dining & Drinks"), tx("2030-06-10", 30_000, "DEMO BISTRO", "Dining & Drinks"));
  rows.push(tx("2030-06-08", 10_000, "DEMO GROCER", "Groceries"));
  rows.push(tx("2030-06-12", 4_000, "DEMO NEW SHOP", null), tx("2030-05-12", 6_000, "DEMO NEW SHOP", null));
  return rows;
}

test("spending by category, pace, projection and suggested budget", () => {
  const r = B.computeBudgets(world(), new Map([["Dining & Drinks", 40_000]]), TODAY);
  const dining = r.lines.find((l) => l.category === "Dining & Drinks");
  assert.equal(dining.spentCents, 60_000);
  assert.equal(dining.avg3Cents, 40_000);
  assert.equal(dining.suggestedCents, 40_000);
  assert.equal(dining.status, "over");
  assert.equal(dining.sameDaysAvgCents, 20_000); // only the 5th falls in days 1-15
  const groceries = r.lines.find((l) => l.category === "Groceries");
  assert.equal(groceries.status, "none");
  assert.equal(groceries.projectedCents, Math.round(10_000 + 30_000 * (15 / 30)));
  // Card payments are not spending; income is not a budget line.
  assert.ok(!r.lines.some((l) => l.category === "Credit Card Payment" || l.category === "Income"));
  assert.equal(r.incomeAvg3Cents, 500_000);
  assert.ok(r.increases.some((x) => x.category === "Dining & Drinks"));
  assert.equal(r.topMerchants[0].cents, 30_000);
  assert.equal(r.uncategorized.length, 1);
  assert.equal(r.uncategorized[0].count, 2);
  assert.equal(r.total.spentCents, 60_000 + 10_000 + 4_000);
});

test("an overall budget and category budgets roll up", () => {
  const r = B.computeBudgets(world(), new Map([[B.TOTAL_KEY, 50_000]]), TODAY);
  assert.equal(r.total.budgetCents, 50_000);
  assert.equal(r.total.status, "over");
  const r2 = B.computeBudgets(world(), new Map([["Groceries", 30_000], ["Dining & Drinks", 50_000]]), TODAY);
  assert.equal(r2.total.budgetCents, 80_000);
});

test("category fixes: one-off override wins over a merchant rule, which wins over the source", () => {
  const fixes = { rules: new Map([["demo new shop", "Shopping"]]), overrides: new Map([["t1", "Gifts"]]) };
  assert.equal(C.fixedCategory({ txn_key: "t0", name: "DEMO NEW SHOP #123", category: null }, fixes), "Shopping");
  assert.equal(C.fixedCategory({ txn_key: "t1", name: "DEMO NEW SHOP", category: null }, fixes), "Gifts");
  assert.equal(C.fixedCategory({ txn_key: "t2", name: "OTHER", category: "Travel" }, fixes), "Travel");
  const rows = C.applyFixes([{ txn_key: "t0", name: "DEMO NEW SHOP", category: null }], fixes);
  assert.equal(rows[0].category, "Shopping");
  assert.equal(C.isCategoryName("Dining & Drinks"), true);
  assert.equal(C.isCategoryName("<script>"), false);
  assert.ok(C.categoryOptions(["Custom Thing"]).includes("Custom Thing"));
});

test("money alerts: low cash, promo, tax due, budget", () => {
  const days = Array.from({ length: 40 }, (_, i) => ({ date: `2030-06-${String(16 + (i % 14)).padStart(2, "0")}`, likely: 50_000, low: i === 10 ? -20_000 : 10_000, high: 90_000 }));
  const forecast = {
    state: "ok",
    days,
    milestones: [{ label: "Demo Card", date: "2030-07-20", daysAway: 35, ended: false, owedAtEndCents: 300_000, interestPerMonthAfterCents: 6_000 }],
    lines: [{ sourceId: "tax:2030:GA:2030-06-20", label: "Georgia estimated tax 2030 (calculated)", amountCents: -100_000, date: "2030-06-20" }],
  };
  const budgets = B.computeBudgets(world(), new Map([["Dining & Drinks", 40_000]]), TODAY);
  const alerts = A.moneyAlerts(forecast, budgets, 0, TODAY);
  const kinds = alerts.map((a) => a.kind);
  assert.ok(kinds.includes("low-cash"));
  assert.ok(kinds.includes("promo"));
  assert.ok(kinds.includes("tax"));
  assert.ok(kinds.includes("budget"));
  assert.equal(alerts[0].severity, "high");
  // Each dated alert carries its own date, so Today can rank an imminent deadline as urgent (lib/today-attention.ts).
  const due = Object.fromEntries(alerts.filter((a) => a.kind !== "budget").map((a) => [a.kind, a.due]));
  assert.deepEqual(due, { "low-cash": "2030-06-26", promo: "2030-07-20", tax: "2030-06-20" });
  assert.ok(alerts.filter((a) => a.kind === "budget").every((a) => a.due === undefined), "a budget has no single day");
  assert.equal(A.moneyAlerts(null, null, 0, TODAY).length, 0);
});

test("money alerts: low cash is dated by the first day below the line; the lowest day is kept for the title", () => {
  // Below the line on day 1 already, lowest on day 21: Today must treat day 1 as the deadline.
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: `2030-06-${String(1 + i).padStart(2, "0")}`,
    likely: i >= 20 ? -5_000 : 20_000,
    low: i === 0 ? -1_000 : i === 20 ? -50_000 : i < 20 ? 5_000 : -10_000,
    high: 90_000,
  }));
  const [cash] = A.moneyAlerts({ state: "ok", days, milestones: [], lines: [] }, null, 0, TODAY);
  assert.equal(cash.kind, "low-cash");
  assert.equal(cash.due, "2030-06-01", "the first day the cautious path is below the line");
  assert.equal(cash.lowest, "2030-06-21", "the lowest day, which the title names");
  assert.match(cash.title, /around Jun 21$/);
  assert.equal(cash.severity, "high");
  assert.equal(cash.likelyDue, "2030-06-21", "the first day the likely path is below the line");
});

test("money alerts: the likely path below the line before the cautious low point is dated and counted as likely", () => {
  // Likely negative on day 2 only; the cautious path is lowest on day 21, where the likely balance is above the line.
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: `2030-06-${String(1 + i).padStart(2, "0")}`,
    likely: i === 1 ? -2_000 : 20_000,
    low: i === 1 ? -3_000 : i === 20 ? -40_000 : 5_000,
    high: 90_000,
  }));
  const [cash] = A.moneyAlerts({ state: "ok", days, milestones: [], lines: [] }, null, 0, TODAY);
  assert.equal(cash.due, "2030-06-02");
  assert.equal(cash.lowest, "2030-06-21");
  assert.equal(cash.likelyDue, "2030-06-02");
  assert.equal(cash.severity, "high", "the likely path breaches, even though not on the lowest cautious day");
  assert.match(cash.detail, /likely below it around Jun 2\)/);
  // The likely path never below the line: no likelyDue, medium.
  const calm = days.map((d) => ({ ...d, likely: 20_000 }));
  const [cautious] = A.moneyAlerts({ state: "ok", days: calm, milestones: [], lines: [] }, null, 0, TODAY);
  assert.equal(cautious.likelyDue, undefined);
  assert.equal(cautious.severity, "medium");
});

test("savings goals: progress, monthly need and the forecast check", () => {
  const G = loadTs("lib/finance-goals.ts");
  const days = [{ date: "2031-03-01", likely: 900_000, low: 0, high: 0 }];
  const out = G.computeGoals(
    [
      { id: "g1", name: "Demo move fund", target_cents: 1_000_000, target_date: "2031-03-01", account_key: null },
      { id: "g2", name: "Demo cushion", target_cents: 300_000, target_date: "2030-12-15", account_key: "sav" },
    ],
    new Map([["sav", 150_000]]),
    new Map([["sav", "Demo Savings"]]),
    400_000,
    days,
    "2030-06-15",
  );
  assert.equal(out[0].pct, 40);
  assert.equal(out[0].monthsLeft, 8);
  assert.equal(out[0].perMonthNeededCents, 75_000);
  assert.equal(out[0].onTrack, false); // forecast has 900k on the date, target 1M
  assert.equal(out[1].accountLabel, "Demo Savings");
  assert.equal(out[1].projectedCents, null);
  assert.equal(out[1].perMonthNeededCents, 25_000);
});

test("cancel tracker: waiting, stopped, still charging", () => {
  const S = loadTs("lib/finance-subscriptions.ts");
  const sub = (id, lastCharge, nextExpected) => ({ id, merchant: `Demo ${id}`, cadence: "monthly", typicalCents: 1_500, monthlyCents: 1_500, lastCharge, nextExpected, status: "active" });
  const subs = [sub("aaaaaaaaaaaaaaaa", "2030-05-20", "2030-06-20"), sub("bbbbbbbbbbbbbbbb", "2030-04-01", "2030-05-01"), sub("cccccccccccccccc", "2030-06-10", "2030-07-10")];
  const marks = new Map([["aaaaaaaaaaaaaaaa", "2030-06-01"], ["bbbbbbbbbbbbbbbb", "2030-04-15"], ["cccccccccccccccc", "2030-06-01"]]);
  const v = Object.fromEntries(S.subscriptionViews(subs, marks, "2030-06-15").map((x) => [x.id, x]));
  assert.equal(v.aaaaaaaaaaaaaaaa.state, "waiting");
  assert.equal(v.bbbbbbbbbbbbbbbb.state, "stopped");
  assert.equal(v.cccccccccccccccc.state, "still-charging");
  assert.match(v.aaaaaaaaaaaaaaaa.cancelSearchUrl, /^https:\/\/www\.google\.com\/search\?q=how%20to%20cancel/);
  assert.equal(S.activeMonthly(Object.values(v)), 3_000);
});

test("review and rules group per-charge codes under one merchant; interest is not a subscription", () => {
  const rows = [
    tx("2030-06-02", 2_000, "PWP DEMO.COM DEMOCOM abc123XYZ RILEY", null),
    tx("2030-06-03", 3_000, "PWP DEMO.COM DEMOCOM zz9QQ8 RILEY", null),
  ];
  const r = B.computeBudgets(rows, new Map(), TODAY);
  assert.equal(r.uncategorized.length, 1);
  assert.equal(r.uncategorized[0].count, 2);
  const key = r.uncategorized[0].key;
  const fixes = { rules: new Map([[key, "Shopping"]]), overrides: new Map() };
  assert.equal(C.fixedCategory({ txn_key: "z", name: "PWP DEMO.COM DEMOCOM newcode77 RILEY", category: null }, fixes), "Shopping");
  const S = loadTs("lib/finance-subscriptions.ts");
  const views = S.subscriptionViews([{ id: "dddddddddddddddd", merchant: "Interest Charge on Demo Purchases", cadence: "monthly", typicalCents: 100, monthlyCents: 100, lastCharge: "2030-06-01", nextExpected: "2030-07-01", status: "active" }], new Map(), TODAY);
  assert.equal(views.length, 0);
});

test("move plan: rent change from the first rent after the move, one-offs around it", () => {
  const P = loadTs("lib/finance-plan.ts");
  const m = P.parseMovePlan({ date: "2031-03-10", currentRentCents: 200_000, newRentCents: 350_000, movingCostsCents: 300_000, depositCents: 350_000, depositRefundCents: 200_000, livingCostChangeCents: 20_000 });
  assert.equal(m.months, 24);
  const items = Object.fromEntries(P.moveItems(m).map((i) => [i.id, i]));
  assert.equal(items["move:rent"].date, "2031-04-01");
  assert.equal(items["move:rent"].amountCents, -150_000);
  assert.equal(items["move:rent"].repeat.count, 24);
  assert.equal(items["move:costs"].amountCents, -300_000);
  assert.equal(items["move:deposit"].date, "2031-02-24");
  assert.equal(items["move:refund"].amountCents, 200_000);
  assert.equal(items["move:col"].amountCents, -20_000);
  assert.equal(P.moveItems(m, "2031-06-01").find((i) => i.id === "move:rent").date, "2031-06-01");
  assert.equal(P.parseMovePlan({ date: "bad" }), null);
  assert.equal(P.parseMovePlan({ date: "2031-03-10", newRentCents: 1.5 }), null);
});
