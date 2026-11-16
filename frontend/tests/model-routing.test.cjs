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

test("observations: none outside a pilot, token counts summed across the calls of one request", () => {
  const choice = R.chooseModel("playlist", "x", null, NOW);
  assert.equal(R.pilotObservation("playlist", choice, null, { usage: [], latencyMs: 1, ok: true }), null);
  const pilot = on();
  const line = R.pilotObservation("playlist", choice, pilot, {
    usage: [
      { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      { input_tokens: 150, output_tokens: 30, cache_creation_input_tokens: 10 },
    ],
    latencyMs: 1234.4,
    ok: true,
  });
  assert.deepEqual(line, {
    event: "model_pilot", task: "playlist", arm: "baseline", model: "claude-sonnet-5-5", effort: "default",
    ok: true, calls: 2, units: 1, accepted: 1, latency_ms: 1234,
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
