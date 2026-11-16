// Run with the rest of the suite (after deployment): node --test tests/focus-unlock.test.cjs
// Focus habit unlock (lib/focus-unlock.ts, lib/focus-unlock-server.ts): the unlock decision under both
// rules, the settings body, what the phone's status answer contains, the auth boundary (isCiRoute, a check over the
// whole of middleware.ts and middleware() run without the owner's session), the two routes (run
// against a fake database) and the /install settings card (mounted with the real autosave on a manual clock).
// SYNTHETIC DATA ONLY: invented habit names, ids and dates; a fake database; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");
const { response } = require("./helpers/hook-harness.cjs");
const { mountAutosaving } = require("./helpers/autosave-harness.cjs");
const SF = require("./helpers/source-facts.cjs");

const F = loadTs("lib/focus-unlock.ts");
const S = loadTs("lib/focus-unlock-server.ts");

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_GONE = "33333333-3333-4333-8333-333333333333";
const DAY = "2031-03-04";

// ─── the decision ────────────────────────────────────────────────────────────

test("shouldUnlock: OR unlocks on habits done or on the time", () => {
  assert.equal(F.shouldUnlock("or", false, false, true), false);
  assert.equal(F.shouldUnlock("or", true, false, true), true); // early unlock
  assert.equal(F.shouldUnlock("or", false, true, true), true); // the time unlocks regardless
  assert.equal(F.shouldUnlock("or", true, true, true), true);
});

test("shouldUnlock: AND needs the habits done and the time reached", () => {
  assert.equal(F.shouldUnlock("and", false, false, true), false);
  assert.equal(F.shouldUnlock("and", true, false, true), false); // habits alone do not unlock early
  assert.equal(F.shouldUnlock("and", false, true, true), false); // stays blocked after the time
  assert.equal(F.shouldUnlock("and", true, true, true), true);
});

test("shouldUnlock: no habits chosen is the time-only rule, whatever else is passed", () => {
  for (const rule of ["or", "and"]) {
    for (const done of [true, false, null]) {
      assert.equal(F.shouldUnlock(rule, done, false, false), false, `${rule} ${done} before`);
      assert.equal(F.shouldUnlock(rule, done, true, false), true, `${rule} ${done} after`);
    }
  }
});

test("shouldUnlock: an unknown or failed status is the time-only rule under both rules", () => {
  for (const rule of ["or", "and"]) {
    assert.equal(F.shouldUnlock(rule, null, false, true), false, `${rule} before the time`);
    // The safety property: a failed check never keeps apps blocked past the unlock time, even under AND.
    assert.equal(F.shouldUnlock(rule, null, true, true), true, `${rule} after the time`);
  }
});

test("the default config is no habits and rule OR", () => {
  assert.deepEqual(F.DEFAULT_FOCUS_CONFIG, { rule: "or", habitPageIds: [] });
  assert.deepEqual(F.configFromRow(null), { rule: "or", habitPageIds: [] });
  assert.deepEqual(F.configFromRow(undefined), { rule: "or", habitPageIds: [] });
});

test("configFromRow: tolerates a damaged row", () => {
  assert.deepEqual(F.configFromRow({ rule: "and", habit_page_ids: [ID_A, ID_B] }), { rule: "and", habitPageIds: [ID_A, ID_B] });
  assert.deepEqual(F.configFromRow({ rule: "xor", habit_page_ids: "nope" }), { rule: "or", habitPageIds: [] });
  assert.deepEqual(F.configFromRow({ rule: "and", habit_page_ids: [ID_A, 7, "not-an-id", ID_A] }), { rule: "and", habitPageIds: [ID_A] });
});

// ─── the settings body ───────────────────────────────────────────────────────

test("parseConfigBody: accepts exactly {rule, habit_page_ids}", () => {
  assert.deepEqual(F.parseConfigBody({ rule: "and", habit_page_ids: [ID_A, ID_B] }), { ok: true, value: { rule: "and", habitPageIds: [ID_A, ID_B] } });
  assert.deepEqual(F.parseConfigBody({ rule: "or", habit_page_ids: [] }), { ok: true, value: { rule: "or", habitPageIds: [] } });
});

