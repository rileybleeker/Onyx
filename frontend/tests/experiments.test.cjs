// Run: node --test tests/experiments.test.cjs
// The Today arm card's data path (docs/experiment-framework.md 4.3 / 4.4) and the check-in question
// "Followed today's arm?" (4.5): the parsers that gate what the browser may learn, the server loaders
// against a stand-in for supabase-js, the /status card, and the access rules (owner session only,
// database functions only, no way to start or change a trial from the app).
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

test("the routes are uncached and reachable with an owner session only", () => {
  const route = read("app/api/experiments/today/route.ts");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.deepEqual([...route.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"], "no POST / PATCH: a trial is never started from the app");
  const ciRoutes = /function isCiRoute[\s\S]*?\r?\n}\r?\n/.exec(read("middleware.ts"))[0];
  assert.ok(!ciRoutes.includes("experiments"), "the CI token must not reach /api/experiments/*");
  assert.ok(!/PUBLIC_MANIFEST = [^\n]*experiments/.test(read("middleware.ts")));
  const apiDir = path.join(SRC, "app", "api", "experiments");
  assert.deepEqual(fs.readdirSync(apiDir).sort(), ["adherence", "today"],
    "two endpoints: the read-only reveal and the check-in question; nothing starts or changes a trial");

  const adherence = read("app/api/experiments/adherence/route.ts");
  assert.match(adherence, /export const dynamic = "force-dynamic"/);
  assert.match(adherence, /"Cache-Control": "no-store"/);
  assert.deepEqual([...adherence.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET", "POST"]);
  const post = adherence.slice(adherence.indexOf("export async function POST"));
  assert.ok(post.indexOf("checkPortionRequest(") >= 0 && post.indexOf("checkPortionRequest(") < post.indexOf("req.text()"),
    "the same-origin JSON check (CSRF) runs before the body is read");
  assert.ok(post.indexOf("parseAdherenceRequest(") < post.indexOf("recordAdherence("), "the body is validated before the write");
  assert.ok(!/console\.(log|info|debug)/.test(adherence));
});

test("only the server module touches the experiment tables, and only through database functions", () => {
  const server = read("lib/experiments-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/\.from\(/.test(server), "no table reads: the schedule is never selected by the app");
  assert.ok(!/console\.(log|info|debug)/.test(server));
  assert.deepEqual([...server.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]),
    ["experiment_today", "experiment_adherence_day", "experiment_record_adherence"]);
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
  const question = read("app/check-in/ExperimentAdherence.tsx");
  assert.ok(!question.includes("experiments-server"), "the check-in question imports the pure module only");
  assert.ok(!question.includes("/api/experiments/today"), "the check-in never calls the reveal: only Today shows an arm first");
  assert.ok(!question.includes("/api/habits"), "a trial answer is never sent as a habit answer");
});

// --- the check-in question "Followed today's arm?" -------------------------------------------
const OPEN = {
  status: "open", experiment_id: "EXP-901", title: "A synthetic evening routine", behavioral_date: "2030-01-18",
  day_number: 12, n_days: 232, arm: "B", instruction: "Synthetic instruction for arm B.",
  self_report: "partly", self_report_note: "Synthetic note.", self_reported_at: "2030-01-19T02:03:04+00:00",
};

test("an open day yields the question, today's arm and the saved answer, and nothing else", () => {
  assert.deepEqual(L.parseAdherenceDay({ ...OPEN, seed_hex: "ab".repeat(32), tomorrow_arm: "A" }), {
    status: "open", experimentId: "EXP-901", title: "A synthetic evening routine", behavioralDate: "2030-01-18",
    dayNumber: 12, nDays: 232, arm: "B", instruction: "Synthetic instruction for arm B.", answer: "partly", note: "Synthetic note.",
  });
  const unanswered = L.parseAdherenceDay({ ...OPEN, self_report: null, self_report_note: null, self_reported_at: null });
  assert.equal(unanswered.answer, null);
  assert.equal(unanswered.note, null);
  assert.deepEqual(L.parseAdherenceDay({ status: "none", behavioral_date: "2030-01-18" }), { status: "none" });
  assert.deepEqual(L.parseAdherenceDay({ ...OPEN, status: "not_revealed" }),
    { status: "not_revealed", experimentId: "EXP-901", title: "A synthetic evening routine", behavioralDate: "2030-01-18" },
    "a day Today has not shown never carries an arm, even if one were sent");
});

test("an unexpected question state is rejected, not passed through", () => {
  const bad = [
    null, "open", [], {}, { status: "active" }, { ...OPEN, arm: "C" }, { ...OPEN, self_report: "maybe" },
    { ...OPEN, self_report: "Yes" }, { ...OPEN, self_report_note: 7 }, { ...OPEN, self_report_note: "x".repeat(501) },
    { ...OPEN, experiment_id: "EXP-1" }, { ...OPEN, behavioral_date: "18/01/2030" }, { ...OPEN, day_number: 233 },
    { ...OPEN, instruction: "" }, { ...OPEN, status: "not_revealed", title: "" },
  ];
  for (const raw of bad) assert.throws(() => L.parseAdherenceDay(raw), /invalid experiment/, JSON.stringify(raw));
  assert.ok(L.isAdherenceDay({ status: "none" }) && L.isAdherenceDay({ status: "not_connected" }));
  assert.ok(L.isAdherenceDay(L.parseAdherenceDay(OPEN)) && L.isAdherenceDay(L.parseAdherenceDay({ ...OPEN, status: "not_revealed" })));
  for (const v of [null, {}, { status: "open" }, { ...L.parseAdherenceDay(OPEN), answer: "maybe" }, { ...L.parseAdherenceDay(OPEN), arm: "C" }]) {
    assert.equal(L.isAdherenceDay(v), false, JSON.stringify(v));
  }
});

test("the answer request is validated before anything is sent to the database", () => {
  assert.deepEqual(L.ADHERENCE_ANSWERS, ["yes", "partly", "no"]);
  assert.deepEqual(L.parseAdherenceRequest({ answer: "yes" }), { ok: true, value: { date: null, answer: "yes", note: null } });
  assert.deepEqual(L.parseAdherenceRequest({ date: "2030-01-18", answer: "no", note: "  Synthetic.  " }),
    { ok: true, value: { date: "2030-01-18", answer: "no", note: "Synthetic." } });
  assert.deepEqual(L.parseAdherenceRequest({ answer: "partly", note: "   " }), { ok: true, value: { date: null, answer: "partly", note: null } });
  for (const body of [null, [], "yes", {}, { answer: "Yes" }, { answer: "maybe" }, { answer: "yes", date: "2030-1-18" },
    { answer: "yes", date: 20300118 }, { answer: "yes", note: 5 }, { answer: "yes", note: "x".repeat(501) }]) {
    assert.equal(L.parseAdherenceRequest(body).ok, false, JSON.stringify(body));
  }
});

test("the question loader and the answer writer each call one database function", async () => {
  const day = loadServer({ data: OPEN, error: null });
  const out = await day.S.loadAdherenceDay("2030-01-18");
  assert.equal(out.status, "open");
  assert.deepEqual(day.calls, [["rpc", "experiment_adherence_day", { p_date: "2030-01-18" }]]);
  assert.equal(day.created[0].key, "test-service-role-key");

  const write = loadServer({ data: { ...OPEN, self_report: "yes" }, error: null });
  const saved = await write.S.recordAdherence({ date: null, answer: "yes", note: null });
  assert.equal(saved.answer, "yes");
  assert.deepEqual(write.calls, [["rpc", "experiment_record_adherence", { p_date: null, p_answer: "yes", p_note: null }]]);

  assert.deepEqual(await loadServer({ data: null, error: { code: "PGRST202" } }).S.loadAdherenceDay(null), { status: "not_connected" });
  assert.deepEqual(await loadServer({ data: null, error: { code: "PGRST202" } }).S.recordAdherence({ date: null, answer: "no", note: null }),
    { status: "not_connected" });
  await assert.rejects(loadServer({ data: null, error: { code: "22023", message: "the answer must be yes, partly or no", details: "secret" } })
    .S.recordAdherence({ date: null, answer: "no", note: null }), (e) => e.message === "experiment_record_adherence failed (22023)");
});

test("the check-in shows the question only for today or yesterday, outside the Save bar", () => {
  const client = read("app/check-in/CheckInClient.tsx");
  assert.match(client, /import ExperimentAdherence from "\.\/ExperimentAdherence";/);
  assert.match(client, /!refreshFailed && \(data\.date === data\.today \|\| data\.date === addDays\(data\.today, -1\)\) && \(/);
  const save = client.slice(client.indexOf("const save = async"), client.indexOf("const goTo"));
  assert.ok(!save.includes("experiments"), "the trial answer is not part of the habit Save");
  const question = read("app/check-in/ExperimentAdherence.tsx");
  assert.match(question, /fetch\("\/api\/experiments\/adherence", \{\s*method: "POST"/);
  assert.match(question, /Followed \{whose\} arm\?/);
});

test("the /status card reads the report job's heartbeat only", () => {
  const route = read("app/api/status/route.ts");
  assert.match(route, /\["experiments", "report"\]/);
  assert.match(route, /experiments: "Daily 15:00 UTC"/);
  assert.match(route, /experiments: +\{ method: "automated", +label: "Trial report" \}/);
  assert.match(route, /ingestionHeartbeatStatus\("success", entry, 26, 30\)/);
  assert.ok(!/from\("experiment/.test(route), "no experiment table is read by the CDN-cacheable status endpoint");
  const page = read("app/status/page.tsx");
  for (const pattern of [/experiments: "N-OF-1"/, /"preprocessing",\s*"experiments",/, /experiments: "Experiments"/, /report: "Trial Report"/]) {
    assert.match(page, pattern);
  }
});
