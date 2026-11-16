// Run: node --test tests/screen-time-upload.test.cjs
// Screen Time export completeness (PIPE-11): the `run` metadata parser (lib/screen-time-upload.ts) and the
// usage route's write order against a fake Supabase client. SYNTHETIC values only: invented ids, hours and
// bundle ids. The database rules (which run counts as complete) are checked on a branch by
// sql/checks/verify_phone_usage_completeness_branch.sql and statically by tests/test_phone_usage_completeness_sql.py.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const U = loadTs("lib/screen-time-upload.ts");

const NOW = Date.parse("2030-03-10T15:00:00Z");
const LIMITS = { maxFutureMs: 2 * 3_600_000, maxAgeMs: 400 * 86_400_000 };
const RUN_ID = "0A1B2C3D-0000-4000-8000-00000000AB01"; // upper case, as Swift's uuidString sends it

function runMeta(over = {}) {
  return {
    run_id: RUN_ID,
    window_start: "2030-03-08T05:00:00Z",
    window_end: "2030-03-10T14:30:00Z",
    stream_ended: true,
    segment_count: 2,
    chunk_index: 0,
    chunk_count: 1,
    ...over,
  };
}

test("no run object = an older app build: accepted, completeness unknown", () => {
  assert.deepEqual(U.parseUploadRun(undefined, NOW, LIMITS), { kind: "none" });
  assert.deepEqual(U.parseUploadRun(null, NOW, LIMITS), { kind: "none" });
});

test("a good run parses, the id is lower-cased and times normalised", () => {
  const p = U.parseUploadRun(runMeta(), NOW, LIMITS);
  assert.equal(p.kind, "ok");
  assert.equal(p.run.runId, RUN_ID.toLowerCase());
  assert.equal(p.run.windowStart, "2030-03-08T05:00:00.000Z");
  assert.equal(p.run.windowEnd, "2030-03-10T14:30:00.000Z");
  assert.equal(p.run.streamEnded, true);
  assert.deepEqual([p.run.segmentCount, p.run.chunkIndex, p.run.chunkCount], [2, 0, 1]);
  // A watchdog stop is still a well-formed run: the database decides it is not complete.
  assert.equal(U.parseUploadRun(runMeta({ stream_ended: false }), NOW, LIMITS).run.streamEnded, false);
});

test("every malformed field is refused with a reason that names the field and echoes no value", () => {
  const bad = [
    ["not an object", "x"],
    ["not an object", [runMeta()]],
    ["run_id", { run_id: "secret-not-a-uuid" }],
    ["run_id", { run_id: 7 }],
    ["window_start", { window_start: "yesterday" }],
    ["window_end is not after", { window_end: "2030-03-08T05:00:00Z" }],
    ["longer than 40 days", { window_start: "2030-01-01T00:00:00Z" }],
    ["outside the accepted time range", { window_end: "2030-03-10T20:00:00Z" }],
    ["stream_ended", { stream_ended: "true" }],
    ["stream_ended", { stream_ended: 1 }],
    ["segment_count", { segment_count: 0 }],
    ["segment_count", { segment_count: 2.5 }],
    ["segment_count", { segment_count: 5000 }],
    ["chunk_count", { chunk_count: 0 }],
    ["chunk_count", { chunk_count: 101 }],
    ["chunk_index", { chunk_index: 1, chunk_count: 1 }],
    ["chunk_index", { chunk_index: -1 }],
    ["chunk_index", { chunk_index: "0" }],
  ];
  for (const [needle, over] of bad) {
    const raw = typeof over === "object" && !Array.isArray(over) ? runMeta(over) : over;
    const p = U.parseUploadRun(raw, NOW, LIMITS);
    assert.equal(p.kind, "bad", needle);
    assert.ok(p.reason.includes(needle.split(" ")[0]) || p.reason.includes(needle), `${needle}: ${p.reason}`);
    assert.ok(!p.reason.includes("secret"), p.reason);
  }
});

test("segments must overlap the run window; the hour in progress may end after it", () => {
  const run = U.parseUploadRun(runMeta(), NOW, LIMITS).run;
  const ms = (iso) => Date.parse(iso);
  assert.equal(U.segmentInWindow(ms("2030-03-10T14:00:00Z"), ms("2030-03-10T15:00:00Z"), run), true);
  assert.equal(U.segmentInWindow(ms("2030-03-08T05:00:00Z"), ms("2030-03-08T06:00:00Z"), run), true);
  assert.equal(U.segmentInWindow(ms("2030-03-08T04:00:00Z"), ms("2030-03-08T05:00:00Z"), run), false);
  assert.equal(U.segmentInWindow(ms("2030-03-10T14:30:00Z"), ms("2030-03-10T15:30:00Z"), run), false);
});

