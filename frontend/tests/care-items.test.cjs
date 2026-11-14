// Run: node --test tests/care-items.test.cjs
// /health storage (lib/care-items.ts + the /api/care/items routes): body checks, row mapping, the
// request checks (same origin, JSON, size), the optimistic list helpers, and the three routes run
// against an in-memory stand-in for the database. Also: the routes stay behind the owner session
// (not in middleware's CI carve-out), the page is not cached, and the SQL is additive.
// SYNTHETIC DATA ONLY: invented labels and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/care-items.ts");

const ID = "11111111-2222-4333-8444-555555555555";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const item = (over = {}) => ({
  id: ID, title: "Routine checkup", kind: "medical", due: "2026-03-10", time: null, tz: "America/New_York",
  months: 12, booked: false, notes: "", archived: false, completedOn: null, ...over,
});

// ---------- body checks ----------

test("a whole item is accepted and normalised", () => {
  const r = L.parseCareItem(item({ title: "  Routine checkup  ", time: "09:30", notes: "line one\nline two" }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.item, item({ time: "09:30", notes: "line one\nline two" }));
});

test("a whole item is refused when anything is off", () => {
  const bad = [
    null, [], "x", {},
    item({ id: "not-a-uuid" }), item({ id: ID2.toUpperCase() }), item({ title: "" }), item({ title: "   " }),
    item({ title: "x".repeat(101) }), item({ title: "two\nlines" }), item({ title: 5 }),
    item({ kind: "surgery" }), item({ due: "2026-02-30" }), item({ due: "2026-3-1" }), item({ due: "1899-12-31" }),
    item({ time: "9:30" }), item({ time: "24:00" }), item({ time: "" }), item({ tz: "Mars/Olympus" }), item({ tz: "" }),
    item({ months: 7 }), item({ months: "12" }), item({ booked: "yes" }), item({ notes: "x".repeat(1001) }),
    item({ notes: "bell\u0007" }), item({ notes: null }), item({ archived: 1 }), item({ completedOn: "yesterday" }),
    { ...item(), extra: 1 }, { ...item(), removed: false },
  ];
  for (const body of bad) assert.equal(L.parseCareItem(body).ok, false, JSON.stringify(body));
  const { notes: _notes, ...missing } = item();
  assert.equal(L.parseCareItem(missing).ok, false);
});

test("sample items can never be saved", () => {
  // Sample ids are not UUIDs, so the id check already refuses them; the import refuses them by name.
  assert.equal(L.parseCareItem(item({ id: "sample-1" })).ok, false);
  const local = { id: "sample-1", title: "Sample: annual checkup", due: "2026-03-10", months: 12, booked: false, archived: false };
  assert.equal(L.parseImportBody({ items: [local] }).ok, false);
});

test("a patch takes known fields only and at least one", () => {
  assert.deepEqual(L.parseCarePatch({ booked: true }), { ok: true, patch: { booked: true } });
  assert.deepEqual(L.parseCarePatch({ title: " New label ", time: null, completedOn: "2026-03-10" }),
    { ok: true, patch: { title: "New label", time: null, completedOn: "2026-03-10" } });
  assert.deepEqual(L.parseCarePatch({ removed: false }), { ok: true, patch: { removed: false } });
  for (const body of [{}, null, [], { id: ID2 }, { removed: true }, { removed_at: null }, { import_key: "x" }, { due: "bad" },
    { months: 2 }, { booked: true, nope: 1 }, { kind: "x" }, { time: "25:00" }, { tz: "Nowhere/Land" }, { notes: 3 }]) {
    assert.equal(L.parseCarePatch(body).ok, false, JSON.stringify(body));
  }
});

test("the import body is the old six-field list", () => {
  const local = [
    { id: "local-1", title: " Dental cleaning ", due: "2026-04-01", months: 6, booked: true, archived: false },
    { id: "local-2", title: "Eye exam", due: "2026-05-01", months: 0, booked: false, archived: true },
  ];
  const r = L.parseImportBody({ items: local, tz: "Europe/Madrid" });
  assert.equal(r.ok, true);
  assert.equal(r.tz, "Europe/Madrid");
  assert.deepEqual(r.items.map((i) => i.title), ["Dental cleaning", "Eye exam"]);
  assert.equal(L.parseImportBody({ items: local }).tz, "America/New_York");
  for (const body of [null, {}, { items: [] }, { items: "x" }, { items: local, tz: "Nowhere/Land" }, { items: local, extra: 1 },
    { items: [local[0], local[0]] }, { items: [{ ...local[0], months: 5 }] }, { items: [{ ...local[0], title: "a\nb" }] },
    { items: Array.from({ length: 501 }, (_, n) => ({ ...local[0], id: `l${n}` })) }]) {
    assert.equal(L.parseImportBody(body).ok, false, JSON.stringify(body).slice(0, 80));
  }
});

// ---------- rows ----------

test("rows map to items and back", () => {
  const row = {
    id: ID, title: "Routine checkup", kind: "medical", due_date: "2026-03-10", due_time: "09:30:00", time_zone: "America/New_York",
    repeat_months: 12, booked: false, notes: "", archived: false, last_completed_on: null,
  };
  assert.deepEqual(L.rowToItem(row), item({ time: "09:30" }));
  assert.deepEqual(L.rowToItem({ ...row, due_time: null }), item());
  assert.equal(L.rowToItem({ ...row, kind: "unknown" }), null);
  assert.equal(L.rowToItem(null), null);
  const { id: _id, ...fields } = item({ time: "09:30", completedOn: "2026-01-02" });
  assert.deepEqual(L.toColumns(fields), {
    title: "Routine checkup", kind: "medical", due_date: "2026-03-10", due_time: "09:30", time_zone: "America/New_York",
    repeat_months: 12, booked: false, notes: "", archived: false, last_completed_on: "2026-01-02",
  });
  assert.deepEqual(L.toColumns({ time: null }), { due_time: null });
  assert.deepEqual(L.toColumns({ removed: false }), { removed_at: null });
  assert.deepEqual(L.toColumns({}), {});
  for (const col of L.CARE_COLUMNS.split(",")) assert.ok(col in row, col);
  assert.ok(!L.CARE_COLUMNS.includes("*") && !L.CARE_COLUMNS.includes("import_key"));
});

// ---------- request checks ----------

const headers = (h) => ({ get: (name) => h[name.toLowerCase()] ?? null });
const ORIGIN = "https://onyx.example";

test("writes must be same-origin JSON within the size cap", () => {
  const ok = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json; charset=utf-8", "content-length": "120" };
  assert.equal(L.checkCareRequest(headers(ok), ORIGIN, { maxBytes: 6000 }), null);
  assert.equal(L.checkCareRequest(headers({ ...ok, origin: undefined }), ORIGIN, { maxBytes: 6000 }).status, 403);
  assert.equal(L.checkCareRequest(headers({ ...ok, origin: "https://evil.example" }), ORIGIN, { maxBytes: 6000 }).status, 403);
  assert.equal(L.checkCareRequest(headers({ ...ok, origin: "not a url" }), ORIGIN, { maxBytes: 6000 }).status, 403);
  assert.equal(L.checkCareRequest(headers({ ...ok, "content-type": "text/plain" }), ORIGIN, { maxBytes: 6000 }).status, 415);
  assert.equal(L.checkCareRequest(headers({ ...ok, "content-length": "6001" }), ORIGIN, { maxBytes: 6000 }).status, 413);
  assert.equal(L.checkCareRequest(headers({ ...ok, "content-length": "abc" }), ORIGIN, { maxBytes: 6000 }).status, 413);
  // A request with no body (DELETE) still needs the same-origin Origin, but no content type.
  assert.equal(L.checkCareRequest(headers({ origin: ORIGIN, host: "onyx.example" }), ORIGIN, null), null);
  assert.equal(L.checkCareRequest(headers({ origin: "https://evil.example", host: "onyx.example" }), ORIGIN, null).status, 403);
  assert.equal(L.utf8Bytes("abc"), 3);
  assert.equal(L.utf8Bytes("é😀"), 6);
});

// ---------- optimistic list helpers ----------

test("a change shows at once, reverts on failure, and can be undone", () => {
  const a = item();
  const b = item({ id: ID2, title: "Dental cleaning", kind: "dental" });
  const list = [a, b];

  const create = { type: "create", item: b };
  assert.deepEqual(L.applyOp([a], create), list);
  assert.deepEqual(L.revertOp(L.applyOp([a], create), create, null), [a]);          // failed create: gone again
  assert.deepEqual(L.inverseOp(create, null), { type: "remove", id: ID2 });

  const update = { type: "update", id: ID, patch: { booked: true, due: "2026-04-01" } };
  const updated = L.applyOp(list, update);
  assert.equal(updated[0].booked, true);
  assert.equal(updated[0].due, "2026-04-01");
  assert.deepEqual(updated[1], b);                                                  // other items untouched
  assert.deepEqual(L.revertOp(updated, update, a), list);                           // failed update: back to confirmed
  assert.deepEqual(L.inverseOp(update, a), { type: "update", id: ID, patch: { booked: false, due: "2026-03-10" } });
  assert.equal(L.inverseOp(update, null), null);

  const remove = { type: "remove", id: ID };
  assert.deepEqual(L.applyOp(list, remove), [b]);
  assert.deepEqual(L.revertOp([b], remove, a).map((i) => i.id).sort(), [ID, ID2].sort()); // failed remove: back
  assert.deepEqual(L.inverseOp(remove, a), { type: "restore", item: a });
  assert.deepEqual(L.applyOp([b], { type: "restore", item: a }).length, 2);
  assert.deepEqual(L.inverseOp({ type: "restore", item: a }, null), { type: "remove", id: ID });

  // A failure on one item never disturbs a different item that changed meanwhile.
  const other = L.applyOp(updated, { type: "update", id: ID2, patch: { archived: true } });
  const afterFail = L.revertOp(other, update, a);
  assert.deepEqual(afterFail[0], a);
  assert.equal(afterFail[1].archived, true);

  assert.deepEqual(L.opRequest(create), { method: "POST", path: "/api/care/items", body: b });
  assert.deepEqual(L.opRequest(update), { method: "PATCH", path: `/api/care/items/${ID}`, body: update.patch });
  assert.deepEqual(L.opRequest(remove), { method: "DELETE", path: `/api/care/items/${ID}`, body: null });
  assert.deepEqual(L.opRequest({ type: "restore", item: a }), { method: "PATCH", path: `/api/care/items/${ID}`, body: { removed: false } });
});

// ---------- the routes, against an in-memory table ----------

function fakeDb(state) {
  class Query {
    constructor() { this.filters = []; this.op = "select"; this.opts = {}; }
    select(_cols, opts) { if (this.op === "select") this.opts = opts || {}; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(values) { this.op = "update"; this.payload = values; return this; }
    upsert(rows, opts) { this.op = "upsert"; this.payload = rows; this.upsertOpts = opts; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    is(col, v) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.one = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      state.calls.push(this.op);
      if (state.fail) return { data: null, count: null, error: { code: state.fail } };
      const match = (r) => this.filters.every((f) => f(r));
      const fill = (row) => ({
        kind: "other", due_time: null, time_zone: "America/New_York", repeat_months: 0, booked: false, notes: "",
        archived: false, last_completed_on: null, import_key: null, removed_at: null, ...row,
      });
      if (this.op === "select") {
        const rows = state.rows.filter(match);
        return this.opts.head ? { data: null, count: rows.length, error: null } : { data: rows, error: null };
      }
      if (this.op === "insert") {
        if (state.rows.some((r) => r.id === this.payload.id)) return { data: null, error: { code: "23505" } };
        const row = fill(this.payload);
        state.rows.push(row);
        return { data: this.one ? row : [row], error: null };
      }
      if (this.op === "update") {
        const rows = state.rows.filter(match);
        for (const r of rows) Object.assign(r, this.payload);
        return { data: rows, error: null };
      }
      // upsert
      assert.deepEqual(this.upsertOpts, { onConflict: "import_key", ignoreDuplicates: true });
      const added = [];
      for (const row of this.payload) {
        if (state.rows.some((r) => r.import_key === row.import_key)) continue;
        const full = fill({ id: crypto.randomUUID(), ...row });
        state.rows.push(full);
        added.push(full);
      }
      return { data: added, error: null };
    }
  }
  return { from(table) { assert.equal(table, "care_items"); return new Query(); } };
}

function loadRoutes(state) {
  const stubs = {
    "server-only": {},
    "next/server": {
      NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body, headers: init?.headers ?? {} }) },
      after: () => assert.fail("no background sync may be scheduled while Google Calendar is not set up"),
    },
    "@supabase/supabase-js": { createClient: () => fakeDb(state) },
  };
  return {
    items: loadTs("app/api/care/items/route.ts", stubs),
    one: loadTs("app/api/care/items/[id]/route.ts", stubs),
    imp: loadTs("app/api/care/items/import/route.ts", stubs),
  };
}

