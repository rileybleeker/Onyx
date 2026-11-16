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

test("/agents: the inbox read starts on the inbox view; a conversation (?t=<agent>) starts its own first read instead", (t) => {
  const value = "base64-" + b64url(session(3600));
  const calls = withWindow(t, { cookie: `${COOKIE}=${value}` });
  const INBOX = WORKER + T.AGENTS_INBOX_PATH;
  for (const [search, expected] of [["", INBOX], ["?view=unread", INBOX], ["?t=nyc-scout", T.agentsThreadFirstUrl(WORKER, "nyc-scout")],
    ["?t=a.b-c_1&reply=A12", T.agentsThreadFirstUrl(WORKER, "a.b-c_1")], ["?t=bad%20name", INBOX]]) {
    calls.length = 0;
    delete global[E.EARLY_FETCH_KEY];
    global.location = { search };
    new Function(T.agentsEarlyScript(SUPABASE, WORKER))();
    assert.deepEqual(calls.map((c) => c.url), [expected], search || "(none)");
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok-synthetic");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.method, undefined, "GET only");
    assert.equal(calls[0].init.credentials, undefined, "no cookies to the Worker");
  }
  // The URL is exactly what agentsApi.messages({ thread, limit }) builds for AgentsChat's first read.
  const q = new URLSearchParams();
  q.set("thread", "nyc-scout");
  q.set("limit", String(T.AGENTS_THREAD_FIRST_LIMIT));
  assert.equal(T.agentsThreadFirstUrl(WORKER, "nyc-scout"), `${WORKER}${T.AGENTS_MESSAGES_PATH}?${q}`);
  // A token about to expire starts nothing for a conversation either (the client refreshes and asks).
  calls.length = 0;
  delete global[E.EARLY_FETCH_KEY];
  global.location = { search: "?t=nyc-scout" };
  global.document.cookie = `${COOKIE}=base64-${b64url(session(30))}`;
  new Function(T.agentsEarlyScript(SUPABASE, WORKER))();
  assert.equal(calls.length, 0);
  assert.equal(T.agentsEarlyScript(undefined, WORKER), "", "no Supabase URL: no script");
  const fs = require("node:fs");
  const path = require("node:path");
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  assert.match(src("app/agents/page.tsx"), /<EarlyInbox \/>/);
  assert.match(src("app/agents/AgentsInbox.tsx"), /agentsApi\.inbox\(\{ early \}\)/);
  assert.match(src("app/agents/AgentsChat.tsx"), /limit: full \? AGENTS_THREAD_FIRST_LIMIT : 100 \},\s*\{ early \}/, "the conversation's first read takes it");
  assert.match(src("lib/agents-api.ts"), /takeEarlyFetch\(`\$\{AGENTS_API\}\$\{path\}`\)/, "the conversation's early key");
  // The same rule AgentsApp uses to open a conversation instead of the inbox.
  assert.ok(src("app/agents/AgentsApp.tsx").includes(String.raw`/^[\w][\w.-]{0,39}$/.test(thread)`));
});

const L = loadTs("lib/log-early.ts");
const { journalTodayUrl } = loadTs("lib/journal-file.ts");

test("/log: the script starts the sections' read-only GETs, the journal list for today, and sets its mark", (t) => {
  const calls = withWindow(t);
  new Function(L.logEarlyScript())();
  const urls = calls.map((c) => c.url);
  for (const u of L.LOG_EARLY_GETS) assert.ok(urls.includes(u), u);
  assert.ok(urls.includes(journalTodayUrl(new Date())), "journal URL = the Journal section's");
  assert.ok(!urls.some((u) => /experiments/.test(u)), "no experiment read");
  for (const c of calls) {
    assert.equal(c.init.method, undefined, "GET only");
    assert.equal(c.init.body, undefined, "GET only");
    assert.equal(c.init.cache, "no-store");
  }
  assert.equal(L.takeLogEarlyMark(), true, "a full page load of /log is marked");
  assert.equal(L.takeLogEarlyMark(), false, "once");
  delete global[L.LOG_EARLY_MARK];
});

