// Run: node --test tests/delivery-leftovers.test.cjs
// Uber Eats leftovers eaten on a later day (pds.delivery_item_leftovers, sql/delivery_item_leftovers.sql):
// which dishes are asked about, the share math, the PUT route and its refusals, the 409 mapping of the
// database guards (also on the delivery-day PATCH), the generic serialized saver, the middleware
// boundary, the SQL file's shape, and the list's markup.
// SYNTHETIC DATA ONLY: invented stores, dishes and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const L = loadTs("lib/delivery-leftovers.ts");
const P = loadTs("lib/delivery-portion.ts");

const dish = (item_id, behavioral_date, eaten_fraction, extra = {}) => ({ item_id, behavioral_date, eaten_fraction, ...extra });
const row = (item_id, eaten_date, fraction, threw_out = false, eaten_time = null) => ({ item_id, eaten_date, fraction, threw_out, eaten_time });

// ─── which dishes are asked about ────────────────────────────────────────────

test("leftFor: whole dish minus the delivery portion and the other days", () => {
  const d = dish(1, "2030-01-10", 0.25);
  assert.equal(L.leftFor(d, [], "2030-01-11"), 0.75);
  assert.equal(L.leftFor(d, [row(1, "2030-01-11", 0.375)], "2030-01-12"), 0.375);
  // the day's own answer does not reduce what that day can take
  assert.equal(L.leftFor(d, [row(1, "2030-01-11", 0.375)], "2030-01-11"), 0.75);
  // another dish's rows do not count
  assert.equal(L.leftFor(d, [row(2, "2030-01-11", 0.5)], "2030-01-12"), 0.75);
  assert.equal(L.leftFor(dish(1, "2030-01-10", null), [], "2030-01-11"), 0);
  assert.equal(L.leftFor(dish(1, "2030-01-10", 1), [], "2030-01-11"), 0);
  assert.equal(L.leftFor(d, [row(1, "2030-01-11", 0.75)], "2030-01-12"), 0);
});

test("leftoverQuestions: delivered in the 3 days before, portion below All, something left", () => {
  const dishes = [
    dish(1, "2030-01-09", 0.5), // D-1 → asked
    dish(2, "2030-01-07", 0.25), // D-3 → asked (last day of the window)
    dish(3, "2030-01-06", 0.5), // D-4 → outside the window
    dish(4, "2030-01-09", null), // All (unset) → nothing left
    dish(5, "2030-01-09", 1), // All → nothing left
    dish(6, "2030-01-10", 0.5), // the day itself → its own portion control, not a leftover
    dish(7, "2030-01-09", 0), // None at delivery → the whole dish is left
    dish(8, "2030-01-08", 0.5), // eaten up on 01-09
    dish(9, "2030-01-08", 0.5), // thrown out on 01-09
  ];
  const rows = [row(8, "2030-01-09", 0.5), row(9, "2030-01-09", 0, true)];
  const q = L.leftoverQuestions(dishes, rows, "2030-01-10");
  assert.deepEqual(
    q.map((x) => [x.dish.item_id, x.left]),
    [
      [1, 0.5],
      [2, 0.75],
      [7, 1],
    ],
  );
});

test("leftoverQuestions: an answer for the day keeps the dish on screen; a later throw-out does not hide it", () => {
  const dishes = [dish(1, "2030-01-09", 0.5)];
  // answered "All" on 01-10: the remaining share is that day's, so the question stays with All lit
  const a = L.leftoverQuestions(dishes, [row(1, "2030-01-10", 0.5)], "2030-01-10");
  assert.equal(a.length, 1);
  assert.equal(L.optionOfToken(L.tokenOfRow(a[0].row), a[0].left), "1");
  // thrown out ON the day itself: still shown (so it can be changed)
  const b = L.leftoverQuestions(dishes, [row(1, "2030-01-10", 0, true)], "2030-01-10");
  assert.equal(L.optionOfToken(L.tokenOfRow(b[0].row), b[0].left), "threw_out");
  // ...but not on the next day
  assert.equal(L.leftoverQuestions(dishes, [row(1, "2030-01-10", 0, true)], "2030-01-11").length, 0);
  // "not today" on 01-10 keeps asking on 01-11 with the same share left
  const c = L.leftoverQuestions(dishes, [row(1, "2030-01-10", 0)], "2030-01-11");
  assert.deepEqual(c.map((x) => x.left), [0.5]);
});

