// Run: node --test tests/model-routing.test.cjs
// Model routing (OPS-MODEL-01, 2026-11-16). Three routes keep their baseline model and effort and
// can try a cheaper candidate only inside the bounded pilot in lib/model-routing.ts; the four
// structured-output routes that were already Sonnet at effort low stay pinned to it. Reads source
// files and runs the pure routing functions only: no network, no database, no model call.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC, loadTs } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const R = loadTs("lib/model-routing.ts");

// Every messages.create call in the file, with the text between its "(" and the matching ")".
function createCalls(src) {
  const calls = [];
  let i = src.indexOf("messages.create(");
  while (i !== -1) {
    let depth = 0;
    let j = src.indexOf("(", i);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(start, j + 1));
    i = src.indexOf("messages.create(", j);
  }
  return calls;
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const on = (extra = {}) =>
  R.parsePilot({ ONYX_MODEL_PILOT: "delivery_estimate,playlist,supplement_photo", ONYX_MODEL_PILOT_UNTIL: "2026-11-30", ...extra }, NOW);

// --- baseline is the production configuration from before OPS-MODEL-01 --------------------------

test("baseline keeps the pre-pilot model and effort for each routed task", () => {
  assert.deepEqual({ ...R.BASELINE.delivery_estimate }, { model: "claude-opus-5-5", effort: "low" });
  assert.deepEqual({ ...R.BASELINE.playlist }, { model: "claude-sonnet-5-5" });
  assert.deepEqual({ ...R.BASELINE.supplement_photo }, { model: "claude-sonnet-5-5" });
});

test("no pilot configured: every call gets the baseline", () => {
  for (const env of [{}, { ONYX_MODEL_PILOT: "" }, { ONYX_MODEL_PILOT: "delivery_estimate" }]) {
    const pilot = R.parsePilot(env, NOW);
    assert.equal(pilot, null);
    for (const task of R.ROUTED_TASKS) {
      for (let k = 0; k < 50; k++) {
        const c = R.chooseModel(task, `unit-${k}`, pilot, NOW);
        assert.equal(c.arm, "baseline");
        assert.equal(c.model, R.BASELINE[task].model);
        assert.equal(c.effort, R.BASELINE[task].effort);
      }
    }
  }
});

// --- the pilot is bounded ----------------------------------------------------------------------

test("the pilot turns itself off: no end date, a bad date, a past date or one too far ahead", () => {
  const t = { ONYX_MODEL_PILOT: "playlist" };
  assert.equal(R.parsePilot({ ...t, ONYX_MODEL_PILOT_UNTIL: "next week" }, NOW), null);
  assert.equal(R.parsePilot({ ...t, ONYX_MODEL_PILOT_UNTIL: "2026-11-15" }, NOW), null);
  assert.ok(R.parsePilot({ ...t, ONYX_MODEL_PILOT_UNTIL: "2026-11-16" }, NOW), "today still runs");
  assert.ok(R.parsePilot({ ...t, ONYX_MODEL_PILOT_UNTIL: "2026-12-07" }, NOW), "21 days ahead is allowed");
  assert.equal(R.parsePilot({ ...t, ONYX_MODEL_PILOT_UNTIL: "2026-12-09" }, NOW), null, "past the 21-day cap");
});

test("the pilot ends at the end of its last day even when the config stays set", () => {
  const pilot = on({ ONYX_MODEL_PILOT_UNTIL: "2026-11-16" });
  const later = Date.parse("2026-11-17T00:00:00Z");
  for (let k = 0; k < 200; k++) assert.equal(R.chooseModel("playlist", `u${k}`, pilot, later).arm, "baseline");
});

test("unknown task names are ignored and the share is capped at one half", () => {
  assert.equal(R.parsePilot({ ONYX_MODEL_PILOT: "chat,everything", ONYX_MODEL_PILOT_UNTIL: "2026-11-30" }, NOW), null);
  assert.equal(on({ ONYX_MODEL_PILOT_SHARE: "1" }).share, R.PILOT_MAX_SHARE);
  assert.equal(on({ ONYX_MODEL_PILOT_SHARE: "0" }), null);
  assert.equal(on({ ONYX_MODEL_PILOT_SHARE: "abc" }), null);
  assert.equal(on({ ONYX_MODEL_PILOT_SHARE: "0.2" }).share, 0.2);
});

