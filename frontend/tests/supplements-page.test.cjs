// Run: node --test tests/supplements-page.test.cjs
// /supplements after "one place to enter data" (2026-11-15): the page manages the library (stacks, products, add /
// scan) and corrects logged intakes (edit, delete); intakes and stacks are logged on /log only, so the page has no
// tap-to-log control. Also: a refused delete stays listed with Retry, a failed read never empties the list, and
// this device's cached copy paints first (speed, 2026-11-15).
// SYNTHETIC DATA ONLY: invented products and ids; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const SRC = path.join(__dirname, "..", "src");
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const PRODUCT = { product_id: "p-mag", dsld_id: null, brand_name: "Synthetic Brand", full_name: "Synthetic Magnesium", upc_sku: null, serving_size: 1, serving_unit: "tablet", physical_state: null, ingredient_count: 1, categories: [] };
const STACK = { stack_id: 3, name: "Synthetic Night", description: null, remind_time: null, items: [], item_count: 3, total_doses: 3 };
const intake = (intake_id, over = {}) => ({ intake_id, intake_date: TODAY, intake_time: null, product_id: "p-mag", doses: 1, notes: null, brand_name: null, full_name: "Synthetic Magnesium", ...over });

function mountPage(t, { onDelete, today = () => ({ date: TODAY, intakes: [], compounds: [] }), products = () => response({ products: [PRODUCT] }), stacks = () => response({ stacks: [STACK] }), extraStubs = {} } = {}) {
  const calls = { posts: [], deletes: [], todayGets: 0 };
  withGlobals(t, {
    confirm: () => true,
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        calls.posts.push({ url, method });
        return response({ ok: true });
      }
      if (method === "DELETE") {
        calls.deletes.push(url);
        return onDelete ? onDelete(url, calls.deletes.length) : response({ ok: true });
      }
      if (url === "/api/behavioral-today") return response({ behavioral_today: TODAY });
      if (url === "/api/supplements/products") return products();
      if (url === "/api/supplements/today") { calls.todayGets++; const r = today(calls.todayGets); return typeof r?.json === "function" ? r : response(r); }
      if (url.startsWith("/api/supplements/history")) return response({ rows: [] });
      if (url === "/api/supplements/stacks") return stacks();
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
      "@/components/LogLink": none,
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
  return { ...h, calls };
}

test("source: no tap-to-log on /supplements; the header links to Log's Supplements section", () => {
  const src = fs.readFileSync(path.join(SRC, "app/supplements/SupplementsClient.tsx"), "utf8");
  assert.equal(/stacks\/log|function logIntake|function logStack|undoLastBatch|supplement-writes/.test(src), false);
  assert.match(src, /<LogLink part="supplements">/);
  // The add-product step may still log the first dose of a NEW product (Log cannot add products).
  assert.match(src, /async function seedAndOptionallyLog\(/);
  assert.equal(fs.existsSync(path.join(SRC, "lib/supplement-writes.ts")), false, "the receipt helpers went with the tap-to-log buttons");
});

test("page: products and stacks are listed without a log button, and opening the page writes nothing", async (t) => {
  const h = mountPage(t);
  await h.flush();
  assert.match(h.text(), /Synthetic Magnesium/);
  assert.match(h.text(), /Synthetic Night/);
  assert.equal(h.find((n) => n.type === "button" && /Synthetic Magnesium|Synthetic Night/.test(h.text(n))).length, 0, "no row is a button");
  assert.equal(h.buttons("Log").length, 0);
  assert.equal(h.buttons("edit").length, 1, "the stack can still be edited");
  assert.equal(h.buttons("Remove product").length, 1, "a product can still be removed from the list");
  assert.equal(h.calls.posts.length, 0);
});

test("page: a refused delete puts the row back and stays listed until Retry succeeds", async (t) => {
  withGlobals(t, { console: { ...console, error: () => {} } });
  const h = mountPage(t, {
    today: () => ({ date: TODAY, compounds: [], intakes: [intake(9)] }),
    onDelete: (_u, n) => (n === 1 ? response({ error: "synthetic" }, 500) : response({ ok: true })),
  });
  await h.flush();
  assert.match(h.text(), /1 logged/);
  await h.click("delete"); await h.flush();
  assert.match(h.text(), /Not deleted: Synthetic Magnesium \(still logged\)/);
  assert.match(h.text(), /1 logged/, "the row is back");
  await h.click("Retry"); await h.flush();
  assert.equal(h.calls.deletes.length, 2);
  assert.match(h.calls.deletes[1], /intake_id=9$/);
  // The bar entry is gone and the row with it; the first failure's toast may still be fading (2.5 s), so match the bar's text.
  assert.doesNotMatch(h.text(), /\(still logged\)/);
  assert.match(h.text(), /No intakes logged today yet/);
});

test("page: a failed refresh keeps the rows already on screen", async (t) => {
  withGlobals(t, { console: { ...console, error: () => {} } });
  const h = mountPage(t, {
    today: (n) => (n === 1 ? { date: TODAY, compounds: [], intakes: [intake(9), intake(10)] } : response({ error: "x" }, 500)),
  });
  await h.flush();
  assert.match(h.text(), /2 logged/);
  // The debounced refresh after a delete answers 500.
  await h.click("delete");
  await new Promise((r) => setTimeout(r, 450));
  await h.flush();
  assert.match(h.text(), /1 logged/, "the deleted row is gone and the other stays; the 500 changed nothing");
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
  assert.match(h.text(), /Synthetic Magnesium/, "the cached product list is on screen while the read is pending");
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
  assert.doesNotMatch(h.text(), /Synthetic Magnesium/, "nothing from yesterday's copy");
  held.resolve(response({ products: [PRODUCT] }));
  await h.flush();
});

// Codex review (PR 365): a failed read of the stack list after the editor saved must not re-enable Edit with the old
// list (its version would only meet a false 409 on the next change). Edit waits, and the card offers Retry.
test("page: a failed read of the stacks after a save keeps Edit disabled, with Retry, until a read works", async (t) => {
  withGlobals(t, { console: { ...console, error: () => {} } });
  const editor = {};
  let reads = 0;
  const h = mountPage(t, {
    stacks: () => { reads++; return reads === 2 ? response({ error: "synthetic" }, 500) : response({ stacks: [STACK] }); },
    extraStubs: { "@/components/StackEditorModal": { __esModule: true, default: (p) => { editor.props = p; return null; } } },
  });
  await h.flush();
  assert.equal(reads, 1);
  assert.equal(h.button("edit").props.disabled, false, "editable once the list has loaded");
  assert.doesNotMatch(h.text(), /load your saved stacks/);
  await editor.props.onSaved(); // the editor saved and closed: the list is read again, and that read fails
  await h.flush();
  assert.equal(reads, 2);
  assert.match(h.text(), /Could not load your saved stacks/);
  assert.equal(h.button("edit").props.disabled, true, "an old version is never handed to the editor");
  assert.match(h.text(), /Synthetic Night/, "the list stays on screen");
  await h.click("Retry");
  await h.flush();
  assert.equal(reads, 3);
  assert.doesNotMatch(h.text(), /load your saved stacks/);
  assert.equal(h.button("edit").props.disabled, false, "editable again once a read worked");
});

test("page: a failed first read of the stacks says so instead of 'No stacks yet'", async (t) => {
  withGlobals(t, { console: { ...console, error: () => {} } });
  const h = mountPage(t, { stacks: () => response({ error: "synthetic" }, 500) });
  await h.flush();
  assert.match(h.text(), /Could not load your saved stacks/);
  assert.doesNotMatch(h.text(), /No stacks yet/);
  assert.equal(h.buttons("Retry").length, 1);
});
