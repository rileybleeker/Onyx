// Run: node --test tests/procurement-renewal-claim.test.cjs
// Renewal cards for /agents, Onyx side: lib/procurement-renewal-claim.ts (the atomic claim and its
// heartbeat, run against an in-memory database), the CI-token route and the SQL file.
// SYNTHETIC DATA ONLY: every merchant, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/procurement-recurring.ts");
const C = loadTs("lib/procurement-renewal-claim.ts");
const TODAY = "2030-06-15";

// Amounts that cannot be mistaken for anything else if they ever leak into a response.
const CENTS = 7654321;
const tx = (over) => ({
  txn_date: "2030-06-01", name: "Demo Service", custom_name: null, amount_cents: CENTS,
  currency: "USD", category: "Demo Secret Category", ignored_from: null, ...over,
});
/** A monthly subscription (fixed 30-day cycle) whose next charge is estimated `inDays` days after `today`. */
const monthly = (name, inDays, today = TODAY, n = 5) =>
  Array.from({ length: n }, (_, i) => tx({ name, txn_date: R.addDays(today, inDays - 30 * (n - i)) }));
const loadOf = (rows, today = TODAY) => ({ state: "ok", subs: R.detectRecurring(rows, today), irregular: [], total: 0, today });

/** In-memory stand-in for the two tables the claim touches. */
function makeDb({ upsertError = null, beatError = null, lookupError = null } = {}) {
  const tables = { procurement_renewal_prompt: [], sync_log: [] };
  const calls = [];
  const db = {
    tables,
    calls,
    from(table) {
      calls.push(table);
      assert.ok(table in tables, `unexpected table ${table}`);
      const st = { filters: [], limit: null };
      const b = {
        select() { return b; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
        in(c, values) { st.filters.push((r) => values.includes(r[c])); return b; },
        order() { return b; },
        limit(n) { st.limit = n; return b; },
        then(resolve, reject) {
          if (lookupError && table === "procurement_renewal_prompt") return Promise.resolve({ data: null, error: lookupError }).then(resolve, reject);
          let rows = tables[table].filter((r) => st.filters.every((f) => f(r)));
          rows = [...rows].sort((x, y) => (x.sync_start < y.sync_start ? 1 : -1));
          if (st.limit != null) rows = rows.slice(0, st.limit);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
        insert(row) {
          if (beatError) return Promise.resolve({ error: beatError });
          tables[table].push(row);
          return Promise.resolve({ error: null });
        },
        upsert(rows, opts) {
          assert.deepEqual(opts, { onConflict: "sub_id,last_charge", ignoreDuplicates: true });
          return {
            select() {
              if (upsertError) return Promise.resolve({ data: null, error: upsertError });
              // INSERT ... ON CONFLICT DO NOTHING RETURNING: only rows that did not exist come back.
              const inserted = [];
              for (const r of rows) {
                if (tables[table].some((x) => x.sub_id === r.sub_id && x.last_charge === r.last_charge)) continue;
                tables[table].push({ ...r });
                inserted.push({ sub_id: r.sub_id, last_charge: r.last_charge });
              }
              return Promise.resolve({ data: inserted, error: null });
            },
          };
        },
      };
      return b;
    },
  };
  return db;
}
const quiet = async (fn) => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try { return { value: await fn(), logged }; } finally { console.error = orig; }
};

// ─── what is claimed ─────────────────────────────────────────────────────────────────────────
test("a renewal due within 3 days is claimed with exactly an id, the merchant, the date and the days", async () => {
  const db = makeDb();
  const res = await C.claimDueRenewals(db, loadOf([...monthly("Demo Streaming", 2), ...monthly("Demo Far Away", 9)]));
  assert.deepEqual(Object.keys(res).sort(), ["claimed", "ok", "today", "within_days"]);
  assert.equal(res.ok, true);
  assert.equal(res.today, TODAY);
  assert.equal(res.within_days, 3);
  assert.equal(res.claimed.length, 1);
  const card = res.claimed[0];
  assert.deepEqual(Object.keys(card).sort(), [...C.CLAIM_FIELDS].sort());
  assert.deepEqual(Object.keys(card).sort(), ["days", "id", "merchant", "renewal_date"]);
  assert.match(card.id, /^[0-9a-f]{16}$/);
  assert.equal(card.merchant, "Demo Streaming");
  assert.equal(card.renewal_date, R.addDays(TODAY, 2));
  assert.equal(card.days, 2);
});

test("the response never carries an amount or any other finance column", async () => {
  const db = makeDb();
  const rows = [...monthly("Demo Streaming", 0), ...monthly("Demo Storage", 1), ...monthly("Demo News", 3)];
  const res = await C.claimDueRenewals(db, loadOf(rows));
  assert.equal(res.claimed.length, 3);
  const json = JSON.stringify(res);
  // No amount-like or finance field name, at any depth ...
  const keys = new Set();
  (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } })(res);
  assert.deepEqual([...keys].sort(), ["claimed", "days", "id", "merchant", "ok", "renewal_date", "today", "within_days"]);
  for (const k of keys) assert.doesNotMatch(k, /cent|amount|price|cost|total|money|usd|currency|category|account|txn|transaction|charge|cadence|confidence|name$/i, k);
  // ... and no amount value, category, charge date or subscription id either.
  assert.doesNotMatch(json, new RegExp(String(CENTS)));
  assert.doesNotMatch(json, /76543\.21|\$/);
  assert.doesNotMatch(json, /Demo Secret Category/);
  const subs = R.detectRecurring(rows, TODAY);
  for (const s of subs) {
    assert.ok(!json.includes(s.lastCharge), "the date of the last charge stays in Onyx");
    assert.ok(!json.includes(s.id), "the subscription id is not the card id");
  }
  for (const card of res.claimed) for (const v of Object.values(card)) assert.ok(typeof v === "string" || Number.isInteger(v));
});

