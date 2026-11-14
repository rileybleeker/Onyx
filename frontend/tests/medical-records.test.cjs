// Run: node --test tests/medical-records.test.cjs
// /health/records (lib/medical-records.ts + the /api/medical/* routes): body checks, row mapping,
// the lab helpers (value / range parsing, High / Low, trend series), the routes run against an
// in-memory stand-in for the database and the storage bucket, and the privacy boundaries checked
// from the source (owner session only, never cached, never read by a model, additive SQL).
// SYNTHETIC DATA ONLY: invented test names, values and titles; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/medical-records.ts");

const DOC = "11111111-2222-4333-8444-555555555555";
const DOC2 = "22222222-3333-4444-8555-666666666666";
const LAB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LAB2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ORIGIN = "https://onyx.example";

const newDoc = (over = {}) => ({
  id: DOC, title: "Sample panel", kind: "lab", date: "2026-03-10", provider: "Example Clinic", notes: "", mime: "application/pdf", size: 2048, ...over,
});
const lab = (over = {}) => ({
  id: LAB, test: "Sample marker", value: 5.4, valueText: "", unit: "mmol/L", refLow: 4, refHigh: 6, refText: "4-6",
  collectedOn: "2026-03-10", lab: "Example Lab", documentId: null, notes: "", ...over,
});

// ---------- body checks ----------

