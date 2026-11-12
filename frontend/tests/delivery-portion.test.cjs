// Run: node --test tests/delivery-portion.test.cjs
// "How much of the Uber Eats dish did you eat?" (pds.delivery_order_items.eaten_fraction):
// the fraction validator, the request checks and handler of PATCH /api/delivery/items/[itemId],
// the kcal math, that the harvester import never sends eaten_fraction (so a set portion survives
// re-harvests), and that the new route is not in middleware's CI carve-out.
// SYNTHETIC DATA ONLY: invented stores, dishes and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const P = loadTs("lib/delivery-portion.ts");

// ─── fraction validation ─────────────────────────────────────────────────────

test("parseEatenFraction accepts null and 0..1 with at most 2 decimals", () => {
  for (const v of [null, 0, 0.25, 0.5, 0.75, 1, 0.1, 0.99]) {
    const r = P.parseEatenFraction(v);
    assert.equal(r.ok, true, `expected ${v} to pass`);
    assert.equal(r.value, v);
  }
});

test("parseEatenFraction refuses out-of-range, over-precise and non-numbers", () => {
  for (const v of [1.01, -0.1, 0.333, 0.125, "0.5", "", NaN, Infinity, -Infinity, true, {}, [], undefined]) {
    assert.equal(P.parseEatenFraction(v).ok, false, `expected ${String(v)} to fail`);
  }
});

test("parsePortionBody wants exactly {eaten_fraction}", () => {
  assert.deepEqual(P.parsePortionBody({ eaten_fraction: 0.25 }), { ok: true, value: 0.25 });
  assert.deepEqual(P.parsePortionBody({ eaten_fraction: null }), { ok: true, value: null });
  for (const b of [null, [], "x", 3, {}, { eaten_fraction: 0.5, kcal: 1 }, { fraction: 0.5 }, { eaten_fraction: "1" }]) {
    assert.equal(P.parsePortionBody(b).ok, false, `expected ${JSON.stringify(b)} to fail`);
  }
});

test("parseItemId takes positive integers only", () => {
  assert.equal(P.parseItemId("42"), 42);
  for (const s of ["0", "-1", "1.5", "abc", "", "01", "1e3", "9".repeat(20)]) assert.equal(P.parseItemId(s), null, s);
});

// ─── request checks ──────────────────────────────────────────────────────────

const H = (o) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(o, k.toLowerCase()) ? o[k.toLowerCase()] : null) });
const ORIGIN = "https://onyx.example.test";
const good = { origin: ORIGIN, host: "onyx.example.test", "content-type": "application/json", "content-length": "22" };

test("checkPortionRequest: same-origin JSON passes", () => {
  assert.equal(P.checkPortionRequest(H(good), ORIGIN), null);
  assert.equal(P.checkPortionRequest(H({ ...good, "content-type": "application/json; charset=utf-8" }), ORIGIN), null);
  // behind a proxy: the request URL is internal, x-forwarded-host is what the browser addressed
  assert.equal(P.checkPortionRequest(H({ ...good, host: "internal:3000", "x-forwarded-host": "onyx.example.test" }), "http://internal:3000"), null);
  // no declared length (chunked) is allowed; the route still caps the read body
  const { "content-length": _, ...noLen } = good;
  assert.equal(P.checkPortionRequest(H(noLen), ORIGIN), null);
});

test("checkPortionRequest: missing or foreign Origin is 403", () => {
  const { origin: _, ...noOrigin } = good;
  assert.equal(P.checkPortionRequest(H(noOrigin), ORIGIN).status, 403);
  assert.equal(P.checkPortionRequest(H({ ...good, origin: "https://evil.example.test" }), ORIGIN).status, 403);
  assert.equal(P.checkPortionRequest(H({ ...good, origin: "null" }), ORIGIN).status, 403);
});

