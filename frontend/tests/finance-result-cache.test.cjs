// Run: node --test tests/finance-result-cache.test.cjs
// Stored finance results (lib/finance-result-cache.ts, lib/finance-result-cache-server.ts,
// sql/finance_result_cache.sql), the Today routes that answer from them, and the parallel paging in
// lib/finance-ledger-server.ts fetchPaged. Runs against an in-memory stand-in for the cache table.
// SYNTHETIC DATA ONLY: every account, merchant, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

process.env.VERCEL_DEPLOYMENT_ID = "dpl_test_build";
const K = loadTs("lib/finance-result-cache.ts");
const F = loadTs("lib/cash-forecast.ts");
const B = loadTs("lib/finance-budgets.ts");
const A = loadTs("lib/finance-alerts.ts");
const R = loadTs("lib/procurement-recurring.ts");
const N = loadTs("lib/procurement-renewals.ts");

const TODAY = "2030-06-15";
const NOW = new Date("2030-06-15T16:00:00Z"); // noon ET
const BUILD = K.cacheBuild();
const addMs = (d, ms) => new Date(d.getTime() + ms);

// ─── the decision ───────────────────────────────────────────────────────────────────────────
const row = (over = {}) => ({ key: "alerts", version: 7, etDate: TODAY, build: BUILD, computedAt: NOW.toISOString(), failedAt: null, body: { status: "ready", alerts: [] }, ...over });

test("decide: fresh only for the same inputs, ET day and build, within the hour", () => {
  const t = NOW.getTime();
  assert.equal(K.decide(row(), 7, TODAY, BUILD, t), "fresh");
  assert.equal(K.decide(row(), 7, TODAY, BUILD, t + K.FRESH_MS - 1), "fresh");
  assert.equal(K.decide(row(), 7, TODAY, BUILD, t + K.FRESH_MS), "stale", "the age cap is a backstop");
  assert.equal(K.decide(row(), 8, TODAY, BUILD, t), "stale", "an input table was written");
  assert.equal(K.decide(row(), null, TODAY, BUILD, t), "stale", "no input version known");
  assert.equal(K.decide(row(), 7, "2030-06-16", BUILD, t), "stale", "a new ET day");
  assert.equal(K.decide(row(), 7, TODAY, "1:other-build", t), "stale", "another deployment wrote it");
});

test("decide: nothing usable is computed", () => {
  const t = NOW.getTime();
  assert.equal(K.decide(null, 7, TODAY, BUILD, t), "compute");
  assert.equal(K.decide(row({ body: null }), 7, TODAY, BUILD, t), "compute");
  assert.equal(K.decide(row({ failedAt: NOW.toISOString() }), 7, TODAY, BUILD, t), "compute", "the last refresh failed");
  assert.equal(K.decide(row(), 8, TODAY, BUILD, t + K.MAX_STALE_MS + 1), "compute", "too old to show");
  assert.equal(K.decide(row({ computedAt: "not a date" }), 7, TODAY, BUILD, t), "compute");
});

test("parseRow accepts what PostgREST returns and rejects junk", () => {
  const r = K.parseRow({ key: "alerts", version: "12", et_date: TODAY, build: "b", computed_at: NOW.toISOString(), failed_at: null, body: { a: 1 } });
  assert.deepEqual(r, { key: "alerts", version: 12, etDate: TODAY, build: "b", computedAt: NOW.toISOString(), failedAt: null, body: { a: 1 } });
  assert.equal(K.parseRow({ key: "alerts", version: 1.5, computed_at: NOW.toISOString() }), null);
  assert.equal(K.parseRow({ key: 3, version: 1, computed_at: NOW.toISOString() }), null);
  assert.equal(K.parseRow(null), null);
});

test("cacheBuild names the deployment", () => {
  assert.equal(K.cacheBuild({ VERCEL_DEPLOYMENT_ID: "dpl_x" }), `${K.CACHE_FORMAT}:dpl_x`);
  assert.equal(K.cacheBuild({ VERCEL_GIT_COMMIT_SHA: "abc" }), `${K.CACHE_FORMAT}:abc`);
  assert.equal(K.cacheBuild({}), `${K.CACHE_FORMAT}:local`);
  assert.ok(K.cacheBuild({ VERCEL_DEPLOYMENT_ID: "x".repeat(200) }).length <= 80);
});

test("jsonSafe: only values that jsonb stores unchanged", () => {
  assert.equal(K.jsonSafe({ a: [1, "x", null, { b: true }], c: undefined }), true);
  assert.equal(K.jsonSafe({ a: NaN }), false);
  assert.equal(K.jsonSafe({ a: [1, Infinity] }), false);
  assert.equal(K.jsonSafe({ a: new Date(0) }), false);
  assert.equal(K.jsonSafe({ a: new Map() }), false);
  assert.equal(K.jsonSafe({ a: new Set() }), false);
  assert.equal(K.jsonSafe({ a: [1, undefined] }), false);
  assert.equal(K.jsonSafe({ a: () => 1 }), false);
  assert.equal(K.jsonSafe({ a: 10n }), false);
});

test("body parsers keep only what is ever stored", () => {
  assert.deepEqual(K.parseAlertsBody({ status: "ready", alerts: [] }), { status: "ready", alerts: [] });
  assert.equal(K.parseAlertsBody({ status: "unavailable" }), null);
  assert.equal(K.parseAlertsBody({ status: "ready" }), null);
  assert.deepEqual(K.parseLoadBody({ kind: "empty" }), { kind: "empty" });
  assert.equal(K.parseLoadBody({ kind: "error", code: "x" }), null);
  assert.equal(K.parseLoadBody([]), null);
});