test("a new document is accepted with exact fields and refused when anything is off", () => {
  const ok = L.parseNewDocument(newDoc({ title: "  Sample panel  " }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.doc, newDoc());
  const bad = [
    null, [], {}, newDoc({ id: "x" }), newDoc({ id: LAB.toUpperCase() }), newDoc({ title: "" }), newDoc({ title: "a\nb" }),
    newDoc({ title: "x".repeat(121) }), newDoc({ kind: "surgery" }), newDoc({ date: "2026-02-30" }), newDoc({ provider: "x".repeat(121) }),
    newDoc({ notes: "x".repeat(2001) }), newDoc({ notes: "bell\u0007" }), newDoc({ mime: "text/html" }), newDoc({ mime: "image/svg+xml" }),
    newDoc({ size: 0 }), newDoc({ size: 25 * 1024 * 1024 + 1 }), newDoc({ size: 1.5 }), newDoc({ size: "2048" }),
    { ...newDoc(), extra: 1 }, { ...newDoc(), storage_path: "documents/x" }, { ...newDoc(), status: "ready" },
  ];
  for (const body of bad) assert.equal(L.parseNewDocument(body).ok, false, JSON.stringify(body));
  const { mime: _m, ...missing } = newDoc();
  assert.equal(L.parseNewDocument(missing).ok, false);
});

test("a document patch takes editable fields only", () => {
  assert.deepEqual(L.parseDocumentPatch({ title: " New ", kind: "visit" }), { ok: true, patch: { title: "New", kind: "visit" } });
  assert.deepEqual(L.parseDocumentPatch({ removed: false }), { ok: true, patch: { removed: false } });
  for (const body of [{}, null, { removed: true }, { mime: "application/pdf" }, { size: 10 }, { status: "ready" }, { storage_path: "x" }, { id: DOC2 }, { date: "bad" }]) {
    assert.equal(L.parseDocumentPatch(body).ok, false, JSON.stringify(body));
  }
});

test("a lab result needs a value, a sane range and known fields", () => {
  assert.deepEqual(L.parseLabResult(lab({ test: "  Sample marker " })), { ok: true, result: lab() });
  assert.equal(L.parseLabResult(lab({ value: null, valueText: "Negative" })).ok, true);
  const bad = [
    lab({ value: null, valueText: "" }), lab({ value: Infinity }), lab({ value: "5.4" }), lab({ refLow: 7, refHigh: 6 }),
    lab({ test: "" }), lab({ test: "x".repeat(81) }), lab({ unit: "x".repeat(25) }), lab({ collectedOn: "03/10/2026" }),
    lab({ documentId: "doc" }), lab({ notes: "x".repeat(501) }), { ...lab(), extra: 1 }, lab({ id: "1" }),
  ];
  for (const body of bad) assert.equal(L.parseLabResult(body).ok, false, JSON.stringify(body));
});

test("a batch is 1..60 results with unique ids", () => {
  assert.equal(L.parseLabBatch({ results: [lab(), lab({ id: LAB2 })] }).ok, true);
  assert.equal(L.parseLabBatch({ results: [] }).ok, false);
  assert.equal(L.parseLabBatch({ results: [lab(), lab()] }).ok, false);
  assert.equal(L.parseLabBatch({ results: [lab()], extra: 1 }).ok, false);
  assert.equal(L.parseLabBatch([lab()]).ok, false);
  const many = Array.from({ length: 61 }, (_, i) => lab({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, "0")}` }));
  assert.equal(L.parseLabBatch({ results: many }).ok, false);
  assert.equal(L.parseLabBatch({ results: many.slice(0, 60) }).ok, true);
});

test("a lab patch checks fields it can check on its own", () => {
  assert.deepEqual(L.parseLabPatch({ value: 6.1 }), { ok: true, patch: { value: 6.1 } });
  assert.equal(L.parseLabPatch({ value: null, valueText: "" }).ok, false);
  assert.equal(L.parseLabPatch({ refLow: 9, refHigh: 2 }).ok, false);
  assert.equal(L.parseLabPatch({ removed: true }).ok, false);
  assert.equal(L.parseLabPatch({ id: LAB2 }).ok, false);
  assert.equal(L.parseLabPatch({}).ok, false);
});

// ---------- lab helpers ----------

test("values and ranges are read the way a report prints them", () => {
  assert.equal(L.parseNumber("5.4"), 5.4);
  assert.equal(L.parseNumber("1,200"), 1200);
  assert.equal(L.parseNumber(".5"), 0.5);
  assert.equal(L.parseNumber("-3"), -3);
  assert.equal(L.parseNumber("5.4 H"), null);
  assert.equal(L.parseNumber("1,2"), null);
  assert.deepEqual(L.parseLabValue("5.4"), { value: 5.4, valueText: "" });
  assert.deepEqual(L.parseLabValue(" Negative "), { value: null, valueText: "Negative" });
  assert.deepEqual(L.parseLabValue("<0.5"), { value: null, valueText: "<0.5" });
  assert.deepEqual(L.parseRange("70-99"), { refLow: 70, refHigh: 99, refText: "70-99" });
  assert.deepEqual(L.parseRange("70 – 99"), { refLow: 70, refHigh: 99, refText: "70 – 99" });
  assert.deepEqual(L.parseRange("3.5 to 5.0"), { refLow: 3.5, refHigh: 5, refText: "3.5 to 5.0" });
  assert.deepEqual(L.parseRange("<200"), { refLow: null, refHigh: 200, refText: "<200" });
  assert.deepEqual(L.parseRange("≤ 5.7"), { refLow: null, refHigh: 5.7, refText: "≤ 5.7" });
  assert.deepEqual(L.parseRange(">40"), { refLow: 40, refHigh: null, refText: ">40" });
  assert.deepEqual(L.parseRange("Negative"), { refLow: null, refHigh: null, refText: "Negative" });
  assert.deepEqual(L.parseRange("99-70"), { refLow: null, refHigh: null, refText: "99-70" });
  assert.deepEqual(L.parseRange(""), { refLow: null, refHigh: null, refText: "" });
});

test("High / Low compare with the stored range only", () => {
  assert.equal(L.labFlag(lab({ value: 3.9 })), "low");
  assert.equal(L.labFlag(lab({ value: 6.1 })), "high");
  assert.equal(L.labFlag(lab({ value: 6 })), "in-range");
  assert.equal(L.labFlag(lab({ value: 4 })), "in-range");
  assert.equal(L.labFlag(lab({ refLow: null, refHigh: 200, value: 210 })), "high");
  assert.equal(L.labFlag(lab({ refLow: 40, refHigh: null, value: 39 })), "low");
  assert.equal(L.labFlag(lab({ refLow: null, refHigh: null })), null);
  assert.equal(L.labFlag(lab({ value: null, valueText: "Negative" })), null);
  assert.equal(L.formatResult(lab()), "5.4 mmol/L");
  assert.equal(L.formatRange(lab({ refText: "" })), "4-6");
  assert.equal(L.formatRange(lab({ refText: "", refLow: null })), "≤ 6");
});

test("series group one test in one unit, oldest first, with the newest as latest", () => {
  const rows = [
    lab({ id: LAB, collectedOn: "2026-01-01", value: 5 }),
    lab({ id: LAB2, collectedOn: "2026-03-01", value: 6.2, test: "sample  MARKER" }),
    lab({ id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", collectedOn: "2026-02-01", value: 90, unit: "mg/dL" }),
    lab({ id: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", collectedOn: "2026-02-01", test: "Another test", value: null, valueText: "Negative", unit: "" }),
  ];
  const s = L.labSeries(rows);
  assert.deepEqual(s.map((x) => [x.test, x.unit, x.results.length]), [["Another test", "", 1], ["Sample marker", "mg/dL", 1], ["sample  MARKER", "mmol/L", 2]]);
  const marker = s[2];
  assert.equal(marker.latest.id, LAB2);
  assert.equal(marker.previous.id, LAB);
  assert.equal(marker.numericCount, 2);
  assert.equal(s[0].numericCount, 0);
  assert.deepEqual([...rows].sort(L.compareNewestFirst).map((r) => r.collectedOn), ["2026-03-01", "2026-02-01", "2026-02-01", "2026-01-01"]);
});

test("files: accepted types, safe names, and storage paths that carry only the id", () => {
  assert.equal(L.mimeForFile("scan.PDF", ""), "application/pdf");
  assert.equal(L.mimeForFile("photo.heic", ""), "image/heic");
  assert.equal(L.mimeForFile("photo", "image/jpg"), "image/jpeg");
  assert.equal(L.mimeForFile("page.html", "text/html"), null);
  assert.equal(L.mimeForFile("x.svg", "image/svg+xml"), null);
  assert.equal(L.titleFromFileName("sample_panel_2026.pdf"), "sample panel 2026");
  assert.equal(L.downloadName({ title: 'Panel: "a/b" <x>', date: "2026-03-10", mime: "application/pdf" }), "2026-03-10 Panel ab x.pdf");
  assert.equal(L.downloadName({ title: "///", date: "2026-03-10", mime: "image/png" }), "2026-03-10 document.png");
  assert.equal(L.storagePathFor(DOC), `documents/${DOC}`);
  assert.equal(L.formatBytes(2048), "2 KB");
  assert.equal(L.formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("rows map to the API shape (numeric columns may arrive as text)", () => {
  const row = {
    id: LAB, test_name: "Sample marker", value_num: "5.4", value_text: "", unit: "mmol/L", ref_low: "4", ref_high: 6, ref_text: "4-6",
    collected_on: "2026-03-10", lab: "Example Lab", document_id: null, notes: "",
  };
  assert.deepEqual(L.rowToLab(row), lab());
  assert.equal(L.rowToLab({ ...row, value_num: null, value_text: "" }), null);
  assert.deepEqual(L.labColumns(lab()), {
    test_name: "Sample marker", value_num: 5.4, value_text: "", unit: "mmol/L", ref_low: 4, ref_high: 6, ref_text: "4-6",
    collected_on: "2026-03-10", lab: "Example Lab", document_id: null, notes: "",
  });
  const docRow = { id: DOC, title: "Sample panel", kind: "lab", doc_date: "2026-03-10", provider: "Example Clinic", notes: "", mime_type: "application/pdf", size_bytes: "2048", uploaded_at: "2026-03-10T12:00:00Z" };
  assert.deepEqual(L.rowToDocument(docRow), { ...newDoc(), uploadedAt: "2026-03-10T12:00:00Z" });
  assert.equal(L.rowToDocument({ ...docRow, mime_type: "text/html" }), null);
  assert.deepEqual(L.documentColumns({ removed: false, title: "T" }), { title: "T", removed_at: null });
  for (const col of L.DOC_COLUMNS.split(",")) assert.ok(col in docRow, col);
});

// ---------- routes against an in-memory database + bucket ----------

function fakeDb(state) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this.opts = {}; }
    select(_cols, opts) { if (this.op === "select") this.opts = opts || {}; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(values) { this.op = "update"; this.payload = values; return this; }
    upsert(rows, opts) { this.op = "upsert"; this.payload = rows; this.upsertOpts = opts; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    is(col, v) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
    in(col, vs) { this.filters.push((r) => vs.includes(r[col])); return this; }
    order() { return this; }
    range(from, to) { this.window = [from, to]; return this; }
    limit() { return this; }
    single() { this.one = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      state.calls.push(`${this.table}:${this.op}`);
      if (state.fail) return { data: null, count: null, error: { code: state.fail } };
      const rows = state[this.table];
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === "select") {
        let found = rows.filter(match);
        if (this.window) found = found.slice(this.window[0], this.window[1] + 1);
        return this.opts.head ? { data: null, count: rows.filter(match).length, error: null } : { data: found.map((r) => ({ ...r })), error: null };
      }
      if (this.op === "insert") {
        if (rows.some((r) => r.id === this.payload.id)) return { data: null, error: { code: "23505" } };
        rows.push({ removed_at: null, uploaded_at: null, ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, this.payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      assert.deepEqual(this.upsertOpts, { onConflict: "id", ignoreDuplicates: true });
      for (const row of this.payload) if (!rows.some((r) => r.id === row.id)) rows.push({ removed_at: null, ...row });
      return { data: null, error: null };
    }
  }
  const storage = {
    from(bucket) {
      assert.equal(bucket, "medical-records");
      return {
        async createSignedUploadUrl(p) { state.uploads.push(p); return { data: { path: p, token: `token-${state.uploads.length}`, signedUrl: "https://storage.example/u" }, error: null }; },
        async info(p) { const f = state.files[p]; return f ? { data: { size: f.size, contentType: f.type }, error: null } : { data: null, error: { statusCode: "404" } }; },
        async createSignedUrl(p, secs, opts) { state.views.push({ p, secs, opts }); return { data: { signedUrl: `https://storage.example/v/${p}?t=1` }, error: null }; },
      };
    },
  };
  return { from(table) { assert.ok(["medical_documents", "lab_results"].includes(table), table); return new Query(table); }, storage };
}