test("pilot on: roughly the share goes to the candidate, the rest stays on the baseline, and a unit never switches arms", () => {
  const pilot = on({ ONYX_MODEL_PILOT_SHARE: "0.3" });
  let candidate = 0;
  const N = 2000;
  for (let k = 0; k < N; k++) {
    const a = R.chooseModel("delivery_estimate", `dish-${k}`, pilot, NOW);
    const b = R.chooseModel("delivery_estimate", `dish-${k}`, pilot, NOW + DAY);
    assert.equal(a.arm, b.arm, "deterministic per unit");
    const want = a.arm === "pilot" ? R.CANDIDATE.delivery_estimate : R.BASELINE.delivery_estimate;
    assert.equal(a.model, want.model);
    if (a.arm === "pilot") candidate++;
  }
  assert.ok(candidate / N > 0.25 && candidate / N < 0.35, `share ${candidate / N}`);
});

test("a task left out of the pilot stays on the baseline", () => {
  const pilot = R.parsePilot({ ONYX_MODEL_PILOT: "playlist", ONYX_MODEL_PILOT_UNTIL: "2026-11-30" }, NOW);
  for (let k = 0; k < 200; k++) assert.equal(R.chooseModel("delivery_estimate", `d${k}`, pilot, NOW).arm, "baseline");
});

// --- observations carry counts only, and only during a pilot ------------------------------------

