// Run: node --test tests/procurement-reorder.test.cjs
// Purchase suggestions on /procurement: lib/procurement-reorder.ts (pure rules), its server loader
// (run against an in-memory stand-in) and the card component's source.
// SYNTHETIC DATA ONLY: every store, item and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/procurement-reorder.ts");
const TODAY = "2030-06-15";
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
const order = (item, ago, over = {}) => ({ merchant: "Demo Store", items: Array.isArray(item) ? item : [item], orderedOn: daysAgo(ago), status: "delivered", ...over });
/** `n` orders of one item, `gap` days apart, the last one `lastAgo` days before TODAY. */
const repeat = (item, n, gap, lastAgo, over = {}) => Array.from({ length: n }, (_, i) => order(item, lastAgo + gap * (n - 1 - i), over));
const suggest = (orders) => P.reorderSuggestions(orders, TODAY);
const only = (orders) => { const r = suggest(orders); assert.equal(r.suggestions.length, 1); return r.suggestions[0]; };

test("an item ordered every 30 days and last ordered 29 days ago is likely due, with the reason", () => {
  const s = only(repeat("Demo Protein Powder 2 lb", 4, 30, 29));
  assert.equal(s.item, "Demo Protein Powder 2 lb");
  assert.equal(s.merchant, "Demo Store");
  assert.equal(s.purchases, 4);
  assert.equal(s.intervalDays, 30);
  assert.equal(s.lastOrdered, daysAgo(29));
  assert.equal(s.daysSince, 29);
  assert.equal(s.dueOn, daysAgo(-1));
  assert.equal(s.status, "due");
  assert.equal(s.regularity, "steady");
  assert.match(s.reason, /^Ordered 4 times, last from Demo Store; usually reordered every ~30 days \(always 30 days apart\)\. Last ordered [A-Z][a-z]{2} \d{1,2}, 2030, 29 days ago\. Likely due about now\.$/);
});

test("status moves with the share of the interval that has passed", () => {
  assert.equal(only(repeat("Demo Filter", 3, 40, 10)).status, "later");
  assert.match(only(repeat("Demo Filter", 3, 40, 10)).reason, /Due in about 30 days\.$/);
  assert.equal(only(repeat("Demo Filter", 3, 40, 27)).status, "later", "67%");
  assert.equal(only(repeat("Demo Filter", 3, 40, 28)).status, "soon", "70%");
  assert.equal(only(repeat("Demo Filter", 3, 40, 35)).status, "soon", "87%");
  assert.equal(only(repeat("Demo Filter", 3, 40, 36)).status, "due", "90%");
  const overdue = only(repeat("Demo Filter", 3, 40, 55));
  assert.equal(overdue.status, "due");
  assert.match(overdue.reason, /Likely due: 15 days past the usual interval\.$/);
});

test("the interval is the median gap, and uneven gaps are called a rough figure", () => {
  const orders = [order("Demo Soap", 200), order("Demo Soap", 170), order("Demo Soap", 100), order("Demo Soap", 62), order("Demo Soap", 30)];
  const s = only(orders); // gaps 30, 70, 38, 32
  assert.equal(s.intervalDays, 35);
  assert.deepEqual([s.minGapDays, s.maxGapDays], [30, 70]);
  assert.equal(s.regularity, "rough");
  assert.match(s.reason, /every ~35 days \(gaps of 30 to 70 days, so a rough figure\)/);
  const steady = only([order("Demo Soap", 100), order("Demo Soap", 68), order("Demo Soap", 30)]); // gaps 32, 38
  assert.equal(steady.regularity, "steady");
  assert.match(steady.reason, /\(gaps of 32 to 38 days\)/);
});

test("one or two purchases are not a pattern; two are counted as left out", () => {
  assert.deepEqual(suggest([order("Demo Lamp", 40)]), { suggestions: [], boughtTwice: 0, stopped: 0 });
  assert.deepEqual(suggest(repeat("Demo Lamp", 2, 30, 20)), { suggestions: [], boughtTwice: 1, stopped: 0 });
  assert.equal(suggest(repeat("Demo Lamp", 3, 30, 20)).suggestions.length, 1);
});

test("orders within three days of each other are one occasion", () => {
  // A split shipment / the same order seen twice must not make a 1-day "interval".
  const orders = [order("Demo Tea", 91), order("Demo Tea", 90), order("Demo Tea", 60), order("Demo Tea", 58), order("Demo Tea", 30)];
  const s = only(orders);
  assert.equal(s.purchases, 3);
  assert.equal(s.intervalDays, 31);
  // Three orders in one week are a single occasion, not a pattern.
  assert.deepEqual(suggest([order("Demo Tea", 12), order("Demo Tea", 10), order("Demo Tea", 8)]).suggestions, []);
});