function loadRoutes(state) {
  const stubs = {
    "server-only": {},
    "next/server": {
      NextResponse: {
        json: (body, init) => ({ status: init?.status ?? 200, body, headers: init?.headers ?? {} }),
        redirect: (url, status) => { const h = {}; return { status, url, headers: { set: (k, v) => { h[k] = v; }, all: h } }; },
      },
    },
    "@supabase/supabase-js": { createClient: () => fakeDb(state) },
  };
  return {
    docs: loadTs("app/api/medical/documents/route.ts", stubs),
    doc: loadTs("app/api/medical/documents/[id]/route.ts", stubs),
    complete: loadTs("app/api/medical/documents/[id]/complete/route.ts", stubs),
    file: loadTs("app/api/medical/documents/[id]/file/route.ts", stubs),
    labs: loadTs("app/api/medical/labs/route.ts", stubs),
    labOne: loadTs("app/api/medical/labs/[id]/route.ts", stubs),
  };
}

const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
function request(body, over = {}, search = "") {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = { origin: ORIGIN, host: "onyx.example", ...(body === undefined ? {} : { "content-type": "application/json" }), ...over };
  return { headers: headers(h), nextUrl: { origin: ORIGIN, searchParams: new URLSearchParams(search) }, text: async () => text };
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const fresh = () => ({ medical_documents: [], lab_results: [], uploads: [], files: {}, views: [], calls: [] });
const silent = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try { return { result: await fn(), logged }; } finally { console.error = original; }
};

