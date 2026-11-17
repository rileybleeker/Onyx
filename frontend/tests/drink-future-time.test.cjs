// Run: node --test tests/drink-future-time.test.cjs
// A drink (or a photo meal) whose time the database refuses as "not happened yet" (OXP01) is answered 409 with
// the machine-readable code `future`, and the Log drink client shows its own sentence for that code. Other 409s
// keep their own handling. SYNTHETIC DATA ONLY: a fake Supabase client and an in-memory device copy; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const FUTURE = "That time has not happened yet.";
const WG = "gorilla-mind-energy-wild-grape-16oz";
const NY = "America/New_York";
const KEY = "5e1a0c7b-3d2f-4a6e-8b9c-0d1e2f3a4b5c";

// ─── the drinks route: a database refusal of a future time ──────────────────

class FakeResponse {
  constructor(body, status) { this.body = body; this.status = status; }
  static json(body, init) { return new FakeResponse(body, (init && init.status) || 200); }
}
const ORIGIN = "https://onyx.example.test";
const headers = { origin: ORIGIN, host: "onyx.example.test", "content-type": "application/json" };
const H = (o) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(o, k.toLowerCase()) ? o[k.toLowerCase()] : null) });
const req = (body) => ({ headers: H(headers), nextUrl: { origin: ORIGIN }, text: async () => JSON.stringify(body) });

/** Every read finds nothing; an insert fails with `insertError` (the database's own code). */
function fakeDb(insertError) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from() {
      let op = "read";
      const b = {
        insert() { op = "insert"; return b; },
        select() { return b; },
        eq() { return b; },
        limit() { return b; },
        then(res, rej) {
          const out = op === "insert" ? { data: null, error: insertError } : { data: [], error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  };
}

function loadDrinks(db) {
  return loadTs("app/api/nutrition/drinks/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "next/cache": { revalidatePath: () => {} },
    "@supabase/supabase-js": { createClient: () => db },
  });
}

const drinkBody = (over = {}) => ({
  client_key: KEY, product_id: WG, servings: 1, time: { mode: "now", at: new Date().toISOString(), zone: NY }, overlap: "none", ...over,
});

test("a database OXP01 refusal of a drink is a 409 that carries the code future", async () => {
  const route = loadDrinks(fakeDb({ code: "OXP01", message: "synthetic" }));
  const res = await route.POST(req(drinkBody()));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: FUTURE, code: "future" });
});

test("other database codes keep their answers and gain no future code", async () => {
  const route = loadDrinks(fakeDb({ code: "23514", message: "synthetic" }));
  const res = await route.POST(req(drinkBody()));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "A number is out of range." });
});

// ─── the photo-meal helper: the same refusal ────────────────────────────────

test("photoMealErrorMessage gives OXP01 the future code and leaves other codes without one", () => {
  const M = loadTs("lib/photo-meal.ts");
  assert.deepEqual(M.photoMealErrorMessage("OXP01"), { status: 409, error: FUTURE, code: "future" });
  assert.equal(M.photoMealErrorMessage("23514").code, undefined);
  assert.equal(M.photoMealErrorMessage("XX000"), null);
});

// ─── the Log drink client: the code shows the future sentence ───────────────

const autosave = loadTs("lib/autosave.ts");
const S = loadTs("lib/drink-session.ts", { "./autosave": autosave });
const { AutosaveRefused } = autosave;

/** An in-memory device copy: the client keeps every request on the device before sending it, and refuses without one. */
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** A fresh session with a device copy and an open drink under `key`, as the Log drink screen adopts it before a save. */
function freshDrink(key) {
  S.drinkSession.reset({ storage: memStorage() });
  S.drinkSession.adopt({
    key, product_id: WG, said: "one wild grape gorilla mind", issue: null, servings: 1, timeMode: "now",
    capturedAt: Date.now() - 60_000, day: null, time: null, fold: null, zone: NY, whenIssue: null,
    overlap: null, recent: null, status: "open", saved: null, hold: null, note: null, pending: null,
  });
}

const save = (key) => ({
  client_key: key, product_id: WG, servings: 1, time: { mode: "now", at: new Date(Date.now() - 60_000).toISOString(), zone: NY }, overlap: "none",
});

test("the client shows the future-time sentence for a 409 with code future", async () => {
  const call = async () => ({ ok: false, status: 409, json: { error: FUTURE, code: "future" } });
  freshDrink("7f2b1c3d-4e5f-4a6b-9c8d-1e2f3a4b5c6d");
  await assert.rejects(S.saveDrinkWith(call, save("7f2b1c3d-4e5f-4a6b-9c8d-1e2f3a4b5c6d")), (e) => e instanceof AutosaveRefused && e.message === FUTURE);
});

test("a 409 without the future code does not show the future sentence", async () => {
  const call = async () => ({ ok: false, status: 409, json: { error: "some other conflict" } });
  freshDrink("8a3c2d4e-5f60-4b7c-8d9e-2f3a4b5c6d7e");
  await assert.rejects(S.saveDrinkWith(call, save("8a3c2d4e-5f60-4b7c-8d9e-2f3a4b5c6d7e")), (e) => e.message !== FUTURE);
});
