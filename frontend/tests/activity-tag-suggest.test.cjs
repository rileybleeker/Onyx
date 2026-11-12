// Run: node --test tests/activity-tag-suggest.test.cjs
// Offline tests for the /activities tag suggestions: POST /api/activities/suggest-tags (validation, eligibility,
// caching, per-call cap, model-output validation, graceful failure) and POST /api/activities/suggest-tags/dismiss.
// The real route files are transpiled and run against an in-memory fake of the Supabase client and a mocked
// Anthropic client - no credentials, network or database. Every workout below is invented.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// The routes log failures with console.error; keep the test output readable.
const logged = [];
console.error = (...args) => { logged.push(args.join(" ")); };

const SRC = path.join(__dirname, "..", "src");
const REPO = path.join(__dirname, "..", "..");

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

// ---------------------------------------------------------------------------------------------
// In-memory stand-in for the pds-scoped supabase-js client (only what the routes call)
// ---------------------------------------------------------------------------------------------
const PK = { whoop_workouts: "workout_id", garmin_activities: "activity_id" };

function makeDb() {
  const tables = { whoop_workouts: [], garmin_activities: [], activity_tag_suggestions: [] };
  const log = { upserts: [], reads: [] };
  const state = { failRead: new Set(), failUpsert: false };

  function from(table) {
    const q = { table, filters: [], or: null, order: null, limit: null };
    const run = () => {
      log.reads.push({ table, in: q.in, or: q.or, order: q.order, limit: q.limit, cols: q.cols });
      if (state.failRead.has(table)) return { data: null, error: { message: `${table} read failed` } };
      let rows = (tables[table] ?? []).filter((r) => q.filters.every((f) => f(r)));
      if (q.or) {
        const cols = q.or.split(",").map((p) => p.replace(/\.not\.is\.null$/, ""));
        rows = rows.filter((r) => cols.some((c) => r[c] !== null && r[c] !== undefined));
      }
      if (q.order) {
        const [col, asc] = q.order;
        rows = [...rows].sort((a, b) => (Date.parse(a[col]) - Date.parse(b[col])) * (asc ? 1 : -1));
      }
      if (q.limit !== null) rows = rows.slice(0, q.limit);
      return { data: rows.map((r) => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = {
      select(cols) { q.cols = cols; return b; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return b; },
      in(c, vs) { q.in = [c, vs]; q.filters.push((r) => vs.includes(String(r[c]))); return b; },
      or(f) { q.or = f; return b; },
      order(c, o) { q.order = [c, !!(o && o.ascending)]; return b; },
      limit(n) { q.limit = n; return b; },
      upsert(rows, opts) {
        const list = Array.isArray(rows) ? rows : [rows];
        log.upserts.push({ table, rows: list, opts });
        if (state.failUpsert) return Promise.resolve({ error: { message: "upsert failed" } });
        for (const row of list) {
          const hit = tables[table].find((r) => r.source === row.source && r.activity_id === row.activity_id);
          if (hit) {
            if (!(opts && opts.ignoreDuplicates)) Object.assign(hit, row); // merge-duplicates: only the columns sent
          } else {
            tables[table].push({ split_labels: [], muscle_groups: [], confidence: null, model: null, dismissed: false, ...row });
          }
        }
        return Promise.resolve({ error: null });
      },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return b;
  }
  return { tables, log, state, client: { from } };
}

// ---------------------------------------------------------------------------------------------
// Mocked Anthropic client
// ---------------------------------------------------------------------------------------------
const model = { calls: [], plan: null, constructed: 0 };
class FakeAnthropic {
  constructor() { model.constructed++; }
  get messages() {
    return { create: async (params) => { model.calls.push(params); return model.plan(params); } };
  }
}
const reply = (obj, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });
const sessionsIn = (params) => JSON.parse(params.messages[0].content).sessions_to_tag;
const examplesIn = (params) => JSON.parse(params.messages[0].content).tagged_examples;
// Default model behaviour: a clean "push day" for every session in the batch.
const pushDay = (params) => reply({
  suggestions: sessionsIn(params).map((s) => ({ id: s.id, split_labels: ["push"], muscle_groups: ["chest", "triceps"], confidence: "medium" })),
});

let db = makeDb();
const stubs = {
  "@supabase/supabase-js": { createClient: () => ({ from: (t) => db.client.from(t) }) },
  "next/server": { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
  "@anthropic-ai/sdk": FakeAnthropic,
};
const route = loadTs("app/api/activities/suggest-tags/route.ts", stubs);
const dismissRoute = loadTs("app/api/activities/suggest-tags/dismiss/route.ts", stubs);
const lib = loadTs("lib/activity-tags.ts", stubs);

function reset() {
  db = makeDb();
  model.calls = [];
  model.constructed = 0;
  model.plan = pushDay;
}
const post = (r, body) => r.POST({ json: async () => body });
const suggest = (items) => post(route, { items });

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
let seq = 0;
function whoop(over = {}) {
  const start = over.start_time ?? daysAgo(2);
  const row = {
    workout_id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    sport_name: "weightlifting_msk",
    start_time: start,
    end_time: new Date(Date.parse(start) + 45 * 60_000).toISOString(),
    timezone_offset: "-04:00",
    strain: "10.3859",
    average_heart_rate: "121.00",
    max_heart_rate: "163.00",
    kilojoule: "982.2201",
    zone_zero_milli: null, zone_one_milli: null, zone_two_milli: null, zone_three_milli: null, zone_four_milli: null, zone_five_milli: null,
    zones: { zone_zero_milli: 60_000, zone_one_milli: 600_000, zone_two_milli: 90_000, zone_three_milli: 0, zone_four_milli: 0, zone_five_milli: 0 },
    split_labels: null, muscle_groups: null, split_label: null,
    is_sauna: false, is_excluded: false,
    ...over,
  };
  db.tables.whoop_workouts.push(row);
  return row;
}
function garmin(over = {}) {
  const start = over.start_time_gmt ?? daysAgo(3);
  const row = {
    activity_id: 9_000_000_000 + ++seq,
    activity_type: "strength_training",
    activity_name: "Upper Body",
    start_time_gmt: start,
    start_time_local: new Date(Date.parse(start) - 4 * 3600_000).toISOString(),
    duration_seconds: 3000, avg_heart_rate: 110, max_heart_rate: 150, calories: 300,
    training_load: 55.2, aerobic_training_effect: 2.1, anaerobic_training_effect: 0.4, total_sets: 18, total_reps: 160,
    split_labels: null, muscle_groups: null, split_label: null, is_sauna: false, is_excluded: false,
    ...over,
  };
  db.tables.garmin_activities.push(row);
  return row;
}
const tagged = (start, split, muscles) => whoop({ start_time: start, split_labels: split, muscle_groups: muscles, split_label: split[0] ?? null });
const w = (row) => ({ source: "whoop", id: row.workout_id });
const g = (row) => ({ source: "garmin", id: String(row.activity_id) });

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------
test("rejects bad bodies with a 400 and never touches the database or the model", async () => {
  reset();
  const bad = [
    null, {}, { items: "x" }, { items: [] },
    { items: [{ source: "strava", id: "1" }] },
    { items: [{ source: "garmin", id: "12abc" }] },
    { items: [{ source: "garmin", id: "1; drop table x" }] },
    { items: [{ source: "whoop", id: "a,b" }] },
    { items: [{ source: "whoop", id: "" }] },
    { items: [{ source: "whoop" }] },
    { items: [null] },
    { items: [{ source: "whoop", id: { $ne: 1 } }] },
  ];
  for (const body of bad) {
    const res = await post(route, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  const res = await route.POST({ json: async () => { throw new Error("not json"); } });
  assert.equal(res.status, 400);
  assert.equal(db.log.reads.length, 0);
  assert.equal(model.calls.length, 0);
});

test("the per-call cap is enforced before any read: 11 items is a 400", async () => {
  reset();
  const rows = Array.from({ length: 11 }, () => whoop());
  const res = await suggest(rows.map(w));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at most 10/);
  assert.equal(db.log.reads.length, 0);
  assert.equal(model.calls.length, 0);
});

test("exactly 10 eligible items make ONE model call carrying 10 sessions", async () => {
  reset();
  const rows = Array.from({ length: 10 }, (_, i) => whoop({ start_time: daysAgo(1 + i) }));
  const res = await suggest(rows.map(w));
  assert.equal(res.status, 200);
  assert.equal(model.calls.length, 1);
  assert.equal(sessionsIn(model.calls[0]).length, 10);
  assert.equal(res.body.suggestions.length, 10);
  assert.equal(res.body.generated, 10);
  assert.equal(db.tables.activity_tag_suggestions.length, 10);
});

test("duplicate items in one request count once", async () => {
  reset();
  const row = whoop();
  const res = await suggest([w(row), w(row), w(row)]);
  assert.equal(res.status, 200);
  assert.equal(sessionsIn(model.calls[0]).length, 1);
  assert.equal(res.body.suggestions.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The happy path: what is sent, what comes back, what is cached
// ---------------------------------------------------------------------------------------------
test("suggests for an untagged WHOOP lift: model request shape, response, cache row", async () => {
  reset();
  const row = whoop();
  const res = await suggest([w(row)]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    suggestions: [{ source: "whoop", id: row.workout_id, split_labels: ["push"], muscle_groups: ["chest", "triceps"], confidence: "medium" }],
    generated: 1, rejected: 0, failed: false,
  });

  assert.equal(model.calls.length, 1);
  const call = model.calls[0];
  assert.equal(call.model, "claude-sonnet-5-5");
  assert.equal(call.output_config.effort, "low");
  assert.equal(call.output_config.format.type, "json_schema");
  const item = call.output_config.format.schema.properties.suggestions.items;
  assert.deepEqual(item.properties.split_labels.items.enum, ["leg", "pull", "push"]);
  assert.deepEqual(item.properties.muscle_groups.items.enum, lib.MUSCLE_GROUPS);
  assert.equal(item.additionalProperties, false);
  assert.ok(!("temperature" in call) && !("top_p" in call) && !("top_k" in call));
  assert.ok(call.max_tokens > 0);

  // What the model is told about the session: facts only, no ids from the database, nothing identifying.
  const [s] = sessionsIn(call);
  const local = new Date(Date.parse(row.start_time) - 4 * 3600_000);
  assert.equal(s.id, 0);
  assert.equal(s.device, "whoop");
  assert.equal(s.activity, "weightlifting_msk");
  assert.equal(s.weekday, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()]);
  assert.equal(s.local_time, local.toISOString().slice(11, 16));
  assert.equal(s.duration_min, 45);
  assert.equal(s.strain, 10.4);
  assert.equal(s.avg_hr, 121);
  assert.equal(s.max_hr, 163);
  assert.equal(s.kcal, 235);
  assert.deepEqual(s.hr_zone_minutes, { zone0: 1, zone1: 10, zone2: 1.5, zone3: 0, zone4: 0, zone5: 0 });
  assert.ok(!JSON.stringify(call).includes(row.workout_id), "the workout id is not sent to the model");

  const cached = db.tables.activity_tag_suggestions;
  assert.equal(cached.length, 1);
  assert.deepEqual(
    { ...cached[0], created_at: undefined },
    { source: "whoop", activity_id: row.workout_id, split_labels: ["push"], muscle_groups: ["chest", "triceps"],
      confidence: "medium", model: "claude-sonnet-5-5", dismissed: false, created_at: undefined },
  );
  // The server never writes tags to the activity row itself.
  assert.equal(db.log.upserts.every((u) => u.table === "activity_tag_suggestions"), true);
  assert.equal(row.split_labels, null);
  assert.equal(row.muscle_groups, null);
});

test("a Garmin strength activity is suggested for too, with its own facts", async () => {
  reset();
  const row = garmin();
  const res = await suggest([g(row)]);
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestions.length, 1);
  const [s] = sessionsIn(model.calls[0]);
  assert.equal(s.device, "garmin");
  assert.equal(s.activity, "strength_training");
  assert.equal(s.title, "Upper Body");
  assert.equal(s.duration_min, 50);
  assert.equal(s.sets, 18);
  assert.equal(s.training_load, 55.2);
  assert.equal(db.tables.activity_tag_suggestions[0].source, "garmin");
  assert.equal(db.tables.activity_tag_suggestions[0].activity_id, String(row.activity_id));
});

test("the model sees the newest 15 tagged strength sessions, newest first, as examples", async () => {
  reset();
  const target = whoop();
  // 20 tagged sessions at 40..59 days ago (outside the suggestion window on purpose: examples have no window)
  const taggedRows = Array.from({ length: 20 }, (_, i) => tagged(daysAgo(40 + i), ["leg"], ["quads", "glutes"]));
  tagged(daysAgo(10), ["push", "pull"], ["chest", "back", "shoulders"]); // newest tagged one
  garmin({ start_time_gmt: daysAgo(12), split_labels: ["pull"], muscle_groups: ["back", "biceps"], split_label: "pull" });
  whoop({ start_time: daysAgo(5), split_labels: ["push"], is_excluded: true });                  // excluded: not an example
  whoop({ start_time: daysAgo(6) });                                                              // untagged: not an example
  whoop({ start_time: daysAgo(7), sport_name: "yoga", split_labels: ["leg"] });                   // not strength: not an example
  void taggedRows;

  await suggest([w(target)]);
  const ex = examplesIn(model.calls[0]);
  assert.equal(ex.length, 15);
  assert.deepEqual(ex[0].split_labels, ["push", "pull"]);   // 10 days ago
  assert.equal(ex[1].device, "garmin");                      // 12 days ago
  assert.deepEqual(ex[1].muscle_groups, ["back", "biceps"]);
  assert.ok(ex.slice(2).every((e) => JSON.stringify(e.split_labels) === '["leg"]'));
  assert.ok(ex.every((e) => e.activity !== "yoga"));
  // The example queries ask for tagged, non-excluded rows only, newest first, capped at 15.
  const exampleReads = db.log.reads.filter((r) => r.or);
  assert.equal(exampleReads.length, 2);
  assert.ok(exampleReads.every((r) => r.limit === 15 && r.order[1] === false));
});

test("WHOOP zone minutes come from raw_json when the typed columns are empty, and typed columns win when present", async () => {
  reset();
  const a = whoop({ zones: null });
  const b = whoop({ zone_one_milli: 1_200_000, zones: { zone_one_milli: 1 } });
  await suggest([w(a), w(b)]);
  const [sa, sb] = sessionsIn(model.calls[0]);
  assert.equal(sa.hr_zone_minutes, undefined, "no zone data -> field left out");
  assert.equal(sb.hr_zone_minutes.zone1, 20);
  // the select asks for the one nested sub-object, never the whole raw_json blob
  const cols = db.log.reads.find((r) => r.table === "whoop_workouts").cols;
  assert.match(cols, /zones:raw_json->score->zone_durations/);
  assert.ok(!/(^|,)raw_json(,|$)/.test(cols));
});

// ---------------------------------------------------------------------------------------------
// Eligibility: the server decides, not the client
// ---------------------------------------------------------------------------------------------
test("rows that already have tags, are excluded, are too old, are not strength, or do not exist cost nothing", async () => {
  reset();
  const rows = [
    whoop({ split_labels: ["leg"] }),
    whoop({ muscle_groups: ["core"] }),
    whoop({ split_label: "push" }),                       // legacy single label only
    whoop({ is_excluded: true }),
    whoop({ start_time: daysAgo(31) }),                    // outside the 30-day window
    whoop({ sport_name: "yoga" }),
    whoop({ sport_name: "running" }),
    whoop({ is_sauna: true }),
    garmin({ activity_type: "running", activity_name: "Easy run" }),
  ];
  const res = await suggest([...rows.map((r) => (r.workout_id ? w(r) : g(r))), { source: "whoop", id: "does-not-exist" }, { source: "garmin", id: "424242" }]
    .slice(0, 10));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.suggestions, []);
  assert.equal(model.calls.length, 0);
  assert.equal(model.constructed, 0);
  assert.equal(db.tables.activity_tag_suggestions.length, 0);
});

test("a session just inside the 30-day window is eligible", async () => {
  reset();
  const row = whoop({ start_time: daysAgo(29.5) });
  const res = await suggest([w(row)]);
  assert.equal(res.body.suggestions.length, 1);
});

test("the strength rule matches the page's: 'weightlifting' and a Garmin 'Strength' title count, 'functional-fitness' does not", async () => {
  reset();
  const lift = whoop({ sport_name: "weightlifting" });
  const ff = whoop({ sport_name: "functional-fitness" });
  const named = garmin({ activity_type: "other", activity_name: "Morning Strength" });
  const res = await suggest([w(lift), w(ff), g(named)]);
  assert.deepEqual(res.body.suggestions.map((s) => s.id).sort(), [lift.workout_id, String(named.activity_id)].sort());
});

// ---------------------------------------------------------------------------------------------
// Caching: never pay twice
// ---------------------------------------------------------------------------------------------
test("a second request for the same row is answered from the cache with no model call", async () => {
  reset();
  const row = whoop();
  const first = await suggest([w(row)]);
  assert.equal(model.calls.length, 1);
  const second = await suggest([w(row)]);
  assert.equal(model.calls.length, 1, "no second model call");
  assert.equal(second.body.generated, 0);
  assert.deepEqual(second.body.suggestions, first.body.suggestions);
});

test("a mixed batch only sends the uncached rows to the model", async () => {
  reset();
  const a = whoop();
  const b = whoop();
  await suggest([w(a)]);
  model.calls = [];
  const res = await suggest([w(a), w(b)]);
  assert.equal(model.calls.length, 1);
  assert.equal(sessionsIn(model.calls[0]).length, 1);
  assert.equal(res.body.suggestions.length, 2);
});

test("a dismissed suggestion is neither returned nor re-requested", async () => {
  reset();
  const row = whoop();
  await suggest([w(row)]);
  await post(dismissRoute, w(row));
  model.calls = [];
  const res = await suggest([w(row)]);
  assert.deepEqual(res.body.suggestions, []);
  assert.equal(model.calls.length, 0);
});

test("a cache read failure stops the call BEFORE any model spend", async () => {
  reset();
  const row = whoop();
  db.state.failRead.add("activity_tag_suggestions");
  const res = await suggest([w(row)]);
  assert.equal(res.status, 500);
  assert.equal(model.calls.length, 0);
  assert.equal(model.constructed, 0);
});

test("the cache write ignores duplicates, so a racing call can never revive a dismissed row", async () => {
  reset();
  const row = whoop();
  await suggest([w(row)]);
  const up = db.log.upserts.find((u) => u.table === "activity_tag_suggestions");
  assert.equal(up.opts.onConflict, "source,activity_id");
  assert.equal(up.opts.ignoreDuplicates, true);
});

test("if the cache write fails the suggestion is still returned (the page just shows it)", async () => {
  reset();
  const row = whoop();
  db.state.failUpsert = true;
  const res = await suggest([w(row)]);
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestions.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Model output is untrusted
// ---------------------------------------------------------------------------------------------
async function withPlan(plan, items) {
  reset();
  const rows = items.map(() => whoop());
  model.plan = plan;
  const res = await suggest(rows.map(w));
  return { res, rows };
}

test("values outside the canonical sets are stripped; what is left is cached", async () => {
  const { res, rows } = await withPlan(
    () => reply({ suggestions: [{ id: 0, split_labels: ["push", "Legs", "PULL", "push", 7, null], muscle_groups: ["Chest", "pecs", "triceps", "chest", {}], confidence: "high" }] }),
    [0],
  );
  assert.deepEqual(res.body.suggestions, [{ source: "whoop", id: rows[0].workout_id, split_labels: ["push", "pull"], muscle_groups: ["chest", "triceps"], confidence: "high" }]);
  assert.deepEqual(db.tables.activity_tag_suggestions[0].split_labels, ["push", "pull"]);
  assert.deepEqual(db.tables.activity_tag_suggestions[0].muscle_groups, ["chest", "triceps"]);
});

test("an unknown confidence becomes 'low' rather than being trusted", async () => {
  const { res } = await withPlan(
    () => reply({ suggestions: [{ id: 0, split_labels: ["leg"], muscle_groups: [], confidence: "certain" }] }),
    [0],
  );
  assert.equal(res.body.suggestions[0].confidence, "low");
});

test("items that are not usable are rejected one by one, the good ones survive", async () => {
  const good = { split_labels: ["pull"], muscle_groups: ["back"], confidence: "low" };
  const { res, rows } = await withPlan(
    () => reply({ suggestions: [
      { id: 0, ...good },
      { id: 0, ...good, split_labels: ["leg"] },                                        // repeated id
      { id: 7, ...good },                                                               // id not in the batch
      { id: -1, ...good },
      { id: 1.5, ...good },
      { id: "1", ...good },
      { id: 1, split_labels: "push", muscle_groups: [], confidence: "low" },            // not an array
      { id: 1, split_labels: ["push"], muscle_groups: null, confidence: "low" },        // not an array
      { id: 2, split_labels: ["Legs"], muscle_groups: ["pecs"], confidence: "low" },    // nothing valid left
      "nonsense", null,
    ] }),
    [0, 1, 2],
  );
  assert.deepEqual(res.body.suggestions.map((s) => s.id), [rows[0].workout_id]);
  assert.equal(res.body.generated, 1);
  assert.equal(res.body.rejected, 10);
  assert.equal(res.body.failed, false);
  assert.equal(db.tables.activity_tag_suggestions.length, 1, "rejected rows are not cached, so they are retried later");
});

test("whole-payload failures degrade to no suggestion: HTTP 200, nothing cached, failed flag set", async () => {
  const plans = {
    "not json": () => reply("I think it was a push day"),
    "wrong shape": () => reply({ items: [] }),
    "suggestions not a list": () => reply({ suggestions: { id: 0 } }),
    "empty list": () => reply({ suggestions: [] }),
    "everything invalid": () => reply({ suggestions: [{ id: 0, split_labels: ["x"], muscle_groups: ["y"], confidence: "high" }] }),
    "truncated": () => reply('{"suggestions":[{"id":0,', "max_tokens"),
    "refusal": () => ({ stop_reason: "refusal", content: [] }),
    "no text block": () => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] }),
    "network error": () => { throw new Error("socket hang up"); },
  };
  for (const [name, plan] of Object.entries(plans)) {
    const { res } = await withPlan(plan, [0]);
    assert.equal(res.status, 200, name);
    assert.deepEqual(res.body.suggestions, [], name);
    assert.equal(res.body.failed, true, name);
    assert.equal(res.body.generated, 0, name);
    assert.equal(db.tables.activity_tag_suggestions.length, 0, `${name}: nothing cached`);
    assert.equal(model.calls.length, 1, `${name}: exactly one attempt per request`);
  }
});

test("a model failure still returns the suggestions that were already cached", async () => {
  reset();
  const cachedRow = whoop();
  await suggest([w(cachedRow)]);
  const fresh = whoop();
  model.plan = () => { throw new Error("overloaded"); };
  const res = await suggest([w(cachedRow), w(fresh)]);
  assert.equal(res.status, 200);
  assert.equal(res.body.failed, true);
  assert.deepEqual(res.body.suggestions.map((s) => s.id), [cachedRow.workout_id]);
});

test("a failure to read the examples degrades the same way (no model call)", async () => {
  reset();
  const row = whoop();
  // examples read whoop_workouts with .or(); fail only that one by failing after the first read
  let reads = 0;
  const original = db.client.from;
  db.client.from = (t) => {
    const b = original(t);
    const origOr = b.or;
    b.or = (f) => { reads++; db.state.failRead.add(t); return origOr(f); };
    return b;
  };
  const res = await suggest([w(row)]);
  assert.ok(reads > 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.failed, true);
  assert.equal(model.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Dismiss route
// ---------------------------------------------------------------------------------------------
test("dismiss validates its body", async () => {
  reset();
  for (const body of [null, {}, { source: "x", id: "1" }, { source: "garmin", id: "abc" }, { source: "whoop", id: "a b" }]) {
    assert.equal((await post(dismissRoute, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await dismissRoute.POST({ json: async () => { throw new Error("x"); } })).status, 400);
  assert.equal(db.log.upserts.length, 0);
});

test("dismiss flips only the dismissed flag and keeps the cached tags", async () => {
  reset();
  const row = whoop();
  await suggest([w(row)]);
  const res = await post(dismissRoute, w(row));
  assert.equal(res.status, 200);
  const up = db.log.upserts[db.log.upserts.length - 1];
  assert.deepEqual(up.rows, [{ source: "whoop", activity_id: row.workout_id, dismissed: true }]);
  assert.equal(up.opts.onConflict, "source,activity_id");
  assert.ok(!up.opts.ignoreDuplicates);
  const stored = db.tables.activity_tag_suggestions[0];
  assert.equal(stored.dismissed, true);
  assert.deepEqual(stored.split_labels, ["push"]);
  assert.equal(stored.model, "claude-sonnet-5-5");
  // idempotent
  assert.equal((await post(dismissRoute, w(row))).status, 200);
  assert.equal(db.tables.activity_tag_suggestions.length, 1);
});

test("dismissing an activity that has no cache row stores a tombstone so it is not suggested later", async () => {
  reset();
  const row = whoop();
  assert.equal((await post(dismissRoute, w(row))).status, 200);
  assert.equal(db.tables.activity_tag_suggestions.length, 1);
  assert.equal(db.tables.activity_tag_suggestions[0].dismissed, true);
  const res = await suggest([w(row)]);
  assert.deepEqual(res.body.suggestions, []);
  assert.equal(model.calls.length, 0);
});

test("dismiss reports a database failure as a 500", async () => {
  reset();
  db.state.failUpsert = true;
  assert.equal((await post(dismissRoute, w(whoop()))).status, 500);
});

// ---------------------------------------------------------------------------------------------
// Guards against drift
// ---------------------------------------------------------------------------------------------
function quoted(text) { return [...text.matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]); }

test("the tag vocabulary is the same in the shared lib, /api/activities/categorize and the SQL CHECK constraints", () => {
  const categorize = fs.readFileSync(path.join(SRC, "app/api/activities/categorize/route.ts"), "utf8");
  const splits = quoted(/ALLOWED_SPLITS = new Set\(\[([\s\S]*?)\]\)/.exec(categorize)[1]);
  const muscles = quoted(/ALLOWED_MUSCLES = new Set\(\[([\s\S]*?)\]\)/.exec(categorize)[1]);
  assert.deepEqual([...lib.SPLIT_LABELS], splits);
  assert.deepEqual([...lib.MUSCLE_GROUPS], muscles);
  const sql = fs.readFileSync(path.join(REPO, "sql", "activity_muscle_groups.sql"), "utf8");
  assert.deepEqual(quoted(/split_labels <@ ARRAY\[([\s\S]*?)\]/.exec(sql)[1]), splits);
  assert.deepEqual(quoted(/muscle_groups <@ ARRAY\[([\s\S]*?)\]/.exec(sql)[1]), muscles);
});

test("category rule parity with the page", () => {
  const cat = lib.deriveActivityCategory;
  assert.equal(cat("weightlifting msk", "weightlifting_msk", false), "strength");
  assert.equal(cat("weightlifting", "weightlifting", false), "strength");
  assert.equal(cat("strength_training", "Upper Body", false), "strength");
  assert.equal(cat("running", "Easy run", false), "run");
  assert.equal(cat("treadmill_running", "x", false), "run");
  assert.equal(cat("sauna", "sauna", false), "sauna");
  assert.equal(cat("weightlifting msk", "weightlifting_msk", true), "sauna");   // manual sauna flag wins
  assert.equal(cat("yoga", "yoga", false), "other");
  assert.equal(cat("functional fitness", "functional-fitness", false), "other");
  const client = fs.readFileSync(path.join(SRC, "app/activities/ActivitiesClient.tsx"), "utf8");
  assert.match(client, /from "@\/lib\/activity-tags"/);
  assert.ok(!client.includes("weightlift|strength"), "the page must use the shared rule, not its own copy");
});

test("keepCanonical and parseActivityTarget", () => {
  assert.equal(lib.keepCanonical("push", lib.SPLIT_LABELS), null);
  assert.deepEqual(lib.keepCanonical([" Push ", "legs", 3, "push", "leg"], lib.SPLIT_LABELS), ["push", "leg"]);
  assert.deepEqual(lib.parseActivityTarget({ source: "garmin", id: 12345 }), { source: "garmin", id: "12345" });
  assert.equal(lib.parseActivityTarget({ source: "garmin", id: 1.5 }), null);
  assert.deepEqual(lib.parseActivityTarget({ source: "whoop", id: "3adf5128-6436-4c4c-a5dd-57b865ce5552" }), { source: "whoop", id: "3adf5128-6436-4c4c-a5dd-57b865ce5552" });
});

test("suggestions stay out of the ISR prefetch; the SQL file is additive only", () => {
  for (const f of ["page.tsx", "ActivitiesLoader.tsx"]) {
    const text = fs.readFileSync(path.join(SRC, "app/activities", f), "utf8");
    assert.ok(!/suggest/i.test(text), `${f} must not mention suggestions`);
  }
  const sql = fs.readFileSync(path.join(REPO, "sql", "activity_tag_suggestions.sql"), "utf8");
  assert.ok(!/drop/i.test(sql), "no DROP anywhere in the migration, comments included");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON pds\.activity_tag_suggestions FROM anon, authenticated/);
  assert.match(sql, /PRIMARY KEY \(source, activity_id\)/);
});

test("the route is not on the middleware's token carve-out list (session auth only)", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes("suggest-tags"));
});
