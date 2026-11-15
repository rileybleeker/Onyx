// Offline regressions for the /status heartbeat fixes of 2026-11-11 (lane 3):
//   1. Garmin freshness keys on the newest day the watch was worn, not the
//      newest (always empty) daily-summary row.
//   2. POST /api/screen-time/usage turns app failure reports and rejected
//      uploads into failed screen_time|usage heartbeats.
// The real route files are transpiled and run against a fake Supabase client;
// no credentials, network or database. Dates and payloads are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "src");

function loadTs(relPath, stubs) {
  const file = path.join(SRC, relPath);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const mod = { exports: {} };
  const localRequire = (spec) => {
    if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
    if (spec.startsWith("@/")) return loadTs(`${spec.slice(2)}.ts`, stubs);
    return require(spec);
  };
  new Function("exports", "require", "module", outputText)(mod.exports, localRequire, mod);
  return mod.exports;
}

// Chainable stand-in for the supabase-js query builder. Reads resolve through
// fixture.read(query); writes are recorded.
function fakeSupabase(fixture) {
  const calls = { inserts: [], upserts: [], reads: [] };
  const from = (table) => {
    const q = { table, eq: {}, or: null };
    const b = {
      select() { return b; },
      eq(col, val) { q.eq[col] = val; return b; },
      not() { return b; },
      gte() { return b; },
      or(filter) { q.or = filter; return b; },
      order() { return b; },
      limit() { return b; },
      insert(row) { calls.inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      upsert(rows) {
        calls.upserts.push({ table, rows });
        return Promise.resolve({ error: fixture.upsertError ? { message: fixture.upsertError } : null });
      },
      then(resolve, reject) {
        calls.reads.push(q);
        return Promise.resolve(fixture.read ? fixture.read(q) : { data: [], error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { client: { from }, calls };
}

let current = fakeSupabase({});
const stubs = {
  "@supabase/supabase-js": { createClient: () => ({ from: (table) => current.client.from(table) }) },
  "next/server": {
    NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) },
  },
  "@/lib/nyc": { getNycScoutFreshness: async () => ({ lastVerified: null, liveCount: 0 }) },
};

const freshness = loadTs("lib/status-freshness.ts", stubs);
const statusRoute = loadTs("app/api/status/route.ts", stubs);
const usageRoute = loadTs("app/api/screen-time/usage/route.ts", stubs);

// ---------------------------------------------------------------- Garmin

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function statusFixture({ newestRow, newestWorn, garminBeat }) {
  return {
    read(q) {
      const rows = (() => {
        switch (q.table) {
          case "garmin_daily_summary":
            // The worn-day query carries the wearable filter; the plain one does not.
            return [{ calendar_date: q.or ? newestWorn : newestRow }].filter((r) => r.calendar_date);
          case "whoop_cycles":
            return [{ start_time: `${newestRow}T03:00:00+00:00` }];
          case "eight_sleep_trends":
            return [{ calendar_date: newestRow }];
          case "sync_log":
            if (q.eq.source === "garmin" && q.eq.data_type === "full_sync") return [garminBeat];
            if (q.eq.source || q.eq.data_type) return [];
            return [garminBeat];
          default:
            return [];
        }
      })();
      return { data: rows, error: null };
    },
  };
}

async function garminCard(fixture) {
  current = fakeSupabase(fixture);
  const res = await statusRoute.GET();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { card: res.body.sources.garmin, reads: current.calls.reads };
}

test("wearable filter is the PostgREST form of garmin_etl.py's rule", () => {
  assert.equal(
    freshness.GARMIN_WEARABLE_FILTER,
    "total_steps.gt.0,resting_heart_rate.not.is.null,min_heart_rate.not.is.null,max_heart_rate.not.is.null,"
      + "body_battery_highest.not.is.null,avg_spo2.not.is.null,avg_waking_respiration.not.is.null",
  );
});

test("supabase-js sends the wearable filter as one or=(...) query parameter", async () => {
  const { createClient } = require("@supabase/supabase-js");
  let url = null;
  const client = createClient("https://example.invalid", "test-key", {
    db: { schema: "pds" },
    auth: { persistSession: false },
    global: { fetch: async (u) => { url = String(u); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); } },
  });
  await client.from("garmin_daily_summary").select("calendar_date")
    .or(freshness.GARMIN_WEARABLE_FILTER).order("calendar_date", { ascending: false }).limit(1);
  const params = new URL(url).searchParams;
  assert.equal(params.get("or"), `(${freshness.GARMIN_WEARABLE_FILTER})`);
  assert.equal(params.get("limit"), "1");
});

test("empty Garmin days turn the card red with the reason", async () => {
  const { card, reads } = await garminCard(statusFixture({
    newestRow: "2030-02-10",
    newestWorn: "2030-01-01",
    garminBeat: { source: "garmin", data_type: "full_sync", status: "success", sync_start: minutesAgo(20), error_message: null },
  }));
  assert.ok(reads.some((q) => q.table === "garmin_daily_summary" && q.or === freshness.GARMIN_WEARABLE_FILTER));
  assert.equal(card.status, "failed");
  assert.equal(card.latestDataDate, "2030-01-01");
  assert.equal(card.daysLag, 40);
  assert.equal(
    card.errorMessage,
    "No Garmin day with watch data since 2030-01-01 (40 days). Daily rows through 2030-02-10 are empty. "
      + "Watch not worn, or Garmin is returning empty payloads.",
  );
});

test("the ETL's own partial message wins over the fallback", async () => {
  const message = "No wearable data in the 8 fetched day(s) (2030-02-03 to 2030-02-10): ...";
  const { card } = await garminCard(statusFixture({
    newestRow: "2030-02-10",
    newestWorn: "2030-01-01",
    garminBeat: { source: "garmin", data_type: "full_sync", status: "partial", sync_start: minutesAgo(20), error_message: message },
  }));
  assert.equal(card.status, "failed");
  assert.equal(card.errorMessage, message);
});

test("a worn watch keeps the card green", async () => {
  const { card } = await garminCard(statusFixture({
    newestRow: "2030-02-10",
    newestWorn: "2030-02-10",
    garminBeat: { source: "garmin", data_type: "full_sync", status: "success", sync_start: minutesAgo(20), error_message: null },
  }));
  assert.equal(card.status, "success");
  assert.equal(card.daysLag, 0);
  assert.equal(card.errorMessage, null);
});

test("garminNoWearMessage edge cases", () => {
  assert.equal(freshness.garminNoWearMessage("2030-02-09", "2030-02-10", 1), null);
  assert.match(freshness.garminNoWearMessage(null, "2030-02-10", 999), /^No Garmin day with watch data on record\. Daily rows through 2030-02-10/);
  assert.equal(
    freshness.garminNoWearMessage("2030-02-01", "2030-02-01", 9),
    "No Garmin day with watch data since 2030-02-01 (9 days). Watch not worn, or Garmin is returning empty payloads.",
  );
});

// ---------------------------------------------------------- Screen Time

function request(body) {
  return { json: async () => { if (body instanceof Error) throw body; return body; } };
}

async function post(body, fixture = {}) {
  current = fakeSupabase(fixture);
  const res = await usageRoute.POST(request(body));
  const beats = current.calls.inserts.filter((c) => c.table === "sync_log").map((c) => c.row);
  return { res, beats, upserts: current.calls.upserts };
}

const hour = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const segment = (h, items = []) => ({ start: hour(h + 1), end: hour(h), total_seconds: 600, items });

test("an app failure report becomes a failed heartbeat", async () => {
  const { res, beats, upserts } = await post({
    device: "iphone",
    app_version: "0.1.0 (8)",
    failure: { stage: "read", message: "Apple returned no Screen Time data for that range." },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, recorded: "failed" });
  assert.equal(upserts.length, 0);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].source, "screen_time");
  assert.equal(beats[0].data_type, "usage");
  assert.equal(beats[0].status, "failed");
  assert.equal(beats[0].records_synced, 0);
  assert.equal(beats[0].error_message, "iPhone app sync failed (read): Apple returned no Screen Time data for that range. [app 0.1.0 (8)]");
});

test("every app stage is kept; anything else is 'unknown'; text is capped", async () => {
  for (const stage of ["access", "read", "encode", "network", "http"]) {
    const { beats } = await post({ failure: { stage, message: "x" } });
    assert.equal(beats[0].error_message, `iPhone app sync failed (${stage}): x`);
  }
  const { beats } = await post({ failure: { stage: "<script>", message: "y".repeat(1000) } });
  assert.equal(beats[0].error_message, `iPhone app sync failed (unknown): ${"y".repeat(300)}`);
  const empty = await post({ failure: "boom" });
  assert.equal(empty.beats[0].error_message, "iPhone app sync failed (unknown): no detail");
});

test("rejected uploads log a failed heartbeat without echoing usage data", async () => {
  const cases = [
    [new SyntaxError("Unexpected token"), "Rejected upload: body was not JSON"],
    [null, "Rejected upload: body was not a JSON object"],
    [{ failure: { stage: "read", message: "x" }, segments: [segment(1)] }, "Rejected upload: failure report carried segments"],
    [{ device: "iphone" }, "Rejected upload: no segments[] array"],
    [{ segments: [{ start: hour(2), items: [{ kind: "app", identifier: "com.example.secretapp", seconds: 5 }] }] },
      "Rejected upload: a segment lacks a valid start, end or total_seconds"],
    [{ segments: [{ start: hour(1), end: hour(2), total_seconds: 5 }] }, "Rejected upload: a segment is outside the accepted time range"],
  ];
  for (const [body, reason] of cases) {
    const { res, beats, upserts } = await post(body);
    assert.equal(res.status, 400, reason);
    assert.equal(res.body.logged, true, reason);
    assert.equal(upserts.length, 0, reason);
    assert.equal(beats.length, 1, reason);
    assert.equal(beats[0].status, "failed", reason);
    assert.equal(beats[0].error_message, reason);
    assert.ok(!beats[0].error_message.includes("secretapp"));
  }
});

test("a database error still logs failed and says so", async () => {
  const { res, beats } = await post({ segments: [segment(1)] }, { upsertError: "connection reset" });
  assert.equal(res.status, 500);
  assert.equal(res.body.logged, true);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].status, "failed");
  assert.equal(beats[0].error_message, "segments: connection reset");
});

