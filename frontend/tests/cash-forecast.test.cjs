// Run: node --test tests/cash-forecast.test.cjs
// Cash flow forecast engine (lib/cash-forecast.ts). SYNTHETIC DATA ONLY: every account, merchant, amount and
// date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const F = loadTs("lib/cash-forecast.ts");
const R = loadTs("lib/procurement-recurring.ts");
const TODAY = "2030-06-15";
const NOW = new Date("2030-06-15T12:00:00Z");

const ACCOUNTS = [
  { account_key: "chk", account_type: "Cash", label: "Demo Checking" },
  { account_key: "sav", account_type: "Cash", label: "Demo Savings" },
  { account_key: "card", account_type: "Credit Card", label: "Demo Card" },
  { account_key: "promo", account_type: "Credit Card", label: "Demo Promo Card" },
  { account_key: "inv", account_type: "Investment", label: "Demo 401k" },
];
const bal = (account_key, cents, kind = "asset", at = "2030-06-15T06:00:00Z") => ({
  account_key, captured_at: at, balance_cents: cents, currency: "USD", kind,
});
const BALANCES = [bal("chk", 500_000), bal("sav", 1_000_000), bal("card", 200_000, "liability"), bal("promo", 500_000, "liability"), bal("inv", 5_000_000)];
const tx = (account_key, txn_date, amount_cents, name, over = {}) => ({
  account_key, txn_date, amount_cents, name, custom_name: null, currency: "USD", category: "Shopping", ignored_from: null, ...over,
});
const months = ["2029-11", "2029-12", "2030-01", "2030-02", "2030-03", "2030-04", "2030-05"];
const monthEnd = (key) => F.lastBusinessDayOfMonth(Number(key.slice(0, 4)), Number(key.slice(5, 7)));

/** Paycheck on the last business day of each month; everyday debit spending; card payments on the 20th. */
function world(extra = []) {
  const txns = [];
  for (const m of months) txns.push(tx("chk", monthEnd(m), -800_000, "DEMO EMPLOYER PAYROLL", { category: "Paycheck" }));
  // Everyday: two debits a week for 30 weeks, at changing shops (so no shop looks like a schedule), $100 a week.
  for (let w = 0; w < 30; w++) {
    const d = R.addDays(TODAY, -7 * w - 1);
    txns.push(tx("chk", d, 3_000 + (w % 3) * 1_000, `DEMO SHOP ${w}`), tx("chk", R.addDays(d, -2), 7_000 - (w % 3) * 1_000, `DEMO DINER ${w}`));
  }
  // Card payments from checking, paired with the card side.
  for (const [i, m] of ["2030-02", "2030-03", "2030-04", "2030-05"].entries()) {
    const d = F.nextBusinessDay(`${m}-20`);
    const amt = 150_000 + 10_000 * i;
    txns.push(tx("chk", d, amt, "DEMO CARD AUTOPAY", { category: "Credit Card Payment" }));
    txns.push(tx("card", d, -amt, "PAYMENT THANK YOU", { category: "Credit Card Payment" }));
    txns.push(tx("card", `${m}-05`, 120_000, "DEMO STORE"));
  }
  return [...txns, ...extra];
}
const run = (over = {}) =>
  F.forecastCash({ today: TODAY, now: NOW, accounts: ACCOUNTS, txns: world(over.extra), balances: BALANCES, settings: { paths: 120 }, ...over });

test("the sign conversion is the one place ledger cents flip", () => {
  assert.equal(F.toBalanceDelta(1234), -1234);
  assert.equal(F.toBalanceDelta(-500), 500);
});

test("bank holidays and business days", () => {
  assert.equal(F.isBusinessDay("2026-11-26"), false); // Thanksgiving
  assert.equal(F.isBusinessDay("2026-07-03"), true); // July 4 on a Saturday is not moved
  assert.equal(F.isBusinessDay("2023-01-02"), false); // Jan 1 on a Sunday -> Monday
  assert.equal(F.lastBusinessDayOfMonth(2026, 5), "2026-05-29");
  assert.equal(F.previousBusinessDay("2026-05-31"), "2026-05-29");
  assert.equal(F.nextBusinessDay("2026-11-26"), "2026-11-27");
});

test("schedules: month end, monthly day, and a skipped cycle does not break scoring", () => {
  assert.equal(F.nextOnSchedule({ kind: "month-end" }, "2026-04-30", 15), "2026-05-29");
  const s = { kind: "monthly-day", day: 20, every: 1, anchorMonth: "2026-01", adjust: "next" };
  assert.equal(F.nextOnSchedule(s, "2026-01-20", 15), "2026-02-20");
  const dates = ["2026-01-30", "2026-02-27", "2026-04-30", "2026-05-29"]; // March missing
  assert.equal(F.scoreSchedule({ kind: "month-end" }, dates, 15).maxMiss, 0);
});

