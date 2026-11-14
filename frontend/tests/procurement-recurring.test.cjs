// Run: node --test tests/procurement-recurring.test.cjs
// Recurring-charge detection (lib/procurement-recurring.ts) and its server loader
// (lib/procurement-recurring-server.ts, run against an in-memory stand-in).
// SYNTHETIC DATA ONLY: every merchant, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/procurement-recurring.ts");
const TODAY = "2030-06-15";

const tx = (over) => ({
  txn_date: "2030-06-01", name: "Demo Service", custom_name: null, amount_cents: 1000,
  currency: "USD", category: "Entertainment", ignored_from: null, ...over,
});
/** `n` dates ending `endAgo` days before TODAY, `gap` days apart (oldest first). */
const series = (n, gap, endAgo) =>
  Array.from({ length: n }, (_, i) => R.addDays(TODAY, -endAgo - gap * (n - 1 - i)));
const charges = (dates, amounts, over = {}) =>
  dates.map((d, i) => tx({ txn_date: d, amount_cents: Array.isArray(amounts) ? amounts[i] : amounts, ...over }));

test("a clean monthly charge is detected and active", () => {
  const out = R.detectRecurring(charges(series(5, 30, 10), 1299, { name: "Demo Streaming" }), TODAY);
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.merchant, "Demo Streaming");
  assert.equal(s.cadence, "monthly");
  assert.equal(s.typicalCents, 1299);
  assert.equal(s.lastCharge, R.addDays(TODAY, -10));
  assert.equal(s.nextExpected, R.addDays(TODAY, 20));
  assert.equal(s.chargeCount, 5);
  assert.equal(s.monthlyCents, 1299);
  assert.equal(s.status, "active");
  assert.equal(R.activeMonthlyTotal(out), 1299);
});

test("an annual charge seen twice is detected; one sighting is not", () => {
  const out = R.detectRecurring(charges(["2029-03-01", "2030-03-01"], 12000), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, "annual");
  assert.equal(out[0].nextExpected, "2031-03-01");
  assert.equal(out[0].monthlyCents, 1000);
  assert.equal(out[0].status, "active");
  assert.deepEqual(R.detectRecurring(charges(["2030-03-01"], 12000), TODAY), []);
});

test("monthly needs three charges", () => {
  assert.deepEqual(R.detectRecurring(charges(series(2, 30, 10), 1000), TODAY), []);
});

test("a weekly charge converts to a monthly equivalent", () => {
  const out = R.detectRecurring(charges(series(4, 7, 3), 500), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, "weekly");
  assert.equal(out[0].monthlyCents, Math.round((500 * 52) / 12));
  assert.equal(out[0].status, "active");
});

test("a quarterly charge is detected and divided by three", () => {
  const out = R.detectRecurring(charges(series(3, 91, 20), 3000), TODAY);
  assert.equal(out[0].cadence, "quarterly");
  assert.equal(out[0].monthlyCents, 1000);
});

test("a monthly with one price increase still counts", () => {
  const out = R.detectRecurring(charges(series(5, 30, 5), [1000, 1000, 1000, 1000, 1200]), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].typicalCents, 1000);
});

test("wildly different amounts are not a subscription", () => {
  assert.deepEqual(R.detectRecurring(charges(series(5, 30, 5), [1000, 1000, 1000, 1000, 5000]), TODAY), []);
});

test("irregular shopping at one merchant is not detected", () => {
  const dates = ["2030-01-03", "2030-01-06", "2030-02-17", "2030-03-01", "2030-05-30"];
  assert.deepEqual(R.detectRecurring(charges(dates, [1000, 1100, 900, 1000, 1050]), TODAY), []);
});

test("refunds and negative amounts are ignored", () => {
  const rows = [...charges(series(4, 30, 10), 1000), tx({ txn_date: "2030-05-20", amount_cents: -1000 })];
  const out = R.detectRecurring(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].chargeCount, 4);
  assert.deepEqual(R.detectRecurring(charges(series(5, 30, 10), -1000), TODAY), []);
});

test("ignored rows and transfer categories are excluded", () => {
  assert.deepEqual(R.detectRecurring(charges(series(5, 30, 10), 1000, { ignored_from: "budget" }), TODAY), []);
  for (const category of ["Internal Transfers", "Credit Card Payment"]) {
    assert.deepEqual(R.detectRecurring(charges(series(5, 30, 10), 1000, { category }), TODAY), [], category);
  }
});

test("a non-USD merchant is excluded and currencies are never mixed", () => {
  assert.deepEqual(R.detectRecurring(charges(series(5, 30, 10), 1000, { currency: "CAD" }), TODAY), []);
  const mixed = [...charges(series(3, 30, 40), 1000), ...charges(series(2, 30, 10), 1000, { currency: "EUR" })];
  assert.equal(R.detectRecurring(mixed, TODAY)[0]?.chargeCount ?? 0, 3);
});

test("a subscription that stopped three months ago is lapsed", () => {
  const out = R.detectRecurring(charges(series(5, 30, 95), 1000), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "lapsed");
  assert.equal(R.activeMonthlyTotal(out), 0);
});