test("a document is listed only after the server finds the declared file in the bucket", async () => {
  const state = fresh();
  const R = loadRoutes(state);
  const created = await R.docs.POST(request(newDoc()));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.upload, { path: `documents/${DOC}`, token: "token-1" });
  assert.equal(created.headers["Cache-Control"], "no-store");
  assert.equal(state.medical_documents[0].status, "pending");
  assert.equal(state.medical_documents[0].storage_path, `documents/${DOC}`);
  assert.deepEqual((await R.docs.GET()).body.documents, [], "pending documents are not listed");

  // A retried create of the same pending id hands out a new token, no second row.
  const again = await R.docs.POST(request(newDoc()));
  assert.equal(again.status, 200);
  assert.equal(again.body.upload.token, "token-2");
  assert.equal(state.medical_documents.length, 1);

  assert.equal((await R.complete.POST(request(undefined), ctx(DOC))).status, 409, "no file yet");
  state.files[`documents/${DOC}`] = { size: 999, type: "application/pdf" };
  assert.equal((await R.complete.POST(request(undefined), ctx(DOC))).status, 409, "wrong size");
  state.files[`documents/${DOC}`] = { size: 2048, type: "text/html" };
  assert.equal((await R.complete.POST(request(undefined), ctx(DOC))).status, 409, "wrong type");
  state.files[`documents/${DOC}`] = { size: 2048, type: "application/pdf" };
  const done = await R.complete.POST(request(undefined), ctx(DOC));
  assert.equal(done.status, 200);
  assert.equal(done.body.document.id, DOC);
  assert.equal(state.medical_documents[0].status, "ready");
  assert.equal((await R.complete.POST(request(undefined), ctx(DOC))).status, 200, "finishing twice is harmless");

  const list = await R.docs.GET();
  assert.equal(list.body.documents.length, 1);
  assert.equal((await R.docs.POST(request(newDoc()))).status, 409, "a ready document is never re-opened for upload");
});