test("parseConfigBody: refuses everything else", () => {
  const eleven = Array.from({ length: F.MAX_FOCUS_HABITS + 1 }, (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const bad = [
    null,
    [],
    "x",
    {},
    { rule: "or" },
    { habit_page_ids: [] },
    { rule: "or", habit_page_ids: [], extra: 1 },
    { rule: "xor", habit_page_ids: [] },
    { rule: "OR", habit_page_ids: [] },
    { rule: "or", habit_page_ids: "x" },
    { rule: "or", habit_page_ids: [7] },
    { rule: "or", habit_page_ids: ["A habit name"] },
    { rule: "or", habit_page_ids: ["ABCDEF12-1111-4111-8111-111111111111"] },
    { rule: "or", habit_page_ids: ["whoop-archived:0123456789abcdef0123456789abcdef"] },
    { rule: "or", habit_page_ids: [ID_A, ID_A] },
    { rule: "or", habit_page_ids: eleven },
  ];
  for (const body of bad) assert.equal(F.parseConfigBody(body).ok, false, JSON.stringify(body));
});

const headers = (h) => ({ get: (name) => (name in h ? h[name] : null) });

test("checkConfigWrite: same origin, JSON, small body", () => {
  const origin = "https://onyx.example";
  const ok = { origin, host: "onyx.example", "content-type": "application/json; charset=utf-8", "content-length": "120" };
  assert.equal(F.checkConfigWrite(headers(ok), origin), null);
  assert.equal(F.checkConfigWrite(headers({ ...ok, origin: undefined }), origin).status, 403);
  assert.equal(F.checkConfigWrite(headers({ ...ok, origin: null }), origin).status, 403);
  assert.equal(F.checkConfigWrite(headers({ ...ok, origin: "https://evil.example" }), origin).status, 403);
  assert.equal(F.checkConfigWrite(headers({ ...ok, origin: "not a url" }), origin).status, 403);
  assert.equal(F.checkConfigWrite(headers({ ...ok, "content-type": "text/plain" }), origin).status, 415);
  assert.equal(F.checkConfigWrite(headers({ ...ok, "content-length": String(F.MAX_FOCUS_CONFIG_BODY_BYTES + 1) }), origin).status, 413);
  assert.equal(F.checkConfigWrite(headers({ ...ok, "content-length": "abc" }), origin).status, 413);
});

// ─── the phone's answer ──────────────────────────────────────────────────────

test("buildUnlockStatus: only the chosen habits, in the chosen order, with done flags", () => {
  const status = F.buildUnlockStatus({
    behavioralDate: DAY,
    config: { rule: "and", habitPageIds: [ID_B, ID_A] },
    names: new Map([[ID_A, "Synthetic habit A"], [ID_B, "Synthetic habit B"]]),
    yes: new Set(["Synthetic habit A", "Some other habit"]),
  });
  assert.deepEqual(status, {
    behavioral_date: DAY,
    rule: "and",
    config_present: true,
    habits: [{ name: "Synthetic habit B", done: false }, { name: "Synthetic habit A", done: true }],
    habits_done: false,
  });
});

test("buildUnlockStatus: all done, none chosen, and a chosen habit Onyx no longer knows", () => {
  const names = new Map([[ID_A, "Synthetic habit A"], [ID_B, "Synthetic habit B"]]);
  const all = F.buildUnlockStatus({ behavioralDate: DAY, config: { rule: "or", habitPageIds: [ID_A, ID_B] }, names, yes: new Set(["Synthetic habit A", "Synthetic habit B"]) });
  assert.equal(all.habits_done, true);

  const none = F.buildUnlockStatus({ behavioralDate: DAY, config: { rule: "or", habitPageIds: [] }, names, yes: new Set(["Synthetic habit A"]) });
  assert.deepEqual(none, { behavioral_date: DAY, rule: "or", config_present: false, habits: [], habits_done: false });

  // An id missing from the map is left out instead of blocking for good under AND.
  const gone = F.buildUnlockStatus({ behavioralDate: DAY, config: { rule: "and", habitPageIds: [ID_GONE, ID_A] }, names, yes: new Set(["Synthetic habit A"]) });
  assert.deepEqual(gone.habits, [{ name: "Synthetic habit A", done: true }]);
  assert.equal(gone.habits_done, true);
  const onlyGone = F.buildUnlockStatus({ behavioralDate: DAY, config: { rule: "and", habitPageIds: [ID_GONE] }, names, yes: new Set() });
  assert.equal(onlyGone.config_present, false);
  assert.equal(onlyGone.habits_done, false);
});

test("describeStatus: one line per case", () => {
  const base = { behavioral_date: DAY, config_present: true };
  const todo = [{ name: "Synthetic habit A", done: false }];
  const done = [{ name: "Synthetic habit A", done: true }];
  assert.match(F.describeStatus({ ...base, rule: "or", config_present: false, habits: [], habits_done: false }), /No habits chosen/);
  assert.match(F.describeStatus({ ...base, rule: "or", habits: todo, habits_done: false }), /or at its unlock time/);
  assert.match(F.describeStatus({ ...base, rule: "or", habits: done, habits_done: true }), /next time it checks/);
  assert.match(F.describeStatus({ ...base, rule: "and", habits: todo, habits_done: false }), /stays blocked after its unlock time/);
  assert.match(F.describeStatus({ ...base, rule: "and", habits: done, habits_done: true }), /unlocks at its unlock time/);
});

// ─── database reads (fake client) ────────────────────────────────────────────

// A tiny stand-in for the supabase-js query builder: records every call, answers from `tables`.
function fakeDb({ config, map = [], journal = [], day = DAY, fail = {} }) {
  const calls = [];
  const db = {
    calls,
    rpc(fn) {
      calls.push({ rpc: fn });
      return Promise.resolve(fail.rpc ? { data: null, error: { code: "X" } } : { data: day, error: null });
    },
    from(table) {
      const q = { table, select: null, filters: [], upsert: null };
      calls.push(q);
      const run = () => {
        if (fail[table]) return { data: null, error: { code: "X" } };
        if (q.upsert) return { data: null, error: null };
        if (table === "focus_unlock_config") return { data: config ?? null, error: null };
        if (table === "habit_name_map") {
          const ids = q.filters.find((f) => f.op === "in" && f.col === "notion_page_id").val;
          return { data: map.filter((r) => ids.includes(r.notion_page_id)), error: null };
        }
        if (table === "habit_journal") {
          const eq = Object.fromEntries(q.filters.filter((f) => f.op === "eq").map((f) => [f.col, f.val]));
          const names = q.filters.find((f) => f.op === "in" && f.col === "question").val;
          return { data: journal.filter((r) => r.cycle_date === eq.cycle_date && r.answer === eq.answer && names.includes(r.question)).map((r) => ({ question: r.question })), error: null };
        }
        throw new Error(`unexpected table ${table}`);
      };
      const builder = {
        select(cols) { q.select = cols; return builder; },
        eq(col, val) { q.filters.push({ op: "eq", col, val }); return builder; },
        in(col, val) { q.filters.push({ op: "in", col, val }); return builder; },
        upsert(row, opts) { q.upsert = { row, opts }; return builder; },
        maybeSingle() { return Promise.resolve(run()); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return builder;
    },
  };
  return db;
}

const MAP = [
  { notion_page_id: ID_A, habit_name: "Synthetic habit A" },
  { notion_page_id: ID_B, habit_name: "Synthetic habit B" },
  { notion_page_id: "44444444-4444-4444-8444-444444444444", habit_name: "Synthetic habit never chosen" },
];

test("loadUnlockStatus: nothing saved yet answers the default and reads no habit data", async () => {
  const db = fakeDb({ config: null, map: MAP, journal: [{ cycle_date: DAY, question: "Synthetic habit A", answer: "Yes" }] });
  assert.deepEqual(await S.loadUnlockStatus(db), { behavioral_date: DAY, rule: "or", config_present: false, habits: [], habits_done: false });
  assert.deepEqual(db.calls.filter((c) => c.table).map((c) => c.table), ["focus_unlock_config"]);
  assert.deepEqual(db.calls.filter((c) => c.rpc).map((c) => c.rpc), ["behavioral_today_now"]);
});

test("loadUnlockStatus: Yes for the behavioral day counts; No, another day and other habits do not", async () => {
  const journal = [
    { cycle_date: DAY, question: "Synthetic habit A", answer: "Yes" },
    { cycle_date: DAY, question: "Synthetic habit B", answer: "No" },
    { cycle_date: "2031-03-03", question: "Synthetic habit B", answer: "Yes" },
    { cycle_date: DAY, question: "Synthetic habit never chosen", answer: "Yes" },
  ];
  const db = fakeDb({ config: { rule: "and", habit_page_ids: [ID_A, ID_B] }, map: MAP, journal });
  const status = await S.loadUnlockStatus(db);
  assert.deepEqual(status, {
    behavioral_date: DAY,
    rule: "and",
    config_present: true,
    habits: [{ name: "Synthetic habit A", done: true }, { name: "Synthetic habit B", done: false }],
    habits_done: false,
  });
  // The answer carries these keys and nothing else.
  assert.deepEqual(Object.keys(status).sort(), ["behavioral_date", "config_present", "habits", "habits_done", "rule"]);
  for (const h of status.habits) assert.deepEqual(Object.keys(h).sort(), ["done", "name"]);
  assert.ok(!JSON.stringify(status).includes("never chosen"));

  // It asks the journal for the chosen names on that one day with answer Yes, and selects one column.
  const hj = db.calls.find((c) => c.table === "habit_journal");
  assert.equal(hj.select, "question");
  assert.deepEqual(hj.filters, [
    { op: "eq", col: "cycle_date", val: DAY },
    { op: "eq", col: "answer", val: "Yes" },
    { op: "in", col: "question", val: ["Synthetic habit A", "Synthetic habit B"] },
  ]);
});

test("loadUnlockStatus: every chosen habit answered Yes", async () => {
  const journal = [
    { cycle_date: DAY, question: "Synthetic habit A", answer: "Yes" },
    { cycle_date: DAY, question: "Synthetic habit B", answer: "Yes" },
  ];
  const status = await S.loadUnlockStatus(fakeDb({ config: { rule: "or", habit_page_ids: [ID_A, ID_B] }, map: MAP, journal }));
  assert.equal(status.habits_done, true);
});

test("loadUnlockStatus: a failed read throws a step name, never a partial answer", async () => {
  const config = { rule: "and", habit_page_ids: [ID_A] };
  const cases = [
    [{ focus_unlock_config: true }, "config"],
    [{ rpc: true }, "behavioral_day"],
    [{ habit_name_map: true }, "habit_names"],
    [{ habit_journal: true }, "habit_answers"],
  ];
  for (const [fail, step] of cases) {
    await assert.rejects(S.loadUnlockStatus(fakeDb({ config, map: MAP, fail })), (e) => e instanceof S.FocusUnlockError && e.step === step, step);
  }
  await assert.rejects(S.loadUnlockStatus(fakeDb({ config, map: MAP, day: "tomorrow" })), (e) => e.step === "behavioral_day");
});

test("saveFocusConfig: writes the one row; refuses an id that is not a known habit", async () => {
  const db = fakeDb({ config: null, map: MAP });
  const now = new Date("2031-03-04T15:00:00Z");
  assert.deepEqual(await S.saveFocusConfig(db, { rule: "and", habitPageIds: [ID_B, ID_A] }, now), { ok: true, config: { rule: "and", habitPageIds: [ID_B, ID_A] } });
  const write = db.calls.find((c) => c.upsert);
  assert.equal(write.table, "focus_unlock_config");
  assert.deepEqual(write.upsert.row, { id: 1, rule: "and", habit_page_ids: [ID_B, ID_A], updated_at: "2031-03-04T15:00:00.000Z" });
  assert.deepEqual(write.upsert.opts, { onConflict: "id" });

  const db2 = fakeDb({ config: null, map: MAP });
  assert.deepEqual(await S.saveFocusConfig(db2, { rule: "or", habitPageIds: [ID_A, ID_GONE] }), { ok: false, unknownIds: [ID_GONE] });
  assert.equal(db2.calls.some((c) => c.upsert), false);

  // Clearing the list needs no habit lookup.
  const db3 = fakeDb({ config: null, map: MAP });
  assert.equal((await S.saveFocusConfig(db3, { rule: "or", habitPageIds: [] })).ok, true);
  assert.deepEqual(db3.calls.map((c) => c.table), ["focus_unlock_config"]);
});

// ─── auth boundary and routes (executed) ─────────────────────────────────────

test("middleware: the token opens /api/focus/unlock-status only, as an exact path", () => {
  const isCiRoute = SF.loadFunction("middleware.ts", "isCiRoute");
  assert.equal(isCiRoute("/api/focus/unlock-status"), true);
  for (const p of ["/api/focus", "/api/focus/", "/api/focus/config", "/api/focus/unlock-status/", "/api/focus/unlock-status/x", "/api/focus/unlock-statusx", "/api/focusx/unlock-status"]) {
    assert.equal(isCiRoute(p), false, p);
  }
});

// The test above proves what isCiRoute() admits; it cannot see the rest of middleware.ts, where an early return,
// a regex or a matcher exclusion would make the session-only /api/focus/config reachable while isCiRoute() still
// answers as before. This check covers the whole file: its only mention of a focus path is isCiRoute's
// `pathname === "/api/focus/unlock-status"`, and no startsWith() anywhere takes a focus path (master's whole-file
// rule). Literals are read from the syntax tree, so quote style, line breaks and comments change nothing. Limit: a
// path assembled at run time from pieces that do not contain "focus" is not seen; the middleware() run below covers
// the paths it sends.
function focusPathProblems(sf) {
  const { ts } = SF;
  const textOf = (n) => (ts.isRegularExpressionLiteral(n) ? n.text.replace(/\\/g, "") : SF.literalText(n));
  const isLiteral = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || ts.isRegularExpressionLiteral(n);
  const mentions = (n) => /focus/i.test(textOf(n) ?? "");
  const shown = (n) => n.getText().replace(/\s+/g, " ");
  const problems = [];
  for (const c of SF.collect(sf, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "startsWith")) {
    if (c.arguments.some(mentions)) problems.push(`a focus prefix: ${shown(c)}`);
  }
  const isCi = SF.functionNamed(sf, "isCiRoute");
  const exactComparison = (n) => {
    let e = n;
    while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
    const p = e.parent;
    return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && SF.refName(p.left === e ? p.right : p.left) === "pathname";
  };
  let allowed = 0;
  for (const n of SF.collect(sf, isLiteral).filter(mentions)) {
    if (textOf(n) === "/api/focus/unlock-status" && isCi && SF.enclosingFunction(n) === isCi && exactComparison(n)) allowed += 1;
    else problems.push(`a focus path outside isCiRoute's exact comparison: ${shown(n.parent)}`);
  }
  if (allowed !== 1) problems.push(`isCiRoute compares pathname with "/api/focus/unlock-status" ${allowed} times (want 1)`);
  return problems;
}

function middlewareLike({ ci = `pathname === "/api/focus/unlock-status"`, body = "", matcher = "_next/static|sw.js" } = {}) {
  return [
    "function isCiRoute(pathname: string): boolean {",
    `  return pathname === "/api/habits/sync" || ${ci};`,
    "}",
    "export async function middleware(request: NextRequest) {",
    body,
    "  return null;",
    "}",
    `export const config = { matcher: ["/((?!${matcher}).*)"] };`,
  ].join("\n");
}
const focusProblemsOf = (parts) => focusPathProblems(SF.parseSource(middlewareLike(parts), "middleware.ts"));

test("middleware focus-path check: re-formatted source passes; every way around isCiRoute is caught", () => {
  assert.deepEqual(focusProblemsOf(), []);
  assert.deepEqual(focusProblemsOf({ ci: "pathname ===\n    ('/api/focus/unlock-status') // the phone's one path" }), [], "quotes, parentheses, a line break and a comment change nothing");
  // The first five open a focus path past the auth boundary or past the token check while isCiRoute("/api/focus/config")
  // stays false; the last drops the phone's one path.
  for (const mutant of [
    { body: `  if (request.nextUrl.pathname.startsWith("/api/focus")) return NextResponse.next({ request });` },
    { body: "  if (/^\\/api\\/focus\\//.test(request.nextUrl.pathname)) return NextResponse.next({ request });" },
    { body: `  if (request.nextUrl.pathname === "/api/focus/unlock-status") return NextResponse.next({ request });` },
    { matcher: "_next/static|sw.js|api/focus" },
    { ci: `pathname.startsWith("/api/focus/unlock-status")` },
    { ci: `pathname === "/api/habits/other"` },
  ]) {
    assert.notDeepEqual(focusProblemsOf(mutant), [], JSON.stringify(mutant));
  }
});

test("middleware: no /api/focus prefix anywhere in the file; its one focus path is isCiRoute's exact comparison", () => {
  assert.deepEqual(focusPathProblems(SF.parseFile("middleware.ts")), []);
});

// middleware() itself, run with Supabase and NextResponse stubbed. Synthetic account ids and token.
const MW_OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const MW_OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const MW_TOKEN = "synthetic-ci-token";
function loadMiddleware(claims) {
  const prevOwner = process.env.ONYX_OWNER_USER_ID;
  process.env.ONYX_OWNER_USER_ID = MW_OWNER;
  try {
    return loadTs("middleware.ts", {
      "@supabase/ssr": { createServerClient: () => ({ auth: { getClaims: async () => ({ data: claims ? { claims } : null }) } }) },
      "next/server": {
        NextResponse: {
          next: () => ({ kind: "next", cookies: { set() {} } }),
          redirect: (url) => ({ kind: "redirect", url: String(url) }),
          json: (body, init = {}) => ({ kind: "json", status: init.status ?? 200, body }),
        },
      },
    }).middleware;
  } finally {
    if (prevOwner === undefined) delete process.env.ONYX_OWNER_USER_ID;
    else process.env.ONYX_OWNER_USER_ID = prevOwner;
  }
}
function mwRequest(pathname, headerValues = {}) {
  const nextUrl = new URL(`https://onyx.example${pathname}`);
  nextUrl.clone = () => new URL(nextUrl.href);
  return { nextUrl, headers: new Headers(headerValues), cookies: { getAll: () => [], set() {} } };
}

test("middleware(): without the owner's session the CI token opens /api/focus/unlock-status and no other focus path", async () => {
  const prevToken = process.env.ONYX_CI_TOKEN;
  process.env.ONYX_CI_TOKEN = MW_TOKEN;
  try {
    const token = { "x-onyx-ci-token": MW_TOKEN };
    for (const claims of [null, { sub: MW_OTHER }]) {
      const who = claims ? "another account" : "signed out";
      const middleware = loadMiddleware(claims);
      assert.equal((await middleware(mwRequest("/api/focus/unlock-status", token))).kind, "next", `${who}: the phone's path, with the token`);
      for (const h of [{}, { "x-onyx-ci-token": "synthetic-ci-tokeX" }]) {
        const res = await middleware(mwRequest("/api/focus/unlock-status", h));
        assert.deepEqual([res.kind, res.status], ["json", 401], `${who}: the phone's path without the right token`);
      }
      for (const p of ["/api/focus", "/api/focus/", "/api/focus/config", "/api/focus/config/", "/api/focus/unlock-status/", "/api/focus/unlock-status/x", "/api/focus/unlock-statusx", "/api/focusx/unlock-status"]) {
        assert.notEqual((await middleware(mwRequest(p, token))).kind, "next", `${who}: ${p} is not opened by the token`);
      }
    }
    // The settings route is session-only: the owner's session reaches it (so the refusals above come from the gate, not the stubs).
    assert.equal((await loadMiddleware({ sub: MW_OWNER })(mwRequest("/api/focus/config"))).kind, "next");
  } finally {
    if (prevToken === undefined) delete process.env.ONYX_CI_TOKEN;
    else process.env.ONYX_CI_TOKEN = prevToken;
  }
});

const nextServer = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, headers: init.headers ?? {}, body }) } };
const loadRoute = (rel, db) => loadTs(rel, { "@supabase/supabase-js": { createClient: () => db }, "next/server": nextServer });
// Next.js answers a method only when the route exports a function of that name.
const methodsOf = (route) => Object.keys(route).filter((k) => typeof route[k] === "function").sort();