test("observations: none outside a pilot, attempted calls counted apart from answered ones, tokens summed", () => {
  const choice = R.chooseModel("playlist", "x", null, NOW);
  assert.equal(R.pilotObservation("playlist", choice, null, { usage: [], latencyMs: 1, ok: true, calls: 1 }), null);
  const pilot = on();
  const line = R.pilotObservation("playlist", choice, pilot, {
    usage: [
      { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      { input_tokens: 150, output_tokens: 30, cache_creation_input_tokens: 10 },
    ],
    latencyMs: 1234.4,
    ok: true,
    calls: 3,
  });
  assert.deepEqual(line, {
    event: "model_pilot", task: "playlist", arm: "baseline", model: "claude-sonnet-5-5", effort: "default",
    ok: true, calls: 3, answered: 2, unpriced: 1, units: 1, accepted: 1, latency_ms: 1234,
    input_tokens: 250, output_tokens: 50, cache_read_tokens: 50, cache_write_tokens: 10,
  });
  for (const v of Object.values(line)) assert.ok(["string", "number", "boolean"].includes(typeof v));
});

test("effortConfig sends no effort when the API default applies", () => {
  assert.deepEqual({ ...R.effortConfig({ model: "m" }) }, {});
  assert.deepEqual({ ...R.effortConfig({ model: "m", effort: "low" }) }, { effort: "low" });
});

// --- the three routes go through the router ----------------------------------------------------

const ROUTED = {
  "app/api/delivery/items/import/route.ts": "delivery_estimate",
  "app/api/spotify/generate-playlist/route.ts": "playlist",
  "app/api/supplements/extract-from-photo/route.ts": "supplement_photo",
};

for (const [rel, task] of Object.entries(ROUTED)) {
  test(`${rel}: model and effort come from chooseModel("${task}"), no hard-coded model id`, () => {
    const src = read(rel);
    assert.match(src, new RegExp(`chooseModel\\("${task}"`));
    assert.equal(/claude-(opus|sonnet|haiku|fable)/.test(src), false, "no model id in the route");
    assert.equal(/effort: "(low|medium|high)"/.test(src), false, "no hard-coded effort");
    const calls = createCalls(src);
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.match(c, /model: choice\.model\b/);
    assert.match(src, /pilotObservation\(/);
  });
}

test("dish batches hold one arm, and the observation is written after the estimates are stored", () => {
  const src = read("app/api/delivery/items/import/route.ts");
  assert.match(src, /selectEstimateBatch\(data \?\? \[\], from, n, armOf, only\)/);
  const save = src.indexOf(".upsert(rows, { onConflict: \"est_key\"");
  const accepted = src.indexOf("observe(rows.length)");
  assert.ok(save > 0 && accepted > save, "accepted count logged only after the upsert");
  assert.match(src, /if \(upErr\) \{\s*observe\(0\);/);
});

test("playlist and label requests count attempted calls before each create, observed once", () => {
  const pl = read("app/api/spotify/generate-playlist/route.ts");
  // One create, inside callWithCountedRetries, which counts every attempt (retries included).
  assert.equal(createCalls(pl).length, 1);
  assert.match(pl, /callWithCountedRetries\(\s*\(\) =>\s*anthropic\.messages\.create\(/);
  assert.match(pl, /onAttempt: \(\) => \{\s*attempts\+\+;/);
  assert.match(pl, /if \(observed\) return;/);
  const ph = read("app/api/supplements/extract-from-photo/route.ts");
  assert.match(ph, /attempts = 1;\s*const resp = await anthropic\.messages\.create\(/);
  for (const src of [pl, ph]) assert.match(src, /calls: attempts/);
});

test("dish estimates record the model of the arm that made them", () => {
  assert.match(read("app/api/delivery/items/import/route.ts"), /model: choice\.model,\n\s+\}\);/);
});

test("the label reader returns its model so the saved product records it", () => {
  assert.match(read("app/api/supplements/extract-from-photo/route.ts"), /model: choice\.model,/);
  assert.match(read("components/CustomSupplementFlow.tsx"), /json\.model/);
});

// --- routes already on Sonnet at effort low stay there -------------------------------------------

const PINNED = [
  "app/api/habits/checkin/voice/route.ts",
  "app/api/log/voice/route.ts",
  "app/api/activities/suggest-tags/route.ts",
  "lib/journal-file-server.ts",
];

for (const rel of PINNED) {
  test(`${rel}: Sonnet 5.5, every call at effort low`, () => {
    const src = read(rel);
    assert.match(src, /const MODEL = "claude-sonnet-5-5";/);
    assert.equal(/claude-opus|claude-fable/.test(src), false);
    const calls = createCalls(src);
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.match(c, /model: MODEL\b/);
      assert.match(c, /effort: "low"/);
    }
  });
}

// --- sanitized comparison fixtures ---------------------------------------------------------------

test("the pilot's comparison fixtures exist for every routed task and look synthetic", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "model-routing-pilot.json"), "utf8"));
  for (const task of R.ROUTED_TASKS) {
    assert.ok(Array.isArray(fx[task]?.cases) && fx[task].cases.length >= 5, task);
    assert.equal(typeof fx[task].pass_rule, "string");
    assert.ok(R.PILOT_CRITERIA[task], `criteria for ${task}`);
  }
  for (const c of fx.delivery_estimate.cases) {
    assert.match(c.store, /^Generic /, "generic store names only");
    assert.ok(c.kcal_min <= c.kcal_max);
  }
  assert.equal(/@|https?:\/\//.test(JSON.stringify(fx)), false, "no addresses or links");
});

// --- behavioral: batches, retries, deadline, label acceptance -------------------------------------

const LABEL = loadTs("lib/label-extract.ts");

function dishes(n) {
  return Array.from({ length: n }, (_, k) => ({ est_key: `dish-${k}` }));
}

test("a batch holds only the first dish's arm; the rest stay queued", () => {
  const pilot = on({ ONYX_MODEL_PILOT_SHARE: "0.5" });
  const rows = dishes(60);
  const armOf = (r) => R.chooseModel("delivery_estimate", r.est_key, pilot, NOW).arm;
  const b = R.selectEstimateBatch(rows, 0, 25, armOf);
  assert.ok(b.todo.length >= 1);
  assert.ok(b.todo.every((r) => armOf(r) === b.arm));
  assert.equal(b.todo[0], rows[0]);
  assert.equal(b.armOffset, 0);
});

test("a retry after a failed batch calls only that arm's dishes, never the other arm's", () => {
  const pilot = on({ ONYX_MODEL_PILOT_SHARE: "0.5" });
  const rows = dishes(80);
  const armOf = (r) => R.chooseModel("delivery_estimate", r.est_key, pilot, NOW).arm;
  const failed = R.selectEstimateBatch(rows, 0, 25, armOf);
  const members = new Set(failed.todo);
  // the harvester's one-dish retries: offset 0..n-1 within the failed arm, each limit 1
  const retried = [];
  for (let k = 0; k < failed.todo.length; k++) {
    const one = R.selectEstimateBatch(rows, failed.armOffset + k, 1, armOf, failed.arm);
    assert.equal(one.todo.length, 1);
    assert.equal(one.arm, failed.arm);
    retried.push(one.todo[0]);
  }
  for (const r of retried) assert.equal(armOf(r), failed.arm, "no other-arm dish retried");
  assert.deepEqual(retried, failed.todo, "the retries walk exactly the failed batch");
  assert.ok(members.size === retried.length);
});

test("armOffset counts same-arm dishes before a batch that starts after stepped-past dishes", () => {
  const pilot = on({ ONYX_MODEL_PILOT_SHARE: "0.5" });
  const rows = dishes(80);
  const armOf = (r) => R.chooseModel("delivery_estimate", r.est_key, pilot, NOW).arm;
  const b = R.selectEstimateBatch(rows, 7, 25, armOf);
  const again = R.selectEstimateBatch(rows, b.armOffset, 1, armOf, b.arm);
  assert.equal(again.todo[0], rows[7]);
  assert.equal(R.selectEstimateBatch(rows, 0, 1, armOf, "pilot") && true, true);
  assert.equal(R.selectEstimateBatch(rows.slice(0, 3), 3, 25, armOf), null);
});

test("without a pilot every dish is baseline and nothing is filtered out", () => {
  const rows = dishes(30);
  const armOf = (r) => R.chooseModel("delivery_estimate", r.est_key, null, NOW).arm;
  const b = R.selectEstimateBatch(rows.slice(0, 25), 0, 25, armOf);
  assert.equal(b.todo.length, 25);
  assert.equal(b.arm, "baseline");
});

test("model calls end inside the 60 s function budget", () => {
  assert.equal(R.callTimeoutMs(1000, 1000), 54_000);
  assert.equal(R.callTimeoutMs(1000, 11_000), 44_000);
  assert.equal(R.callTimeoutMs(1000, 80_000), 1_000, "never zero or negative");
  for (const rel of ["app/api/delivery/items/import/route.ts", "app/api/supplements/extract-from-photo/route.ts"]) {
    const src = read(rel);
    assert.match(src, /timeout: callTimeoutMs\(routeStart, Date\.now\(\)\), maxRetries: 0/);
  }
  // The playlist route has no function limit; its calls get a fixed deadline, SDK retries off.
  assert.match(read("app/api/spotify/generate-playlist/route.ts"), /timeout: PLAYLIST_CALL_TIMEOUT_MS, maxRetries: 0/);
});

test("a failed estimate batch answers with its arm first, so the harvester can read it", () => {
  const src = read("app/api/delivery/items/import/route.ts");
  assert.match(src, /\{ \.\.\.extra, error: msg \}/);
  const h = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "ubereats_harvest", "harvest.mjs"), "utf8");
  assert.match(h, /"arm":"\(baseline\|pilot\)","arm_offset"/);
  assert.match(h, /arm: retryArm/);
});