test("run statuses: only the five the database answers, anything else is unknown", () => {
  for (const s of ["complete", "receiving", "stream_open", "inconsistent", "unknown_run"]) {
    assert.equal(U.runStatusOf({ status: s }), s);
  }
  for (const a of [null, undefined, "complete", {}, { status: "verified" }, { status: 1 }]) assert.equal(U.runStatusOf(a), "unknown");
});

// ── The route, against a fake Supabase client that records the order of writes ─────────────────────────────────
function fakeSupabase(fixture = {}) {
  const log = [];
  const client = {
    from(table) {
      return {
        insert(row) {
          log.push({ op: "insert", table, row });
          return Promise.resolve({ error: null });
        },
        upsert(rows, opts) {
          log.push({ op: "upsert", table, rows, opts });
          const fail = fixture.failTable === table ? { message: `${table} write failed` } : null;
          return Promise.resolve({ error: fail });
        },
      };
    },
    rpc(name, args) {
      log.push({ op: "rpc", name, args });
      if (fixture.rpcError) return Promise.resolve({ data: null, error: { message: fixture.rpcError } });
      return Promise.resolve({ data: fixture.rpcAnswer ?? { status: "complete", hours_verified: 2 }, error: null });
    },
  };
  return { client, log };
}

let current = fakeSupabase();
const route = loadTs("app/api/screen-time/usage/route.ts", {
  "@supabase/supabase-js": { createClient: () => ({ from: (t) => current.client.from(t), rpc: (n, a) => current.client.rpc(n, a) }) },
  "next/server": { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
});

const realNow = Date.now;
async function post(body, fixture) {
  current = fakeSupabase(fixture);
  Date.now = () => NOW;
  try {
    const res = await route.POST({ json: async () => body });
    return { res, log: current.log };
  } finally {
    Date.now = realNow;
  }
}

const hourSeg = (startIso, items = []) => ({
  start: startIso,
  end: new Date(Date.parse(startIso) + 3_600_000).toISOString(),
  total_seconds: 600,
  items,
});
const ITEMS = [
  { kind: "app", identifier: "com.example.alpha", seconds: 300, pickups: 1, notifications: 2 },
  { kind: "app", identifier: "com.example.beta", seconds: 100 },
];
const SEGMENTS = [hourSeg("2030-03-10T12:00:00Z", ITEMS), hourSeg("2030-03-10T13:00:00Z")];
const beats = (log) => log.filter((c) => c.table === "sync_log").map((c) => c.row);

test("an older build's upload: stored as before, provenance cleared, no chunk, no finalization", async () => {
  const { res, log } = await post({ segments: SEGMENTS });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, segments: 2, items: 2 }); // unchanged answer for the old app
  const writes = log.filter((c) => c.op !== "insert");
  assert.deepEqual(writes.map((c) => c.table), ["phone_usage_segments", "phone_usage_items"]);
  for (const row of writes[0].rows) {
    assert.equal(row.last_run_id, null);
    assert.equal(row.last_run_item_count, null);
    assert.equal(row.last_export_at, null);
    assert.ok(!("verified_at" in row), "the route never writes verification");
  }
  for (const row of writes[1].rows) assert.equal(row.last_run_id, null);
  assert.equal(beats(log)[0].status, "success");
});

test("a run chunk: hours, then items, then the chunk ack, then finalization; the answer carries completeness", async () => {
  const { res, log } = await post({ app_version: "0.2.0 (9)", segments: SEGMENTS, run: runMeta() });
  assert.equal(res.status, 200);
  assert.equal(res.body.completeness, "complete");
  assert.equal(res.body.hours_verified, 2);
  assert.deepEqual(res.body.chunk, { index: 0, count: 1 });
  const order = log.filter((c) => c.op !== "insert").map((c) => c.op === "rpc" ? `rpc:${c.name}` : c.table);
  assert.deepEqual(order, ["phone_usage_segments", "phone_usage_items", "phone_usage_sync_chunks", "rpc:finalize_phone_usage_run"]);
  const seg = log.find((c) => c.table === "phone_usage_segments").rows;
  const runId = RUN_ID.toLowerCase();
  assert.deepEqual(seg.map((r) => [r.last_run_id, r.last_run_item_count, r.last_export_at]), [
    [runId, 2, "2030-03-10T14:30:00.000Z"],
    [runId, 0, "2030-03-10T14:30:00.000Z"], // an hour with no items claims zero
  ]);
  for (const row of log.find((c) => c.table === "phone_usage_items").rows) assert.equal(row.last_run_id, runId);
  const chunk = log.find((c) => c.table === "phone_usage_sync_chunks");
  assert.equal(chunk.opts.onConflict, "device,run_id,chunk_index"); // a retried chunk lands on the same row
  assert.deepEqual(
    [chunk.rows.run_id, chunk.rows.chunk_index, chunk.rows.chunk_count, chunk.rows.stream_ended, chunk.rows.run_segment_count, chunk.rows.segment_count],
    [runId, 0, 1, true, 2, 2],
  );
  assert.equal(chunk.rows.first_segment_start, "2030-03-10T12:00:00.000Z");
  assert.equal(chunk.rows.last_segment_end, "2030-03-10T14:00:00.000Z");
  assert.equal(chunk.rows.app_version, "0.2.0 (9)");
  assert.deepEqual(log.find((c) => c.op === "rpc").args, { p_device: "iphone", p_run_id: runId });
});