test("checkPortionRequest: non-JSON content type is 415, oversize is 413", () => {
  assert.equal(P.checkPortionRequest(H({ ...good, "content-type": "text/plain" }), ORIGIN).status, 415);
  assert.equal(P.checkPortionRequest(H({ ...good, "content-type": "application/x-www-form-urlencoded" }), ORIGIN).status, 415);
  const { "content-type": _, ...noType } = good;
  assert.equal(P.checkPortionRequest(H(noType), ORIGIN).status, 415);
  assert.equal(P.checkPortionRequest(H({ ...good, "content-length": String(P.MAX_PORTION_BODY_BYTES + 1) }), ORIGIN).status, 413);
  assert.equal(P.checkPortionRequest(H({ ...good, "content-length": "abc" }), ORIGIN).status, 413);
});

// ─── kcal math ───────────────────────────────────────────────────────────────

test("dishKcal = unit x quantity x fraction, null fraction = all", () => {
  assert.equal(P.dishKcal(1000, 1, null), 1000);
  assert.equal(P.dishKcal(1000, 1, undefined), 1000);
  assert.equal(P.dishKcal(1000, 1, 0.25), 250);
  assert.equal(P.dishKcal(400, 2, 0.5), 400);
  assert.equal(P.dishKcal(400, 3, 0), 0);
  assert.equal(P.dishKcal(400, null, 1), 400);
  assert.equal(P.dishKcal(null, 2, 0.5), null);
});

test("dayKcal sums food and drink like delivery_nutrition_daily, null when nothing is estimated", () => {
  assert.equal(
    P.dayKcal([
      { est_kcal: 250, est_kind: "food" },
      { est_kcal: 100, est_kind: "drink" },
      { est_kcal: 150, est_kind: "alcohol" },
      { est_kcal: 0, est_kind: "non_food" },
      { est_kcal: null, est_kind: null },
    ]),
    350,
  );
  assert.equal(P.dayKcal([{ est_kcal: null, est_kind: "food" }]), null);
  assert.equal(P.dayKcal([]), null);
});

test("selectedPortion shows NULL as All and the options cover the one-tap choices", () => {
  assert.equal(P.selectedPortion(null), 1);
  assert.equal(P.selectedPortion(0.25), 0.25);
  assert.deepEqual(P.PORTION_OPTIONS.map((o) => o.value), [1, 0.75, 0.5, 0.25, 0]);
  for (const o of P.PORTION_OPTIONS) assert.equal(P.parseEatenFraction(o.value).ok, true);
});

// ─── PATCH handler ───────────────────────────────────────────────────────────

class FakeResponse {
  constructor(body, status) { this.body = body; this.status = status; }
  static json(body, init) { return new FakeResponse(body, (init && init.status) || 200); }
}

function makeSupabase({ rows = [{ item_id: 7, eaten_fraction: null }], failWith = null } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const st = { table, update: null, filters: [], select: null };
      const b = {
        update(p) { st.update = p; return b; },
        upsert(r, opts) { calls.push({ table, upsert: r, opts }); return Promise.resolve({ error: null }); },
        eq(c, v) { st.filters.push([c, v]); return b; },
        select(c) { st.select = c; return b; },
        then(resolve, reject) {
          calls.push(st);
          if (failWith) return Promise.resolve({ data: null, error: failWith }).then(resolve, reject);
          const hit = rows.filter((r) => st.filters.every(([c, v]) => r[c] === v));
          for (const r of hit) Object.assign(r, st.update);
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { client, calls, rows };
}

function loadPatch(db, revalidated = []) {
  return loadTs("app/api/delivery/items/[itemId]/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "next/cache": { revalidatePath: (p) => revalidated.push(p) },
    "@supabase/supabase-js": { createClient: () => db.client },
  });
}

function req({ headers = good, body = JSON.stringify({ eaten_fraction: 0.25 }) } = {}) {
  return { headers: H(headers), nextUrl: { origin: ORIGIN }, text: async () => body };
}
const params = (id) => ({ params: Promise.resolve({ itemId: id }) });

test("PATCH writes only eaten_fraction of that one row and returns it", async () => {
  const db = makeSupabase({ rows: [{ item_id: 7, eaten_fraction: null }, { item_id: 8, eaten_fraction: null }] });
  const revalidated = [];
  const res = await loadPatch(db, revalidated).PATCH(req(), params("7"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { item_id: 7, eaten_fraction: 0.25 });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].table, "delivery_order_items");
  assert.deepEqual(db.calls[0].update, { eaten_fraction: 0.25 });
  assert.deepEqual(db.calls[0].filters, [["item_id", 7]]);
  assert.equal(db.rows[1].eaten_fraction, null);
  assert.deepEqual(revalidated, ["/nutrition"]);
});