// ─── a synthetic forecast and budgets survive the round trip through jsonb ─────────────────────────
const ACCOUNTS = [
  { account_key: "chk", account_type: "Cash", label: "Demo Checking" },
  { account_key: "card", account_type: "Credit Card", label: "Demo Card" },
];
let txnN = 0;
const ftx = (account_key, txn_date, amount_cents, name, category = "Shopping") => ({
  txn_key: `t${txnN++}`, account_key, txn_date, amount_cents, name, custom_name: null, currency: "USD", category, ignored_from: null,
});
function world() {
  const out = [];
  for (const m of ["2029-12", "2030-01", "2030-02", "2030-03", "2030-04", "2030-05"]) {
    out.push(ftx("chk", `${m}-28`, -400_000, "DEMO EMPLOYER PAYROLL", "Paycheck"));
    out.push(ftx("chk", `${m}-03`, 150_000, "DEMO LANDLORD RENT", "Rent"));
    out.push(ftx("card", `${m}-10`, 30_000, "DEMO GROCER", "Groceries"), ftx("card", `${m}-18`, 12_000, "DEMO DINER", "Dining & Drinks"));
    out.push(ftx("chk", `${m}-20`, 42_000, "DEMO CARD AUTOPAY", "Credit Card Payment"), ftx("card", `${m}-20`, -42_000, "PAYMENT THANK YOU", "Credit Card Payment"));
    out.push(ftx("card", `${m}-07`, 1_599, "DEMO STREAMING", "Entertainment"));
  }
  out.push(ftx("card", "2030-06-07", 1_599, "DEMO STREAMING", "Entertainment"), ftx("card", "2030-06-10", 45_000, "DEMO GROCER", "Groceries"));
  return out;
}
function synthForecast(now = NOW) {
  return F.forecastCash({
    today: TODAY,
    now,
    accounts: ACCOUNTS,
    txns: world(),
    balances: [
      { account_key: "chk", captured_at: "2030-06-15T06:00:00Z", balance_cents: 250_000, currency: "USD", kind: "asset" },
      { account_key: "card", captured_at: "2030-06-15T06:00:00Z", balance_cents: 60_000, currency: "USD", kind: "liability" },
    ],
    settings: { paths: 60, horizonDays: 730 },
  });
}

test("a synthetic forecast and budgets are plain JSON, and alerts from the stored copy are identical", () => {
  const forecast = synthForecast();
  assert.equal(forecast.state, "ok");
  const budgets = B.computeBudgets(world(), new Map([["Groceries", 40_000], ["__total__", 90_000]]), TODAY);
  const forecastLoad = { kind: "ok", result: forecast, items: [], drivers: [], accounts: [], setupPending: false, profile: null, tax: [], scenario: null, saved: [], accuracy: [], goals: [], move: null };
  assert.equal(K.jsonSafe(forecastLoad), true, "the forecast load stores unchanged");
  assert.equal(K.jsonSafe({ kind: "ok", result: budgets, categories: [], rules: [], setupPending: false, subscriptions: [] }), true);
  const back = (v) => JSON.parse(JSON.stringify(v));
  assert.deepStrictEqual(A.moneyAlerts(back(forecast), back(budgets), 100_000, TODAY), A.moneyAlerts(forecast, budgets, 100_000, TODAY));
});

// ─── renewals: the stored form gives the same Today summary on later days ────────────────────────
const sub = (name, inDays, cadenceDays = 30, n = 6, jitter = []) =>
  Array.from({ length: n }, (_, i) => ({
    txn_date: R.addDays(TODAY, inDays - cadenceDays * (n - i) + (jitter[i] ?? 0)),
    name, custom_name: null, amount_cents: 1_000 + name.length, currency: "USD", category: "Entertainment", ignored_from: null,
  }));
const RENEWAL_ROWS = [
  ...sub("Demo Today", 0), ...sub("Demo One", 1), ...sub("Demo Two A", 2), ...sub("Demo Two B", 2), ...sub("Demo Three", 3),
  ...sub("Demo Five", 5), ...sub("Demo Eight", 8), ...sub("Demo Weekly", 4, 7, 8), ...sub("Demo Overdue", -2),
  ...sub("Demo Lapsed", -80), ...sub("Demo Rough", 6, 30, 6, [0, 6, -5, 7, -6, 0]), ...sub("Demo Far", 25),
];

test("renewals: the stored form, read on each later day, equals a fresh computation on that day", () => {
  const atT = { state: "ok", subs: R.detectRecurring(RENEWAL_ROWS, TODAY), irregular: [], total: 0, today: TODAY };
  const ahead = N.renewalsAhead(atT);
  assert.equal(ahead.status, "ready");
  assert.ok(ahead.upcoming.every((u) => u.date >= TODAY), "only today and later are stored");
  assert.doesNotMatch(JSON.stringify(ahead), /cents|amount/i, "no amounts in the stored form");
  let sawSomething = 0;
  for (let k = 0; k <= 12; k++) {
    const day = R.addDays(TODAY, k);
    const fresh = N.renewalSummary({ state: "ok", subs: R.detectRecurring(RENEWAL_ROWS, day), irregular: [], total: 0, today: day });
    assert.deepStrictEqual(N.summaryFromAhead(ahead, day), fresh, `day +${k}`);
    if (fresh.count > 0) sawSomething++;
  }
  assert.ok(sawSomething >= 8, "the comparison covered days with renewals due");
  // Never evaluated for a day before it was computed.
  assert.deepStrictEqual(N.summaryFromAhead(ahead, R.addDays(TODAY, -3)), N.summaryFromAhead(ahead, TODAY));
});

test("renewals: empty stays empty; the stored form parses back and junk does not", () => {
  assert.deepEqual(N.renewalsAhead({ state: "empty" }), { status: "empty" });
  assert.deepEqual(N.summaryFromAhead({ status: "empty" }, TODAY), { status: "empty" });
  const ahead = N.renewalsAhead({ state: "ok", subs: R.detectRecurring(RENEWAL_ROWS, TODAY), irregular: [], total: 0, today: TODAY });
  assert.deepStrictEqual(N.parseRenewalsAhead(JSON.parse(JSON.stringify(ahead))), ahead);
  assert.deepEqual(N.parseRenewalsAhead({ status: "empty" }), { status: "empty" });
  assert.equal(N.parseRenewalsAhead({ status: "ready", from: TODAY, upcoming: [{ merchant: "x", date: "soon" }] }), null);
  assert.equal(N.parseRenewalsAhead({ status: "ready", upcoming: [] }), null);
  assert.equal(N.parseRenewalsAhead("ready"), null);
});

