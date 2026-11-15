// Run: node --test tests/early-fetch.test.cjs
// lib/early-fetch.ts + lib/today-early.ts: a page's first GETs started by an inline script, taken once each by the
// client (speed budget, 2026-11-15). SYNTHETIC ONLY: no network, made-up tokens and URLs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const E = loadTs("lib/early-fetch.ts");
const T = loadTs("lib/today-early.ts");
const { localDate, shiftDate } = loadTs("lib/calendar-events.ts");

function withWindow(t, { search = "", cookie = "" } = {}) {
  const calls = [];
  const prev = { window: global.window, location: global.location, fetch: global.fetch, document: global.document };
  global.window = global;
  global.location = { search };
  global.document = { cookie };
  global.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, status: 200, redirected: false, url }); };
  t.after(() => {
    delete global[E.EARLY_FETCH_KEY];
    global.window = prev.window; global.location = prev.location; global.fetch = prev.fetch; global.document = prev.document;
  });
  return calls;
}

const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const SUPABASE = "https://abcdefgh.supabase.co";
const WORKER = "https://worker.invalid";
const COOKIE = "sb-abcdefgh-auth-token";
const session = (expiresInS) => JSON.stringify({ access_token: "tok-synthetic", expires_at: Math.floor(Date.now() / 1000) + expiresInS, user: { id: "u", name: "Zoë" } });

test("the script starts one same-origin, uncached GET and the client takes it once", async (t) => {
  const calls = withWindow(t);
  new Function(E.earlyFetchScript("/api/habits/checkin", true))();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/habits/checkin");
  assert.equal(calls[0].init.cache, "no-store");
  const p = E.takeEarlyFetch("/api/habits/checkin");
  assert.ok(p);
  assert.equal((await p).url, "/api/habits/checkin");
  assert.equal(E.takeEarlyFetch("/api/habits/checkin"), null, "a second load fetches for itself");
});

test("the page's ?date= is copied onto the URL, as the client builds it", (t) => {
  const calls = withWindow(t, { search: "?date=2031-03-05" });
  new Function(E.earlyFetchScript("/api/habits/checkin", true))();
  assert.equal(calls[0].url, "/api/habits/checkin?date=2031-03-05");
  assert.equal(E.takeEarlyFetch("/api/habits/checkin"), null, "another URL is not used");
  assert.ok(E.takeEarlyFetch("/api/habits/checkin?date=2031-03-05"), "the dated one is still there");
});

test("an answer older than the limit is not used", (t) => {
  withWindow(t);
  new Function(E.earlyFetchScript("/api/habits/checkin"))();
  assert.equal(E.takeEarlyFetch("/api/habits/checkin", Date.now() + E.EARLY_FETCH_MAX_AGE_MS + 1), null);
});

