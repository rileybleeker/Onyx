// Run: node --test tests/derived-reads.test.cjs
// The owner-only facade over the pds materialized views (SEC-01-B): lib/derived-reads.ts (names, date rule,
// browser fetch), lib/derived-reads-server.ts + app/api/derived/[read]/route.ts (the fixed server queries),
// the query functions' browser vs server paths, middleware refusing a non-owner, and a source guard that no
// browser-reachable code reads a matview directly.
// SYNTHETIC DATA ONLY: invented dates and numbers, a fake fetch and a fake database; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const D = loadTs("lib/derived-reads.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const MAT = /^[a-z_]+_mat$/;

// ---------- fakes ----------

/** A supabase-js stand-in: records every table touched, answers `answers[table]` (default: no rows). */
function fakeDb(answers = {}) {
  const calls = [];
  const client = {
    from(table) {
      const st = { table, ops: [] };
      calls.push(st);
      const b = new Proxy({}, {
        get(_, prop) {
          if (prop === "then") {
            const a = answers[table] ?? { data: [], error: null };
            return (res, rej) => Promise.resolve(typeof a === "function" ? a(st) : a).then(res, rej);
          }
          return (...args) => { st.ops.push([prop, ...args]); return b; };
        },
      });
      return b;
    },
  };
  return { client, calls };
}

/** Runs `fn` as if in the browser (window defined) with a fake fetch; restores both afterwards. */
async function inBrowser(fetchImpl, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    if (hadWindow) globalThis.window = prevWindow; else delete globalThis.window;
    globalThis.fetch = prevFetch;
  }
}

/** A fetch that answers `{rows}` per read name and records each request. */
function facadeFetch(rowsByName = {}, overrides = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const name = new URL(url, "https://onyx.invalid").pathname.split("/").pop();
    if (overrides[name]) return overrides[name]();
    return { ok: true, status: 200, redirected: false, json: async () => ({ rows: rowsByName[name] ?? [] }) };
  };
  return { fetchImpl, requests };
}

const json = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, redirected: false, json: async () => body, ...extra });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- names, date rule, URL ----------

test("the read names are a fixed list and nothing else counts as one", () => {
  assert.deepEqual(Object.keys(D.DERIVED_READS).sort(), [
    "caffeine-hrv", "health-matrix", "historical-hrv", "nutrition", "running-recovery", "spotify-drift", "spotify-volume", "sweet-spot",
  ]);
  for (const name of Object.keys(D.DERIVED_READS)) assert.equal(D.isDerivedRead(name), true, name);
  for (const bad of ["", "tz-log-gaps", "daily_health_matrix_behavioral_mat", "../nutrition", "nutrition/", "Nutrition",
    "__proto__", "constructor", "hasOwnProperty", "toString", null, undefined, 1, {}]) {
    assert.equal(D.isDerivedRead(bad), false, String(bad));
  }
});

test("since: a real calendar date only, wide enough for the 'all' range (36500 days back)", () => {
  for (const ok of ["2030-01-01", "2028-02-29", "1926-05-14", "1900-01-01", "2199-12-31"]) assert.equal(D.parseSince(ok), ok, ok);
  for (const bad of ["2030-02-30", "2029-02-29", "2030-13-01", "2030-00-10", "1899-12-31", "2200-01-01", "2030-1-1",
    "2030-01-01T00:00", " 2030-01-01", "20300101", "", null, undefined, 20300101]) {
    assert.equal(D.parseSince(bad), null, String(bad));
  }
  assert.deepEqual(D.checkSince("nutrition", null), { ok: false }, "required");
  assert.deepEqual(D.checkSince("nutrition", "2030-01-01"), { ok: true, since: "2030-01-01" });
  assert.deepEqual(D.checkSince("nutrition", "2030-02-30"), { ok: false });
  assert.deepEqual(D.checkSince("spotify-volume", null), { ok: true, since: null }, "optional: all time");
  assert.deepEqual(D.checkSince("spotify-drift", "2030-01-01"), { ok: true, since: "2030-01-01" });
  assert.deepEqual(D.checkSince("sweet-spot", null), { ok: true, since: null });
  assert.deepEqual(D.checkSince("sweet-spot", "2030-01-01"), { ok: false }, "not accepted");
  assert.equal(D.derivedUrl("nutrition", "2030-01-01"), "/api/derived/nutrition?since=2030-01-01");
  assert.equal(D.derivedUrl("sweet-spot"), "/api/derived/sweet-spot");
});