test("status route: GET only, read-only, never cached; a failed read answers and logs a step name only", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const config = { rule: "or", habit_page_ids: [ID_A] };
  const journal = [{ cycle_date: DAY, question: "Synthetic habit A", answer: "Yes" }];
  const db = fakeDb({ config, map: MAP, journal });
  const route = loadRoute("app/api/focus/unlock-status/route.ts", db);
  assert.deepEqual(methodsOf(route), ["GET"]);
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body.habits, [{ name: "Synthetic habit A", done: true }]);
  assert.equal(db.calls.some((c) => c.upsert), false, "nothing is written");

  const failing = loadRoute("app/api/focus/unlock-status/route.ts", fakeDb({ config, map: MAP, journal, fail: { habit_journal: true } }));
  const err = await failing.GET();
  assert.equal(err.status, 500);
  assert.deepEqual(Object.keys(err.body).sort(), ["error", "step"], "no habit data in a failure");
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [["focus unlock-status failed:", "habit_answers"]]);
});

const ORIGIN = "https://onyx.example";
function putRequest(text, over = {}) {
  let reads = 0;
  const all = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json", "content-length": String(text.length), ...over };
  return {
    headers: headers(all),
    nextUrl: { origin: ORIGIN },
    text: async () => {
      reads += 1;
      return text;
    },
    reads: () => reads,
  };
}

