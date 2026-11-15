// Run: node --test tests/supplement-writes.test.cjs
// /supplements write receipts (Codex review #191, UI item 1): "Saved" only after the server answered OK, a
// failed write stays listed with Retry, Retry adopts a row the server wrote although its answer was lost
// (no duplicate), a failed read never empties the list, and stack "undo all" keeps what was not deleted.
// SYNTHETIC DATA ONLY: invented products and ids; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const W = loadTs("lib/supplement-writes.ts");
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const write = (over = {}) => W.newWrite({
  id: "w1", kind: "intake", label: "Synthetic Magnesium", date: "2031-03-05", time: "2031-03-05T21:41:03.123Z",
  productId: "p-mag", body: {}, knownIds: [1, 2], ...over,
});
const row = (intake_id, over = {}) => ({
  intake_id, intake_date: "2031-03-05", intake_time: "2031-03-05T21:41:03.123+00:00", product_id: "p-mag", notes: null, ...over,
});

// ─── pure rules ───────────────────────────────────────────────────────────────

test("findSavedCopy adopts the unknown row with the same product, day and instant", () => {
  assert.deepEqual(W.findSavedCopy(write(), [row(1), row(2), row(7)], new Set()), [7]);
});

test("findSavedCopy never adopts a row that was on screen, claimed by another write, or differs", () => {
  const w = write();
  assert.deepEqual(W.findSavedCopy(w, [row(1), row(2)], new Set()), [], "rows on screen when sent");
  assert.deepEqual(W.findSavedCopy(w, [row(7)], new Set([7])), [], "claimed by another write");
  assert.deepEqual(W.findSavedCopy(w, [row(7, { product_id: "p-other" })], new Set()), [], "other product");
  assert.deepEqual(W.findSavedCopy(w, [row(7, { intake_date: "2031-03-04" })], new Set()), [], "other day");
  assert.deepEqual(W.findSavedCopy(w, [row(7, { intake_time: "2031-03-05T21:41:04.123Z" })], new Set()), [], "other instant");
  assert.deepEqual(W.findSavedCopy(write({ time: null }), [row(7, { intake_time: null })], new Set()), [], "no clock time: nothing to match on");
});

test("findSavedCopy: one intake write is one row; a stack write is all rows with its note", () => {
  assert.deepEqual(W.findSavedCopy(write(), [row(7), row(8)], new Set()), [7]);
  const stack = write({ kind: "stack", productId: null, stackName: "Synthetic Night" });
  const note = W.stackNote("Synthetic Night");
  assert.deepEqual(W.findSavedCopy(stack, [row(7, { notes: note }), row(8, { notes: note, product_id: "p-zinc" }), row(9)], new Set()), [7, 8]);
});

test("claimedIds collects the saved ids of every other write", () => {
  const a = { ...write({ id: "a" }), savedIds: [7] };
  const b = { ...write({ id: "b" }), savedIds: [8, 9] };
  assert.deepEqual([...W.claimedIds([a, b], "a")].sort(), [8, 9]);
});

test("receiptText says Saving / Saved / Not saved with the day", () => {
  const short = (d) => `short:${d}`;
  const w = write({ date: TODAY });
  assert.equal(W.receiptText(w, TODAY, short), "Saving Synthetic Magnesium…");
  assert.equal(W.receiptText({ ...w, status: "saved" }, TODAY, short), "Saved Synthetic Magnesium · today");
  assert.equal(W.receiptText({ ...w, date: "2031-03-04", status: "failed" }, TODAY, short), "Not saved: Synthetic Magnesium · short:2031-03-04");
});

test("batchUndoResult splits confirmed and refused deletes", () => {
  assert.deepEqual(W.batchUndoResult([4, 5, 6], [true, false, true]), { removed: [4, 6], failed: [5] });
});

// ─── the real page ────────────────────────────────────────────────────────────

const PRODUCT = { product_id: "p-mag", dsld_id: null, brand_name: "Synthetic Brand", full_name: "Synthetic Magnesium", upc_sku: null, serving_size: 1, serving_unit: "tablet", physical_state: null, ingredient_count: 1, categories: [] };
const STACK = { stack_id: 3, name: "Synthetic Night", description: null, remind_time: null, items: [], item_count: 3, total_doses: 3 };