// ─── serveStored against an in-memory cache table ───────────────────────────────────────────────
function cacheDb({ readError = null } = {}) {
  const rows = new Map([["inputs", { key: "inputs", version: 1, et_date: null, build: null, computed_at: "2030-01-01T00:00:00Z", failed_at: null, body: null }]]);
  const ops = [];
  const client = {
    from(table) {
      assert.equal(table, "finance_result_cache");
      const st = { op: "select", keys: [], eq: null, payload: null, cols: null };
      const b = {
        select(cols) { st.cols = cols; return b; },
        in(_c, keys) { st.keys = keys; return b; },
        eq(_c, v) { st.eq = v; return b; },
        upsert(payload, opts) { st.op = "upsert"; st.payload = payload; assert.equal(opts.onConflict, "key"); return b; },
        update(payload) { st.op = "update"; st.payload = payload; return b; },
        then(resolve, reject) {
          ops.push(st.op);
          let res;
          if (st.op === "select") {
            assert.ok(st.cols && !st.cols.includes("*"), "explicit columns");
            res = readError ? { data: null, error: { code: readError, message: "secret detail" } } : { data: st.keys.filter((k) => rows.has(k)).map((k) => JSON.parse(JSON.stringify(rows.get(k)))), error: null };
          } else if (st.op === "upsert") {
            for (const r of st.payload) {
              assert.notEqual(r.key, "inputs", "the input version is only written by the triggers");
              rows.set(r.key, JSON.parse(JSON.stringify(r)));
            }
            res = { error: null };
          } else {
            const r = rows.get(st.eq);
            if (r) Object.assign(r, st.payload);
            res = { error: null };
          }
          return Promise.resolve(res).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { client, rows, ops, bump: () => rows.get("inputs").version++ };
}

function harness({ readError = null, forecast = { kind: "empty" }, budgets = { kind: "empty" }, detected = { state: "empty" } } = {}) {
  const db = cacheDb({ readError });
  const queue = [];
  const calls = { forecast: 0, budgets: 0, detected: 0 };
  const state = { forecast, budgets, detected };
  const stubs = {
    "server-only": {},
    "next/server": {
      after: (fn) => queue.push(fn),
      NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) },
    },
    "@/lib/finance-service-client": { serviceClient: () => db.client },
    "@/lib/finance-ledger-server": { serviceClient: () => db.client },
    "@/lib/cash-forecast-server": { loadForecast: async () => { calls.forecast++; return typeof state.forecast === "function" ? state.forecast() : state.forecast; } },
    "@/lib/finance-budgets-server": { loadBudgets: async () => { calls.budgets++; return state.budgets; } },
    "@/lib/procurement-recurring-server": { loadDetectedSubscriptions: async () => { calls.detected++; return state.detected; } },
  };
  const S = loadTs("lib/finance-result-cache-server.ts", stubs);
  const drain = async () => { while (queue.length) await queue.shift()(); };
  return { S, db, queue, calls, state, drain, stubs };
}
const quiet = async (fn) => {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
};

test("first call computes inline and stores after the answer; the next call is served without computing", async () => {
  const h = harness({ budgets: { kind: "ok", result: { lines: [], daysInMonth: 30, dayOfMonth: 15 }, categories: [], rules: [], setupPending: false, subscriptions: [] } });
  const first = await h.S.cachedMoneyAlerts(NOW);
  assert.deepEqual(first, { status: "ready", alerts: [], asOf: NOW.toISOString() }, "computed now: current, no marker");
  assert.deepEqual([h.calls.forecast, h.calls.budgets], [1, 1]);
  assert.equal(h.queue.length, 1, "the store runs after the response");
  assert.equal(h.db.rows.has("alerts"), false);
  await h.drain();
  const stored = h.db.rows.get("alerts");
  assert.deepEqual([stored.version, stored.et_date, stored.build, stored.failed_at], [1, TODAY, BUILD, null]);
  assert.ok(h.db.rows.has("forecast") && h.db.rows.has("budgets"), "the page loads computed on the way are stored too");

  const second = await h.S.cachedMoneyAlerts(addMs(NOW, 5 * 60_000));
  assert.deepEqual(second, first, "a fresh stored answer keeps the time it was computed");
  assert.deepEqual([h.calls.forecast, h.calls.budgets], [1, 1], "served from the stored row");
  assert.equal(h.queue.length, 0, "a fresh row schedules nothing");
  // The pages find their stored loads fresh.
  assert.deepEqual(await h.S.cachedForecast(addMs(NOW, 60_000)), { kind: "empty" });
  assert.equal(h.calls.forecast, 1);
  assert.equal((await h.S.cachedBudgets(addMs(NOW, 60_000))).kind, "ok");
  assert.equal(h.calls.budgets, 1);
});

// Speed (PERF-02): the computation modules are loaded only when something is computed, so a cold request answered
// from the stored row does not parse the forecast engine, the budgets or the subscription detection first.
const COMPUTE_MODULES = ["@/lib/cash-forecast-server", "@/lib/finance-budgets-server", "@/lib/procurement-recurring-server"];
function watchLoads(stubs) {
  const loaded = [];
  for (const spec of COMPUTE_MODULES) {
    const mod = stubs[spec];
    Object.defineProperty(stubs, spec, { enumerable: true, configurable: true, get() { loaded.push(spec); return mod; } });
  }
  return loaded;
}
const storedRow = (key, body, over = {}) => ({ key, version: 1, et_date: TODAY, build: BUILD, computed_at: NOW.toISOString(), failed_at: null, body, ...over });

test("a stored answer loads no computation module; a stale one loads them only for the refresh after the response", async () => {
  const h = harness({ detected: { state: "empty" } });
  const loaded = watchLoads(h.stubs);
  h.db.rows.set("alerts", storedRow("alerts", { status: "ready", alerts: [] }));
  h.db.rows.set("renewals", storedRow("renewals", { status: "empty" }));
  const at = addMs(NOW, 60_000);
  assert.deepEqual(await h.S.cachedMoneyAlerts(at), { status: "ready", alerts: [], asOf: NOW.toISOString() });
  assert.deepEqual((await h.S.cachedRenewalsAheadWithAge(at, "stale-ok")).value, { status: "empty" });
  assert.deepEqual(loaded, [], "fresh stored rows: nothing computed, no computation module loaded");
  assert.deepEqual([h.calls.forecast, h.calls.budgets, h.calls.detected], [0, 0, 0]);

  h.db.bump(); // an input table was written: both rows are stale
  const stale = await h.S.cachedMoneyAlerts(at);
  assert.equal(stale.updating, true, "the stored answer at once");
  await h.S.cachedRenewalsAheadWithAge(at, "stale-ok");
  assert.deepEqual(loaded, [], "still nothing loaded before the answers");
  assert.equal(h.queue.length, 2);
  await h.drain();
  assert.deepEqual([...new Set(loaded)].sort(), [...COMPUTE_MODULES].sort(), "the refresh after the response loads them");
  assert.deepEqual([h.calls.forecast, h.calls.budgets, h.calls.detected], [1, 1, 1]);
});

test("a computation module that fails to load answers like a failed computation; the stored row is kept and marked", async () => {
  const h = harness();
  h.db.rows.set("renewals", storedRow("renewals", { status: "empty" }));
  h.db.bump();
  Object.defineProperty(h.stubs, "@/lib/procurement-recurring-server", { enumerable: true, configurable: true, get() { throw new Error("chunk failed"); } });
  const { value: served, lines } = await quiet(async () => {
    const v = await h.S.cachedRenewalsAheadWithAge(addMs(NOW, 1_000), "stale-ok");
    await h.drain();
    return v;
  });
  assert.equal(served.stale, true, "the stored detection is answered");
  assert.ok(h.db.rows.get("renewals").failed_at, "the failed refresh is remembered, so the next call computes first");
  assert.ok(lines.every((l) => !/chunk failed/.test(l)), "only a code is logged");
});

test("nothing stored and the computation module fails to load: null (the route's 500 JSON), nothing stored, a code logged", async () => {
  const h = harness();
  Object.defineProperty(h.stubs, "@/lib/cash-forecast-server", { enumerable: true, configurable: true, get() { throw new Error("chunk failed"); } });
  const { value, lines } = await quiet(() => h.S.cachedMoneyAlerts(NOW));
  assert.equal(value, null);
  assert.equal(h.queue.length, 0, "nothing scheduled to store");
  assert.equal(h.db.rows.has("alerts"), false);
  assert.ok(lines.some((l) => /compute failed alerts/.test(l)) && lines.every((l) => !/chunk failed/.test(l)), "only a code is logged");
  const route = loadTs("app/api/finance/alerts/route.ts", h.stubs);
  const res = await quiet(() => route.GET());
  assert.deepEqual([res.value.status, res.value.body], [500, { status: "unavailable" }]);
});

test("source: the stored-result module imports the computations lazily and the small client module", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/finance-result-cache-server.ts"), "utf8");
  for (const spec of [...COMPUTE_MODULES, "@/lib/procurement-renewals"]) {
    const esc = spec.replace(/[/.-]/g, (c) => "\\" + c);
    assert.doesNotMatch(src, new RegExp(`^import \\{[^}]*\\} from "${esc}"`, "m"), `${spec}: no value import at load`);
    assert.match(src, new RegExp(`import\\("${esc}"\\)`), `${spec}: loaded with import()`);
  }
  assert.match(src, /from "@\/lib\/finance-service-client"/);
  assert.doesNotMatch(src, /from "@\/lib\/finance-ledger-server"/, "the ledger arithmetic is not loaded for a stored answer");
});

test("after an input write: the stored answer comes back at once and is recomputed after the response", async () => {
  const h = harness({ detected: { state: "ok", subs: R.detectRecurring(sub("Demo Soon", 2), TODAY), irregular: [], total: 0, today: TODAY } });
  const v1 = await h.S.cachedRenewalsAhead(NOW);
  await h.drain();
  assert.equal(h.calls.detected, 1);
  h.db.bump(); // the ETL wrote the ledger
  h.state.detected = { state: "empty" };
  const v2 = await h.S.cachedRenewalsAhead(addMs(NOW, 60_000));
  assert.deepStrictEqual(v2, v1, "stale-while-revalidate: the old answer, immediately");
  assert.equal(h.calls.detected, 1, "nothing computed before answering");
  assert.equal(h.queue.length, 1);
  await h.drain();
  assert.equal(h.calls.detected, 2);
  assert.equal(h.db.rows.get("renewals").version, 2);
  const v3 = await h.S.cachedRenewalsAhead(addMs(NOW, 120_000));
  assert.deepEqual(v3, { status: "empty" });
  assert.equal(h.calls.detected, 2);
});

test("the version read before computing is the one stored, so a write during the computation stays visible", async () => {
  const h = harness();
  h.state.detected = { state: "empty" };
  const orig = h.stubs["@/lib/procurement-recurring-server"].loadDetectedSubscriptions;
  h.stubs["@/lib/procurement-recurring-server"].loadDetectedSubscriptions = async () => { h.db.bump(); return orig(); };
  await h.S.cachedRenewalsAhead(NOW);
  await h.drain();
  assert.equal(h.db.rows.get("renewals").version, 1);
  assert.equal(h.db.rows.get("inputs").version, 2);
  await h.S.cachedRenewalsAhead(addMs(NOW, 1_000));
  assert.equal(h.queue.length, 1, "seen as stale, refreshed after the answer");
});

test("a failed refresh is remembered: the next call computes before answering, and answers null if it fails again", async () => {
  const h = harness({ detected: { state: "empty" } });
  await h.S.cachedRenewalsAhead(NOW);
  await h.drain();
  h.db.bump();
  h.state.detected = { state: "error", code: "57014" };
  assert.deepEqual(await h.S.cachedRenewalsAhead(addMs(NOW, 1_000)), { status: "empty" }, "the stale answer");
  await h.drain();
  assert.ok(h.db.rows.get("renewals").failed_at, "marked failed");
  assert.equal(await h.S.cachedRenewalsAhead(addMs(NOW, 2_000)), null, "computed inline, failed: the route answers 500");
  h.state.detected = { state: "empty" };
  assert.deepEqual(await h.S.cachedRenewalsAhead(addMs(NOW, 3_000)), { status: "empty" });
  await h.drain();
  assert.equal(h.db.rows.get("renewals").failed_at, null, "a good result clears the mark");
});

test("half-failed alerts are answered marked partial, and never stored", async () => {
  const h = harness({ forecast: { kind: "error", code: "57014" }, budgets: { kind: "empty" } });
  assert.deepEqual(await h.S.cachedMoneyAlerts(NOW), { status: "ready", alerts: [], asOf: NOW.toISOString(), partial: "forecast" });
  await h.drain();
  assert.equal(h.db.rows.has("alerts"), false);
  assert.equal(h.db.rows.has("forecast"), false, "an error load is never stored");
  assert.equal(h.db.rows.has("budgets"), true);
  h.state.budgets = { kind: "error", code: "57014" };
  assert.equal(await h.S.cachedMoneyAlerts(NOW), null, "both failed: unavailable");
  h.state.forecast = { kind: "empty" };
  assert.equal((await h.S.cachedMoneyAlerts(NOW)).partial, "budgets");
});

test("the alerts answer carries the cash forecast's input check, and the stored copy serves it back unchanged", async () => {
  const forecastLoad = (result) => ({ kind: "ok", result, items: [], drivers: [], accounts: [], setupPending: false, profile: null, tax: [], scenario: null, saved: [], accuracy: [], goals: [], move: null });
  const fresh = synthForecast();
  assert.equal(fresh.eligibility.eligible, true);
  const h = harness({ forecast: forecastLoad(fresh), budgets: { kind: "empty" } });
  const first = await h.S.cachedMoneyAlerts(NOW);
  assert.deepEqual(first.cash, { eligible: true, reasons: [] });
  await h.drain();
  assert.deepEqual(h.db.rows.get("alerts").body.cash, { eligible: true, reasons: [], validUntil: fresh.eligibility.validUntil }, "stored with the alerts, and when it stops holding");
  assert.deepEqual(await h.S.cachedMoneyAlerts(addMs(NOW, 60_000)), first, "served from the stored row, same check");

  // The same ledger read three days later with no new balance: Today is told the forecast is incomplete.
  const later = addMs(NOW, 3 * 86_400_000);
  const stale = synthForecast(later);
  assert.equal(stale.headlines.safeToMoveCents, null);
  const h2 = harness({ forecast: forecastLoad(stale), budgets: { kind: "empty" } });
  const answer = await h2.S.cachedMoneyAlerts(NOW);
  assert.equal(answer.cash.eligible, false);
  assert.deepEqual(answer.cash.reasons, stale.eligibility.reasons.map((r) => r.text));
  assert.match(answer.cash.reasons[0], /Demo Checking.*older than 48 hours/);
  assert.doesNotMatch(JSON.stringify(answer.cash), /\$\d|cents/, "no amounts in the check");
  // No ledger at all: nothing to check, no field (the existing answer shape).
  const none = await harness().S.cachedMoneyAlerts(NOW);
  assert.equal("cash" in none, false);
  // A failed forecast is `partial`, not a cash check.
  const failed = await harness({ forecast: { kind: "error", code: "57014" }, budgets: { kind: "empty" } }).S.cachedMoneyAlerts(NOW);
  assert.deepEqual([failed.partial, "cash" in failed], ["forecast", false]);
});

test("a stored forecast and Today's check stop offering an amount once a counted balance turns 48 hours old", async () => {
  const HOUR = 3_600_000;
  const forecastLoad = (result) => ({ kind: "ok", result, items: [], drivers: [], accounts: [], setupPending: false, profile: null, tax: [], scenario: { params: {}, result, tax: [] }, saved: [], accuracy: [], goals: [], move: null });
  // Computed 47.5 hours after the synthetic balance: the check holds 30 more minutes, inside the fresh window.
  const at = new Date(Date.parse("2030-06-15T06:00:00Z") + 47.5 * HOUR);
  const result = synthForecast(at);
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.eligibility.validUntil, "2030-06-17T06:00:00.000Z");
  const h = harness({ forecast: forecastLoad(result), budgets: { kind: "empty" } });
  const first = await h.S.cachedForecast(at);
  assert.equal(typeof first.result.headlines.safeToMoveCents, "number");
  await h.drain();
  // Today's first answer at the same moment, stored alongside.
  assert.deepEqual((await h.S.cachedMoneyAlerts(at)).cash, { eligible: true, reasons: [] });
  await h.drain();
  const callsBefore = h.calls.forecast;
  // 45 minutes on: the stored load is still in its fresh hour, but its check no longer holds, so the page recomputes
  // it (the ledger now gives the real, per-account reason) instead of serving a withheld copy.
  const later = addMs(at, 45 * 60_000);
  const recomputed = synthForecast(later);
  h.state.forecast = () => forecastLoad(recomputed);
  const served = await h.S.cachedForecast(later);
  assert.equal(h.calls.forecast, callsBefore + 1, "an expired check is recomputed, not served");
  assert.equal(served.result.headlines.safeToMoveCents, null);
  assert.equal(served.result.eligibility.eligible, false);
  assert.deepEqual(served.result.eligibility.reasons.map((r) => [r.code, r.account]), [["stale-balance", "chk"]], "the real reason, naming the account");
  assert.equal(served.scenario.result.headlines.safeToMoveCents, null, "the what-if agrees");
  await h.drain();
  assert.equal(h.db.rows.get("forecast").body.result.headlines.safeToMoveCents, null, "the recomputed load is stored");
  assert.equal(h.calls.forecast, callsBefore + 1);
  await h.S.cachedForecast(addMs(later, 60_000));
  assert.equal(h.calls.forecast, callsBefore + 1, "and served from then on (its own check holds no expiry that has passed)");
  // The computed value is checked against the clock too: a load whose check has already expired is withheld.
  const h2 = harness({ forecast: forecastLoad(result), budgets: { kind: "empty" } });
  const old = await h2.S.cachedForecast(later);
  assert.equal(h2.calls.forecast, 1);
  assert.equal(old.result.headlines.safeToMoveCents, null);
  assert.equal(old.result.eligibility.reasons[0].code, "stale-balance");
  // Today: the stored answer's check has expired, so it is answered at once marked updating (Today asks again with
  // ?fresh=1), and its verdict is not eligible.
  h.state.forecast = () => forecastLoad(recomputed);
  const laterAlerts = await h.S.cachedMoneyAlerts(later);
  assert.equal(laterAlerts.cash.eligible, false);
  assert.match(laterAlerts.cash.reasons[0], /gone stale/);
  assert.equal(laterAlerts.updating, true, "expired: being recomputed");
  assert.equal("validUntil" in laterAlerts.cash, false, "the answer carries only the verdict");
  await h.drain();
  const followUp = await h.S.cachedMoneyAlerts(addMs(later, 4_000), "fresh-only");
  assert.equal(followUp.updating, undefined, "the follow-up gets the recomputed answer");
  assert.deepEqual(followUp.cash.reasons, recomputed.eligibility.reasons.map((r) => r.text));
  // An older answer served while its refresh is pending (or after a refresh failed) is not eligible either.
  const dayLater = await h.S.cachedMoneyAlerts(addMs(at, 26 * HOUR));
  assert.equal(dayLater.updating, true);
  assert.equal(dayLater.cash.eligible, false);
});