test("a label read is accepted only with a product name and named ingredients", () => {
  const ok = { full_name: "Generic Magnesium", ingredients: [{ name: "Magnesium", quantity: 200 }] };
  assert.equal(LABEL.isUsableLabel(ok), true);
  assert.equal(LABEL.isUsableLabel({ brand_name: "Generic", ingredients: [{ name: "X", quantity: null }] }), true);
  for (const bad of [
    null,
    "text",
    {},
    { ingredients: [] },
    { full_name: "Generic", ingredients: [] },
    { full_name: "Generic" },
    { full_name: "  ", brand_name: null, ingredients: [{ name: "X" }] },
    { full_name: "Generic", ingredients: [{ name: "" }] },
    { full_name: "Generic", ingredients: [{ name: null, quantity: 5 }] },
    { full_name: "Generic", ingredients: [{ name: "X", quantity: "5" }] },
    { full_name: "Generic", ingredients: [{ name: "X", quantity: -1 }] },
  ]) {
    assert.equal(LABEL.isUsableLabel(bad), false, JSON.stringify(bad));
  }
});

test("the label route records success only through isUsableLabel", () => {
  const src = read("app/api/supplements/extract-from-photo/route.ts");
  assert.match(src, /observe\(isUsableLabel\(product\)\)/);
  assert.equal(/observe\(true\)/.test(src), false);
});