test("a month-end paycheck is detected, and a bonus paid on payday does not change the usual amount", () => {
  const bonusDay = monthEnd("2030-01");
  const out = run({ extra: [tx("chk", bonusDay, -5_000_000, "DEMO EMPLOYER PAYROLL", { category: "Paycheck" })] });
  const pay = out.streams.find((s) => s.kind === "income");
  assert.ok(pay, "paycheck stream");
  assert.equal(pay.cadence, "monthly");
  assert.equal(pay.typicalCents, 800_000);
  assert.equal(pay.certainty, "confirmed");
  assert.equal(pay.next, monthEnd("2030-06"));
  assert.ok(out.notes.some((n) => /unusual/.test(n)), "bonus noted as unusual");
  const payLines = out.lines.filter((l) => l.sourceId === pay.id);
  assert.ok(payLines.length >= 11 && payLines.every((l) => l.amountCents === 800_000));
});

test("a biweekly deposit is projected every 14 days", () => {
  const extra = [];
  for (let k = 0; k < 8; k++) extra.push(tx("sav", R.addDays("2030-06-07", -14 * k), -20_000, "DEMO SIDE GIG", { category: "Income" }));
  const out = run({ extra });
  const s = out.streams.find((x) => x.label.toLowerCase().includes("side gig"));
  assert.ok(s);
  assert.equal(s.next, "2030-06-21");
  assert.equal(s.typicalCents, 20_000);
});

test("everyday spending: mean weekly net flow, internal transfers and one-offs left out", () => {
  const extra = [
    tx("chk", "2030-06-01", 100_000, "TO SAVINGS", { category: "Internal Transfers" }),
    tx("sav", "2030-06-01", -100_000, "FROM CHECKING", { category: "Internal Transfers" }),
    tx("chk", "2030-05-02", 300_000, "DEMO MOVERS DEPOSIT", { category: "Moving" }),
    tx("chk", "2030-05-09", -400_000, "DEMO TAX REFUND", { category: "Income" }),
    tx("chk", "2030-05-12", 26_000, "DEMO IGNORED PURCHASE", { ignored_from: "budget" }),
  ];
  const out = run({ extra });
  assert.equal(out.baseline.projected, true);
  // Large money out stays in the mean (300k + the 26k ignored row over 26 weeks); the large refund does not.
  assert.equal(out.baseline.weeklyMeanCents, Math.round(-10_000 - (300_000 + 26_000) / 26));
  assert.equal(out.baseline.oneOffs, 1);
  assert.ok(out.notes.some((n) => /unusually large deposit/.test(n)));
});

test("card payments follow what was paid, on the usual day", () => {
  const out = run();
  const card = out.streams.find((s) => s.kind === "card");
  assert.ok(card);
  assert.equal(card.typicalCents, -170_000); // mean of the last 3 payments: 160k, 170k, 180k
  assert.equal(card.next, F.nextBusinessDay("2030-06-20"));
  // The everyday baseline does not also count the card payments.
  assert.equal(out.baseline.weeklyMeanCents, -10_000);
});

test("planned items: projected, matched when they happen, late money in dropped, late money out kept", () => {
  const extra = [tx("chk", "2030-06-11", 200_000, "DEMO LANDLORD DEPOSIT", { category: "Rent" })];
  const planned = [
    { id: "bonus", label: "Bonus", date: "2030-07-31", amountCents: 5_000_000, certainty: "likely" },
    { id: "deposit", label: "Apartment deposit", date: "2030-06-10", amountCents: -200_000, certainty: "confirmed" },
    { id: "refund", label: "Refund", date: "2030-05-20", amountCents: 100_000, certainty: "confirmed" },
    { id: "fee", label: "Fee", date: "2030-05-20", amountCents: -50_000, certainty: "confirmed" },
  ];
  const out = run({ extra, planned });
  const st = Object.fromEntries(out.planned.map((p) => [p.id, p]));
  assert.equal(st.deposit.status, "realized");
  assert.equal(st.deposit.matchedDate, "2030-06-11");
  assert.equal(st.refund.status, "late-dropped");
  assert.equal(st.fee.status, "late-kept");
  assert.equal(st.bonus.status, "upcoming");
  assert.ok(out.lines.some((l) => l.sourceId === "bonus" && l.date === "2030-07-31"));
  assert.ok(out.lines.some((l) => l.sourceId === "fee" && l.date === "2030-06-16"));
  assert.ok(!out.lines.some((l) => l.sourceId === "refund"));
  // The likely line has the "likely" bonus; the low band does not.
  const aug = out.days.find((d) => d.date === "2030-08-01");
  assert.ok(aug.likely - aug.low > 4_000_000);
});

test("a stream can be stopped from a date (for example the old rent after a move)", () => {
  const out = run();
  const pay = out.streams.find((s) => s.kind === "income");
  const stopped = run({ adjustments: [{ streamId: pay.id, from: "2030-09-01", stop: true }] });
  assert.ok(stopped.lines.filter((l) => l.sourceId === pay.id).every((l) => l.date < "2030-09-01"));
});