function request(body, over = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const h = { origin: ORIGIN, host: "onyx.example", ...(body === undefined ? {} : { "content-type": "application/json" }), ...over };
  return { headers: headers(h), nextUrl: { origin: ORIGIN }, text: async () => text };
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const silent = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try { return { result: await fn(), logged }; } finally { console.error = original; }
};

test("POST stores an item, GET lists it, and a retried POST does not add a second", async () => {
  const state = { rows: [], calls: [] };
  const R = loadRoutes(state);
  const created = await R.items.POST(request(item({ time: "09:30" })));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.item, item({ time: "09:30" }));
  assert.equal(created.headers["Cache-Control"], "no-store");
  const again = await R.items.POST(request(item({ time: "09:30" })));
  assert.equal(again.status, 200);
  assert.equal(state.rows.length, 1);
  const list = await R.items.GET();
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items, [item({ time: "09:30" })]);
});

test("POST refuses bad requests before touching the table", async () => {
  const state = { rows: [], calls: [] };
  const R = loadRoutes(state);
  assert.equal((await R.items.POST(request(item(), { origin: "https://evil.example" }))).status, 403);
  assert.equal((await R.items.POST(request(item(), { origin: undefined }))).status, 403);
  assert.equal((await R.items.POST(request(item(), { "content-type": "text/plain" }))).status, 415);
  assert.equal((await R.items.POST(request("{not json"))).status, 400);
  assert.equal((await R.items.POST(request(item({ title: "" })))).status, 400);
  assert.equal((await R.items.POST(request(item({ notes: "x".repeat(1000) + "é".repeat(3000) })))).status, 413); // real size, not the declared one
  assert.deepEqual(state.calls, []);
  assert.equal(state.rows.length, 0);
});