test("a charge a few days overdue is still active (within half a cycle)", () => {
  const out = R.detectRecurring(charges(series(4, 30, 40), 1000), TODAY); // next expected 10 days ago
  assert.equal(out[0].status, "active");
});

test("store-number spellings of one merchant merge", () => {
  const names = ["Demo Market #1234", "DEMO MARKET  #98", "demo market 556677", "Demo Market #1234"];
  const rows = series(4, 30, 10).map((d, i) => tx({ txn_date: d, name: names[i] }));
  const out = R.detectRecurring(rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].chargeCount, 4);
  assert.equal(out[0].merchant, "Demo Market");
});

test("custom_name wins over the raw name", () => {
  const rows = charges(series(4, 30, 10), 2500, { name: "RAW 8812 DESCRIPTOR", custom_name: "Demo Gym" });
  assert.equal(R.detectRecurring(rows, TODAY)[0].merchant, "Demo Gym");
});

test("active first, then monthly-equivalent descending", () => {
  const rows = [
    ...charges(series(4, 30, 10), 500, { name: "Small Active" }),
    ...charges(series(4, 30, 12), 2000, { name: "Big Active" }),
    ...charges(series(4, 30, 120), 9000, { name: "Big Lapsed" }),
  ];
  const out = R.detectRecurring(rows, TODAY);
  assert.deepEqual(out.map((s) => s.merchant), ["Big Active", "Small Active", "Big Lapsed"]);
  assert.equal(R.activeMonthlyTotal(out), 2500);
});

test("empty input and malformed rows", () => {
  assert.deepEqual(R.detectRecurring([], TODAY), []);
  assert.equal(R.parseRecurringInput(null), null);
  assert.equal(R.parseRecurringInput({ txn_date: "nope", amount_cents: 5 }), null);
  assert.equal(R.parseRecurringInput({ txn_date: "2030-01-01", amount_cents: "x" }), null);
  assert.equal(R.parseRecurringInput({ txn_date: "2030-01-01", amount_cents: "1200", name: "Demo" }).amount_cents, 1200);
});

// ─── next-charge estimate: method, confidence, no date for irregular repeats ─────────────────
const monthlyOn = (day, months, over = {}) =>
  charges(months.map((m) => `2030-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`), 1500, over);

test("same day each month: calendar method, high confidence, exact date", () => {
  const s = R.detectRecurring(monthlyOn(17, [1, 2, 3, 4, 5]), TODAY)[0];
  assert.equal(s.nextExpected, "2030-06-17");
  assert.match(s.nextMethod, /same day of the month/);
  assert.equal(s.confidence, "high");
  assert.equal(s.maxMissDays, 0);
  assert.equal(s.checkedGaps, 4);
  assert.match(s.id, /^[0-9a-f]{16}$/);
});

test("a fixed 28-day cycle uses the interval method, not the calendar", () => {
  const s = R.detectRecurring(charges(series(6, 28, 5), 900), TODAY)[0];
  assert.equal(s.cadence, "monthly");
  assert.match(s.nextMethod, /every 28 days/);
  assert.equal(s.nextExpected, R.addDays(TODAY, 23));
  assert.equal(s.confidence, "high");
});

test("one charge posted two days late does not move the estimate", () => {
  const rows = charges(["2030-02-05", "2030-03-05", "2030-04-05", "2030-05-07"], 1000);
  const s = R.detectRecurring(rows, "2030-05-20")[0];
  assert.equal(s.nextExpected, "2030-06-05");
  assert.equal(s.maxMissDays, 2);
  assert.equal(s.confidence, "high");
});