// ---------- browser fetch ----------

test("fetchDerived: same-origin, no-store GET; rows on 200; every failure throws (no partial answer)", async () => {
  const { fetchImpl, requests } = facadeFetch({ "caffeine-hrv": [{ calendar_date: "2030-01-02", caffeine_total_mg: 80 }] });
  const rows = await inBrowser(fetchImpl, () => D.fetchDerived("caffeine-hrv", "2030-01-01"));
  assert.deepEqual(rows, [{ calendar_date: "2030-01-02", caffeine_total_mg: 80 }]);
  assert.equal(requests[0].url, "/api/derived/caffeine-hrv?since=2030-01-01");
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.equal(requests[0].init.method ?? "GET", "GET");

  const cases = [
    [json(500, { error: "unavailable" }), 500],
    [json(401, { error: "Unauthorized" }), 401],
    [json(403, { error: "cross_origin" }), 403],
    [json(404, { error: "unknown_read" }), 404],
    // Signed out: middleware redirects to /login, which answers HTML with 200.
    [{ ok: true, status: 200, redirected: true, url: "https://onyx.invalid/login", json: async () => { throw new SyntaxError("html"); } }, "redirected"],
    [{ ok: true, status: 200, redirected: false, json: async () => { throw new SyntaxError("bad"); } }, "malformed"],
    [json(200, { rows: "x" }), "malformed"],
    [json(200, [{ calendar_date: "2030-01-02" }]), "malformed"],
    [json(200, null), "malformed"],
  ];
  for (const [res, reason] of cases) {
    await assert.rejects(
      () => inBrowser(async () => res, () => D.fetchDerived("nutrition", "2030-01-01")),
      (e) => e instanceof D.DerivedReadError && e.reason === reason && e.read === "nutrition",
      String(reason),
    );
  }
});

test("a server reader refuses to run in the browser (a direct matview read there is the leak this closes)", async () => {
  const db = fakeDb();
  const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
  const H = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: db.client }, "@/lib/queries": {} });
  const readers = [
    () => Q.readNutritionMatrix("2030-01-01"), () => Q.readCaffeineHrvPairs("2030-01-01"),
    () => Q.readRunningRecoveryContext("2030-01-01"), () => Q.readHealthMatrix("2030-01-01"),
    () => Q.readSpotifyDailyVolume(null), () => Q.readSpotifyAudioFeatureDrift("2030-01-01"),
    () => H.readHistoricalHrv("2030-01-01"), () => H.readEnvDoseResponseData(),
  ];
  for (const r of readers) {
    await assert.rejects(() => inBrowser(async () => assert.fail("no fetch"), r), /read on the server only/);
  }
  assert.equal(db.calls.length, 0, "no table was queried");
});

// ---------- the query functions: browser path ----------