// ─── share math ──────────────────────────────────────────────────────────────

test("tokens: a tap stores the share of the whole dish; the lit option is read back", () => {
  const left = 0.75;
  for (const [key, token] of [
    ["1", "0.75"],
    ["0.75", "0.5625"],
    ["0.5", "0.375"],
    ["0.25", "0.1875"],
    ["not_today", "0"],
    ["threw_out", "out"],
  ]) {
    assert.equal(L.tokenForOption(key, left), token, key);
    assert.equal(L.optionOfToken(token, left), key, token);
  }
  assert.equal(L.optionOfToken(null, left), null);
  assert.equal(L.tokenForOption("bogus", left), null);
  assert.equal(L.fractionOfToken("0.375"), 0.375);
  assert.equal(L.fractionOfToken("out"), 0);
  assert.equal(L.fractionOfToken(null), 0);
  assert.equal(L.tokenOfRow(row(1, "2030-01-10", 0.375)), "0.375");
  assert.equal(L.tokenOfRow(row(1, "2030-01-10", 0, true)), "out");
  assert.equal(L.tokenOfRow(undefined), null);
});

test("bodyForToken: clear, thrown out, not today, a share", () => {
  assert.deepEqual(L.bodyForToken("2030-01-10", null), { date: "2030-01-10", fraction: null });
  assert.deepEqual(L.bodyForToken("2030-01-10", "out"), { date: "2030-01-10", fraction: 0, threw_out: true });
  assert.deepEqual(L.bodyForToken("2030-01-10", "0"), { date: "2030-01-10", fraction: 0, threw_out: false });
  assert.deepEqual(L.bodyForToken("2030-01-10", "0.1875"), { date: "2030-01-10", fraction: 0.1875, threw_out: false, time: null });
  // every body a tap can produce passes the route's parser
  for (const k of L.LEFTOVER_OPTIONS.map((o) => o.key)) {
    for (const left of [1, 0.75, 0.5, 0.25, 0.375, 0.1875]) {
      const b = L.bodyForToken("2030-01-10", L.tokenForOption(k, left));
      assert.equal(L.parseLeftoverBody(b).ok, true, `${k} of ${left}`);
    }
  }
});

test("tokens carry the time it was eaten; changing the amount keeps it, Not today / Threw out drop it", () => {
  assert.equal(L.tokenOfRow(row(1, "2030-01-10", 0.375, false, "19:30:00")), "0.375@19:30");
  assert.equal(L.tokenOfRow(row(1, "2030-01-10", 0, false, null)), "0");
  assert.deepEqual(L.splitToken("0.375@19:30"), { fraction: 0.375, time: "19:30" });
  assert.deepEqual(L.splitToken("0.375"), { fraction: 0.375, time: null });
  assert.deepEqual(L.splitToken("out"), { fraction: 0, time: null });
  assert.equal(L.tokenForOption("0.5", 0.75, "19:30"), "0.375@19:30");
  assert.equal(L.tokenForOption("not_today", 0.75, "19:30"), "0");
  assert.equal(L.tokenForOption("threw_out", 0.75, "19:30"), "out");
  assert.equal(L.optionOfToken("0.375@19:30", 0.75), "0.5");
  assert.equal(L.fractionOfToken("0.375@19:30"), 0.375);
  assert.equal(L.withTime("0.375", "01:15"), "0.375@01:15");
  assert.equal(L.withTime("0.375@19:30", null), "0.375");
  assert.equal(L.withTime("0", "19:30"), "0"); // no amount, no time
  assert.equal(L.withTime("out", "19:30"), "out");
  assert.equal(L.withTime(null, "19:30"), null);
  assert.equal(L.withTime("0.375", "7:30"), "0.375"); // not HH:MM
  assert.deepEqual(L.bodyForToken("2030-01-10", "0.375@19:30"), { date: "2030-01-10", fraction: 0.375, threw_out: false, time: "19:30" });
  assert.deepEqual(L.bodyForToken("2030-01-10", "0.375"), { date: "2030-01-10", fraction: 0.375, threw_out: false, time: null });
  assert.equal(L.parseLeftoverBody(L.bodyForToken("2030-01-10", "0.375@01:15")).ok, true);
});