test("noStore: false keeps the browser's default cache mode (a client that fetches without no-store)", (t) => {
  const calls = withWindow(t);
  new Function(E.earlyFetchScript("/api/status", false, { noStore: false }))();
  assert.equal(calls[0].url, "/api/status");
  assert.equal(calls[0].init.cache, undefined);
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("several scripts share one map; each URL is taken once", (t) => {
  const calls = withWindow(t);
  new Function(E.earlyFetchesScript(["/api/a", "/api/b"]))();
  new Function(E.earlyFetchScript("/api/c"))();
  assert.deepEqual(calls.map((c) => c.url), ["/api/a", "/api/b", "/api/c"]);
  assert.ok(E.takeEarlyFetch("/api/b"));
  assert.ok(E.takeEarlyFetch("/api/a"));
  assert.ok(E.takeEarlyFetch("/api/c"));
  assert.equal(E.takeEarlyFetch("/api/a"), null);
});

test("earlyOr: a usable answer is returned; 401, a redirect to sign-in and a network error are fetched again", async (t) => {
  withWindow(t);
  const fallback = () => Promise.resolve({ fallback: true });
  global[E.EARLY_FETCH_KEY] = {
    "/ok": { at: Date.now(), p: Promise.resolve({ ok: true, status: 200, redirected: false }) },
    "/gone": { at: Date.now(), p: Promise.resolve({ ok: false, status: 404, redirected: false }) },
    "/401": { at: Date.now(), p: Promise.resolve({ ok: false, status: 401, redirected: false }) },
    "/login": { at: Date.now(), p: Promise.resolve({ ok: true, status: 200, redirected: true }) },
    "/down": { at: Date.now(), p: Promise.reject(new Error("offline")) },
  };
  assert.equal((await E.earlyOr("/ok", fallback)).status, 200);
  assert.equal((await E.earlyOr("/gone", fallback)).status, 404, "a Gone answer is the server's answer");
  assert.equal((await E.earlyOr("/401", fallback)).fallback, true);
  assert.equal((await E.earlyOr("/login", fallback)).fallback, true);
  assert.equal((await E.earlyOr("/down", fallback)).fallback, true);
  assert.equal((await E.earlyOr("/none", fallback)).fallback, true);
});

test("Today: read-only GETs only, the calendar URL TodayClient builds, never the experiment arm", (t) => {
  const calls = withWindow(t);
  new Function(T.todayEarlyScript(SUPABASE, WORKER))();
  const urls = calls.map((c) => c.url);
  for (const u of T.TODAY_EARLY_GETS) assert.ok(urls.includes(u), u);
  const today = localDate(new Date());
  assert.ok(urls.includes(`${T.TODAY_CALENDAR_PATH}?from=${today}&to=${shiftDate(today, 1)}`), "calendar URL");
  assert.ok(!urls.some((u) => /experiments/.test(u)), "the experiment arm is never asked early");
  for (const c of calls) {
    assert.equal(c.init.method, undefined, "GET only");
    assert.equal(c.init.body, undefined, "GET only");
  }
  assert.ok(!urls.some((u) => u.startsWith(WORKER)), "no session cookie: no inbox read");
});

test("Today: the inbox read carries the session's token (base64url cookie, also split into chunks)", (t) => {
  const value = "base64-" + b64url(session(3600));
  const calls = withWindow(t);
  for (const cookie of [
    `other=1; ${COOKIE}=${value}`,
    `other=1;${COOKIE}=${value}`,
    `${COOKIE}.0=${value.slice(0, 20)}; x=y; ${COOKIE}.1=${value.slice(20)}`,
    `${COOKIE}=${encodeURIComponent(session(3600))}`,
  ]) {
    calls.length = 0;
    delete global[E.EARLY_FETCH_KEY];
    global.document.cookie = cookie;
    new Function(T.todayEarlyScript(SUPABASE, WORKER))();
    const inbox = calls.find((c) => c.url === WORKER + T.AGENTS_INBOX_PATH);
    assert.ok(inbox, cookie.slice(0, 30));
    assert.equal(inbox.init.headers.Authorization, "Bearer tok-synthetic");
    assert.equal(inbox.init.credentials, undefined, "no cookies to the Worker");
  }
});

test("Today: a token that expires within 90 s, a broken cookie or another project's cookie starts no inbox read", (t) => {
  const calls = withWindow(t);
  for (const cookie of [
    `${COOKIE}=base64-${b64url(session(30))}`,
    `${COOKIE}=base64-%%%`,
    `${COOKIE}.1=base64-${b64url(session(3600))}`,
    `sb-other-auth-token=base64-${b64url(session(3600))}`,
  ]) {
    calls.length = 0;
    delete global[E.EARLY_FETCH_KEY];
    global.document.cookie = cookie;
    new Function(T.todayEarlyScript(SUPABASE, WORKER))();
    assert.ok(!calls.some((c) => c.url.startsWith(WORKER)), cookie.slice(0, 30));
    assert.ok(calls.length >= T.TODAY_EARLY_GETS.length, "the same-origin reads still start");
  }
});

test("the cookie name is supabase-js's default storage key", () => {
  assert.equal(T.authCookieName(SUPABASE), COOKIE);
  assert.equal(T.authCookieName("not a url"), null);
});

test("Today's early URLs are the ones TodayClient reads (so each answer is taken, never wasted)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const SRC = path.join(__dirname, "..", "src");
  const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
  const client = read("app/today/TodayClient.tsx") + "\n" + read("lib/money-alerts-view.ts");
  for (const url of T.TODAY_EARLY_GETS) assert.ok(client.includes(`"${url}"`), url);
  assert.ok(client.includes("`" + T.TODAY_CALENDAR_PATH + "?from=${firstDay}&to=${shiftDate(firstDay, 1)}`"), "calendar URL");
  assert.match(read("app/today/TodayClient.tsx"), /agentsApi\.inbox\(\{ early: !feed \}\)/, "the inbox takes the early answer");
  assert.match(read("lib/agents-api.ts"), /takeEarlyFetch\(`\$\{AGENTS_API\}\/onyx\/inbox`\)/, "the inbox's early key");
  assert.equal(T.AGENTS_INBOX_PATH, "/onyx/inbox");
  // Both static pages start them; /status starts its own read.
  for (const f of ["app/page.tsx", "app/today/page.tsx"]) assert.match(read(f), /<EarlyReads \/>/, f);
  assert.match(read("app/status/page.tsx"), /earlyFetchScript\(STATUS_URL/);
});