test("a good upload still logs success", async () => {
  const items = [{ kind: "app", identifier: "com.example.app", seconds: 300, pickups: 2, notifications: 1 }];
  const { res, beats, upserts } = await post({ segments: [segment(1, items), segment(2)] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, segments: 2, items: 1 });
  assert.equal(upserts.length, 2);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].status, "success");
  assert.equal(beats[0].records_synced, 2);
});

// ------------------------------------------- Care Calendar (Google write side)

test("Care Calendar card: nothing is read until Google is set up, then only the sync-state row", async () => {
  const saved = [process.env.GOOGLE_CALENDAR_CLIENT_ID, process.env.GOOGLE_CALENDAR_CLIENT_SECRET];
  try {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    current = fakeSupabase({});
    let res = await statusRoute.GET();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let card = res.body.sources.care_calendar;
    assert.deepEqual({ status: card.status, label: card.label, method: card.integrationMethod }, { status: "unknown", label: "Care Calendar (not set up)", method: "automated" });
    assert.ok(card.cadence && card.methodLabel);
    assert.match(card.errorMessage, /^Not set up/);
    assert.ok(!current.calls.reads.some((q) => q.table === "care_calendar_sync"), "not set up: no read");

    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-fixture";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret-fixture";
    const row = {
      calendar_id: "calendar-fixture-1", connected_at: minutesAgo(48 * 60), last_sync_at: minutesAgo(30), last_sync_ok: true,
      last_sync_counts: { created: 1, updated: 2, removed: 0, unchanged: 5, failed: 0 }, last_error: null,
    };
    current = fakeSupabase({ read: (q) => ({ data: q.table === "care_calendar_sync" && q.eq.id === 1 ? [row] : [], error: null }) });
    res = await statusRoute.GET();
    card = res.body.sources.care_calendar;
    assert.deepEqual({ status: card.status, label: card.label, lastSync: card.lastSync, recordsSynced: card.recordsSynced, errorMessage: card.errorMessage },
      { status: "success", label: "Care Calendar", lastSync: row.last_sync_at, recordsSynced: 3, errorMessage: null });
    assert.equal(current.calls.reads.filter((q) => q.table === "care_calendar_sync").length, 1);
    assert.ok(!current.calls.reads.some((q) => q.table === "ci_tokens" && q.eq.service === "google_calendar"), "the stored sign-in is never read here");
    assert.ok(!current.calls.reads.some((q) => q.table === "care_items" || q.table === "care_calendar_links"), "no care item or link row either");
    assert.ok(!JSON.stringify(res.body).includes("secret-fixture"));

    current = fakeSupabase({ read: (q) => ({ data: q.table === "care_calendar_sync" ? [{ ...row, last_sync_ok: false, last_error: "google_auth", last_sync_counts: {} }] : [], error: null }) });
    card = (await statusRoute.GET()).body.sources.care_calendar;
    assert.equal(card.status, "failed");
    assert.match(card.errorMessage, /google_auth/);

    current = fakeSupabase({ read: (q) => ({ data: q.table === "care_calendar_sync" ? [{ ...row, last_sync_at: minutesAgo(31 * 60) }] : [], error: null }) });
    assert.equal((await statusRoute.GET()).body.sources.care_calendar.status, "failed", "no sync for 31 h: the catch-up is not running");
  } finally {
    if (saved[0] === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID; else process.env.GOOGLE_CALENDAR_CLIENT_ID = saved[0];
    if (saved[1] === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET; else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = saved[1];
  }
});