test("/log: the sections read the URLs the script starts", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const SRC = path.join(__dirname, "..", "src");
  const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
  assert.equal(L.LOG_BEHAVIORAL_TODAY_URL, loadTs("lib/log-ubereats.ts").BEHAVIORAL_TODAY_URL);
  assert.match(read("app/log/sections/Weight.tsx"), /const WEIGHT_URL = LOG_WEIGHT_URL;/);
  assert.match(read("app/log/sections/Reading.tsx"), /const READING_URL = LOG_READING_URL;/);
  assert.match(read("app/log/sections/Supplements.tsx"), /const TODAY_URL = LOG_SUPPLEMENTS_TODAY_URL;/);
  assert.match(read("app/log/sections/Supplements.tsx"), /const HISTORY_URL = LOG_SUPPLEMENTS_HISTORY_URL;/);
  assert.match(read("app/log/sections/Supplements.tsx"), /cachedJson<\{ rows: UsageRow\[\] \}>\(HISTORY_URL, \{ check: checkHistory, get: logEarlyGet\(HISTORY_URL, routed\) \}\)/);
  assert.match(read("app/log/page.tsx"), /<EarlyReads \/>/);
});

test("/log: logEarlyGet takes the started answer once on the routed page, never in a copy in the scroll", async (t) => {
  withWindow(t);
  global[E.EARLY_FETCH_KEY] = { "/api/reading": { at: Date.now(), p: Promise.resolve({ ok: true, status: 200, redirected: false, early: true }) } };
  assert.equal(L.logEarlyGet("/api/reading", false), undefined, "a copy in the scroll fetches for itself");
  const get = L.logEarlyGet("/api/reading", true);
  assert.equal((await get()).early, true);
  assert.equal((await get()).url, "/api/reading", "the second read is the section's own fetch");
});

// ---- PERF-01 (2026-11-16): the early scripts load from the head, and do nothing once the app is running ----------

const ALL_SCRIPTS = () => [
  ["status-style inline", E.earlyFetchScript("/api/status")],
  ["Today", T.todayEarlyScript(SUPABASE, WORKER)],
  ["/log", L.logEarlyScript()],
  ["/agents", T.agentsEarlyScript(SUPABASE, WORKER)],
];

test("once the document has finished loading (React inserted the script on an in-app navigation), no script starts a read or sets the /log mark", (t) => {
  const calls = withWindow(t, { cookie: `${COOKIE}=base64-${b64url(session(3600))}` });
  t.after(() => { delete global.next; delete global[L.LOG_EARLY_MARK]; });
  global.document.readyState = "complete";
  for (const next of [true, false]) {
    if (next) global.next = { version: "synthetic", appDir: true };
    else delete global.next;
    for (const [name, script] of ALL_SCRIPTS()) {
      calls.length = 0;
      delete global[E.EARLY_FETCH_KEY];
      new Function(script)();
      assert.equal(calls.length, 0, `${name} (next=${next})`);
    }
    assert.equal(L.takeLogEarlyMark(), false, `no /log mark (next=${next})`);
  }
});

test("during a full page load every script runs, however late: it never depends on Next's own globals", (t) => {
  const calls = withWindow(t, { cookie: `${COOKIE}=base64-${b64url(session(3600))}` });
  t.after(() => { delete global.next; delete global[L.LOG_EARLY_MARK]; });
  // An inline script runs while the parser runs ("loading"); the head's async script holds the load event back, so even
  // a late run (HTML parsed, Next already started) is "interactive" at the latest, never "complete".
  for (const [next, state] of [[false, "loading"], [true, "loading"], [false, "interactive"], [true, "interactive"]]) {
    if (next) global.next = { version: "synthetic", appDir: true };
    else delete global.next;
    global.document.readyState = state;
    for (const [name, script] of ALL_SCRIPTS()) {
      calls.length = 0;
      delete global[E.EARLY_FETCH_KEY];
      new Function(script)();
      assert.ok(calls.length >= 1, `${name} (next=${next}, ${state})`);
    }
    assert.equal(L.takeLogEarlyMark(), true, `the /log mark (next=${next}, ${state})`);
  }
});