test("browser: every matview read goes through /api/derived; the live tables are still read directly", async () => {
  const db = fakeDb({
    delivery_nutrition_daily: { data: [{ behavioral_date: "2030-01-03", est_kcal: 700, est_protein_g: 30, est_carbs_g: 80, est_fat_g: 25 }], error: null },
  });
  const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
  const H = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: db.client }, "@/lib/queries": {} });
  const { fetchImpl, requests } = facadeFetch({
    nutrition: [{ calendar_date: "2030-01-02", calories: 2100, nutrition_source: "cronometer" }],
    "caffeine-hrv": [{ calendar_date: "2030-01-02", caffeine_total_mg: 120, caffeine_to_bedtime_min: 400, whoop_hrv_rmssd: 61 }],
    "running-recovery": [{ activity_id: 7, whoop_recovery: 70 }],
    "health-matrix": [{ calendar_date: "2030-01-02", onyx_behavioral_date: "2030-01-02", whoop_hrv_rmssd: 58 }],
    "historical-hrv": [{ onyx_behavioral_date: "2030-01-02", whoop_hrv_rmssd: 58 }],
    "spotify-volume": [{ calendar_date: "2030-01-02", play_count: 12 }],
    "spotify-drift": [{ calendar_date: "2030-01-02", avg_valence: 0.5 }],
    "sweet-spot": [{ d: "2030-01-02", hrv: 58, kcal: 2100 }],
  });
  const out = await inBrowser(fetchImpl, async () => ({
    nutrition: await Q.getNutrition(30),
    caffeine: await Q.getCaffeineHrvPairs(90),
    recovery: await Q.getRunningRecoveryContext(30),
    matrix: await Q.getHealthMatrix(36500),
    volume: await Q.getSpotifyDailyVolume("all"),
    drift: await Q.getSpotifyAudioFeatureDrift("60d"),
    hrv: await H.getHistoricalHrv(180),
    sweet: await H.getEnvDoseResponseData(),
  }));

  // No matview was read from the browser client; the live nutrition tables still were.
  assert.deepEqual(db.calls.filter((c) => MAT.test(c.table)).map((c) => c.table), []);
  assert.deepEqual(db.calls.map((c) => c.table).sort(), ["delivery_nutrition_daily", "direct_drink_daily", "photo_meal_daily"]);

  const asked = requests.map((r) => new URL(r.url, "https://onyx.invalid"));
  assert.deepEqual(asked.map((u) => u.pathname), [
    "/api/derived/nutrition", "/api/derived/caffeine-hrv", "/api/derived/running-recovery", "/api/derived/health-matrix",
    "/api/derived/spotify-volume", "/api/derived/spotify-drift", "/api/derived/historical-hrv", "/api/derived/sweet-spot",
  ]);
  for (const u of asked) {
    const name = u.pathname.split("/").pop();
    const since = u.searchParams.get("since");
    if (name === "sweet-spot" || name === "spotify-volume") assert.equal(since, null, `${name}: no bound`);
    else assert.match(since, DATE, name);
    assert.deepEqual(D.checkSince(name, since).ok, true, `${name}: the route accepts what the browser sends`);
  }
  assert.ok(asked[3].searchParams.get("since") < "1950-01-01", "the 'all' range asks for a date the route accepts");

  // The facade rows are what the functions return (getNutrition still merges the live estimates).
  assert.deepEqual(out.nutrition.map((r) => [r.calendar_date, r.calories, r.nutrition_source]), [
    ["2030-01-02", 2100, "cronometer"], ["2030-01-03", 700, "uber_eats"],
  ]);
  assert.equal(out.caffeine[0].whoop_hrv_rmssd, 61);
  assert.equal(out.recovery[0].activity_id, 7);
  assert.equal(out.matrix[0].whoop_hrv_rmssd, 58);
  assert.equal(out.volume[0].play_count, 12);
  assert.equal(out.drift[0].avg_valence, 0.5);
  assert.equal(out.hrv[0].whoop_hrv_rmssd, 58);
  assert.deepEqual(out.sweet, [{ d: "2030-01-02", hrv: 58, kcal: 2100 }]);
});