test("what the ledger table stores: two hashes' worth of ids and dates, no merchant, no amount", async () => {
  const db = makeDb();
  await C.claimDueRenewals(db, loadOf(monthly("Demo Streaming", 2)));
  assert.equal(db.tables.procurement_renewal_prompt.length, 1);
  const row = db.tables.procurement_renewal_prompt[0];
  assert.deepEqual(Object.keys(row).sort(), ["last_charge", "renewal_date", "sub_id"]);
  assert.match(row.sub_id, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(row), /Demo|7654321/);
});

test("not claimed: later than 3 days, overdue, lapsed, low confidence, irregular, empty ledger", async () => {
  const none = async (load) => assert.deepEqual((await C.claimDueRenewals(makeDb(), load)).claimed, []);
  await none(loadOf(monthly("Demo Later", 4)));
  await none(loadOf(monthly("Demo Overdue", -1)));
  await none(loadOf(monthly("Demo Gone", -100)));
  const wobbly = ["2030-02-01", "2030-03-08", "2030-04-06", "2030-05-11", "2030-06-07"].map((d) => tx({ name: "Demo Wobbly", txn_date: d }));
  const sub = R.detectRecurring(wobbly, "2030-07-05")[0];
  assert.equal(sub.confidence, "low");
  await none(loadOf(wobbly, R.addDays(sub.nextExpected, -1)));
  const irregular = ["2030-01-04", "2030-01-25", "2030-03-20", "2030-04-02", "2030-05-28"].map((d) => tx({ name: "Demo Top-up", txn_date: d }));
  await none({ state: "ok", subs: R.detectRecurring(irregular, TODAY), irregular: R.detectIrregular(irregular, TODAY), total: 0, today: TODAY });
  const empty = await C.claimDueRenewals(makeDb(), { state: "empty" });
  assert.deepEqual(empty.claimed, []);
  assert.equal((await C.claimDueRenewals(makeDb(), loadOf(monthly("Demo Today", 0)))).claimed[0].days, 0, "due today is claimed");
});