test("a script that runs twice in one load sends each read once; after the answer was taken, or once too old, it may start again", (t) => {
  const calls = withWindow(t);
  const script = E.earlyFetchesScript(["/api/a", "/api/b"]);
  new Function(script)();
  new Function(script)();
  assert.deepEqual(calls.map((c) => c.url), ["/api/a", "/api/b"], "the second run starts nothing");
  const first = global[E.EARLY_FETCH_KEY]["/api/a"].p;
  assert.equal(E.takeEarlyFetch("/api/a"), first, "the first answer is the one taken");
  new Function(script)();
  assert.deepEqual(calls.map((c) => c.url), ["/api/a", "/api/b", "/api/a"], "taken: started again; /api/b still pending");
  global[E.EARLY_FETCH_KEY]["/api/b"].at = Date.now() - E.EARLY_FETCH_MAX_AGE_MS - 1;
  new Function(script)();
  assert.deepEqual(calls.map((c) => c.url), ["/api/a", "/api/b", "/api/a", "/api/b"], "too old: started again");
});

test("earlyScriptSrc: a data: URL of only URL-safe characters that decodes to exactly the script, and runs", (t) => {
  const calls = withWindow(t);
  const PREFIX = "data:text/javascript;charset=utf-8,";
  for (const [name, script] of ALL_SCRIPTS()) {
    const src = E.earlyScriptSrc(script);
    assert.ok(src.startsWith(PREFIX), name);
    const body = src.slice(PREFIX.length);
    // No raw '#' (it would end the URL), quote, angle bracket, space or newline: every other byte is %-escaped.
    assert.match(body, /^[A-Za-z0-9\-_.!~*'()%]*$/, name);
    assert.equal(decodeURIComponent(body), script, name);
  }
  new Function(decodeURIComponent(E.earlyScriptSrc(E.earlyFetchScript("/api/habits/checkin")).slice(PREFIX.length)))();
  assert.deepEqual(calls.map((c) => c.url), ["/api/habits/checkin"]);
});

test("Today, /log and /agents render their early script as an async script with a src (hoisted into the head), not inline", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  for (const f of ["app/today/EarlyReads.tsx", "app/log/EarlyReads.tsx", "app/agents/EarlyInbox.tsx"]) {
    const src = read(f);
    assert.match(src, /<script async src=\{SRC\} \/>/, `${f}: async + src`);
    assert.match(src, /earlyScriptSrc\(/, `${f}: the data: URL helper`);
    // An inline script in the body waits for the stylesheet; React hoists a <script> only with async + src and no handlers.
    assert.ok(!/dangerouslySetInnerHTML/.test(src), `${f}: nothing inline`);
    assert.ok(!/onLoad|onError/.test(src), `${f}: no handlers`);
  }
});

test("/log: the Drinks section's first read is started with the others, at the URL the section reads, on the routed page only", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  assert.ok(L.LOG_EARLY_GETS.includes(L.LOG_DRINKS_URL));
  // The URL the section builds for behavioral today (no ?day=) is the one the script starts.
  assert.match(read("lib/drink-capture.ts"), new RegExp(`export const DRINKS_URL = "${L.LOG_DRINKS_URL}";`));
  const drinks = read("app/log/sections/Drinks.tsx");
  assert.ok(drinks.includes("LOG_DRINKS_URL") && drinks.includes("logEarlyGet(url, routed)"), "the section takes the started read");
  assert.ok(drinks.includes("useInFeed()"), "a copy in the continuous scroll fetches for itself");
});

test("/log: the Uber Eats section's reads start before the frame and the sections are evaluated, on a full page load only", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  const loader = read("app/log/LogLoader.tsx");
  // ES imports run in order: the starter module must come before ./LogClient, whose evaluation is the slow part.
  const start = loader.indexOf('import "./early-delivery-start";');
  const client = loader.indexOf('import "./LogClient";');
  assert.ok(start !== -1 && client !== -1 && start < client, "early-delivery-start is imported before LogClient");
  const starter = read("app/log/early-delivery-start.ts");
  assert.ok(starter.includes("takeLogEarlyMark()"), "only a full page load of /log (the head script's mark)");
  assert.ok(!/fetch\(|method:\s*"(POST|PUT|PATCH|DELETE)"/.test(starter), "read-only: nothing is sent from here");
});