test("POST stops at the item limit", async () => {
  const state = { rows: Array.from({ length: 500 }, (_, n) => ({ id: `row-${n}`, removed_at: null })), calls: [] };
  const R = loadRoutes(state);
  assert.equal((await R.items.POST(request(item()))).status, 409);
  assert.equal(state.rows.length, 500);
});

test("PATCH changes fields, DELETE removes softly, and removed: false brings the item back", async () => {
  const state = { rows: [], calls: [] };
  const R = loadRoutes(state);
  await R.items.POST(request(item()));

  const patched = await R.one.PATCH(request({ booked: true, time: "14:00" }), ctx(ID));
  assert.equal(patched.status, 200);
  assert.equal(patched.body.item.booked, true);
  assert.equal(patched.body.item.time, "14:00");
  assert.ok(state.rows[0].updated_at);

  assert.equal((await R.one.PATCH(request({ booked: true }), ctx(ID2))).status, 404);
  assert.equal((await R.one.PATCH(request({ booked: true }), ctx("nope"))).status, 400);
  assert.equal((await R.one.PATCH(request({ id: ID2 }), ctx(ID))).status, 400);
  assert.equal((await R.one.PATCH(request({ booked: true }, { origin: "https://evil.example" }), ctx(ID))).status, 403);

  const removed = await R.one.DELETE(request(undefined), ctx(ID));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { id: ID });
  assert.equal(state.rows.length, 1, "the row stays in the table");
  assert.ok(state.rows[0].removed_at);
  assert.deepEqual((await R.items.GET()).body.items, []);
  assert.equal((await R.one.DELETE(request(undefined), ctx(ID))).status, 404);          // already removed
  assert.equal((await R.one.PATCH(request({ booked: false }), ctx(ID))).status, 404);    // removed items cannot be edited
  assert.equal((await R.one.DELETE(request(undefined, { origin: "https://evil.example" }), ctx(ID))).status, 403);
  assert.equal((await R.items.POST(request(item()))).status, 409);                       // a removed id is not silently reused

  const restored = await R.one.PATCH(request({ removed: false }), ctx(ID));
  assert.equal(restored.status, 200);
  assert.equal(state.rows[0].removed_at, null);
  assert.equal((await R.items.GET()).body.items.length, 1);
});