test("settings route: a cross-site, non-JSON or oversized request is refused before the body is read", async () => {
  const cases = [[{ origin: "https://evil.example" }, 403], [{ origin: undefined }, 403], [{ "content-type": "text/plain" }, 415], [{ "content-length": "999999" }, 413]];
  for (const [over, status] of cases) {
    const db = fakeDb({ config: null, map: MAP });
    const route = loadRoute("app/api/focus/config/route.ts", db);
    const req = putRequest(JSON.stringify({ rule: "or", habit_page_ids: [ID_A] }), over);
    const res = await route.PUT(req);
    assert.equal(res.status, status, JSON.stringify(over));
    assert.equal(req.reads(), 0, "the body is never read");
    assert.equal(db.calls.length, 0, "nothing is read or written");
  }
});

test("settings route: a valid change is written once; a body larger than it claims, an unknown habit or bad JSON writes nothing", async () => {
  const db = fakeDb({ config: null, map: MAP });
  const route = loadRoute("app/api/focus/config/route.ts", db);
  assert.deepEqual(methodsOf(route), ["GET", "PUT"]);
  const ok = await route.PUT(putRequest(JSON.stringify({ rule: "and", habit_page_ids: [ID_A] })));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { rule: "and", habit_page_ids: [ID_A], chosen: [{ id: ID_A, name: "Synthetic habit A" }] });
  assert.equal(db.calls.filter((c) => c.upsert).length, 1);
  const big = await route.PUT(putRequest(JSON.stringify({ rule: "or", habit_page_ids: [ID_A], pad: "x".repeat(2000) }), { "content-length": "10" }));
  assert.equal(big.status, 413);
  assert.equal((await route.PUT(putRequest(JSON.stringify({ rule: "or", habit_page_ids: [ID_GONE] })))).status, 400);
  assert.equal((await route.PUT(putRequest("{not json"))).status, 400);
  assert.equal(db.calls.filter((c) => c.upsert).length, 1, "only the valid change was written");
});