test("clockNow / formatClock / isClock", () => {
  assert.equal(L.clockNow(new Date(2030, 0, 10, 7, 5)), "07:05");
  assert.equal(L.clockNow(new Date(2030, 0, 10, 23, 59)), "23:59");
  assert.equal(L.formatClock("19:30"), "7:30 PM");
  assert.equal(L.formatClock("00:15"), "12:15 AM");
  assert.equal(L.formatClock("12:00"), "12:00 PM");
  for (const ok of ["00:00", "09:30", "23:59"]) assert.equal(L.isClock(ok), true, ok);
  for (const bad of ["24:00", "7:30", "12:60", "", null, 730, "07:30:00"]) assert.equal(L.isClock(bad), false, String(bad));
});

test("formatShare", () => {
  assert.equal(L.formatShare(1), "all");
  assert.equal(L.formatShare(0.75), "3/4");
  assert.equal(L.formatShare(0.5), "1/2");
  assert.equal(L.formatShare(0.375), "3/8");
  assert.equal(L.formatShare(0.1875), "3/16");
  assert.equal(L.formatShare(0.4), "40%");
});

// ─── body + write checks ─────────────────────────────────────────────────────

test("parseLeftoverBody: exact keys, real dates, 0..1 with at most 4 decimals", () => {
  assert.deepEqual(L.parseLeftoverBody({ date: "2030-01-10", fraction: 0.375 }), {
    ok: true,
    value: { date: "2030-01-10", fraction: 0.375, threw_out: false, time: null },
  });
  assert.deepEqual(L.parseLeftoverBody({ date: "2030-01-10", fraction: 0, threw_out: true }).value, {
    date: "2030-01-10",
    fraction: 0,
    threw_out: true,
    time: null,
  });
  assert.equal(L.parseLeftoverBody({ date: "2030-01-10", fraction: 0.25, time: "19:30" }).value.time, "19:30");
  assert.equal(L.parseLeftoverBody({ date: "2030-01-10", fraction: 0.25, time: null }).value.time, null);
  assert.equal(L.parseLeftoverBody({ date: "2030-01-10", fraction: null }).ok, true);
  for (const b of [
    null,
    [],
    "x",
    {},
    { date: "2030-01-10" },
    { fraction: 0.5 },
    { date: "2030-01-10", fraction: 0.5, kcal: 1 },
    { date: "2030-02-30", fraction: 0.5 },
    { date: "10/01/2030", fraction: 0.5 },
    { date: "2030-01-10", fraction: 1.01 },
    { date: "2030-01-10", fraction: -0.1 },
    { date: "2030-01-10", fraction: 0.12345 },
    { date: "2030-01-10", fraction: "0.5" },
    { date: "2030-01-10", fraction: 0.5, threw_out: "yes" },
    { date: "2030-01-10", fraction: null, threw_out: true },
    { date: "2030-01-10", fraction: 0.25, time: "7:30" },
    { date: "2030-01-10", fraction: 0.25, time: "24:00" },
    { date: "2030-01-10", fraction: 0.25, time: 1930 },
    { date: "2030-01-10", fraction: 0, time: "19:30" }, // a time needs an amount
    { date: "2030-01-10", fraction: null, time: "19:30" },
  ]) {
    assert.equal(L.parseLeftoverBody(b).ok, false, JSON.stringify(b));
  }
});