test("files are served through a 60-second link, never for removed or pending documents", async () => {
  const state = fresh();
  const R = loadRoutes(state);
  await R.docs.POST(request(newDoc()));
  assert.equal((await R.file.GET(request(undefined), ctx(DOC))).status, 404, "pending");
  state.files[`documents/${DOC}`] = { size: 2048, type: "application/pdf" };
  await R.complete.POST(request(undefined), ctx(DOC));
  const open = await R.file.GET(request(undefined), ctx(DOC));
  assert.equal(open.status, 303);
  assert.equal(open.headers.all["Cache-Control"], "no-store");
  assert.equal(open.headers.all["Referrer-Policy"], "no-referrer");
  assert.deepEqual(state.views[0], { p: `documents/${DOC}`, secs: 60, opts: undefined });
  await R.file.GET(request(undefined, {}, "download=1"), ctx(DOC));
  assert.deepEqual(state.views[1].opts, { download: "2026-03-10 Sample panel.pdf" });

  assert.equal((await R.doc.DELETE(request(undefined), ctx(DOC))).status, 200);
  assert.ok(state.medical_documents[0].removed_at, "removal is soft");
  assert.equal((await R.file.GET(request(undefined), ctx(DOC))).status, 404);
  assert.deepEqual((await R.docs.GET()).body.documents, []);
  const back = await R.doc.PATCH(request({ removed: false }), ctx(DOC));
  assert.equal(back.status, 200);
  assert.equal((await R.docs.GET()).body.documents.length, 1);
  const renamed = await R.doc.PATCH(request({ title: "Renamed" }), ctx(DOC));
  assert.equal(renamed.body.document.title, "Renamed");
  assert.equal((await R.file.GET(request(undefined), ctx("not-a-uuid"))).status, 400);
});