test("the Swift decision table matches this one (the phone app cannot run here)", () => {
  const swift = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "FocusCore", "Sources", "FocusCore", "OnyxHabits.swift"), "utf8");
  assert.match(swift, /guard\s+configPresent\s*,\s*let\s+habitsDone\s+else\s*\{\s*return\s+timeReady\s*\}/);
  assert.match(swift, /case\s+\.and\s*:\s*return\s+habitsDone\s*&&\s*timeReady/);
  assert.match(swift, /case\s+\.or\s*:\s*return\s+habitsDone\s*\|\|\s*timeReady/);
  // The phone asks the one path the token opens.
  const sync = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "FocusUI", "FocusHabitSync.swift"), "utf8");
  assert.match(sync, /"\/api\/focus\/unlock-status"/);
});

// ─── the settings card on /install (mounted, real autosave on a manual clock) ─

test("the settings card is on /install", () => {
  assert.ok(SF.jsxElements(SF.parseFile("app/install/page.tsx")).some((e) => e.tag === "FocusUnlockSettings"));
});

const HABITS = [{ id: ID_A, name: "Synthetic habit A" }, { id: ID_B, name: "Synthetic habit B" }];
const STATUS = { behavioral_date: DAY, rule: "or", config_present: false, habits: [], habits_done: false };
const savedConfig = (ids) => response({ rule: "or", habit_page_ids: ids, chosen: [] });