test("PATCH null resets to all", async () => {
  const db = makeSupabase({ rows: [{ item_id: 7, eaten_fraction: 0.5 }] });
  const res = await loadPatch(db).PATCH(req({ body: '{"eaten_fraction":null}' }), params("7"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { item_id: 7, eaten_fraction: null });
});

test("PATCH refusals never reach the database", async () => {
  const cases = [
    [req(), params("abc"), 400],
    [req({ headers: { ...good, origin: "https://evil.example.test" } }), params("7"), 403],
    [req({ headers: { ...good, "content-type": "text/plain" } }), params("7"), 415],
    [req({ body: "not json" }), params("7"), 400],
    [req({ body: JSON.stringify({ eaten_fraction: 0.333 }) }), params("7"), 400],
    [req({ body: JSON.stringify({ eaten_fraction: "0.5" }) }), params("7"), 400],
    [req({ body: JSON.stringify({ eaten_fraction: 1.01 }) }), params("7"), 400],
    [req({ body: " ".repeat(P.MAX_PORTION_BODY_BYTES + 1) }), params("7"), 413],
  ];
  for (const [r, p, status] of cases) {
    const db = makeSupabase();
    const res = await loadPatch(db).PATCH(r, p);
    assert.equal(res.status, status);
    assert.equal(db.calls.length, 0);
  }
});

test("PATCH unknown row is 404, a database error is 500 without its message", async () => {
  const missing = await loadPatch(makeSupabase({ rows: [] })).PATCH(req(), params("99"));
  assert.equal(missing.status, 404);
  const broken = await loadPatch(makeSupabase({ failWith: { code: "XX000", message: "secret detail" } })).PATCH(req(), params("7"));
  assert.equal(broken.status, 500);
  assert.ok(!JSON.stringify(broken.body).includes("secret detail"));
});

// ─── importer never sends eaten_fraction ─────────────────────────────────────

const ORDERS = [
  {
    uuid: "order-synthetic-1",
    store: "Example Pizza Co",
    completedAt: "2030-01-02T01:00:00Z",
    total: 2500,
    currency: "USD",
    items: [
      { key: "line-1", title: "Large Test Pie", quantity: 1, price: 2000, customizations: [{ title: "Size", options: ["Large"] }] },
      { title: "Test Soda", quantity: 2, price: 250 },
    ],
  },
];

test("buildOrderItemRows: no eaten_fraction in any upsert row", () => {
  const D = loadTs("lib/delivery.ts");
  const rows = D.buildOrderItemRows(ORDERS);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.ok(!("eaten_fraction" in r), "importer row must not carry eaten_fraction");
});

test("import route: the upsert payload has no eaten_fraction", async () => {
  const db = makeSupabase();
  const route = loadTs("app/api/delivery/items/import/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "@supabase/supabase-js": { createClient: () => db.client },
    "@anthropic-ai/sdk": { __esModule: true, default: class { constructor() { this.messages = {}; } } },
  });
  const res = await route.POST({ json: async () => ({ orders: ORDERS }) });
  assert.equal(res.status, 200);
  const up = db.calls.filter((c) => c.upsert);
  assert.equal(up.length, 1);
  assert.equal(up[0].table, "delivery_order_items");
  assert.equal(up[0].opts.onConflict, "provider,order_uuid,item_key");
  assert.equal(up[0].upsert.length, 2);
  for (const r of up[0].upsert) assert.ok(!("eaten_fraction" in r));
});

// ─── middleware carve-out unchanged ──────────────────────────────────────────

test("middleware: only /api/delivery/items/import skips the session check", () => {
  const src = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const m = /function isCiRoute\(pathname: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, "isCiRoute not found");
  const isCiRoute = new Function("pathname", m[1]);
  assert.equal(isCiRoute("/api/delivery/items/import"), true);
  for (const p of ["/api/delivery/items/7", "/api/delivery/items/123456", "/api/delivery/items", "/api/delivery/items/import/x"]) {
    assert.equal(isCiRoute(p), false, p);
  }
});