test("browser: a failed facade read rejects like a PostgREST error did, and the next load asks again (no sticky failure)", async () => {
  const db = fakeDb();
  const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
  let fail = true;
  const fetchImpl = async () => (fail ? json(500, { error: "unavailable" }) : json(200, { rows: [{ calendar_date: "2030-01-02", calories: 1800 }] }));
  await assert.rejects(() => inBrowser(fetchImpl, () => Q.getNutrition(30)), (e) => e.name === "DerivedReadError" && e.reason === 500);
  await assert.rejects(() => inBrowser(fetchImpl, () => Q.getCaffeineHrvPairs(90)), (e) => e.name === "DerivedReadError");
  fail = false;
  const rows = await inBrowser(fetchImpl, () => Q.getNutrition(30));
  assert.deepEqual(rows.map((r) => r.calories), [1800]);
  // Signed out mid-session: the redirect to /login rejects (AppData's fetch observer ends the session).
  const signedOut = async () => ({ ok: true, status: 200, redirected: true, url: "https://onyx.invalid/login", json: async () => ({}) });
  await assert.rejects(() => inBrowser(signedOut, () => Q.getHealthMatrix(30)), (e) => e.reason === "redirected");
  assert.equal(db.calls.filter((c) => MAT.test(c.table)).length, 0);
});

// ---------- the query functions: server path (ISR prefetch, the route) ----------

test("server: the same functions read the matview directly with the explicit columns, and never fetch", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("the server path must not call the facade");
  try {
    const db = fakeDb({
      daily_health_matrix_behavioral_mat: { data: [{ calendar_date: "2030-01-02", onyx_behavioral_date: "2030-01-02", whoop_hrv_rmssd: 50 }], error: null },
    });
    const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
    const H = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: db.client }, "@/lib/queries": {} });
    await Q.getCaffeineHrvPairs(90);
    await Q.getRunningRecoveryContext(30);
    await Q.getSpotifyDailyVolume("all");
    await H.getHistoricalHrv(30);
    const tables = db.calls.map((c) => c.table);
    assert.deepEqual(tables, ["daily_health_matrix_behavioral_mat", "recovery_vs_pace_mat", "spotify_daily_signature_mat", "daily_health_matrix_behavioral_mat"]);
    const select = (i) => db.calls[i].ops.find((o) => o[0] === "select")[1];
    assert.equal(select(0), "calendar_date,caffeine_total_mg,caffeine_to_bedtime_min,whoop_hrv_rmssd");
    assert.equal(select(1), "activity_id, whoop_recovery, whoop_hrv_rmssd_ms, whoop_sleep_performance, pace_delta_pct, segment_targets, segment_target_count");
    assert.equal(select(2), "calendar_date,play_count,unique_tracks,unique_artists,total_minutes,featurized_plays");
    assert.equal(select(3), "onyx_behavioral_date,whoop_hrv_rmssd");
    for (const c of db.calls) assert.ok(!c.ops.some((o) => o[0] === "select" && /\*/.test(o[1])), `${c.table}: no select("*")`);
    assert.ok(!db.calls[2].ops.some((o) => o[0] === "gte"), "spotify 'all' has no date bound");
    const errDb = fakeDb({ recovery_vs_pace_mat: { data: null, error: Object.assign(new Error("synthetic"), { code: "XX000" }) } });
    const Q2 = loadTs("lib/queries.ts", { "./supabase": { supabase: errDb.client } });
    await assert.rejects(() => Q2.getRunningRecoveryContext(30), /synthetic/, "a PostgREST error still rejects (ISR fail-open contract)");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ---------- the route ----------

const fakeNext = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body, headers: init.headers ?? {} }) } };

function loadRoute(readers) {
  const asked = [];
  const wrap = (name, value) => async (...args) => {
    asked.push([name, ...args]);
    if (typeof value === "function") return value(...args);
    return value;
  };
  const queries = {}, hrv = {};
  for (const [name, value] of Object.entries(readers)) (name === "readHistoricalHrv" || name === "readEnvDoseResponseData" ? hrv : queries)[name] = wrap(name, value);
  const route = loadTs("app/api/derived/[read]/route.ts", {
    "next/server": fakeNext,
    "server-only": {},
    "@/lib/queries": queries,
    "@/lib/queries-hrv": hrv,
  });
  return { route, asked };
}