// ─── prompted once ───────────────────────────────────────────────────────────────────────────
test("a renewal is prompted once: a second poll, the next day, and a moved estimate all get nothing", async () => {
  const db = makeDb();
  const rows = monthly("Demo Streaming", 3);
  const first = await C.claimDueRenewals(db, loadOf(rows));
  assert.equal(first.claimed.length, 1);
  assert.deepEqual((await C.claimDueRenewals(db, loadOf(rows))).claimed, []);
  assert.deepEqual((await C.claimDueRenewals(db, loadOf(rows, R.addDays(TODAY, 1)))).claimed, [], "still within the window the next day");
  // The estimate moves by a day (an older charge is re-dated): same billing cycle, so no second card.
  const moved = rows.map((r, i) => (i === 0 ? { ...r, txn_date: R.addDays(r.txn_date, -2) } : r));
  assert.deepEqual((await C.claimDueRenewals(db, loadOf(moved))).claimed, []);
  assert.equal(db.tables.procurement_renewal_prompt.length, 1);
});

test("two polls at the same time: exactly one of them gets the renewal", async () => {
  const db = makeDb();
  const load = loadOf([...monthly("Demo Streaming", 1), ...monthly("Demo Storage", 2)]);
  const [a, b] = await Promise.all([C.claimDueRenewals(db, load), C.claimDueRenewals(db, load)]);
  assert.equal(a.claimed.length + b.claimed.length, 2);
  const ids = [...a.claimed, ...b.claimed].map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
});

test("the next billing cycle is prompted again, with a new id", async () => {
  const db = makeDb();
  const rows = monthly("Demo Streaming", 2);
  const first = (await C.claimDueRenewals(db, loadOf(rows))).claimed[0];
  // The charge posts two days later; a month on, the next renewal comes up.
  const posted = [...rows, tx({ name: "Demo Streaming", txn_date: R.addDays(TODAY, 2) })];
  const later = R.addDays(TODAY, 30);
  const second = (await C.claimDueRenewals(db, loadOf(posted, later))).claimed;
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first.id);
  assert.equal(second[0].merchant, "Demo Streaming");
  assert.equal(db.tables.procurement_renewal_prompt.length, 2);
});

test("at most ten cards from one poll; the rest are claimed by the next one", async () => {
  const db = makeDb();
  const rows = Array.from({ length: 13 }, (_, i) => monthly(`Demo Plan ${String.fromCharCode(65 + i)}`, 1)).flat();
  const first = await C.claimDueRenewals(db, loadOf(rows));
  assert.equal(first.claimed.length, C.MAX_CLAIMS_PER_CALL);
  assert.equal((await C.claimDueRenewals(db, loadOf(rows))).claimed.length, 3);
});

test("the merchant is one line of display text", () => {
  assert.equal(C.displayName("  Demo\tStreaming\nPlan  "), "Demo Streaming Plan");
  assert.equal(C.displayName("x".repeat(200)).length, C.MAX_MERCHANT_CHARS);
  assert.match(C.cycleId("0123456789abcdef", "2030-06-01"), /^[0-9a-f]{16}$/);
  assert.notEqual(C.cycleId("0123456789abcdef", "2030-06-01"), C.cycleId("0123456789abcdef", "2030-07-01"));
});

// ─── failures happen before the claim; errors and heartbeats carry codes only ────────────────
test("a failed ledger read claims nothing and writes a failed heartbeat with a code only", async () => {
  const db = makeDb();
  const { value, logged } = await quiet(() => C.runRenewalClaim(db, async () => ({ state: "error", code: "42501" })).then(() => "resolved", (e) => e));
  assert.ok(value instanceof C.RenewalClaimError);
  assert.equal(value.message, "ledger read (42501)");
  assert.equal(db.tables.procurement_renewal_prompt.length, 0, "nothing was claimed");
  assert.equal(db.tables.sync_log.length, 1);
  assert.equal(db.tables.sync_log[0].status, "failed");
  assert.equal(db.tables.sync_log[0].error_message, "ledger read failed (42501)");
  assert.deepEqual(logged, []);
});