test("an item listed twice in one order counts once", () => {
  const orders = [order(["Demo Tea", "demo tea"], 90), order("Demo Tea", 60), order("Demo Tea", 30)];
  assert.equal(only(orders).purchases, 3);
});

test("spelling differences in case, spacing and punctuation are the same item; the latest spelling is shown", () => {
  const orders = [order("DEMO  Vitamin-D3 (5000 IU)", 100), order("demo vitamin d3 5000 iu", 70), order("Demo Vitamin D3, 5000 IU", 40)];
  const s = only(orders);
  assert.equal(s.purchases, 3);
  assert.equal(s.item, "Demo Vitamin D3, 5000 IU");
  assert.equal(P.normalizeItem("  DEMO  Vitamin-D3 (5000 IU) "), "demo vitamin d3 5000 iu");
  assert.equal(P.normalizeItem("2.5% Demo"), "2.5% demo");
});

test("the same item from two stores is one item, named after the store it was last ordered from", () => {
  const orders = [order("Demo Razor Blades", 120, { merchant: "Demo Store" }), order("Demo Razor Blades", 80, { merchant: "Other Shop" }), order("Demo Razor Blades", 40, { merchant: "Other Shop" })];
  const s = only(orders);
  assert.equal(s.merchant, "Other Shop");
  assert.match(s.reason, /last from Other Shop/);
});

test("canceled orders, future dates and unusable rows never count", () => {
  const orders = [
    ...repeat("Demo Coffee", 2, 30, 30),
    order("Demo Coffee", 5, { status: "canceled" }),
    order("Demo Coffee", -3),
    { merchant: "Demo Store", items: ["Demo Coffee"], orderedOn: "not-a-date", status: "delivered" },
    order("", 10), order("ab", 10),
  ];
  assert.deepEqual(suggest(orders), { suggestions: [], boughtTwice: 1, stopped: 0 });
});

test("something not ordered for more than three intervals is treated as stopped", () => {
  assert.equal(only(repeat("Demo Wipes", 3, 30, 90)).status, "due", "exactly three intervals is still listed");
  assert.deepEqual(suggest(repeat("Demo Wipes", 3, 30, 91)), { suggestions: [], boughtTwice: 0, stopped: 1 });
});

test("a pattern shorter than a week is not a reorder interval", () => {
  assert.deepEqual(suggest(repeat("Demo Snack", 5, 5, 2)).suggestions, []);
  assert.equal(suggest(repeat("Demo Snack", 5, 7, 2)).suggestions.length, 1);
});

test("due first, then due soon, then later; soonest due date first within a group", () => {
  const orders = [
    ...repeat("Demo Later", 3, 60, 10), ...repeat("Demo Soon", 3, 40, 30), ...repeat("Demo Due B", 3, 30, 28), ...repeat("Demo Due A", 3, 30, 45),
  ];
  assert.deepEqual(suggest(orders).suggestions.map((s) => [s.item, s.status]), [
    ["Demo Due A", "due"], ["Demo Due B", "due"], ["Demo Soon", "soon"], ["Demo Later", "later"],
  ]);
});

test("a suggestion carries no price, link or address", () => {
  const s = only(repeat("Demo Protein Powder 2 lb", 4, 30, 29));
  assert.deepEqual(Object.keys(s).sort(), ["daysSince", "dueOn", "intervalDays", "item", "key", "lastOrdered", "maxGapDays", "merchant", "minGapDays", "purchases", "reason", "regularity", "status"]);
  assert.doesNotMatch(JSON.stringify(s), /https?:|\$|cart|checkout/i);
});

test("parseOrderInput: the order day comes from ordered / shipped / first seen, in that order", () => {
  const toDay = (iso) => iso.slice(0, 10);
  const row = { merchant_name: " Demo Store ", items: ["Demo Tea", "", 5], status: "shipped", ordered_at: null, shipped_at: "2030-05-02T10:00:00Z", first_event_at: "2030-05-01T10:00:00Z" };
  assert.deepEqual(P.parseOrderInput(row, toDay), { merchant: "Demo Store", items: ["Demo Tea"], orderedOn: "2030-05-02", status: "shipped" });
  assert.equal(P.parseOrderInput({ ...row, ordered_at: "2030-04-30T23:00:00Z" }, toDay).orderedOn, "2030-04-30");
  assert.equal(P.parseOrderInput({ ...row, shipped_at: null, first_event_at: "nope" }, toDay), null);
  assert.equal(P.parseOrderInput(null, toDay), null);
  assert.deepEqual(P.parseOrderInput({ ...row, items: "x" }, toDay).items, []);
});