const ALL_READERS = {
  readNutritionMatrix: [{ calendar_date: "2030-01-02", calories: 2000 }],
  readCaffeineHrvPairs: [{ calendar_date: "2030-01-02", caffeine_total_mg: 90 }],
  readRunningRecoveryContext: [{ activity_id: 3 }],
  readHealthMatrix: [{ calendar_date: "2030-01-02" }],
  readHistoricalHrv: [{ onyx_behavioral_date: "2030-01-02", whoop_hrv_rmssd: 44 }],
  readSpotifyDailyVolume: [{ calendar_date: "2030-01-02", play_count: 3 }],
  readSpotifyAudioFeatureDrift: [{ calendar_date: "2030-01-02", avg_energy: 0.4 }],
  readEnvDoseResponseData: [{ d: "2030-01-02", hrv: 44 }],
};

const req = (pathAndQuery, site = "same-origin") => {
  const url = new URL(`https://onyx.example${pathAndQuery}`);
  return {
    headers: new Headers(site === null ? {} : { "sec-fetch-site": site }),
    nextUrl: url,
    params: Promise.resolve({ read: decodeURIComponent(url.pathname.split("/").pop()) }),
  };
};
const call = (route, pathAndQuery, site) => {
  const r = req(pathAndQuery, site);
  return route.GET(r, { params: r.params });
};

test("route: GET only; each name runs its one reader with the checked date, answers {rows}, no-store", async () => {
  const { route, asked } = loadRoute(ALL_READERS);
  assert.deepEqual(Object.keys(route).filter((k) => typeof route[k] === "function"), ["GET"]);
  const expect = [
    ["/api/derived/nutrition?since=2030-01-01", "readNutritionMatrix", ["2030-01-01"]],
    ["/api/derived/caffeine-hrv?since=2030-01-01", "readCaffeineHrvPairs", ["2030-01-01"]],
    ["/api/derived/running-recovery?since=2030-01-01", "readRunningRecoveryContext", ["2030-01-01"]],
    ["/api/derived/health-matrix?since=1926-05-14", "readHealthMatrix", ["1926-05-14"]],
    ["/api/derived/historical-hrv?since=2030-01-01", "readHistoricalHrv", ["2030-01-01"]],
    ["/api/derived/spotify-volume", "readSpotifyDailyVolume", [null]],
    ["/api/derived/spotify-volume?since=2030-01-01", "readSpotifyDailyVolume", ["2030-01-01"]],
    ["/api/derived/spotify-drift?since=2030-01-01", "readSpotifyAudioFeatureDrift", ["2030-01-01"]],
    ["/api/derived/sweet-spot", "readEnvDoseResponseData", []],
  ];
  for (const [url, reader, args] of expect) {
    asked.length = 0;
    const res = await call(route, url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers["Cache-Control"], "no-store", url);
    assert.deepEqual(res.body, { rows: ALL_READERS[reader] }, url);
    assert.deepEqual(asked, [[reader, ...args]], url);
  }
  // A same-origin fetch from an older browser may carry no Sec-Fetch-Site at all.
  assert.equal((await call(route, "/api/derived/sweet-spot", null)).status, 200);
  assert.match(read("app/api/derived/[read]/route.ts"), /export const dynamic = "force-dynamic"/);
});

test("route: refuses another site, unknown names, and any date or parameter outside the read's rule; reads nothing then", async () => {
  const { route, asked } = loadRoute(ALL_READERS);
  const refused = [
    ["/api/derived/nutrition?since=2030-01-01", "cross-site", 403],
    ["/api/derived/nutrition?since=2030-01-01", "same-site", 403],
    ["/api/derived/tz-log-gaps", "same-origin", 404],
    ["/api/derived/daily_health_matrix_behavioral_mat", "same-origin", 404],
    ["/api/derived/__proto__", "same-origin", 404],
    ["/api/derived/constructor", "same-origin", 404],
    ["/api/derived/nutrition", "same-origin", 400],
    ["/api/derived/nutrition?since=2030-02-30", "same-origin", 400],
    ["/api/derived/nutrition?since=yesterday", "same-origin", 400],
    ["/api/derived/nutrition?since=2030-01-01&since=2029-01-01", "same-origin", 400],
    ["/api/derived/nutrition?since=2030-01-01&select=*", "same-origin", 400],
    ["/api/derived/nutrition?since=2030-01-01&columns=raw_json", "same-origin", 400],
    ["/api/derived/sweet-spot?since=2030-01-01", "same-origin", 400],
    ["/api/derived/spotify-drift?limit=5", "same-origin", 400],
  ];
  for (const [url, site, status] of refused) {
    const res = await call(route, url, site);
    assert.equal(res.status, status, `${url} (${site})`);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.ok(!("rows" in res.body), url);
  }
  assert.deepEqual(asked, [], "no reader ran for a refused request");
});