// --- OPSMODEL-R2: every provider attempt is counted, and missing usage is unknown, not free -------

test("callWithCountedRetries counts every attempt, retries only retryable errors, and stops at the limit", async () => {
  const noWait = { sleep: async () => {}, waitMs: () => 0 };
  const retryable = (e) => Boolean(e && e.retry === true);
  const run = async (outcomes, retries = 2) => {
    let attempts = 0;
    const queue = [...outcomes];
    let result;
    let error;
    try {
      result = await R.callWithCountedRetries(
        async () => {
          const o = queue.shift();
          if (o instanceof Error) throw o;
          return o;
        },
        { retries, isRetryable: retryable, onAttempt: () => { attempts++; }, ...noWait },
      );
    } catch (e) {
      error = e;
    }
    return { attempts, result, error };
  };
  const soft = () => Object.assign(new Error("soft"), { retry: true });
  const hard = () => Object.assign(new Error("hard"), { retry: false });
  assert.deepEqual(await run(["ok"]), { attempts: 1, result: "ok", error: undefined });
  const r2 = await run([soft(), "ok"]);
  assert.equal(r2.attempts, 2);
  assert.equal(r2.result, "ok");
  const r3 = await run([soft(), soft(), soft(), "never"]);
  assert.equal(r3.attempts, 3, "1 + MODEL_CALL_RETRIES attempts, then the error");
  assert.equal(r3.error.message, "soft");
  const r4 = await run([hard(), "never"]);
  assert.equal(r4.attempts, 1, "a non-retryable error is not retried");
  assert.equal(R.MODEL_CALL_RETRIES, 2);
});

test("retryable statuses match the SDK's own rule", () => {
  for (const s of [408, 409, 429, 500, 503, 529]) assert.equal(R.isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422, undefined, null, "500"]) assert.equal(R.isRetryableStatus(s), false, String(s));
});

test("pilotCostEvidence: an arm's cost is computable only when every attempt reported usage", () => {
  assert.deepEqual(R.pilotCostEvidence([]), { attempts: 0, answered: 0, unpriced: 0, complete: true });
  assert.deepEqual(R.pilotCostEvidence([{ calls: 2, answered: 2 }, { calls: 1, answered: 1 }]), {
    attempts: 3, answered: 3, unpriced: 0, complete: true,
  });
  assert.deepEqual(R.pilotCostEvidence([{ calls: 3, answered: 2 }]), { attempts: 3, answered: 2, unpriced: 1, complete: false });
  // A line without counts is never treated as free.
  assert.equal(R.pilotCostEvidence([{ calls: 1, answered: 1 }, {}]).complete, false);
  assert.equal(R.pilotCostEvidence([{ calls: "x", answered: 0 }]).unpriced, 1);
});

// The real playlist route, driven by a stub SDK through each scripted case in the fixture file.
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "model-routing-pilot.json"), "utf8"));

class StubAPIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class StubConnectionError extends StubAPIError {
  constructor(message = "Connection error.") {
    super(undefined, message);
  }
}
class StubTimeoutError extends StubConnectionError {
  constructor() {
    super("Request timed out.");
  }
}

