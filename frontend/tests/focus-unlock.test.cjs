// Run: node --test tests/focus-unlock.test.cjs
// Focus habit unlock (lib/focus-unlock.ts, lib/focus-unlock-server.ts): the unlock decision under both
// rules, the settings body, what the phone's status answer contains, and the auth boundary.
// SYNTHETIC DATA ONLY: invented habit names, ids and dates; a fake database; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

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

// ─── auth boundary and wiring ────────────────────────────────────────────────

test("middleware: the token opens /api/focus/unlock-status only, as an exact path", () => {
  const src = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const m = /function isCiRoute\(pathname: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, "isCiRoute not found");
  const isCiRoute = new Function("pathname", m[1]);
  assert.equal(isCiRoute("/api/focus/unlock-status"), true);
  for (const p of ["/api/focus", "/api/focus/", "/api/focus/config", "/api/focus/unlock-status/", "/api/focus/unlock-status/x", "/api/focus/unlock-statusx", "/api/focusx/unlock-status"]) {
    assert.equal(isCiRoute(p), false, p);
  }
  assert.ok(!/startsWith\("\/api\/focus/.test(src), "never a /api/focus prefix");
});

test("routes: the status route is read-only; the settings route checks the request before reading it", () => {
  const status = fs.readFileSync(path.join(SRC, "app/api/focus/unlock-status/route.ts"), "utf8");
  assert.deepEqual([...status.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"]);
  assert.match(status, /loadUnlockStatus\(supabase\)/);
  assert.match(status, /"Cache-Control": "no-store"/);
  assert.ok(!/\.(insert|upsert|update|delete)\(/.test(status));

  const config = fs.readFileSync(path.join(SRC, "app/api/focus/config/route.ts"), "utf8");
  assert.deepEqual([...config.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET", "PUT"]);
  assert.ok(config.indexOf("checkConfigWrite(req.headers") < config.indexOf("req.text()"));
  assert.match(config, /text\.length > MAX_FOCUS_CONFIG_BODY_BYTES/);
  assert.match(config, /parseConfigBody\(body\)/);
});

test("the Swift decision table matches this one", () => {
  const swift = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "FocusCore", "Sources", "FocusCore", "OnyxHabits.swift"), "utf8");
  assert.match(swift, /guard configPresent, let habitsDone else \{ return timeReady \}/);
  assert.match(swift, /case \.and: return habitsDone && timeReady/);
  assert.match(swift, /case \.or: return habitsDone \|\| timeReady/);
  // The phone asks the one path the token opens.
  const sync = fs.readFileSync(path.join(SRC, "..", "..", "tools", "screentime_ios", "FocusUI", "FocusHabitSync.swift"), "utf8");
  assert.match(sync, /"\/api\/focus\/unlock-status"/);
});

test("the settings card is on /install and writes with PUT", () => {
  const page = fs.readFileSync(path.join(SRC, "app/install/page.tsx"), "utf8");
  assert.match(page, /<FocusUnlockSettings \/>/);
  const card = fs.readFileSync(path.join(SRC, "components/FocusUnlockSettings.tsx"), "utf8");
  assert.match(card, /fetch\("\/api\/focus\/config", \{\s*method: "PUT"/);
  assert.match(card, /JSON\.stringify\(\{ rule, habit_page_ids: selected \}\)/);
});