// ─── server loader: data / empty / not connected / failed are distinct ───────────────────────
function loader({ rows = [], error = null, configured = true }) {
  class LedgerQueryError extends Error {
    constructor(code) { super(code ?? "query failed"); this.code = code; }
  }
  const logged = [];
  const seen = {};
  const stubs = {
    "server-only": {},
    "@/lib/format": { etDate: (iso) => iso.slice(0, 10) },
    "@/lib/finance-ledger-server": {
      LedgerQueryError,
      serviceClient: () => {
        if (!configured) throw new LedgerQueryError("not-configured");
        const b = { select(cols) { seen.cols = cols; return b; }, gte(col) { seen.since = col; return b; }, order() { return b; }, range() { return b; } };
        return { from(table) { seen.table = table; return b; } };
      },
      fetchPaged: async (build) => { build(0, 999); if (error) throw new LedgerQueryError(error); return { rows, truncated: false }; },
    },
  };
  const mod = loadTs("lib/procurement-reorder-server.ts", stubs);
  const run = async () => {
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    try { return await mod.loadReorderSuggestions(new Date(`${TODAY}T15:00:00Z`)); } finally { console.error = orig; }
  };
  return { run, logged, seen };
}
const dbRow = (item, ago, over = {}) => ({
  order_key: `o:demo:${item}:${ago}`, merchant_name: "Demo Store", items: [item], status: "delivered",
  ordered_at: `${daysAgo(ago)}T12:00:00Z`, shipped_at: null, first_event_at: `${daysAgo(ago)}T12:00:00Z`, ...over,
});

test("loader: reads item names, store and dates only, and returns the suggestions", async () => {
  const l = loader({ rows: [dbRow("Demo Tea", 90), dbRow("Demo Tea", 60), dbRow("Demo Tea", 31), dbRow("Demo Lamp", 20)] });
  const res = await l.run();
  assert.equal(res.state, "ok");
  assert.equal(res.today, TODAY);
  assert.equal(res.orders, 4);
  assert.deepEqual(res.suggestions.map((s) => [s.item, s.status]), [["Demo Tea", "due"]]);
  assert.equal(l.seen.table, "online_orders");
  assert.equal(l.seen.cols, "order_key,merchant_name,items,status,ordered_at,shipped_at,first_event_at");
});

test("loader: empty history, a missing table and a failed query are three different states", async () => {
  assert.deepEqual(await loader({ rows: [] }).run(), { state: "empty" });
  assert.deepEqual(await loader({ rows: [dbRow("x", 5, { items: [] })] }).run(), { state: "empty" }, "orders without item names");
  for (const code of ["42P01", "PGRST205"]) assert.deepEqual(await loader({ error: code }).run(), { state: "not_connected" });
  const failing = loader({ error: "42501" });
  assert.deepEqual(await failing.run(), { state: "error", code: "42501" });
  assert.equal(failing.logged.length, 1);
  assert.match(failing.logged[0], /42501/);
  assert.deepEqual(await loader({ configured: false }).run(), { state: "error", code: "not-configured" });
});

test("loader: history with no repeats is ok with zero suggestions, not empty", async () => {
  const res = await loader({ rows: [dbRow("Demo Lamp", 20)] }).run();
  assert.equal(res.state, "ok");
  assert.deepEqual(res.suggestions, []);
});

// ─── advice only: no cart, no link, no model ─────────────────────────────────────────────────
test("the card makes no request and links nowhere; the code calls no model and has no order function", () => {
  const card = fs.readFileSync(path.join(SRC, "app/procurement/ReorderSuggestions.tsx"), "utf8");
  assert.doesNotMatch(card, /\bfetch\(|https?:\/\/|<a\b|href=|<Link\b|<button\b|<form\b|onClick/, "no request, link, button or form");
  assert.doesNotMatch(card, /add to cart|checkout|buy now|place order/i);
  for (const file of ["lib/procurement-reorder.ts", "lib/procurement-reorder-server.ts"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.doesNotMatch(src, /anthropic-ai|openai|@ai-sdk|messages\.create|\bfetch\(|https?:\/\//, file);
    assert.doesNotMatch(src, /delivery_order|finance_/, `${file}: restaurant delivery and the ledger are not read here`);
    assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\(/, `${file}: read-only`);
  }
  const FORBIDDEN = /^(place|submit|buy|purchase|checkout|pay|order|cancel|subscribe|charge|execute|approve)/i;
  for (const key of Object.keys(P)) if (typeof P[key] === "function") assert.doesNotMatch(key, FORBIDDEN, key);
});