test("lab results save as a batch, a retry stores nothing twice, and links need a listed document", async () => {
  const state = fresh();
  const R = loadRoutes(state);
  const batch = { results: [lab(), lab({ id: LAB2, test: "Other marker", value: null, valueText: "Negative", unit: "", refLow: null, refHigh: null, refText: "" })] };
  const saved = await R.labs.POST(request(batch));
  assert.equal(saved.status, 201);
  assert.equal(saved.body.results.length, 2);
  const retry = await R.labs.POST(request(batch));
  assert.equal(retry.status, 201);
  assert.equal(state.lab_results.length, 2);

  const linked = await R.labs.POST(request({ results: [lab({ id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", documentId: DOC2 })] }));
  assert.equal(linked.status, 400, "unknown document");
  assert.equal(state.lab_results.length, 2);

  const changed = await R.labOne.PATCH(request({ value: 6.5 }), ctx(LAB));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.result.value, 6.5);
  assert.equal((await R.labOne.PATCH(request({ documentId: DOC2 }), ctx(LAB))).status, 400);
  assert.equal((await R.labOne.DELETE(request(undefined), ctx(LAB))).status, 200);
  assert.equal((await R.labs.GET()).body.results.length, 1);
  assert.equal((await R.labOne.PATCH(request({ value: 1 }), ctx(LAB))).status, 404, "a removed result is not edited");
  assert.equal((await R.labOne.PATCH(request({ removed: false }), ctx(LAB))).status, 200);
  assert.equal((await R.labs.GET()).body.results.length, 2);
});

test("writes are refused before touching the database when the request is wrong", async () => {
  const state = fresh();
  const R = loadRoutes(state);
  const refusals = [
    await R.docs.POST(request(newDoc(), { origin: "https://evil.example" })),
    await R.docs.POST(request(newDoc(), { origin: undefined })),
    await R.docs.POST(request(newDoc(), { "content-type": "text/plain" })),
    await R.docs.POST(request(newDoc({ mime: "text/html" }))),
    await R.labs.POST(request({ results: [lab({ value: null })] })),
    await R.labOne.DELETE(request(undefined, { origin: "https://evil.example" }), ctx(LAB)),
    await R.complete.POST(request(undefined, { origin: "https://evil.example" }), ctx(DOC)),
    await R.doc.PATCH(request({ status: "ready" }), ctx(DOC)),
  ];
  for (const res of refusals) assert.ok(res.status >= 400 && res.status < 500, String(res.status));
  assert.deepEqual(state.calls, []);
});

test("a database failure answers 500 with no record text, and logs a code only", async () => {
  const state = { ...fresh(), fail: "XX000" };
  const R = loadRoutes(state);
  const secret = "Very private marker";
  const { result, logged } = await silent(async () => [
    await R.docs.GET(),
    await R.labs.GET(),
    await R.docs.POST(request(newDoc({ title: secret, notes: secret }))),
    await R.labs.POST(request({ results: [lab({ test: secret, notes: secret })] })),
    await R.labOne.PATCH(request({ test: secret }), ctx(LAB)),
    await R.doc.PATCH(request({ title: secret }), ctx(DOC)),
    await R.file.GET(request(undefined), ctx(DOC)),
  ]);
  for (const res of result) {
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.body).includes(secret));
  }
  assert.ok(logged.length >= 7);
  for (const line of logged) {
    assert.ok(!line.includes(secret), "logs must not carry record text");
    assert.match(line, /XX000$/);
  }
});

// ---------- boundaries checked from the source ----------

const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");
const ROUTES = [
  "app/api/medical/documents/route.ts", "app/api/medical/documents/[id]/route.ts", "app/api/medical/documents/[id]/complete/route.ts",
  "app/api/medical/documents/[id]/file/route.ts", "app/api/medical/labs/route.ts", "app/api/medical/labs/[id]/route.ts",
];

test("the medical routes are owner-session only, never cached, and log codes only", () => {
  const middleware = read(SRC, "middleware.ts");
  const ciBlock = middleware.slice(middleware.indexOf("function isCiRoute"), middleware.indexOf("const PUBLIC_MANIFEST"));
  assert.ok(ciBlock.length > 0);
  assert.ok(!/medical|\/health/.test(ciBlock), "/api/medical must not be admitted by the CI token");
  assert.ok(!/medical/.test(middleware.slice(middleware.indexOf("matcher"))), "middleware must run on /api/medical");
  for (const file of ROUTES) {
    const src = read(SRC, file);
    assert.match(src, /export const dynamic = "force-dynamic"/, file);
    assert.ok(!/console\.(log|info|warn)\(/.test(src), file);
    for (const line of src.split("\n").filter((l) => l.includes("console.error"))) assert.match(line, /\.code/, `${file}: ${line.trim()}`);
    assert.ok(!/sync_log|anthropic|voyage/i.test(src), `${file}: no heartbeats, no model calls`);
  }
  const page = read(SRC, "app/health/records/page.tsx");
  assert.match(page, /export const dynamic = 'force-dynamic'/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.ok(!/revalidate/.test(page), "/health/records must not be ISR");
  const server = read(SRC, "lib/medical-records-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/sync_log/.test(server.replace(/\/\*[\s\S]*?\*\//g, "")), "medical records never write heartbeats");
});

test("the browser only uploads with a one-time token; it never reads the tables or the bucket", () => {
  for (const file of ["app/health/records/RecordsClient.tsx", "app/health/records/LabTrendChart.tsx", "lib/medical-records.ts"]) {
    const src = read(SRC, file);
    assert.ok(!/SERVICE_ROLE|@supabase\/supabase-js|createClient\(/.test(src), `${file} must not hold the service role`);
    assert.ok(!/from ['"]@\/lib\/medical-records-server['"]/.test(src.replace(/import type [^;]+;/g, "")), `${file} may import server types only`);
    assert.ok(!/\.(download|createSignedUrl|list|info|remove)\(/.test(src), `${file} must not read the bucket`);
    assert.ok(!/\.schema\(|\.from\(['"](medical_documents|lab_results)/.test(src), `${file} must not query the tables`);
  }
  const client = read(SRC, "app/health/records/RecordsClient.tsx");
  assert.equal((client.match(/\.storage\.from\(/g) || []).length, 1);
  assert.match(client, /\.uploadToSignedUrl\(/);
});

test("no chat tool or model prompt reads medical records", () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !p.includes(`${path.sep}medical`) && !p.includes(`health${path.sep}records`) && !p.endsWith(`medical-records.ts`) && !p.endsWith(`medical-records-server.ts`)) {
        if (/medical_documents|lab_results|medical-records|\/api\/medical/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(SRC, p));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits.filter((h) => !["lib/nav.ts", "app/health/HealthClient.tsx"].includes(h.split(path.sep).join("/"))), []);
});

test("the schema is additive, private and service-role only", () => {
  const sql = read(SRC, "..", "..", "sql", "medical_records_schema.sql").replace(/\r/g, ""); // CRLF-safe on a Windows checkout
  assert.ok(!/\b(drop|truncate|delete)\b/i.test(sql), "additive only (and safe to send through the Supabase connector)");
  for (const t of ["medical_documents", "lab_results"]) {
    assert.match(sql, new RegExp(`ALTER TABLE pds\\.${t} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON pds\\.${t} FROM PUBLIC, anon, authenticated`));
  }
  const statements = sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  assert.ok(!/GRANT[^;]*\b(anon|authenticated|public)\b/i.test(statements), "nothing granted to anon / authenticated");
  assert.ok(!/CREATE POLICY/i.test(sql), "no policies: service role only (tables and bucket)");
  assert.match(statements, /'medical-records', 'medical-records', false, 26214400/, "the bucket is private with a 25 MB cap");
  for (const mime of L.DOC_MIME_TYPES) assert.ok(statements.includes(`'${mime}'`), mime);
  for (const col of [...L.DOC_COLUMNS.split(","), ...L.LAB_COLUMNS.split(",")]) assert.match(sql, new RegExp(`\\b${col}\\b`), col);
});

// ---------- the page renders its three states offline ----------

test("the page renders data, empty and failed states (synthetic rows, no network)", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Client = loadTs("app/health/records/RecordsClient.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
    "next/dynamic": { __esModule: true, default: () => () => React.createElement("div", { "data-chart": "lab" }) },
    "@/lib/supabase-browser": { createSupabaseBrowser: () => assert.fail("rendering must not create a storage client") },
  }).default;
  const render = (documents, labs) => renderToStaticMarkup(React.createElement(Client, { documents, labs }));
  const ready = (items) => ({ state: "ready", items });

  const doc = { ...newDoc(), uploadedAt: "2026-03-10T12:00:00Z" };
  const rows = [
    lab({ id: LAB, collectedOn: "2026-01-10", value: 6.4, documentId: DOC }),
    lab({ id: LAB2, collectedOn: "2026-03-10", value: 5.2 }),
  ];
  const full = render(ready([doc]), ready(rows));
  assert.match(full, /Medical records/);
  assert.match(full, /Sample marker/);
  assert.match(full, /5\.2 mmol\/L/);
  assert.match(full, /In range/);
  assert.match(full, /data-chart="lab"/, "two numeric results draw a chart");
  assert.match(full, /Sample panel/);
  assert.match(full, /\/api\/medical\/documents\/11111111-2222-4333-8444-555555555555\/file/);
  assert.match(full, /1 lab result/);
  assert.ok(!/No lab results yet|Couldn&#x27;t load/.test(full));

  const empty = render(ready([]), ready([]));
  assert.match(empty, /No lab results yet\. Add the values from a lab report below\./);
  assert.match(empty, /No documents yet/);

  const failed = render({ state: "error" }, { state: "error" });
  assert.match(failed, /Couldn&#x27;t load lab results\./);
  assert.match(failed, /Couldn&#x27;t load documents\./);
  assert.ok(!/No lab results yet/.test(failed), "a failed load is never shown as an empty account");
});