async function mountCard(t, { config = savedConfig([]), put = () => savedConfig([]) } = {}) {
  return mountAutosaving(t, "components/FocusUnlockSettings.tsx", {
    stubs: { "./InfoHint": { __esModule: true, default: () => null } },
    answer: (call, n) => {
      if (call.method === "PUT") return put(call, n);
      if (call.url === "/api/focus/config") return config;
      if (call.url === "/api/habits/list") return response({ habits: HABITS });
      if (call.url === "/api/focus/unlock-status") return response(STATUS);
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    },
  });
}
function pick(h, text, type) {
  const label = h.find((n) => n.type === "label" && h.text(n).includes(text))[0];
  assert.ok(label, `${text} is listed`);
  const input = h.nodes(label).find((n) => n.type === "input" && n.props.type === type);
  assert.ok(input, `${text} has a ${type}`);
  input.props.onChange();
}
const puts = (h) => h.net.writes().filter((c) => c.method === "PUT");

test("settings card: opening writes nothing; a burst of ticks is one PUT with the chosen habits and the rule", async (t) => {
  const h = await mountCard(t);
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 0, "nothing is written on open");
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  pick(h, "Synthetic habit B", "checkbox");
  await h.flush();
  await h.tick(699);
  assert.equal(puts(h).length, 0, "nothing until the pause after the last tick");
  await h.tick(1);
  assert.deepEqual(puts(h).map((c) => [c.url, c.body]), [["/api/focus/config", { rule: "or", habit_page_ids: [ID_A, ID_B] }]]);
  assert.match(h.text(), /Saved/);
  pick(h, F.FOCUS_RULE_TEXT.and.label, "radio");
  await h.flush();
  await h.tick(700);
  assert.deepEqual(puts(h).map((c) => c.body), [{ rule: "or", habit_page_ids: [ID_A, ID_B] }, { rule: "and", habit_page_ids: [ID_A, ID_B] }], "a rule change is sent with the chosen habits");
});