test("an older stored answer is marked updating with the time it was computed; fresh-only computes before answering", async () => {
  const h = harness();
  await h.S.cachedMoneyAlerts(NOW);
  await h.drain();
  // The next ET day (or an ETL run): Today gets the old answer at once, marked, and a refresh is queued.
  const tomorrow = new Date("2030-06-16T13:00:00Z");
  const stale = await h.S.cachedMoneyAlerts(tomorrow);
  assert.deepEqual(stale, { status: "ready", alerts: [], asOf: NOW.toISOString(), updating: true });
  assert.equal(h.calls.forecast, 1);
  assert.equal(h.queue.length, 1);
  // Today's follow-up before the refresh landed: computed now, current.
  const followUp = await h.S.cachedMoneyAlerts(addMs(tomorrow, 4_000), "fresh-only");
  assert.deepEqual(followUp, { status: "ready", alerts: [], asOf: addMs(tomorrow, 4_000).toISOString() });
  assert.equal(h.calls.forecast, 2);
  // Once a refresh has landed, both reads are current and nothing is computed.
  await h.drain();
  const after = await h.S.cachedMoneyAlerts(addMs(tomorrow, 10_000));
  assert.ok(!("updating" in after));
  assert.equal((await h.S.cachedMoneyAlerts(addMs(tomorrow, 11_000), "fresh-only")).asOf, after.asOf);
  assert.ok(h.calls.forecast <= 3);
});