test("a failed claim insert, or a loader that throws, never puts row content in the error or the heartbeat", async () => {
  const db = makeDb({ upsertError: { code: "23514", message: 'Failing row contains (Demo Streaming, 7654321)' } });
  const { value } = await quiet(() => C.runRenewalClaim(db, async () => loadOf(monthly("Demo Streaming", 2))).then(() => "resolved", (e) => e));
  assert.equal(value.message, "renewal claim (23514)");
  assert.equal(db.tables.sync_log[0].error_message, "renewal claim failed (23514)");
  assert.doesNotMatch(JSON.stringify(db.tables.sync_log), /Demo|7654321/);

  const db3 = makeDb({ lookupError: { code: "57014", message: "timeout" } });
  const lookup = await quiet(() => C.runRenewalClaim(db3, async () => loadOf(monthly("Demo Streaming", 2))).then(() => "resolved", (e) => e));
  assert.equal(lookup.value.message, "prompt lookup (57014)");
  assert.equal(db3.tables.procurement_renewal_prompt.length, 0, "a failed lookup claims nothing");

  const db2 = makeDb();
  const thrown = await quiet(() => C.runRenewalClaim(db2, async () => { throw new Error("boom with Demo Streaming 7654321"); }).then(() => "resolved", (e) => e));
  assert.equal(thrown.value.message, "unexpected (unexpected)");
  assert.equal(db2.tables.sync_log[0].error_message, "unexpected error");
});

test("heartbeat: every claim is recorded, quiet polls at most once per 50 minutes, never a merchant", async () => {
  const db = makeDb();
  let t = Date.parse("2030-06-15T12:00:00Z");
  const clock = () => new Date(t);
  const poll = (rows) => C.runRenewalClaim(db, async () => loadOf(rows), clock);
  const beats = () => db.tables.sync_log.filter((r) => r.source === "procurement_renewals" && r.data_type === "prompt");

  await poll(monthly("Demo Far Away", 9));
  assert.equal(beats().length, 1, "the first heartbeat always lands");
  assert.deepEqual([beats()[0].status, beats()[0].records_synced, beats()[0].error_message], ["success", 0, null]);
  t += 15 * 60_000; await poll(monthly("Demo Far Away", 9));
  t += 15 * 60_000; await poll(monthly("Demo Far Away", 9));
  assert.equal(beats().length, 1, "quiet polls inside 50 minutes are not repeated");
  t += 25 * 60_000; await poll(monthly("Demo Far Away", 9));
  assert.equal(beats().length, 2, "after 50 minutes a quiet heartbeat is written again");
  t += 5 * 60_000; await poll(monthly("Demo Streaming", 2));
  assert.equal(beats().length, 3, "a claim is always recorded");
  assert.equal(beats()[2].records_synced, 1);
  assert.doesNotMatch(JSON.stringify(db.tables.sync_log), /Demo/);
  assert.deepEqual(Object.keys(beats()[2]).sort(), ["data_type", "duration_seconds", "error_message", "records_synced", "source", "status", "sync_end", "sync_start"]);
});

test("a heartbeat that cannot be written does not lose the claim", async () => {
  const db = makeDb({ beatError: { code: "57014", message: "timeout" } });
  const { value, logged } = await quiet(() => C.runRenewalClaim(db, async () => loadOf(monthly("Demo Streaming", 2))));
  assert.equal(value.claimed.length, 1);
  assert.deepEqual(logged, ["procurement_renewals heartbeat failed: 57014"]);
});