test("settings card: ticking a habit and unticking it again sends nothing", async (t) => {
  const h = await mountCard(t);
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  await h.tick(60_000);
  assert.equal(puts(h).length, 0, "back to what is saved");
});

test("settings card: a refusal is shown with Retry and not retried on its own", async (t) => {
  let refuse = true;
  const h = await mountCard(t, { put: () => (refuse ? response({ error: "Synthetic refusal" }, 400) : savedConfig([ID_A])) });
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  await h.tick(700);
  assert.match(h.text(), /Not saved: Synthetic refusal/);
  assert.doesNotMatch(h.text(), /Trying again/);
  await h.tick(120_000);
  assert.equal(puts(h).length, 1, "a refusal waits for Riley");
  refuse = false;
  h.click("Retry");
  await h.flush();
  assert.equal(puts(h).length, 2);
  assert.match(h.text(), /Saved/);
});

test("settings card: an outage is shown and retried with backoff until it is saved", async (t) => {
  let down = true;
  const h = await mountCard(t, { put: () => (down ? response({ error: "Synthetic outage" }, 503) : savedConfig([ID_A])) });
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  await h.tick(700);
  assert.match(h.text(), /Not saved: Synthetic outage Trying again…/);
  down = false;
  await h.tick(1999);
  assert.equal(puts(h).length, 1, "retried after the backoff, not at once");
  await h.tick(1);
  assert.equal(puts(h).length, 2);
  assert.match(h.text(), /Saved/);
});