test("a new ET day or another build: stale for Today, recomputed before answering on the pages", async () => {
  const h = harness();
  await h.S.cachedForecast(NOW);
  await h.drain();
  assert.equal(h.calls.forecast, 1);
  const tomorrow = new Date("2030-06-16T16:00:00Z");
  await h.S.cachedForecast(tomorrow);
  assert.equal(h.calls.forecast, 2, "the page computes on a new day");
  await h.drain();
  assert.equal(h.db.rows.get("forecast").et_date, "2030-06-16");

  await h.S.cachedMoneyAlerts(tomorrow);
  await h.drain();
  const forecastCalls = h.calls.forecast;
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_next_build";
  try {
    assert.deepEqual(await h.S.cachedMoneyAlerts(addMs(tomorrow, 1_000)), { status: "ready", alerts: [], asOf: tomorrow.toISOString(), updating: true });
    assert.equal(h.calls.forecast, forecastCalls, "Today: the old build's answer, at once, marked as being updated");
    assert.equal(h.queue.length, 1);
    await h.S.cachedBudgets(addMs(tomorrow, 1_000));
    assert.equal(h.calls.budgets, 2, "the page does not trust another build's stored load");
  } finally {
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_test_build";
  }
});

test("an unreadable cache table: computed every time, nothing stored, only a code logged", async () => {
  const h = harness({ readError: "42P01" });
  const { value, lines } = await quiet(async () => [await h.S.cachedMoneyAlerts(NOW), await h.S.cachedMoneyAlerts(NOW)]);
  assert.deepEqual(value, [{ status: "ready", alerts: [], asOf: NOW.toISOString() }, { status: "ready", alerts: [], asOf: NOW.toISOString() }]);
  assert.equal(h.calls.forecast, 2);
  assert.equal(h.queue.length, 0);
  assert.ok(!h.db.ops.includes("upsert"));
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.doesNotMatch(l, /secret detail/);
});