function mountPage(t, { onPost, onDelete, today = () => ({ date: TODAY, intakes: [], compounds: [] }), products = () => response({ products: [PRODUCT] }), extraStubs = {} } = {}) {
  const calls = { posts: [], deletes: [], todayGets: 0 };
  withGlobals(t, {
    confirm: () => true,
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        const body = JSON.parse(init.body);
        calls.posts.push({ url, body });
        return onPost ? onPost(url, body, calls.posts.length) : response({ intake_id: 100 + calls.posts.length });
      }
      if (method === "DELETE") {
        calls.deletes.push(url);
        return onDelete ? onDelete(url, calls.deletes.length) : response({ ok: true });
      }
      if (url === "/api/behavioral-today") return response({ behavioral_today: TODAY });
      if (url === "/api/supplements/products") return products();
      if (url === "/api/supplements/today") { calls.todayGets++; const r = today(calls.todayGets); return typeof r?.json === "function" ? r : response(r); }
      if (url.startsWith("/api/supplements/history")) return response({ rows: [] });
      if (url === "/api/supplements/stacks") return response({ stacks: [STACK] });
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });
  const passthrough = (p) => ({ type: "section", props: { children: [p.title, " ", p.subtitle, p.children] } });
  const none = { __esModule: true, default: () => null };
  const h = mountClient("app/supplements/SupplementsClient.tsx", {
    stubs: {
      "next/dynamic": { __esModule: true, default: () => () => null },
      "lucide-react": { Check: () => null, X: () => null },
      "@/lib/queries": { rangeDays: () => 30, rangeLabel: () => "30 days" },
      "@/components/StatCard": none,
      "@/components/RangeFilter": none,
      "@/components/EditIntakeModal": none,
      "@/components/StackEditorModal": none,
      "@/components/CustomSupplementFlow": none,
      "@/components/ChartCard": { __esModule: true, default: passthrough },
      // /supplements is a personalized page since #267; the grid and table use React context, which this hook
      // shim does not provide. Same passthrough as tests/range-load.test.cjs; no assertion reads the totals table.
      "@/components/personalize/PartGrid": { PartGrid: ({ children }) => children, PartGroup: ({ children }) => children, Part: ({ children }) => children },
      "@/components/personalize/PersonalTable": none,
      ...extraStubs,
    },
  });
  t.after(() => h.unmount());
  const productButton = () => h.find((n) => n.type === "button" && h.text(n).includes("Synthetic Magnesium") && h.text(n).includes("ingredients"))[0];
  const stackButton = () => h.find((n) => n.type === "button" && h.text(n).includes("Synthetic Night") && h.text(n).includes("Log"))[0];
  return { ...h, calls, tapProduct: () => productButton().props.onClick(), tapStack: () => stackButton().props.onClick() };
}

test("page: no Saved before the server answers; Saved after an OK answer", async (t) => {
  const pending = deferred();
  const h = mountPage(t, { onPost: () => pending.promise });
  await h.flush();
  const tap = h.tapProduct();
  await h.flush();
  assert.match(h.text(), /Saving…/);
  assert.doesNotMatch(h.text(), /Saved/);
  pending.resolve(response({ intake_id: 501 }));
  await tap; await h.flush();
  assert.match(h.text(), /Saved/);
  assert.doesNotMatch(h.text(), /Saving…/);
  assert.doesNotMatch(h.text(), /Not saved/);
});

test("page: a refused write stays listed as Not saved until Retry succeeds", async (t) => {
  const h = mountPage(t, { onPost: (_u, _b, n) => (n === 1 ? response({ error: "synthetic" }, 500) : response({ intake_id: 502 })) });
  await h.flush();
  await h.tapProduct(); await h.flush();
  assert.match(h.text(), /Not saved: Synthetic Magnesium · today/);
  assert.doesNotMatch(h.text(), /Saving…/, "a failed row is not shown as saving");
  await h.click("Retry"); await h.flush();
  assert.equal(h.calls.posts.length, 2);
  assert.deepEqual(h.calls.posts[1].body, h.calls.posts[0].body, "Retry re-sends the same request");
  assert.doesNotMatch(h.text(), /Not saved/);
});