test("a watchdog stop is recorded as such, and the database's 'not complete' answer is passed back", async () => {
  const { res, log } = await post(
    { segments: SEGMENTS, run: runMeta({ stream_ended: false }) },
    { rpcAnswer: { status: "stream_open", hours_verified: 0 } },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.completeness, "stream_open");
  assert.equal(res.body.hours_verified, 0);
  assert.equal(log.find((c) => c.table === "phone_usage_sync_chunks").rows.stream_ended, false);
});

test("the first chunk of two is acknowledged but not complete; a retry of it is the same chunk row", async () => {
  const meta = runMeta({ segment_count: 4, chunk_count: 2, chunk_index: 0 });
  const first = await post({ segments: SEGMENTS, run: meta }, { rpcAnswer: { status: "receiving", hours_verified: 0 } });
  const retry = await post({ segments: SEGMENTS, run: meta }, { rpcAnswer: { status: "receiving", hours_verified: 0 } });
  assert.equal(first.res.body.completeness, "receiving");
  const key = (r) => [r.device, r.run_id, r.chunk_index].join("|");
  assert.equal(
    key(first.log.find((c) => c.table === "phone_usage_sync_chunks").rows),
    key(retry.log.find((c) => c.table === "phone_usage_sync_chunks").rows),
  );
});

test("a failed write never acknowledges the chunk: no ack, no finalization, a logged 500", async () => {
  for (const failTable of ["phone_usage_segments", "phone_usage_items"]) {
    const { res, log } = await post({ segments: SEGMENTS, run: runMeta() }, { failTable });
    assert.equal(res.status, 500, failTable);
    assert.equal(res.body.logged, true);
    assert.ok(!log.some((c) => c.table === "phone_usage_sync_chunks"), `${failTable}: chunk acknowledged`);
    assert.ok(!log.some((c) => c.op === "rpc"), `${failTable}: finalized`);
    assert.equal(beats(log)[0].status, "failed");
  }
  // The ack itself failing, or the finalization failing, is also a logged 500 (the hours stay unverified).
  const ack = await post({ segments: SEGMENTS, run: runMeta() }, { failTable: "phone_usage_sync_chunks" });
  assert.equal(ack.res.status, 500);
  assert.ok(!ack.log.some((c) => c.op === "rpc"));
  const fin = await post({ segments: SEGMENTS, run: runMeta() }, { rpcError: "connection reset" });
  assert.equal(fin.res.status, 500);
  assert.equal(beats(fin.log)[0].error_message, "finalize: connection reset");
});

test("malformed run metadata and chunks that contradict their run are rejected uploads, nothing written", async () => {
  const cases = [
    [{ segments: SEGMENTS, run: runMeta({ stream_ended: "yes" }) }, "completeness metadata invalid"],
    [{ segments: SEGMENTS, run: "run" }, "completeness metadata invalid"],
    [{ segments: [], run: runMeta() }, "a run chunk carried no segments"],
    [{ segments: [hourSeg("2030-03-07T12:00:00Z")], run: runMeta() }, "outside its run's window"],
    [{ segments: SEGMENTS, run: runMeta({ segment_count: 1 }) }, "more hours than its run"],
  ];
  for (const [body, reason] of cases) {
    const { res, log } = await post(body);
    assert.equal(res.status, 400, reason);
    assert.equal(res.body.logged, true, reason);
    assert.ok(!log.some((c) => c.op === "upsert" || c.op === "rpc"), reason);
    const beat = beats(log)[0];
    assert.equal(beat.status, "failed");
    assert.ok(beat.error_message.includes(reason), beat.error_message);
    assert.ok(!beat.error_message.includes("com.example"), "no usage data in the heartbeat");
  }
});

test("the route is still the only CI-token Screen Time path and the app sends `run` on every chunk", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(mw.includes('"/api/screen-time/usage"'));
  const swift = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "OnyxScreenTime", "SyncService.swift"), "utf8");
  assert.match(swift, /payload\(for: result, segments: chunk, run: run\)/);
  assert.match(swift, /UUID\(\)\.uuidString\.lowercased\(\)/);
  const models = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "OnyxScreenTime", "Models.swift"), "utf8");
  for (const key of ["run_id", "window_start", "window_end", "stream_ended", "segment_count", "chunk_index", "chunk_count"]) {
    assert.match(models, new RegExp(`let ${key}:`), key);
  }
});