test("a result that is not plain JSON is answered but not stored", async () => {
  const h = harness({ forecast: { kind: "ok", result: { value: NaN }, drivers: [] } });
  const { lines } = await quiet(async () => {
    await h.S.cachedForecast(NOW);
    await h.drain();
  });
  assert.equal(h.db.rows.has("forecast"), false);
  assert.ok(lines.some((l) => /not plain JSON/.test(l) && /forecast/.test(l)));
});

test("a stored row past MAX_STALE_MS is not served, even to Today", async () => {
  const h = harness({ detected: { state: "empty" } });
  await h.S.cachedRenewalsAhead(NOW);
  await h.drain();
  await h.S.cachedRenewalsAhead(addMs(NOW, K.MAX_STALE_MS + 60_000));
  assert.equal(h.calls.detected, 2);
});

// ─── the routes ───────────────────────────────────────────────────────────────────────────────
test("alerts route: same shape and HTTP semantics, answered from the stored row", async () => {
  const h = harness();
  const route = loadTs("app/api/finance/alerts/route.ts", h.stubs);
  assert.equal(route.dynamic, "force-dynamic");
  const a = await route.GET();
  assert.deepEqual([a.status, a.body.status, a.body.alerts, a.headers["Cache-Control"]], [200, "ready", [], "no-store"]);
  assert.ok(Number.isFinite(Date.parse(a.body.asOf)) && !("updating" in a.body));
  await h.drain();
  const b = await route.GET();
  assert.deepEqual([b.status, b.body], [200, a.body]);
  assert.equal(h.calls.forecast, 1, "the second answer came from the stored row");
  // After an input write: the plain read answers the older result marked updating; ?fresh=1 computes it first.
  h.db.bump();
  const c1 = await route.GET(new Request("http://localhost/api/finance/alerts"));
  assert.deepEqual([c1.body.updating, c1.body.asOf, h.calls.forecast], [true, a.body.asOf, 1]);
  h.queue.length = 0; // the background refresh has not landed yet
  const c2 = await route.GET(new Request("http://localhost/api/finance/alerts?fresh=1"));
  assert.equal(h.calls.forecast, 2, "?fresh=1 computed before answering");
  assert.ok(!("updating" in c2.body));
  const failing = harness({ forecast: { kind: "error", code: "x" }, budgets: { kind: "error", code: "x" } });
  const c = await loadTs("app/api/finance/alerts/route.ts", failing.stubs).GET();
  assert.deepEqual([c.status, c.body, c.headers["Cache-Control"]], [500, { status: "unavailable" }, "no-store"]);
  const cf = await loadTs("app/api/finance/alerts/route.ts", failing.stubs).GET(new Request("http://localhost/api/finance/alerts?fresh=1"));
  assert.deepEqual([cf.status, cf.body], [500, { status: "unavailable" }]);
});