test("month-end billing is clamped to the last day of a short month", () => {
  assert.equal(R.addMonths("2030-01-31", 1), "2030-02-28");
  assert.equal(R.addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(R.addMonths("2030-11-30", 3), "2031-02-28");
  assert.equal(R.addMonths("2030-12-15", 1), "2031-01-15");
  const s = R.detectRecurring(charges(["2030-01-31", "2030-02-28", "2030-03-31", "2030-04-30"], 700), "2030-05-10")[0];
  assert.equal(s.nextExpected, "2030-05-31");
  const on30th = R.detectRecurring(charges(["2030-01-30", "2030-02-28", "2030-03-30", "2030-04-30"], 700), "2030-05-10")[0];
  assert.equal(on30th.nextExpected, "2030-05-30");
  const intoFeb = R.detectRecurring(charges(["2029-10-31", "2029-11-30", "2029-12-31", "2030-01-31"], 700), "2030-02-10")[0];
  assert.equal(intoFeb.nextExpected, "2030-02-28");
});

test("wobbly spacing is low confidence; fairly steady is medium", () => {
  const wobbly = R.detectRecurring(charges(["2030-01-01", "2030-02-05", "2030-03-03", "2030-04-07", "2030-05-02"], 1000), "2030-05-10")[0];
  assert.equal(wobbly.confidence, "low");
  const steady = R.detectRecurring(charges(["2030-01-10", "2030-02-13", "2030-03-12", "2030-04-12"], 1000), "2030-04-20")[0];
  assert.equal(steady.confidence, "medium");
});

test("an annual charge seen twice is medium confidence at best", () => {
  const s = R.detectRecurring(charges(["2029-03-01", "2030-03-01"], 12000), TODAY)[0];
  assert.equal(s.confidence, "medium");
  assert.equal(s.checkedGaps, 1);
  assert.match(s.nextMethod, /one year after/);
});

test("the id is stable per merchant and differs between merchants", () => {
  const a = R.detectRecurring(charges(series(4, 30, 10), 1000, { name: "Demo Alpha #12" }), TODAY)[0];
  const again = R.detectRecurring(charges(series(5, 30, 10), 1100, { name: "DEMO ALPHA #77" }), TODAY)[0];
  const b = R.detectRecurring(charges(series(4, 30, 10), 1000, { name: "Demo Beta" }), TODAY)[0];
  assert.equal(a.id, again.id);
  assert.notEqual(a.id, b.id);
  assert.equal(R.stableId("demo alpha"), a.id);
});

test("a same-price charge on no schedule is listed as irregular, with no date", () => {
  const dates = ["2030-01-04", "2030-01-25", "2030-03-20", "2030-04-02", "2030-05-28"];
  const rows = charges(dates, 2000, { name: "Demo Top-up" });
  assert.deepEqual(R.detectRecurring(rows, TODAY), []);
  const out = R.detectIrregular(rows, TODAY);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ["chargeCount", "id", "lastCharge", "medianGapDays", "merchant", "typicalCents"]);
  assert.equal(out[0].merchant, "Demo Top-up");
  assert.equal(out[0].typicalCents, 2000);
  assert.equal(out[0].chargeCount, 5);
  assert.equal(out[0].lastCharge, "2030-05-28");
});

test("irregular: varying amounts, too few charges, frequent visits, old or regular ones are left out", () => {
  const dates = ["2030-01-04", "2030-01-25", "2030-03-20", "2030-04-02", "2030-05-28"];
  assert.deepEqual(R.detectIrregular(charges(dates, [1000, 1400, 800, 1000, 1250]), TODAY), [], "amounts vary");
  assert.deepEqual(R.detectIrregular(charges(dates.slice(0, 3), 2000), TODAY), [], "three charges");
  assert.deepEqual(R.detectIrregular(charges(series(8, 3, 2), 600), TODAY), [], "every few days");
  assert.deepEqual(R.detectIrregular(charges(dates, 2000), "2031-06-15"), [], "last charge long ago");
  assert.deepEqual(R.detectIrregular(charges(series(5, 30, 10), 1000), TODAY), [], "already a regular subscription");
  assert.deepEqual(R.detectIrregular(charges(dates, 2000, { ignored_from: "budget" }), TODAY), [], "ignored rows");
  assert.deepEqual(R.detectIrregular(charges(dates, 2000, { currency: "EUR" }), TODAY), [], "not USD");
  assert.deepEqual(R.detectIrregular(charges(dates, -2000), TODAY), [], "refunds");
});

// ─── server loader: three distinct states ─────────────────────────────────────────────────────
function loader({ rows, error, configured = true }) {
  class LedgerQueryError extends Error {
    constructor(code) { super(code ?? "query failed"); this.code = code; }
  }
  const logged = [];
  const stubs = {
    "server-only": {},
    "@/lib/format": { etDate: (iso) => iso.slice(0, 10) },
    "@/lib/finance-ledger-server": {
      LedgerQueryError,
      serviceClient: () => { if (!configured) throw new LedgerQueryError("not-configured"); return {}; },
      fetchPaged: async () => { if (error) throw new LedgerQueryError(error); return { rows, truncated: false }; },
    },
  };
  const origErr = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  const mod = loadTs("lib/procurement-recurring-server.ts", stubs);
  return { run: async () => { try { return await mod.loadDetectedSubscriptions(new Date(`${TODAY}T15:00:00Z`)); } finally { console.error = origErr; } }, logged };
}

test("loader: data, empty and failed query are three distinct states", async () => {
  const ok = await loader({ rows: charges(series(5, 30, 10), 1299) }).run();
  assert.equal(ok.state, "ok");
  assert.equal(ok.subs.length, 1);
  assert.equal(ok.total, 1299);
  assert.equal(ok.today, TODAY);
  assert.deepEqual(ok.irregular, []);

  const empty = await loader({ rows: [] }).run();
  assert.deepEqual(empty, { state: "empty" });

  const failing = loader({ error: "42501", rows: [] });
  const err = await failing.run();
  assert.deepEqual(err, { state: "error", code: "42501" });
  assert.equal(failing.logged.length, 1);
  assert.match(failing.logged[0], /42501/);

  const noKey = await loader({ rows: [], configured: false }).run();
  assert.deepEqual(noKey, { state: "error", code: "not-configured" });
});

test("loader: rows with data but no recurrence is ok with zero subs, not empty", async () => {
  const res = await loader({ rows: [tx({ txn_date: "2030-06-01" })] }).run();
  assert.equal(res.state, "ok");
  assert.equal(res.subs.length, 0);
});