// ─── the route ───────────────────────────────────────────────────────────────────────────────
function route({ result = null, error = null, configured = true } = {}) {
  const seen = {};
  class RenewalClaimError extends Error {
    constructor(step, code) { super(`${step} (${code})`); this.step = step; this.code = code; }
  }
  const stubs = {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) } },
    "@/lib/finance-ledger-server": { serviceClient: () => { if (!configured) throw new Error("not-configured"); return { db: true }; } },
    "@/lib/procurement-recurring-server": { loadDetectedSubscriptions: async (now) => { seen.now = now; return { state: "empty" }; } },
    "@/lib/procurement-renewal-claim": {
      RenewalClaimError,
      runRenewalClaim: async (db, load) => {
        seen.db = db; await load();
        if (error) throw error === "claim" ? new RenewalClaimError("renewal claim", "23514") : new Error("boom with Demo Streaming");
        return result;
      },
    },
    "@/lib/supplement-reminders": {
      parseClaimNow: (raw) => (raw === undefined ? { ok: true, now: null } : typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? { ok: true, now: new Date(raw) } : { ok: false, error: "now is not a valid ISO timestamp" }),
    },
  };
  return { mod: loadTs("app/api/procurement/renewals/claim/route.ts", stubs), seen };
}
const post = (body) => ({ text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const RESULT = { ok: true, today: TODAY, within_days: 3, claimed: [{ id: "0123456789abcdef", merchant: "Demo Streaming", renewal_date: "2030-06-17", days: 2 }] };

test("route: answers the claim result, uncached, and passes `now` to the ledger read", async () => {
  const r = route({ result: RESULT });
  assert.equal(r.mod.dynamic, "force-dynamic");
  const res = await r.mod.POST(post({ now: "2030-06-15T12:00:00.000Z" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, RESULT);
  assert.equal(r.seen.now.toISOString(), "2030-06-15T12:00:00.000Z");
  assert.equal((await route({ result: RESULT }).mod.POST(post(""))).status, 200, "an empty body uses the server clock");
});

test("route: bad bodies are 400, an unconfigured deploy 503, a failure 500 with a step and a code only", async () => {
  for (const bad of ["{not json", "[]", "null", { now: "yesterday-ish" }]) assert.equal((await route({ result: RESULT }).mod.POST(post(bad))).status, 400);
  assert.equal((await route({ configured: false }).mod.POST(post({}))).status, 503);
  const failed = await quiet(() => route({ error: "claim" }).mod.POST(post({})));
  assert.deepEqual([failed.value.status, failed.value.body], [500, { ok: false, error: "renewal claim failed (23514)" }]);
  const boom = await quiet(() => route({ error: "other" }).mod.POST(post({})));
  assert.deepEqual([boom.value.status, boom.value.body], [500, { ok: false, error: "unexpected error" }]);
  assert.doesNotMatch(JSON.stringify([failed, boom]), /Demo/, "no merchant in a response or a log line");
});

// ─── source guards ───────────────────────────────────────────────────────────────────────────
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the claim code never touches an amount, a category, an account or a transaction id", () => {
  for (const file of ["lib/procurement-renewal-claim.ts", "app/api/procurement/renewals/claim/route.ts"]) {
    const code = stripComments(fs.readFileSync(path.join(SRC, file), "utf8"));
    assert.doesNotMatch(code, /[Cc]ents|amount|price|category|account|txn_|currency|custom_name|typical|monthly/, file);
    assert.doesNotMatch(code, /anthropic-ai|openai|@ai-sdk|messages\.create|\bfetch\(|https?:\/\//, `${file}: no model, no outbound call`);
  }
  const lib = stripComments(fs.readFileSync(path.join(SRC, "lib/procurement-renewal-claim.ts"), "utf8"));
  assert.deepEqual([...lib.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]).sort(), ["procurement_renewal_prompt", "procurement_renewal_prompt", "sync_log", "sync_log"], "it touches its own ledger and the heartbeat, nothing else");
  assert.doesNotMatch(lib, /console\.\w+\([^)]*merchant/, "a merchant is never logged");
  const routeSrc = fs.readFileSync(path.join(SRC, "app/api/procurement/renewals/claim/route.ts"), "utf8");
  assert.deepEqual([...routeSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["POST"]);
});

test("the middleware admits exactly this path with the CI token, by exact match", () => {
  const middleware = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.deepEqual([...middleware.matchAll(/["'`](\/api\/procurement[^"'`]*)["'`]/g)].map((m) => m[1]), ["/api/procurement/renewals/claim"]);
  assert.match(middleware, /pathname === "\/api\/procurement\/renewals\/claim"/);
  assert.doesNotMatch(middleware, /startsWith\(\s*["'`]\/api\/(procurement|financ)/);
});

test("the SQL is additive, service-role only, and stores no merchant or amount", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "procurement_renewal_prompts.sql"), "utf8");
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i, "not even in a comment");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(code, /CREATE TABLE IF NOT EXISTS pds\.procurement_renewal_prompt/);
  assert.match(code, /PRIMARY KEY \(sub_id, last_charge\)/);
  assert.match(code, /ENABLE ROW LEVEL SECURITY/);
  assert.match(code, /REVOKE ALL ON pds\.procurement_renewal_prompt FROM anon, authenticated/);
  assert.doesNotMatch(code, /TO anon|TO authenticated|TO public/i);
  const table = code.slice(code.indexOf("CREATE TABLE"), code.indexOf(");"));
  assert.doesNotMatch(table, /merchant|amount|cents|name/i);
});