function stubSdk(script, seenOptions) {
  const USAGE = { input_tokens: 100, output_tokens: 20 };
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (_params, options) => {
          seenOptions.push(options);
          const step = script.shift();
          if (step === "timeout") throw new StubTimeoutError();
          if (step === "http_529") throw new StubAPIError(529, "Overloaded");
          if (step === "http_400") throw new StubAPIError(400, "Bad request");
          if (step === "answer_tool") {
            return {
              stop_reason: "tool_use",
              content: [{ type: "tool_use", id: "tu1", name: "create_spotify_playlist", input: { name: "Generic mix", track_ids: Array(12).fill("trk") } }],
              usage: { ...USAGE },
            };
          }
          if (step === "answer_end") return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }], usage: { ...USAGE } };
          throw new Error(`script ran out (${String(step)})`);
        },
      };
    }
  }
  FakeAnthropic.APIError = StubAPIError;
  FakeAnthropic.APIConnectionError = StubConnectionError;
  return FakeAnthropic;
}

async function runPlaylistCase(attempts) {
  const until = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  const saved = { p: process.env.ONYX_MODEL_PILOT, u: process.env.ONYX_MODEL_PILOT_UNTIL, s: process.env.ONYX_MODEL_PILOT_SHARE };
  process.env.ONYX_MODEL_PILOT = "playlist";
  process.env.ONYX_MODEL_PILOT_UNTIL = until;
  delete process.env.ONYX_MODEL_PILOT_SHARE;
  const seenOptions = [];
  const lines = [];
  const origInfo = console.info;
  const origSetTimeout = global.setTimeout;
  console.info = (msg) => lines.push(JSON.parse(msg));
  // The route's retry wait goes through setTimeout; run it at once so the test does not sleep.
  global.setTimeout = (fn) => origSetTimeout(fn, 0);
  try {
    const route = loadTs("app/api/spotify/generate-playlist/route.ts", {
      "@anthropic-ai/sdk": stubSdk([...attempts], seenOptions),
      "@supabase/supabase-js": { createClient: () => ({}) },
      "next/server": { NextRequest: class {} },
      "@/lib/spotify-server": {
        searchTracks: async () => [],
        createPlaylist: async ({ name, trackIds }) => ({ playlist_id: "pl1", spotify_url: "", name, track_count: trackIds.length }),
      },
    });
    const res = await route.POST({ json: async () => ({ prompt: "Upbeat songs for a morning run", source_pool: "discovery" }) });
    await res.text();
  } finally {
    console.info = origInfo;
    global.setTimeout = origSetTimeout;
    for (const [k, v] of [["ONYX_MODEL_PILOT", saved.p], ["ONYX_MODEL_PILOT_UNTIL", saved.u], ["ONYX_MODEL_PILOT_SHARE", saved.s]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { lines, seenOptions };
}

for (const c of FX.playlist_measurement.cases) {
  test(`playlist route, ${c.id} (${c.attempts.join(" > ")}): every attempt logged, missing usage unpriced`, async () => {
    const { lines, seenOptions } = await runPlaylistCase(c.attempts);
    assert.equal(seenOptions.length, c.attempts.length, "the route made exactly the scripted attempts");
    for (const o of seenOptions) {
      assert.equal(o.maxRetries, 0, "SDK retries off, so no attempt is hidden from the count");
      assert.equal(o.timeout, R.PLAYLIST_CALL_TIMEOUT_MS);
    }
    assert.equal(lines.length, 1, "one observation per request");
    const line = lines[0];
    assert.equal(line.event, "model_pilot");
    assert.equal(line.task, "playlist");
    for (const k of ["ok", "calls", "answered", "unpriced", "input_tokens"]) assert.equal(line[k], c.expect[k], k);
    assert.equal(R.pilotCostEvidence([line]).complete, c.expect.cost_complete);
  });
}

test("the playlist measurement fixtures are internally consistent", () => {
  const known = new Set(["answer_tool", "answer_end", "timeout", "http_529", "http_400"]);
  assert.ok(FX.playlist_measurement.cases.length >= 5);
  assert.equal(typeof FX.playlist_measurement.evaluation_rule, "string");
  for (const c of FX.playlist_measurement.cases) {
    for (const a of c.attempts) assert.ok(known.has(a), a);
    assert.equal(c.expect.calls, c.attempts.length);
    assert.equal(c.expect.answered, c.attempts.filter((a) => a.startsWith("answer")).length);
    assert.equal(c.expect.unpriced, c.expect.calls - c.expect.answered);
    assert.equal(c.expect.cost_complete, c.expect.unpriced === 0);
  }
});