test("checkLeftoverWrite mirrors the database guard", () => {
  const d = dish(1, "2030-01-10", 0.5, { merchant_kind: "restaurant", is_cancelled: false });
  const w = (date, fraction, threw_out = false) => ({ date, fraction, threw_out });
  const today = "2030-01-12";
  assert.equal(L.checkLeftoverWrite(d, [], today, w("2030-01-11", 0.5)), null);
  assert.equal(L.checkLeftoverWrite(d, [], today, w("2030-01-11", null)), null); // clearing always allowed
  assert.equal(L.checkLeftoverWrite({ ...d, eaten_fraction: null }, [], today, w("2030-01-11", 0.25)).status, 409);
  assert.equal(L.checkLeftoverWrite({ ...d, eaten_fraction: 1 }, [], today, w("2030-01-11", 0.25)).status, 409);
  assert.equal(L.checkLeftoverWrite(d, [], today, w("2030-01-10", 0.25)).status, 409); // the delivery day itself
  assert.equal(L.checkLeftoverWrite(d, [], "2030-01-20", w("2030-01-14", 0.25)).status, 409); // D+4
  assert.equal(L.checkLeftoverWrite(d, [], today, w("2030-01-13", 0.25)).status, 409); // future
  assert.equal(L.checkLeftoverWrite(d, [row(1, "2030-01-11", 0.25)], today, w("2030-01-12", 0.5)).status, 409); // too much
  assert.equal(L.checkLeftoverWrite(d, [row(1, "2030-01-11", 0.25)], today, w("2030-01-12", 0.25)), null);
  assert.equal(L.checkLeftoverWrite(d, [row(1, "2030-01-11", 0, true)], today, w("2030-01-12", 0.25)).status, 409); // after a throw-out
  assert.equal(L.checkLeftoverWrite(d, [row(1, "2030-01-12", 0.25)], today, w("2030-01-11", 0, true)).status, 409); // throw-out before a later row
  assert.equal(L.checkLeftoverWrite({ ...d, merchant_kind: "store" }, [], today, w("2030-01-11", 0.25)).status, 409);
  assert.equal(L.checkLeftoverWrite({ ...d, is_cancelled: true }, [], today, w("2030-01-11", 0.25)).status, 409);
});

test("leftoverConflictMessage maps the guard codes, nothing else", () => {
  for (const c of ["OXL01", "OXL02", "OXL03", "OXL04", "OXL05"]) assert.ok(L.leftoverConflictMessage(c, "leftover"), c);
  assert.match(L.leftoverConflictMessage("OXL01", "portion"), /later day/);
  assert.equal(L.leftoverConflictMessage("23505", "leftover"), null);
  assert.equal(L.leftoverConflictMessage(undefined, "portion"), null);
});

// ─── PUT /api/delivery/items/[itemId]/leftovers ──────────────────────────────

class FakeResponse {
  constructor(body, status) {
    this.body = body;
    this.status = status;
  }
  static json(body, init) {
    return new FakeResponse(body, (init && init.status) || 200);
  }
}