test("route: a failed read is a 500 with no detail; the log carries the read name and a code, never the message", async () => {
  const secret = "SYNTHETIC-ROW-VALUE-123";
  const { route } = loadRoute({
    ...ALL_READERS,
    readCaffeineHrvPairs: () => { throw Object.assign(new Error(`failing row ${secret}`), { code: "57014" }); },
    readHealthMatrix: () => { throw new TypeError(`fetch failed ${secret}`); },
  });
  const logged = [];
  const prev = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    const a = await call(route, "/api/derived/caffeine-hrv?since=2030-01-01");
    const b = await call(route, "/api/derived/health-matrix?since=2030-01-01");
    assert.deepEqual([a.status, a.body], [500, { error: "unavailable" }]);
    assert.deepEqual([b.status, b.body], [500, { error: "unavailable" }]);
    // Recovery: the next request runs the reader again (nothing cached on failure).
    const c = await call(route, "/api/derived/nutrition?since=2030-01-01");
    assert.equal(c.status, 200);
  } finally {
    console.error = prev;
  }
  assert.deepEqual(logged, ["[api/derived/caffeine-hrv] read failed 57014", "[api/derived/health-matrix] read failed TypeError"]);
  assert.ok(logged.every((l) => !l.includes(secret)));
  const S = loadTs("lib/derived-reads-server.ts", { "server-only": {}, "@/lib/queries": {}, "@/lib/queries-hrv": {} });
  assert.equal(S.readFailureCode({ code: "PGRST205" }), "PGRST205");
  assert.equal(S.readFailureCode({ code: "a code with spaces and a value 42" }), "error");
  assert.equal(S.readFailureCode(null), "error");
  assert.equal(S.readFailureCode("plain string"), "error");
  assert.deepEqual(Object.keys(S.DERIVED_READERS).sort(), Object.keys(D.DERIVED_READS).sort(), "one reader per name");
});

// ---------- middleware: the owner session is the gate ----------

const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";

function loadMiddleware(claims) {
  const prevOwner = process.env.ONYX_OWNER_USER_ID;
  process.env.ONYX_OWNER_USER_ID = OWNER;
  try {
    return loadTs("middleware.ts", {
      "@supabase/ssr": {
        createServerClient: () => ({ auth: { getClaims: async () => (claims === "throw" ? Promise.reject(new Error("bad jwk")) : { data: claims ? { claims } : null }) } }),
      },
      "next/server": {
        NextResponse: {
          next: () => ({ kind: "next", cookies: { set() {} } }),
          redirect: (url) => ({ kind: "redirect", url: new URL(String(url)) }),
          json: (body, init = {}) => ({ kind: "json", status: init.status ?? 200, body }),
        },
      },
    });
  } finally {
    if (prevOwner === undefined) delete process.env.ONYX_OWNER_USER_ID; else process.env.ONYX_OWNER_USER_ID = prevOwner;
  }
}

function mwRequest(pathAndQuery, headers = {}) {
  const nextUrl = new URL(`https://onyx.example${pathAndQuery}`);
  nextUrl.clone = () => new URL(nextUrl.href);
  return { nextUrl, headers: new Headers(headers), cookies: { getAll: () => [], set() {} } };
}

