// Run: node --test tests/experiments.test.cjs
// The Today arm card's data path (docs/experiment-framework.md 4.3 / 4.4): the parser that gates
// what the browser may learn, the server loader against a stand-in for supabase-js, and the
// access rules (owner session only, one database function, no way to start a trial from the app).
// SYNTHETIC DATA ONLY; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/experiments.ts");

const ACTIVE = {
  status: "active", experiment_id: "EXP-901", title: "A synthetic evening routine", behavioral_date: "2030-01-18",
  start_date: "2030-01-07", planned_end: "2030-08-26", n_days: 232, day_number: 12, arm: "A",
  instruction: "Synthetic instruction for arm A.", first_revealed_at: "2030-01-18T11:02:03+00:00",
};

test("an active day yields the arm and instruction, and only the fields the card needs", () => {
  assert.deepEqual(L.parseExperimentToday({ ...ACTIVE, seed_hex: "ab".repeat(32), tomorrow_arm: "B", schedule: ["A", "B"] }), {
    status: "active", experimentId: "EXP-901", title: "A synthetic evening routine", behavioralDate: "2030-01-18",
    dayNumber: 12, nDays: 232, plannedEnd: "2030-08-26", arm: "A", instruction: "Synthetic instruction for arm A.",
  });
});

test("no trial, an ended trial, an upcoming one and a paused one", () => {
  assert.deepEqual(L.parseExperimentToday({ status: "none", behavioral_date: "2030-01-18" }), { status: "none" });
  assert.deepEqual(L.parseExperimentToday({ ...ACTIVE, status: "ended", arm: undefined }), { status: "none" });
  assert.deepEqual(L.parseExperimentToday({ ...ACTIVE, status: "upcoming", arm: "A" }),
    { status: "upcoming", experimentId: "EXP-901", title: "A synthetic evening routine", startDate: "2030-01-07", nDays: 232 },
    "an upcoming trial never carries an arm, even if one were sent");
  assert.deepEqual(L.parseExperimentToday({ ...ACTIVE, status: "paused" }),
    { status: "paused", experimentId: "EXP-901", title: "A synthetic evening routine" });
});

test("anything unexpected is rejected, not passed through", () => {
  const bad = [
    null, "active", [], {}, { status: "running" },
    { ...ACTIVE, arm: "C" }, { ...ACTIVE, arm: null }, { ...ACTIVE, instruction: "" }, { ...ACTIVE, instruction: "x".repeat(601) },
    { ...ACTIVE, experiment_id: "EXP-1" }, { ...ACTIVE, experiment_id: 7 }, { ...ACTIVE, title: "" },
    { ...ACTIVE, behavioral_date: "18/01/2030" }, { ...ACTIVE, day_number: 0 }, { ...ACTIVE, day_number: 233 },
    { ...ACTIVE, day_number: "12" }, { ...ACTIVE, n_days: 1.5 }, { ...ACTIVE, planned_end: null },
  ];
  for (const raw of bad) assert.throws(() => L.parseExperimentToday(raw), /invalid experiment/, JSON.stringify(raw));
});

test("the client-side shape check", () => {
  assert.ok(L.isExperimentToday({ status: "none" }));
  assert.ok(L.isExperimentToday({ status: "not_connected" }));
  assert.ok(L.isExperimentToday(L.parseExperimentToday(ACTIVE)));
  assert.ok(L.isExperimentToday(L.parseExperimentToday({ ...ACTIVE, status: "upcoming" })));
  assert.ok(L.isExperimentToday(L.parseExperimentToday({ ...ACTIVE, status: "paused" })));
  for (const v of [null, {}, { status: "active" }, { error: "x" }, { status: "active", experimentId: "EXP-901", title: "t", arm: "C", instruction: "i", dayNumber: 1, nDays: 4 },
    { status: "upcoming", experimentId: "EXP-901", title: "t" }]) assert.equal(L.isExperimentToday(v), false, JSON.stringify(v));
});

test("day labels do not shift with the time zone", () => {
  assert.equal(L.dayLabel("2030-01-18"), "Fri, Jan 18");
  assert.equal(L.dayLabel("2030-01-07"), "Mon, Jan 7");
  assert.equal(L.dayLabel("2029-12-31"), "Mon, Dec 31");
});

// --- the server loader, against a stand-in for supabase-js --------------------------------
function loadServer(answer) {
  const calls = [];
  const created = [];
  const client = {
    rpc(name, args) { calls.push(["rpc", name, args]); return Promise.resolve(answer); },
    from(table) { calls.push(["from", table]); throw new Error("the loader must not query tables"); },
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const S = loadTs("lib/experiments-server.ts", {
    "server-only": {},
    "@supabase/supabase-js": { createClient: (url, key, opts) => { created.push({ url, key, opts }); return client; } },
  });
  return { S, calls, created };
}

test("the loader calls one database function and nothing else", async () => {
  const { S, calls, created } = loadServer({ data: ACTIVE, error: null });
  const out = await S.loadExperimentToday();
  assert.equal(out.status, "active");
  assert.equal(out.arm, "A");
  assert.deepEqual(calls, [["rpc", "experiment_today", undefined]]);
  assert.equal(created[0].key, "test-service-role-key");
  assert.equal(created[0].opts.db.schema, "pds");
  assert.equal(created[0].opts.auth.persistSession, false);
});

test("a database without the SQL applied is not_connected; other failures throw without detail", async () => {
  assert.deepEqual(await loadServer({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }).S.loadExperimentToday(),
    { status: "not_connected" });
  await assert.rejects(loadServer({ data: null, error: { code: "42501", message: "permission denied for table experiment_schedule", details: "secret row" } }).S.loadExperimentToday(),
    (e) => e.message === "experiment_today failed (42501)");
  await assert.rejects(loadServer({ data: { status: "active", arm: "Z" }, error: null }).S.loadExperimentToday(), /invalid experiment/);
  assert.deepEqual(await loadServer({ data: { status: "none", behavioral_date: "2030-01-18" }, error: null }).S.loadExperimentToday(), { status: "none" });
});

// --- access rules, read from the sources ----------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("the route is GET-only, uncached and reachable with an owner session only", () => {
  const route = read("app/api/experiments/today/route.ts");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.deepEqual([...route.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"], "no POST / PATCH: a trial is never started from the app");
  const ciRoutes = /function isCiRoute[\s\S]*?\r?\n}\r?\n/.exec(read("middleware.ts"))[0];
  assert.ok(!ciRoutes.includes("experiments"), "the CI token must not reach /api/experiments/*");
  assert.ok(!/PUBLIC_MANIFEST = [^\n]*experiments/.test(read("middleware.ts")));
  const apiDir = path.join(SRC, "app", "api", "experiments");
  assert.deepEqual(fs.readdirSync(apiDir), ["today"], "the only experiment endpoint is the read-only reveal");
});

test("only the server module touches the experiment tables, and only through the reveal function", () => {
  const server = read("lib/experiments-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/\.from\(/.test(server), "no table reads: the schedule is never selected by the app");
  assert.ok(!/console\.(log|info|debug)/.test(server));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && /experiment_(schedule|secrets|days|register)|from\("experiments"\)/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], "no frontend file may name the schedule, the seed table or the register function");
  assert.ok(!read("app/today/TodayClient.tsx").includes("experiments-server"), "the client imports the pure module only");
});