test("renewals route: ready / empty / 500, uncached, from the stored form", async () => {
  const today = loadTs("lib/format.ts").etDate(new Date().toISOString());
  const detected = { state: "ok", subs: R.detectRecurring(sub("Demo Soon", 2).map((t) => ({ ...t, txn_date: R.addDays(t.txn_date, R.daysBetween(TODAY, today)) })), today), irregular: [], total: 0, today };
  const h = harness({ detected });
  const route = loadTs("app/api/procurement/renewals/summary/route.ts", h.stubs);
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.status, "ready");
  assert.deepEqual(Object.keys(res.body).sort(), ["count", "soon", "status", "withinDays"]);
  assert.doesNotMatch(JSON.stringify(res.body), /cents|amount/i);
  const empty = await loadTs("app/api/procurement/renewals/summary/route.ts", harness({ detected: { state: "empty" } }).stubs).GET();
  assert.deepEqual([empty.status, empty.body], [200, { status: "empty" }]);
  const failed = await loadTs("app/api/procurement/renewals/summary/route.ts", harness({ detected: { state: "error", code: "42501" } }).stubs).GET();
  assert.deepEqual([failed.status, failed.body, failed.headers["Cache-Control"]], [500, { error: "renewals unavailable" }, "no-store"]);
});

test("renewals route: an older stored detection is marked updating; ?fresh=1 computes before answering", async () => {
  // An outdated "nothing renews" must never read as current: Today treats `updating` as not confirmed and asks again.
  const h = harness({ detected: { state: "empty" } });
  const route = loadTs("app/api/procurement/renewals/summary/route.ts", h.stubs);
  const a = await route.GET();
  assert.deepEqual([a.status, a.body], [200, { status: "empty" }], "computed now: current, no marker");
  await h.drain();
  h.db.bump(); // the ETL wrote the ledger
  const b = await route.GET(new Request("http://localhost/api/procurement/renewals/summary"));
  assert.equal(b.body.status, "empty");
  assert.equal(b.body.updating, true);
  assert.ok(Number.isFinite(Date.parse(b.body.asOf)), "says when the stored detection was computed");
  assert.equal(h.calls.detected, 1, "answered at once from the stored row");
  h.queue.length = 0; // the background refresh has not landed yet
  const c = await route.GET(new Request("http://localhost/api/procurement/renewals/summary?fresh=1"));
  assert.equal(h.calls.detected, 2, "?fresh=1 computed before answering");
  assert.deepEqual(c.body, { status: "empty" });
  // The follow-up read fails: a 500, never the outdated answer.
  h.db.bump();
  h.state.detected = { state: "error", code: "57014" };
  h.queue.length = 0;
  const d = await route.GET(new Request("http://localhost/api/procurement/renewals/summary?fresh=1"));
  assert.deepEqual([d.status, d.body], [500, { error: "renewals unavailable" }]);
});

// ─── source and SQL guards ──────────────────────────────────────────────────────────────────────
const REPO = path.join(SRC, "..", "..");
const SQL = fs.readFileSync(path.join(REPO, "sql", "finance_result_cache.sql"), "utf8");