test("settings card: hiding the page sends a waiting change at once, with keepalive", async (t) => {
  const h = await mountCard(t);
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  h.page.hide();
  await h.flush();
  assert.deepEqual(puts(h).map((c) => [c.body, c.keepalive]), [[{ rule: "or", habit_page_ids: [ID_A] }, true]]);
});

test("settings card: leaving the page (pagehide) sends a waiting change once, with keepalive", async (t) => {
  const h = await mountCard(t);
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  assert.equal(h.page.fire("pagehide"), true, "the card listens for the page being left");
  await h.flush();
  assert.deepEqual(puts(h).map((c) => [c.body, c.keepalive]), [[{ rule: "or", habit_page_ids: [ID_A] }, true]]);
  await h.tick(60_000);
  assert.equal(puts(h).length, 1, "the pause that followed sent nothing more");
});

test("settings card: leaving the card (unmount, a route change) sends a waiting change once, with keepalive, then stops", async (t) => {
  const h = await mountCard(t);
  pick(h, "Synthetic habit A", "checkbox");
  await h.flush();
  assert.equal(puts(h).length, 0, "still waiting for the pause");
  h.unmount();
  await h.flush();
  assert.deepEqual(puts(h).map((c) => [c.body, c.keepalive]), [[{ rule: "or", habit_page_ids: [ID_A] }, true]]);
  await h.tick(60_000);
  assert.equal(puts(h).length, 1, "nothing more once the card is gone");
});

test("settings card: settings that could not load show the error and offer nothing to send", async (t) => {
  const h = await mountCard(t, { config: response({ error: "Synthetic load failure" }, 500) });
  assert.match(h.text(), /Couldn.t load the Focus settings\./);
  assert.match(h.text(), /Synthetic load failure/);
  assert.equal(h.find((n) => n.type === "input" && n.props.type === "checkbox").length, 0);
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 0);
});