function makeDb({ items, leftovers = [], today = "2030-01-12", failRead = null, failWrite = null } = {}) {
  const calls = [];
  const tables = {
    delivery_order_items: items ?? [
      { item_id: 7, onyx_behavioral_date: "2030-01-10", eaten_fraction: 0.5, merchant_kind: "restaurant", is_cancelled: false },
    ],
    delivery_item_leftovers: leftovers,
  };
  const client = {
    rpc(name) {
      calls.push({ rpc: name });
      return Promise.resolve({ data: today, error: null });
    },
    from(table) {
      const st = { table, op: "select", filters: [], payload: null, opts: null };
      const b = {
        select() {
          return b;
        },
        eq(c, v) {
          st.filters.push([c, v]);
          return b;
        },
        order() {
          return b;
        },
        delete() {
          st.op = "delete";
          return b;
        },
        upsert(p, o) {
          st.op = "upsert";
          st.payload = p;
          st.opts = o;
          return b;
        },
        then(resolve, reject) {
          calls.push(st);
          const match = (r) => st.filters.every(([c, v]) => r[c] === v);
          let out;
          if (st.op === "select") {
            out = failRead ? { data: null, error: failRead } : { data: tables[table].filter(match).map((r) => ({ ...r })), error: null };
          } else if (failWrite) {
            out = { data: null, error: failWrite };
          } else if (st.op === "delete") {
            tables[table] = tables[table].filter((r) => !match(r));
            out = { data: null, error: null };
          } else {
            const rows = tables[table];
            const i = rows.findIndex((r) => r.item_id === st.payload.item_id && r.eaten_date === st.payload.eaten_date);
            if (i >= 0) rows[i] = { ...rows[i], ...st.payload };
            else rows.push({ ...st.payload });
            out = { data: null, error: null };
          }
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { client, calls, tables };
}

const H = (o) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(o, k.toLowerCase()) ? o[k.toLowerCase()] : null) });
const ORIGIN = "https://onyx.example.test";
const good = { origin: ORIGIN, host: "onyx.example.test", "content-type": "application/json", "content-length": "40" };
const req = (body, headers = good) => ({ headers: H(headers), nextUrl: { origin: ORIGIN }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const params = (id) => ({ params: Promise.resolve({ itemId: id }) });

function loadPut(db, revalidated = []) {
  return loadTs("app/api/delivery/items/[itemId]/leftovers/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "next/cache": { revalidatePath: (p) => revalidated.push(p) },
    "@supabase/supabase-js": { createClient: () => db.client },
  });
}
const writes = (db) => db.calls.filter((c) => c.op === "upsert" || c.op === "delete");

test("PUT saves a leftover row for that dish and day and returns the dish's rows", async () => {
  const db = makeDb();
  const revalidated = [];
  const res = await loadPut(db, revalidated).PUT(req({ date: "2030-01-11", fraction: 0.375, threw_out: false }), params("7"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    item_id: 7,
    leftovers: [{ item_id: 7, eaten_date: "2030-01-11", fraction: 0.375, threw_out: false, eaten_time: null }],
  });
  const w = writes(db);
  assert.equal(w.length, 1);
  assert.equal(w[0].table, "delivery_item_leftovers");
  assert.deepEqual(w[0].payload, { item_id: 7, eaten_date: "2030-01-11", fraction: 0.375, threw_out: false, eaten_time: null });
  assert.equal(w[0].opts.onConflict, "item_id,eaten_date");
  // the dish row itself is never written
  assert.ok(!db.calls.some((c) => c.table === "delivery_order_items" && c.op !== "select"));
  assert.deepEqual(revalidated, ["/nutrition"]);
});

test("PUT with a time stores eaten_time (the database computes the instant); a future time is 409", async () => {
  const db = makeDb();
  const res = await loadPut(db).PUT(req({ date: "2030-01-11", fraction: 0.25, threw_out: false, time: "01:30" }), params("7"));
  assert.equal(res.status, 200);
  assert.equal(writes(db)[0].payload.eaten_time, "01:30");
  assert.ok(!("eaten_at" in writes(db)[0].payload), "the client never sends the instant");
  assert.equal(res.body.leftovers[0].eaten_time, "01:30");
  const future = await loadPut(makeDb({ failWrite: { code: "OXL05", message: "secret detail" } })).PUT(
    req({ date: "2030-01-12", fraction: 0.25, time: "23:59" }),
    params("7"),
  );
  assert.equal(future.status, 409);
  assert.match(future.body.error, /not happened yet/);
});

test("PUT with fraction null deletes only that day's answer", async () => {
  const db = makeDb({ leftovers: [{ item_id: 7, eaten_date: "2030-01-11", fraction: 0.25, threw_out: false }, { item_id: 7, eaten_date: "2030-01-12", fraction: 0.25, threw_out: false }] });
  const res = await loadPut(db).PUT(req({ date: "2030-01-11", fraction: null }), params("7"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.leftovers.map((r) => r.eaten_date), ["2030-01-12"]);
  const w = writes(db);
  assert.equal(w[0].op, "delete");
  assert.deepEqual(w[0].filters, [["item_id", 7], ["eaten_date", "2030-01-11"]]);
});

test("PUT refusals never write", async () => {
  const cases = [
    [req({ date: "2030-01-11", fraction: 0.25 }), params("abc"), 400],
    [req({ date: "2030-01-11", fraction: 0.25 }, { ...good, origin: "https://evil.example.test" }), params("7"), 403],
    [req({ date: "2030-01-11", fraction: 0.25 }, { ...good, "content-type": "text/plain" }), params("7"), 415],
    [req("not json"), params("7"), 400],
    [req({ date: "2030-01-11", fraction: 0.6 }), params("7"), 409], // more than the 1/2 left
    [req({ date: "2030-01-10", fraction: 0.25 }), params("7"), 409], // the delivery day
    [req({ date: "2030-01-13", fraction: 0.25 }), params("7"), 409], // after behavioral today
    [req({ date: "2030-01-11", fraction: 0.25 }), params("8"), 404],
    [req(" ".repeat(300)), params("7"), 413],
  ];
  for (const [r, p, status] of cases) {
    const db = makeDb();
    const res = await loadPut(db).PUT(r, p);
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(writes(db).length, 0);
  }
});

test("PUT: a guard refusal from the database is 409; other errors are 500 without their text", async () => {
  const guarded = await loadPut(makeDb({ failWrite: { code: "OXL01", message: "secret detail" } })).PUT(req({ date: "2030-01-11", fraction: 0.25 }), params("7"));
  assert.equal(guarded.status, 409);
  assert.ok(!JSON.stringify(guarded.body).includes("secret detail"));
  const broken = await loadPut(makeDb({ failWrite: { code: "XX000", message: "secret detail" } })).PUT(req({ date: "2030-01-11", fraction: 0.25 }), params("7"));
  assert.equal(broken.status, 500);
  assert.ok(!JSON.stringify(broken.body).includes("secret detail"));
  const readFail = await loadPut(makeDb({ failRead: { code: "XX000", message: "secret detail" } })).PUT(req({ date: "2030-01-11", fraction: 0.25 }), params("7"));
  assert.equal(readFail.status, 500);
});

test("PATCH delivery-day portion: the leftover guard answers 409", async () => {
  const client = {
    from() {
      const b = {
        update() {
          return b;
        },
        eq() {
          return b;
        },
        select() {
          return b;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: { code: "OXL01", message: "secret detail" } }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  const route = loadTs("app/api/delivery/items/[itemId]/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "next/cache": { revalidatePath: () => {} },
    "@supabase/supabase-js": { createClient: () => client },
  });
  const res = await route.PATCH(req({ eaten_fraction: null }), params("7"));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /later day/);
  assert.ok(!JSON.stringify(res.body).includes("secret detail"));
});

// ─── generic serialized saver (string keys, token values) ────────────────────

test("createPortionSaver works with string keys and token values", async () => {
  const shown = new Map();
  const sent = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const saver = P.createPortionSaver({
    send: async (k, v) => {
      sent.push([k, v]);
      if (sent.length === 1) await gate;
      return { ok: true };
    },
    apply: (k, v) => shown.set(k, v),
    onError: () => assert.fail("no error expected"),
    onSaved: () => {},
  });
  assert.equal(saver.seed("7|2030-01-11", null), null);
  const first = saver.set("7|2030-01-11", "0.5");
  void saver.set("7|2030-01-11", "out"); // queued behind the first write
  release();
  await first;
  assert.deepEqual(sent, [
    ["7|2030-01-11", "0.5"],
    ["7|2030-01-11", "out"],
  ]);
  assert.equal(shown.get("7|2030-01-11"), "out");
  assert.equal(saver.confirmed("7|2030-01-11"), "out");
});

// ─── boundaries ──────────────────────────────────────────────────────────────

test("middleware: the leftovers route is session-only", () => {
  const src = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const m = /function isCiRoute\(pathname: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, "isCiRoute not found");
  const isCiRoute = new Function("pathname", m[1]);
  for (const p of ["/api/delivery/items/7/leftovers", "/api/delivery/items/123/leftovers/"]) assert.equal(isCiRoute(p), false, p);
});

test("SQL (time): no DROP, the trigger computes eaten_at, delivery_daily appends the leftover counts", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "delivery_leftover_time.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  assert.ok(!/\bDROP\b/i.test(code), "no DROP outside comments");
  assert.ok(code.includes("'OXL05'"));
  assert.match(code, /NEW\.eaten_at := /);
  const daily = /CREATE OR REPLACE VIEW pds\.delivery_daily AS([\s\S]*?);\s*\n/.exec(code)[1];
  const tail = daily.slice(daily.lastIndexOf("SELECT behavioral_date"));
  assert.match(tail, /merchants,\s*uneaten_meal_order_count,\s*leftover_meal_count,\s*untimed_leftover_meal_count\s*FROM agg/);
});

test("SQL: no DROP statement, guards present, nutrition view keeps its column order", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "delivery_item_leftovers.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  assert.ok(!/\bDROP\b/i.test(code), "no DROP outside comments");
  for (const c of ["OXL01", "OXL02", "OXL03", "OXL04"]) assert.ok(code.includes(`'${c}'`), c);
  const view = /CREATE OR REPLACE VIEW pds\.delivery_nutrition_daily AS([\s\S]*?);\s*\n/.exec(code)[1];
  const final = view.slice(view.lastIndexOf("SELECT p.behavioral_date"));
  const aliases = [...final.matchAll(/\bAS\s+([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(aliases, [
    "order_count",
    "item_lines",
    "unestimated_lines",
    "low_confidence_lines",
    "has_group_order",
    "est_kcal",
    "est_protein_g",
    "est_carbs_g",
    "est_fat_g",
    "est_alcohol_g_with_meal",
    "leftover_lines",
  ]);
  const daily = /CREATE OR REPLACE VIEW pds\.delivery_daily AS([\s\S]*?);\s*\n/.exec(code)[1];
  const tail = daily.slice(daily.lastIndexOf("SELECT behavioral_date"));
  assert.match(tail, /has_estimated_time,\s*merchants,\s*uneaten_meal_order_count\s*FROM agg/);
});

// ─── markup ──────────────────────────────────────────────────────────────────

test("LeftoverList renders the share left, the six answers and the lit one", () => {
  const C = loadTs("components/DeliveryPortions.tsx", { "@/lib/queries": {} });
  const q = {
    dish: { item_id: 7, behavioral_date: "2030-01-08", store_name: "Example Pizza Co", title: "Large Test Pie", quantity: 1, unit_kcal: 2000, est_kind: "food", eaten_fraction: 0.25 },
    left: 0.75,
    token: "0.375",
    option: "0.5",
    kcal: 750,
    time: null,
  };
  const html = renderToStaticMarkup(React.createElement(C.LeftoverList, { questions: [q], onPick: () => {} }));
  assert.match(html, /From Tue/);
  assert.match(html, /3\/4 left/);
  assert.match(html, /~750 kcal/);
  for (const label of ["All", "3/4", "1/2", "1/4", "Not today", "Threw out"]) assert.ok(html.includes(`>${label}<`), label);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /aria-pressed="true"[^>]*>1\/2</);
  assert.equal(renderToStaticMarkup(React.createElement(C.LeftoverList, { questions: [], onPick: () => {} })), "");
});

test("LeftoverList: the When? row appears once an amount is picked, with Now and Same as", () => {
  const C = loadTs("components/DeliveryPortions.tsx", { "@/lib/queries": {} });
  const base = { left: 0.75, kcal: 750 };
  const dish = (item_id, title) => ({ item_id, behavioral_date: "2030-01-08", store_name: "Example Pizza Co", title, quantity: 1, unit_kcal: 2000, est_kind: "food", eaten_fraction: 0.25 });
  const timed = { ...base, dish: dish(7, "Large Test Pie"), token: "0.375@19:30", option: "0.5", time: "19:30" };
  const untimed = { ...base, dish: dish(8, "Test Garlic Knots"), token: "0.75", option: "1", time: null };
  const notToday = { ...base, dish: dish(9, "Test Salad"), token: "0", option: "not_today", kcal: null, time: null };
  const html = renderToStaticMarkup(
    React.createElement(C.LeftoverList, { questions: [timed, untimed, notToday], onPick: () => {}, onTime: () => {}, showNow: true }),
  );
  assert.equal((html.match(/type="time"/g) || []).length, 2, "time row only for answers with an amount");
  assert.match(html, /value="19:30"/);
  assert.equal((html.match(/>Now</g) || []).length, 2);
  assert.equal((html.match(/Same as 7:30 PM/g) || []).length, 1, "offered only where the time is missing");
  assert.match(html, /When\? \(for meal timing\)/);
  // without onTime (or on another day without Now) the extras are not drawn
  const plain = renderToStaticMarkup(React.createElement(C.LeftoverList, { questions: [timed], onPick: () => {} }));
  assert.ok(!plain.includes('type="time"'));
  const past = renderToStaticMarkup(React.createElement(C.LeftoverList, { questions: [timed], onPick: () => {}, onTime: () => {} }));
  assert.ok(!past.includes(">Now<"));
});