test("SQL: service-role only, no DROP anywhere, statement triggers on every finance table the app reads", () => {
  assert.doesNotMatch(SQL, /drop/i, "the Supabase connector declines any text containing it");
  assert.match(SQL, /alter table pds\.finance_result_cache enable row level security/);
  assert.match(SQL, /revoke all on pds\.finance_result_cache from anon, authenticated/);
  assert.match(SQL, /revoke execute on function pds\.finance_inputs_changed\(\) from public, anon, authenticated/);
  assert.doesNotMatch(SQL, /\bgrant\s+\w+(\s*,\s*\w+)*\s+on\b/i, "no grants at all");
  assert.doesNotMatch(SQL, /create policy/i);
  assert.match(SQL, /for each statement execute function pds\.finance_inputs_changed\(\)/);
  const list = /foreach t in array array\[([\s\S]*?)\]/.exec(SQL);
  assert.ok(list, "trigger list");
  const triggered = new Set([...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  // Every real finance table named anywhere in the app (a table some sql/*.sql file creates) must bump the
  // version, or an edit to it would not show while a stored result is fresh.
  const sqlDir = path.join(REPO, "sql");
  const tables = new Set();
  for (const f of fs.readdirSync(sqlDir).filter((x) => x.endsWith(".sql"))) {
    for (const m of fs.readFileSync(path.join(sqlDir, f), "utf8").matchAll(/create table if not exists pds\.(finance_[a-z_]+)/gi)) tables.add(m[1].toLowerCase());
  }
  const used = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) for (const m of fs.readFileSync(p, "utf8").matchAll(/["'`](finance_[a-z_]+)["'`]/g)) if (tables.has(m[1])) used.add(m[1]);
    }
  };
  walk(SRC);
  used.delete("finance_result_cache");
  assert.ok(used.has("finance_transactions") && used.has("finance_plan_drivers"), "the scan found the tables");
  for (const t of used) assert.ok(triggered.has(t), `${t} is read by the app but has no version trigger in sql/finance_result_cache.sql`);
  assert.ok(!triggered.has("finance_result_cache"), "the cache table never triggers itself");
});

test("source: the cache table is touched only by the server module; finance routes stay session-only", () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && /["'`]finance_result_cache["'`]/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(SRC, p).split(path.sep).join("/"));
    }
  };
  walk(SRC);
  assert.deepEqual(hits, ["lib/finance-result-cache-server.ts"], "only the server-only module queries the table");
  const server = fs.readFileSync(path.join(SRC, "lib/finance-result-cache-server.ts"), "utf8");
  assert.match(server, /^import "server-only";/);
  assert.doesNotMatch(server, /console\.(log|error|warn)\([^)]*body/, "no stored value is logged");
  const middleware = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.doesNotMatch(middleware, /api\/finance/);
  for (const r of ["app/api/finance/alerts/route.ts", "app/api/procurement/renewals/summary/route.ts"]) {
    const src = fs.readFileSync(path.join(SRC, r), "utf8");
    assert.deepEqual([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"], r);
    assert.match(src, /"Cache-Control": "no-store"/, r);
  }
});

// ─── fetchPaged: count once, the rest in parallel, same rows in the same order ─────────────────────
function pagedSource(total, { cap = 1000, noCount = false, vanishAfterCount = 0 } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ i }));
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const build = (from, to, withCount) => ({
    then(resolve, reject) {
      seen.push({ from, to, withCount });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((r) => setTimeout(r, 5)).then(() => {
        inFlight--;
        const live = seen.length > 1 ? all.slice(0, total - vanishAfterCount) : all;
        if (from > 0 && from >= live.length) return { data: null, error: { code: "PGRST103" }, count: null };
        return { data: live.slice(from, Math.min(to + 1, from + cap)), error: null, count: withCount && !noCount ? live.length : null };
      }).then(resolve, reject);
    },
  });
  return { build, seen, all, stats: () => ({ maxInFlight }) };
}
const L = loadTs("lib/finance-ledger-server.ts", { "server-only": {}, "@supabase/supabase-js": { createClient: () => ({}) } });

test("fetchPaged: one counted page, then the rest at the same time, in order", async () => {
  const src = pagedSource(4_321);
  const { rows, truncated } = await L.fetchPaged(src.build, 40);
  assert.equal(truncated, false);
  assert.deepEqual(rows, src.all);
  assert.deepEqual(src.seen.map((s) => s.withCount), [true, false, false, false, false], "the count is asked for once");
  assert.ok(src.stats().maxInFlight >= 4, "pages 2-5 were in flight together");
});

test("fetchPaged: a PostgREST row cap below 1000 sets the page size, so nothing is skipped", async () => {
  const src = pagedSource(2_050, { cap: 700 });
  const { rows } = await L.fetchPaged(src.build, 40);
  assert.deepEqual(rows, src.all);
  assert.deepEqual(src.seen.map((s) => s.from), [0, 700, 1400]);
});

test("fetchPaged: the page cap truncates, a small read is one request, no count falls back to one page at a time", async () => {
  const cut = pagedSource(5_000);
  const r = await L.fetchPaged(cut.build, 3);
  assert.deepEqual([r.rows.length, r.truncated], [3_000, true]);
  const one = pagedSource(10);
  assert.deepEqual([(await L.fetchPaged(one.build, 40)).rows.length, one.seen.length], [10, 1]);
  const none = pagedSource(0);
  assert.deepEqual(await L.fetchPaged(none.build, 40), { rows: [], truncated: false });
  const noCount = pagedSource(2_500, { noCount: true });
  const nc = await L.fetchPaged(noCount.build, 40);
  assert.deepEqual(nc.rows, noCount.all);
  assert.equal(noCount.stats().maxInFlight, 1);
  // With no count either, full pages past the page limit are cut off by the limit alone and reported.
  const noCountCut = pagedSource(5_000, { noCount: true });
  const ncc = await L.fetchPaged(noCountCut.build, 3);
  assert.deepEqual([ncc.rows.length, ncc.truncated], [3_000, true]);
});

test("fetchPaged: rows removed after the count end the read instead of failing it; other errors still throw", async () => {
  const src = pagedSource(2_500, { vanishAfterCount: 600 });
  const { rows } = await L.fetchPaged(src.build, 40);
  assert.equal(rows.length, 1_900);
  const failing = (from, to, withCount) => Promise.resolve(from === 0 ? { data: Array.from({ length: 1000 }, () => ({})), error: null, count: 3000 } : { data: null, error: { code: "57014" }, count: null });
  await assert.rejects(L.fetchPaged(failing, 40), (e) => e instanceof L.LedgerQueryError && e.code === "57014");
});