test("page: Retry after a lost answer adopts the row the server wrote instead of writing it twice", async (t) => {
  let written = null;
  const h = mountPage(t, {
    onPost: async (_u, body) => { written = body; throw new TypeError("synthetic network failure"); },
    today: () => ({ date: TODAY, compounds: [], intakes: written ? [{ intake_id: 777, intake_date: written.intake_date, intake_time: written.intake_time, product_id: written.product_id, doses: 1, notes: null, brand_name: null, full_name: "Synthetic Magnesium" }] : [] }),
  });
  await h.flush();
  await h.tapProduct(); await h.flush();
  assert.match(h.text(), /Not saved: Synthetic Magnesium/);
  await h.click("Retry"); await h.flush();
  assert.equal(h.calls.posts.length, 1, "no second POST");
  assert.doesNotMatch(h.text(), /Not saved/);
  assert.match(h.text(), /1 saved/);
});

test("page: a failed refresh keeps the rows already on screen", async (t) => {
  withGlobals(t, { console: { ...console, error: () => {} } });
  const h = mountPage(t, {
    today: (n) => (n === 1 ? { date: TODAY, compounds: [], intakes: [{ intake_id: 9, intake_date: TODAY, intake_time: null, product_id: "p-mag", doses: 1, notes: null, brand_name: null, full_name: "Synthetic Magnesium" }] } : response({ error: "x" }, 500)),
  });
  await h.flush();
  assert.match(h.text(), /1 saved/);
  // The debounced refresh after a save answers 500.
  await h.tapProduct();
  await new Promise((r) => setTimeout(r, 450));
  await h.flush();
  assert.match(h.text(), /2 saved/, "the confirmed row plus the earlier one; the 500 changed nothing");
});

test("page: stack undo keeps the bar until deletes are confirmed and keeps what was not deleted", async (t) => {
  const h = mountPage(t, {
    onPost: () => response({ ok: true, intake_ids: [41, 42, 43] }),
    onDelete: (url, n) => (n === 2 ? response({ error: "x" }, 500) : response({ ok: true })),
  });
  await h.flush();
  await h.tapStack(); await h.flush();
  assert.match(h.text(), /Saved.*Synthetic Night · 3 products/);
  await h.click("undo all"); await h.flush();
  assert.equal(h.calls.deletes.length, 3);
  assert.match(h.text(), /Not removed: 1 intake from Synthetic Night/);
  await h.click("retry undo"); await h.flush();
  assert.equal(h.calls.deletes.length, 4);
  assert.match(h.calls.deletes[3], /intake_id=42$/, "only the refused delete is tried again");
  assert.doesNotMatch(h.text(), /Synthetic Night · 3 products|Not removed/);
});

test("page: this device's cached copy shows before the server answers, and the answer is stored (speed, 2026-11-15)", async (t) => {
  const day = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());
  const held = deferred();
  const store = new Map([
    ["/api/supplements/products", { products: [PRODUCT] }],
    ["/api/supplements/today", { date: day, intakes: [], compounds: [] }],
  ]);
  const stored = [];
  const clientCache = {
    peek: (k) => store.get(k),
    read: async (k) => store.get(k),
    put: (k, v) => { stored.push(k); store.set(k, v); return true; },
  };
  const h = mountPage(t, { products: () => held.promise, extraStubs: { "@/lib/client-cache": { clientCache } } });
  await h.flush();
  assert.ok(h.find((n) => n.type === "button" && h.text(n).includes("Synthetic Magnesium")).length > 0, "the cached product list is on screen while the read is pending");
  held.resolve(response({ products: [PRODUCT] }));
  await h.flush();
  assert.deepEqual([...stored].sort(), ["/api/supplements/products", "/api/supplements/today"]);
});

test("page: a cached copy for another day is not shown (speed, 2026-11-15)", async (t) => {
  const held = deferred();
  const store = new Map([
    ["/api/supplements/products", { products: [PRODUCT] }],
    ["/api/supplements/today", { date: "2001-01-01", intakes: [], compounds: [] }],
  ]);
  const clientCache = { peek: (k) => store.get(k), read: async (k) => store.get(k), put: () => true };
  const h = mountPage(t, { products: () => held.promise, extraStubs: { "@/lib/client-cache": { clientCache } } });
  await h.flush();
  assert.equal(h.find((n) => n.type === "button" && h.text(n).includes("Synthetic Magnesium")).length, 0, "nothing from yesterday's copy");
  held.resolve(response({ products: [PRODUCT] }));
  await h.flush();
});