test("the one-time copy is idempotent and never resurrects a removed item", async () => {
  const state = { rows: [], calls: [] };
  const R = loadRoutes(state);
  const local = [
    { id: "local-1", title: "Dental cleaning", due: "2026-04-01", months: 6, booked: true, archived: false },
    { id: "local-2", title: "Eye exam", due: "2026-05-01", months: 0, booked: false, archived: true },
  ];
  const first = await R.imp.POST(request({ items: local, tz: "Europe/Madrid" }));
  assert.equal(first.status, 200);
  assert.equal(first.body.copied, 2);
  assert.equal(first.body.skipped, 0);
  assert.equal(first.body.items.length, 2);
  assert.ok(first.body.items.every((i) => L.parseItemId(i.id) && i.tz === "Europe/Madrid" && i.kind === "other" && i.time === null));
  assert.deepEqual(state.rows.map((r) => r.import_key).sort(), ["local-1", "local-2"]);

  const second = await R.imp.POST(request({ items: local, tz: "Europe/Madrid" }));
  assert.equal(second.body.copied, 0);
  assert.equal(second.body.skipped, 2);
  assert.equal(state.rows.length, 2);

  const dental = first.body.items.find((i) => i.title === "Dental cleaning");
  await R.one.DELETE(request(undefined), ctx(dental.id));
  const third = await R.imp.POST(request({ items: local }));
  assert.equal(third.body.copied, 0);
  assert.equal(third.body.items.length, 1);

  assert.equal((await R.imp.POST(request({ items: [] }))).status, 400);
  assert.equal((await R.imp.POST(request({ items: local }, { origin: "https://evil.example" }))).status, 403);
  const sample = [{ id: "sample-1", title: "Sample: annual checkup", due: "2026-04-01", months: 12, booked: false, archived: false }];
  assert.equal((await R.imp.POST(request({ items: sample }))).status, 400);
});