test("middleware: only the owner's session reaches /api/derived; another account, no session or a CI token is sent to /login", async () => {
  const path_ = "/api/derived/nutrition?since=2030-01-01";
  assert.equal((await loadMiddleware({ sub: OWNER }).middleware(mwRequest(path_))).kind, "next");
  for (const claims of [{ sub: OTHER }, { sub: OWNER.toUpperCase() }, {}, null, "throw"]) {
    const res = await loadMiddleware(claims).middleware(mwRequest(path_));
    assert.equal(res.kind, "redirect", JSON.stringify(claims));
    assert.equal(res.url.pathname, "/login");
    assert.equal(res.url.searchParams.get("next"), null, "an API path is not offered as a return target");
  }
  // The CI shared secret does not open this path (it is not in isCiRoute).
  const prevToken = process.env.ONYX_CI_TOKEN;
  process.env.ONYX_CI_TOKEN = "synthetic-ci-token";
  try {
    const res = await loadMiddleware({ sub: OTHER }).middleware(mwRequest(path_, { "x-onyx-ci-token": "synthetic-ci-token" }));
    assert.equal(res.kind, "redirect");
  } finally {
    if (prevToken === undefined) delete process.env.ONYX_CI_TOKEN; else process.env.ONYX_CI_TOKEN = prevToken;
  }
  const middleware = read("middleware.ts");
  const ciBlock = middleware.slice(middleware.indexOf("function isCiRoute"), middleware.indexOf("const PUBLIC_MANIFEST"));
  assert.ok(ciBlock.length > 0);
  assert.ok(!/derived/.test(ciBlock), "/api/derived must not be admitted by the CI token");
  assert.ok(!/derived/.test(middleware.slice(middleware.indexOf("matcher"))), "middleware must run on /api/derived");
});

// ---------- source guard ----------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("guard: outside server-only code, a matview is only read inside a server reader that refuses the browser", () => {
  const SERVER_ONLY_OK = new Set(["lib/travel-server.ts", "app/api/status/route.ts"]);
  const seen = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_]+_mat)["'`]\s*\)/g)) {
      seen.push(`${rel}:${m[1]}`);
      if (SERVER_ONLY_OK.has(rel)) {
        assert.ok(rel.startsWith("app/api/") || /^import "server-only";/m.test(src), `${rel} must stay server-only`);
        continue;
      }
      assert.ok(rel === "lib/queries.ts" || rel === "lib/queries-hrv.ts", `${rel} reads ${m[1]} directly`);
      const before = src.slice(0, m.index);
      const fnStart = before.lastIndexOf("export async function ");
      const fnName = /export async function (\w+)/.exec(before.slice(fnStart))[1];
      assert.match(fnName, /^read[A-Z]/, `${rel}: ${m[1]} is read in ${fnName}, not a server reader`);
      assert.match(before.slice(fnStart), /assertServerRead\("[a-z-]+"\)/, `${rel}: ${fnName} must refuse the browser`);
    }
  }
  // The guard actually looked at the readers (it would pass vacuously on a renamed call).
  for (const expected of ["lib/queries.ts:daily_health_matrix_behavioral_mat", "lib/queries.ts:recovery_vs_pace_mat",
    "lib/queries.ts:spotify_daily_signature_mat", "lib/queries-hrv.ts:daily_health_matrix_behavioral_mat"]) {
    assert.ok(seen.includes(expected), expected);
  }
  // Every server reader is reachable through exactly one facade name.
  const server = read("lib/derived-reads-server.ts");
  assert.match(server, /^import "server-only";/m);
  for (const fn of ["readNutritionMatrix", "readCaffeineHrvPairs", "readRunningRecoveryContext", "readHealthMatrix",
    "readHistoricalHrv", "readSpotifyDailyVolume", "readSpotifyAudioFeatureDrift", "readEnvDoseResponseData"]) {
    assert.equal(server.split(`${fn}(`).length - 1, 1, fn);
  }
});