test("headlines and bands", () => {
  const out = run({ settings: { paths: 120, bufferCents: 100_000 } });
  assert.equal(out.state, "ok");
  assert.equal(out.opening.cents, 1_500_000);
  const short = out.days.slice(0, 91);
  assert.equal(out.headlines.lowest.cents, Math.min(...short.map((d) => d.low)));
  assert.equal(out.headlines.safeToMoveCents, Math.max(0, Math.min(1_500_000, out.headlines.lowest.cents) - 100_000));
  assert.ok(out.days.every((d) => d.low <= d.likely && d.likely <= d.high));
  assert.equal(out.days.length, 365);
  assert.ok(out.weeks.length === 13 && out.months.length >= 12);
});

test("deterministic: the same input draws the same forecast", () => {
  assert.deepEqual(run().days, run().days);
});

test("staleness, no pool, no balance", () => {
  const stale = F.forecastCash({ today: TODAY, now: new Date("2030-06-20T00:00:00Z"), accounts: ACCOUNTS, txns: world(), balances: BALANCES, settings: { paths: 60 } });
  assert.equal(stale.opening.stale, true);
  assert.equal(F.forecastCash({ today: TODAY, accounts: ACCOUNTS.filter((a) => a.account_type !== "Cash"), txns: [], balances: [] }).state, "no-pool");
  assert.equal(F.forecastCash({ today: TODAY, accounts: ACCOUNTS, txns: [], balances: [] }).state, "no-balance");
});

test("promo end dates are read from balance-transfer text", () => {
  assert.deepEqual(F.parsePromo("DEMO BANK ******9999BT CA APR 0.00% EXPIRES 08/2031"), { promoEnds: "2031-08-31", promoAprPct: 0 });
  assert.deepEqual(F.parsePromo("BALANCE TRANSFER APR 1.99% EXPIRES 2/2031"), { promoEnds: "2031-02-28", promoAprPct: 1.99 });
  assert.equal(F.parsePromo("BAL XFR. DEMO BANK - ALL PRODUCT"), null);
  assert.equal(F.parsePromo("DEMO GIFT CARD EXPIRES 08/2031"), null);
});

test("card projection: effective APR from interest, promo end from the transfer row, interest accrues", () => {
  const extra = [
    tx("card", "2030-04-28", 3_000, "INTEREST CHARGE ON PURCHASES", { category: "Fees" }),
    tx("card", "2030-05-28", 3_000, "INTEREST CHARGE ON PURCHASES", { category: "Fees" }),
    tx("card", "2030-06-01", 3_000, "INTEREST CHARGE ON PURCHASES", { category: "Fees" }),
    tx("promo", "2030-01-10", 500_000, "DEMO BANK ******9999BT CA APR 0.00% EXPIRES 02/2031", { category: "Credit Card Payment" }),
  ];
  const out = run({ extra });
  const card = out.cards.find((c) => c.account_key === "card");
  assert.equal(card.aprPct, 18); // 9,000 x 4 / 200,000
  assert.ok(card.interestNext12Cents > 0);
  const promo = out.cards.find((c) => c.account_key === "promo");
  assert.equal(promo.promoEnds, "2031-02-28");
  assert.equal(promo.months[0].interest, 0);
  assert.ok(promo.months.find((m) => m.month === "2031-03").interest > 0);
  assert.ok(promo.warnings.some((w) => /Promo ends 2031-02-28/.test(w)));
  assert.ok(promo.warnings.some((w) => /Standard APR/.test(w)));
});

test("net worth: investments grow at the expected return, cards and cash included", () => {
  const out = run();
  assert.equal(out.netWorth.length, 12);
  const last = out.netWorth[11];
  assert.ok(Math.abs(last.investments - 5_250_000) <= 2);
  assert.equal(last.netWorth, last.cash + last.investments - last.cardsOwed);
  const withContrib = run({ growth: [{ account_key: "inv", returnPct: 0, monthlyContributionCents: 10_000, contributionStarts: "2031-01-01" }] });
  assert.equal(withContrib.netWorth[11].investments, 5_000_000 + 10_000 * 6);
});

test("backtest helpers", () => {
  const pool = [tx("chk", "2030-06-10", 10_000, "X"), tx("chk", "2030-06-12", -50_000, "Y"), tx("chk", "2030-06-01", 99, "Z")];
  assert.equal(F.poolBalanceAt(pool, 1_000_000, "2030-06-15", "2030-06-05"), 1_000_000 + 10_000 - 50_000);
  const sum = F.summarizeBacktest([
    { horizonDays: 7, likely: 110, low: 90, high: 130, actual: 100, scale: 100 },
    { horizonDays: 7, likely: 80, low: 85, high: 120, actual: 80, scale: 100 },
  ]);
  assert.equal(sum[0].n, 2);
  assert.equal(sum[0].medianAbsErrorPct, 5);
  assert.equal(sum[0].belowLowPct, 50);
});

test("the engine is pure: no clock, no network, no Supabase", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/cash-forecast.ts"), "utf8");
  assert.ok(!/Date\.now\(/.test(src));
  assert.ok(!/new Date\(\)/.test(src));
  assert.ok(!/fetch\(|from\s+["'][^"']*supabase|["']server-only["']/i.test(src));
});