test("a database failure answers 500 with no item text, and logs a code only", async () => {
  const state = { rows: [], calls: [], fail: "XX000" };
  const R = loadRoutes(state);
  const secret = "Very private label";
  const { result, logged } = await silent(async () => [
    await R.items.GET(),
    await R.items.POST(request(item({ title: secret, notes: secret }))),
    await R.one.PATCH(request({ title: secret }), ctx(ID)),
    await R.one.DELETE(request(undefined), ctx(ID)),
    await R.imp.POST(request({ items: [{ id: "local-1", title: secret, due: "2026-04-01", months: 0, booked: false, archived: false }] })),
  ]);
  for (const res of result) {
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.body).includes(secret));
  }
  assert.ok(logged.length >= 5);
  for (const line of logged) {
    assert.ok(!line.includes(secret), "logs must not carry item text");
    assert.match(line, /XX000$/);
  }
});

// ---------- boundaries checked from the source ----------

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("the care routes are owner-session only and nothing is cached", () => {
  const middleware = read(SRC, "middleware.ts");
  const ciBlock = middleware.slice(middleware.indexOf("function isCiRoute"), middleware.indexOf("const PUBLIC_MANIFEST"));
  assert.ok(ciBlock.length > 0);
  assert.ok(!ciBlock.includes("/api/care"), "/api/care must not be admitted by the CI token");
  assert.ok(!middleware.slice(middleware.indexOf("matcher")).includes("api/care"), "middleware must run on /api/care");
  for (const file of ["app/api/care/items/route.ts", "app/api/care/items/[id]/route.ts", "app/api/care/items/import/route.ts"]) {
    const src = read(SRC, file);
    assert.match(src, /export const dynamic = "force-dynamic"/, file);
    assert.ok(!/console\.(log|info|warn)\(/.test(src), file);
    for (const line of src.split("\n").filter((l) => l.includes("console.error"))) assert.match(line, /\.code/, `${file}: ${line.trim()}`);
  }
  const page = read(SRC, "app/health/page.tsx");
  assert.match(page, /export const dynamic = 'force-dynamic'/);
  assert.ok(!/revalidate/.test(page), "/health must not be ISR");
  const server = read(SRC, "lib/care-items-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/sync_log/.test(server.replace(/\/\*[\s\S]*?\*\//g, "")), "care items never write heartbeats");
  // The browser bundle never reaches the table directly.
  for (const file of ["app/health/HealthClient.tsx", "app/health/CareCalendar.tsx", "lib/care-items.ts", "lib/care-planner.ts"]) {
    const src = read(SRC, file);
    assert.ok(!/@supabase|createClient|SERVICE_ROLE/.test(src), `${file} must not talk to the database`);
    assert.ok(!/from ['"]@\/lib\/care-items-server['"]/.test(src.replace(/import type [^;]+;/g, "")), `${file} may import server types only`);
  }
});

test("the schema is additive and service-role only", () => {
  const sql = read(SRC, "..", "..", "sql", "care_items_schema.sql");
  assert.ok(!/\b(drop|truncate|delete)\b/i.test(sql), "additive only");
  assert.match(sql, /ALTER TABLE pds\.care_items ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON pds\.care_items FROM PUBLIC, anon, authenticated/);
  const statements = sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  assert.ok(!/GRANT[^;]*\b(anon|authenticated|public)\b/i.test(statements), "nothing granted to anon / authenticated");
  assert.ok(!/CREATE POLICY/i.test(sql), "no policies: service role only");
  for (const col of L.CARE_COLUMNS.split(",")) assert.match(sql, new RegExp(`\\b${col}\\b`), col);
});
