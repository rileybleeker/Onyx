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
  assert.match(src, /selectEstimateBatch\(queue, from, n, armOf, only\)/);
  const save = src.indexOf(".upsert(rows, { onConflict: \"est_key\"");
  const accepted = src.indexOf("observe(rows.length)");
  assert.ok(save > 0 && accepted > save, "accepted count logged only after the upsert");
  assert.match(src, /if \(upErr\) \{\s*observe\(0\);/);
});

test("playlist and label requests count attempted calls before each create, observed once", () => {
  const pl = read("app/api/spotify/generate-playlist/route.ts");
  // One create, inside callWithCountedRetries, which counts every attempt (retries included).
  assert.equal(createCalls(pl).length, 1);
  assert.match(pl, /callWithCountedRetries\(\s*async \(\) => \{[\s\S]{0,400}?return await anthropic\.messages\.create\(/);
  assert.match(pl, /onAttempt: \(\) => \{\s*attempts\+\+;/);
  assert.match(pl, /if \(observed\) return;/);
  // The label and dish routes: one create each, inside callWithCountedRetries (their attempt
  // counting is checked by driving the real routes through a stub SDK below).
  for (const rel of ["app/api/supplements/extract-from-photo/route.ts", "app/api/delivery/items/import/route.ts"]) {
    const src = read(rel);
    assert.equal(createCalls(src).length, 1, rel);
    assert.match(src, /callWithCountedRetries\(\s*\(\) =>\s*anthropic\.messages\.create\(/, rel);
    assert.match(src, /calls: attempts/, rel);
  }
  assert.match(pl, /calls: attempts/);
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

const dishSrc = () => read("app/api/delivery/items/import/route.ts");

test("route deadlines count from the handler's entry and end the model call before the writes", () => {
  const d = R.routeDeadline(1000, 1000);
  assert.equal(d.at, 1000 + R.FUNCTION_BUDGET_MS - R.FUNCTION_RESERVE_MS);
  assert.equal(d.modelAt, d.at - R.MODEL_WRITE_RESERVE_MS);
  assert.ok(d.signal instanceof AbortSignal && d.modelSignal instanceof AbortSignal);
  assert.equal(d.signal.aborted, false);
  // A request whose budget is already used up gets signals that are (about to be) aborted.
  assert.equal(R.attemptTimeoutMs(50_000, 10_000), 40_000);
  assert.equal(R.attemptTimeoutMs(50_000, 80_000), R.MIN_ATTEMPT_MS, "never zero or negative");
  for (const rel of ["app/api/delivery/items/import/route.ts", "app/api/supplements/extract-from-photo/route.ts"]) {
    const src = read(rel);
    assert.match(src, /routeDeadline\(/, rel);
    assert.match(src, /timeout: attemptTimeoutMs\(deadline\.modelAt, Date\.now\(\)\), maxRetries: 0, signal: deadline\.modelSignal/, rel);
    assert.match(src, /retries: MODEL_CALL_RETRIES,/, rel);
    assert.match(src, /deadlineMs: deadline\.modelAt,/, rel);
    // Every database read and write of the request is cut off at the request deadline.
    assert.match(src, /\.abortSignal\((deadline\.)?signal\)/, rel);
  }
  assert.match(read("app/api/supplements/extract-from-photo/route.ts"), /buildReferenceTable\(deadline\.signal\)/);
  assert.match(dishSrc(), /\.upsert\(rows, \{ onConflict: "est_key", ignoreDuplicates: true \}\)\s*\.abortSignal\(deadline\.signal\)/);
  // The dish route starts its deadline before parsing the body or reading the queue.
  const dish = read("app/api/delivery/items/import/route.ts");
  assert.ok(dish.indexOf("routeDeadline(startedAt.getTime()") < dish.indexOf("await req.json()"));
  // The playlist route has no function limit: 60 s per attempt, a whole-request budget, SDK retries off.
  const pl = read("app/api/spotify/generate-playlist/route.ts");
  assert.match(pl, /const attemptMs = Math\.min\(PLAYLIST_CALL_TIMEOUT_MS, attemptTimeoutMs\(requestAt, Date\.now\(\)\)\)/);
  // Each attempt's own deadline also ends a stalled body read; it is retryable, the budget is not.
  assert.match(pl, /timeout: attemptMs,\s*maxRetries: 0,\s*signal: AbortSignal\.any\(\[stop\.signal, attempt\]\)/);
  assert.match(pl, /if \(attempt\.aborted && !stop\.signal\.aborted\) throw new AttemptTimeoutError\(\);/);
  assert.match(pl, /e instanceof AttemptTimeoutError \|\|/);
  // Every request is observed, also one whose client disconnected mid-loop.
  assert.match(pl, /\} finally \{[\s\S]{0,700}?observe\(\);/);
});

test("a failed estimate batch answers with its arm first, so the harvester can read it", () => {
  const src = read("app/api/delivery/items/import/route.ts");
  assert.match(src, /\{ \.\.\.extra, error: msg \}/);
  const h = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "ubereats_harvest", "harvest.mjs"), "utf8");
  assert.match(h, /"arm":"\(baseline\|pilot\)","arm_offset"/);
  assert.match(h, /arm: retryArm/);
  // An arm with no dish left ends the one-dish retries without counting a skipped dish.
  assert.match(h, /if \(retrying && r\.arm_exhausted\) \{[\s\S]*?single = 0;[\s\S]*?retryArm = null;[\s\S]*?continue;/);
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

test("callWithCountedRetries waits as long as the provider asks, but never past the deadline", async () => {
  const waits = [];
  const clock = { t: 0 };
  const opts = (extra) => ({
    retries: 2,
    isRetryable: () => true,
    onAttempt: () => {},
    now: () => clock.t,
    sleep: async (ms) => {
      waits.push(ms);
      clock.t += ms;
    },
    waitMs: () => 500,
    ...extra,
  });
  const failThenOk = () => {
    let n = 0;
    return async () => {
      if (n++ === 0) throw new Error("rate limited");
      return "ok";
    };
  };
  // Retry-After honoured when it fits.
  assert.equal(await R.callWithCountedRetries(failThenOk(), opts({ retryAfterMs: () => 30_000, deadlineMs: 50_000 })), "ok");
  assert.deepEqual(waits, [30_000]);
  // A wait that would end past the deadline (less one attempt) is not started: the error ends it.
  waits.length = 0;
  clock.t = 0;
  let attempts = 0;
  await assert.rejects(
    R.callWithCountedRetries(failThenOk(), opts({ retryAfterMs: () => 49_500, deadlineMs: 50_000, onAttempt: () => attempts++ })),
    /rate limited/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
  // No header: the route's own backoff.
  waits.length = 0;
  clock.t = 0;
  assert.equal(await R.callWithCountedRetries(failThenOk(), opts({ retryAfterMs: () => null })), "ok");
  assert.deepEqual(waits, [500]);
  // An aborted signal starts no attempt at all.
  const ctl = new AbortController();
  ctl.abort(new Error("gone"));
  attempts = 0;
  await assert.rejects(R.callWithCountedRetries(async () => "never", opts({ signal: ctl.signal, onAttempt: () => attempts++ })), /gone/);
  assert.equal(attempts, 0);
});

test("retryAfterMs and isRetryableModelError read the provider's headers like the SDK", () => {
  const err = (status, headers) => Object.assign(new Error("x"), { status, headers: new Headers(headers) });
  assert.equal(R.retryAfterMs(err(429, { "retry-after-ms": "1500" }), 0), 1500);
  assert.equal(R.retryAfterMs(err(429, { "retry-after": "30" }), 0), 30_000);
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(R.retryAfterMs(err(429, { "retry-after": "Mon, 16 Nov 2026 12:00:10 GMT" }), now), 10_000);
  assert.equal(R.retryAfterMs(err(429, {}), 0), null);
  assert.equal(R.retryAfterMs(new Error("no headers"), 0), null);
  const conn = (e) => e && e.conn === true;
  assert.equal(R.isRetryableModelError(Object.assign(new Error("c"), { conn: true }), conn), true);
  assert.equal(R.isRetryableModelError(err(529, {}), conn), true);
  assert.equal(R.isRetryableModelError(err(400, {}), conn), false);
  assert.equal(R.isRetryableModelError(err(400, { "x-should-retry": "true" }), conn), true);
  assert.equal(R.isRetryableModelError(err(503, { "x-should-retry": "false" }), conn), false);
  assert.equal(R.isRetryableModelError(Object.assign(new Error("aborted"), { status: undefined }), conn), false);
});

test("retryable statuses match the SDK's own rule", () => {
  for (const s of [408, 409, 429, 500, 503, 529]) assert.equal(R.isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422, undefined, null, "500"]) assert.equal(R.isRetryableStatus(s), false, String(s));
});

test("unresolved creation: observed as unresolved and blocks cost promotion", () => {
  assert.ok(R.PLAYLIST_CREATE_HARD_MS < 300_000 && R.PLAYLIST_CREATE_HARD_MS > R.PLAYLIST_REQUEST_BUDGET_MS + R.PLAYLIST_CREATE_GRACE_MS);
  assert.equal(R.pilotCostEvidence([{ calls: 1, answered: 1, unresolved: true }]).complete, false);
  assert.equal(R.pilotCostEvidence([{ calls: 1, answered: 1, unresolved: false }]).complete, true);
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
          // Headers arrived but the body never does: ends only when the call's signal aborts.
          if (step === "stall") {
            return new Promise((_, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
            });
          }
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
          // Route-specific answers built from the request, and error statuses carrying headers.
          if (typeof step === "function") return { usage: { ...USAGE }, ...step(_params) };
          if (step && typeof step === "object") {
            const e = new StubAPIError(step.status, "Error status");
            e.headers = new Headers(step.headers || {});
            throw e;
          }
          throw new Error(`script ran out (${String(step)})`);
        },
      };
    }
  }
  FakeAnthropic.APIError = StubAPIError;
  FakeAnthropic.APIConnectionError = StubConnectionError;
  return FakeAnthropic;
}

async function runPlaylistCase(attempts, opts = {}) {
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
  // Optionally shorten the per-attempt deadline (a real AbortSignal.timeout, not setTimeout).
  const origAbortTimeout = AbortSignal.timeout;
  if (opts.attemptMs) {
    AbortSignal.timeout = (ms) => origAbortTimeout.call(AbortSignal, ms === R.PLAYLIST_CALL_TIMEOUT_MS ? opts.attemptMs : ms);
  }
  const afterFns = [];
  let text = "";
  try {
    const route = loadTs("app/api/spotify/generate-playlist/route.ts", {
      "@anthropic-ai/sdk": stubSdk([...attempts], seenOptions),
      "@supabase/supabase-js": { createClient: () => ({}) },
      "next/server": { NextRequest: class {}, after: (fn) => afterFns.push(fn) },
      "@/lib/spotify-server": {
        searchTracks: async () => [],
        createPlaylist:
          opts.createPlaylist ||
          (async ({ name, trackIds }) => ({ playlist_id: "pl1", spotify_url: "", name, track_count: trackIds.length })),
      },
    });
    const res = await route.POST({ json: async () => ({ prompt: "Upbeat songs for a morning run", source_pool: "discovery" }) });
    text = await res.text();
    // What `after` keeps alive (a creation still running when the response closed).
    await Promise.all(afterFns.map((fn) => fn()));
  } finally {
    console.info = origInfo;
    global.setTimeout = origSetTimeout;
    AbortSignal.timeout = origAbortTimeout;
    for (const [k, v] of [["ONYX_MODEL_PILOT", saved.p], ["ONYX_MODEL_PILOT_UNTIL", saved.u], ["ONYX_MODEL_PILOT_SHARE", saved.s]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { lines, seenOptions, text };
}

test("a playlist attempt whose body stalls ends at its own deadline and is retried", async () => {
  const { lines, seenOptions } = await runPlaylistCase(["stall", "answer_tool", "answer_end"], { attemptMs: 20 });
  assert.equal(seenOptions.length, 3, "the stalled attempt was retried, not left to the request budget");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].calls, 3);
  assert.equal(lines[0].answered, 2);
});

test("a second create in one playlist request reuses the first creation", async () => {
  let writes = 0;
  const createPlaylist = async ({ name, trackIds }) => {
    writes++;
    return { playlist_id: "pl1", spotify_url: "", name, track_count: trackIds.length };
  };
  const { lines, text } = await runPlaylistCase(["answer_tool", "answer_tool", "answer_end"], { createPlaylist });
  assert.equal(writes, 1, "one Spotify write per request");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true);
  assert.match(text, /Already created/);
  assert.match(text, /"type":"done"/);
});

test("a creation still running when the request gives up is observed with its real outcome", async () => {
  // The grace timer runs at once in this test (setTimeout is shortened), so the route gives up on
  // the creation while it is still running; it lands 30 ms later.
  const realSetTimeout = setTimeout;
  const createPlaylist = ({ name, trackIds }) =>
    new Promise((resolve) => realSetTimeout(() => resolve({ playlist_id: "pl1", spotify_url: "", name, track_count: trackIds.length }), 30));
  const { lines, text } = await runPlaylistCase(["answer_tool", "answer_end"], { createPlaylist });
  assert.match(text, /may still appear in Spotify/);
  assert.doesNotMatch(text, /"type":"done"/);
  assert.equal(lines.length, 1, "observed once, after the creation settled");
  assert.equal(lines[0].ok, true, "a playlist that landed late counts as accepted");
  assert.equal(lines[0].accepted, 1);
});

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

// --- the label and dish routes, driven through a stub SDK: attempts counted, retries kept -------

async function withPilot(task, fn) {
  const until = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  const saved = { p: process.env.ONYX_MODEL_PILOT, u: process.env.ONYX_MODEL_PILOT_UNTIL, s: process.env.ONYX_MODEL_PILOT_SHARE };
  process.env.ONYX_MODEL_PILOT = task;
  process.env.ONYX_MODEL_PILOT_UNTIL = until;
  delete process.env.ONYX_MODEL_PILOT_SHARE;
  const lines = [];
  const origInfo = console.info;
  const origError = console.error;
  const origSetTimeout = global.setTimeout;
  console.info = (msg) => lines.push(JSON.parse(msg));
  console.error = () => {};
  // Retry waits go through setTimeout; run them at once so the test does not sleep.
  global.setTimeout = (f) => origSetTimeout(f, 0);
  try {
    return { result: await fn(), lines };
  } finally {
    console.info = origInfo;
    console.error = origError;
    global.setTimeout = origSetTimeout;
    for (const [k, v] of [["ONYX_MODEL_PILOT", saved.p], ["ONYX_MODEL_PILOT_UNTIL", saved.u], ["ONYX_MODEL_PILOT_SHARE", saved.s]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const jsonResponse = { NextResponse: { json: (body, init) => ({ body, status: (init && init.status) || 200 }) }, NextRequest: class {} };
const LABEL_ANSWER = () => ({
  stop_reason: "end_turn",
  content: [{
    type: "text",
    text: JSON.stringify({
      brand_name: "Generic", full_name: "Generic Magnesium", serving_size: 1, serving_unit: "Capsule(s)", servings_per_container: 60,
      physical_state: "Capsule",
      ingredients: [{ name: "Magnesium", ingredient_group: "Magnesium", unii_code: null, category: "mineral", quantity: 200, unit: "mg", percent_dv: null, forms: [], notes: null }],
    }),
  }],
});

async function runLabelCase(script) {
  const seen = [];
  const { result, lines } = await withPilot("supplement_photo", async () => {
    const route = loadTs("app/api/supplements/extract-from-photo/route.ts", {
      "@anthropic-ai/sdk": stubSdk([...script], seen),
      "@supabase/supabase-js": {
        createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ abortSignal: async () => ({ data: [], error: null }) }) }) }) }),
      },
      "next/server": jsonResponse,
    });
    return route.POST({ json: async () => ({ image_base64: "AAAA", media_type: "image/jpeg" }) });
  });
  return { res: result, lines, seen };
}

test("label route: a retryable error is retried (as the SDK did) and every attempt is counted", async () => {
  const { res, lines, seen } = await runLabelCase(["http_529", LABEL_ANSWER]);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2);
  for (const o of seen) {
    assert.equal(o.maxRetries, 0);
    assert.ok(o.signal instanceof AbortSignal, "the model call gets the deadline signal");
    assert.ok(o.timeout > 0 && o.timeout <= R.FUNCTION_BUDGET_MS - R.FUNCTION_RESERVE_MS - R.MODEL_WRITE_RESERVE_MS);
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].calls, 2);
  assert.equal(lines[0].answered, 1);
  assert.equal(lines[0].unpriced, 1);
  assert.equal(lines[0].ok, true);
});

test("label route: retries stop at the limit, a non-retryable error is not retried", async () => {
  const exhausted = await runLabelCase(["http_529", "http_529", "http_529", LABEL_ANSWER]);
  assert.equal(exhausted.res.status, 502);
  assert.equal(exhausted.seen.length, 1 + R.MODEL_CALL_RETRIES);
  assert.equal(exhausted.lines[0].calls, 1 + R.MODEL_CALL_RETRIES);
  assert.equal(exhausted.lines[0].ok, false);
  const hard = await runLabelCase(["http_400", LABEL_ANSWER]);
  assert.equal(hard.seen.length, 1);
  assert.equal(hard.lines[0].calls, 1);
});

test("label route: a Retry-After that would outlast the function limit ends the request instead of waiting", async () => {
  const { res, seen, lines } = await runLabelCase([{ status: 429, headers: { "retry-after": "120" } }, LABEL_ANSWER]);
  assert.equal(res.status, 502);
  assert.equal(seen.length, 1);
  assert.equal(lines[0].calls, 1);
  // A short one is honoured and the retry goes through.
  const short = await runLabelCase([{ status: 429, headers: { "retry-after-ms": "5" } }, LABEL_ANSWER]);
  assert.equal(short.res.status, 200);
  assert.equal(short.seen.length, 2);
});

function dishSupabase(dishes, upserts, reads = []) {
  return {
    createClient: () => ({
      from: (table) => ({
        select: () => ({
          order: () => ({
            limit: (n) => (reads.push(n), {
              abortSignal: async (sig) => {
                assert.ok(sig instanceof AbortSignal, `${table} read gets the request signal`);
                return { data: dishes.slice(0, n), error: null, count: dishes.length };
              },
            }),
          }),
        }),
        upsert: (rows) => ({
          abortSignal: async (sig) => {
            assert.ok(sig instanceof AbortSignal, `${table} write gets the request signal`);
            upserts.push(rows);
            return { error: null };
          },
        }),
      }),
    }),
  };
}

// Answers every dish in the request with a synthetic estimate.
const DISH_ANSWER = (params) => {
  const { items } = JSON.parse(params.messages[0].content);
  return {
    stop_reason: "end_turn",
    content: [{
      type: "text",
      text: JSON.stringify({
        items: items.map((it) => ({ id: it.id, kind: "food", kcal: 500, protein_g: 20, carbs_g: 50, fat_g: 20, alcohol_g: 0, confidence: "medium", basis: "typical" })),
      }),
    }],
  };
};

const genericDish = (k) => ({
  est_key: k, store_name: "Generic Diner", merchant_kind: "restaurant", title: "Generic bowl", customizations: null, price: 12, currency: "USD",
});

async function runDishCase(script, body = { estimate: true }, opts = {}) {
  const dishes = opts.dishes ?? ["k01", "k02", "k03", "k04"].map(genericDish);
  const seen = [];
  const upserts = [];
  const reads = [];
  const { result, lines } = await withPilot(opts.pilot ?? "delivery_estimate", async () => {
    const route = loadTs("app/api/delivery/items/import/route.ts", {
      "@anthropic-ai/sdk": stubSdk([...script], seen),
      "@supabase/supabase-js": dishSupabase(dishes, upserts, reads),
      "next/server": jsonResponse,
    });
    return route.POST({ json: async () => body });
  });
  return { res: result, lines, seen, upserts, reads };
}

test("dish route: a transient error is retried inside the deadline, not failed for the whole batch", async () => {
  const { res, lines, seen, upserts } = await runDishCase(["http_529", DISH_ANSWER]);
  assert.equal(res.status, 200);
  assert.ok(res.body.estimated >= 1);
  assert.equal(seen.length, 2);
  for (const o of seen) {
    assert.equal(o.maxRetries, 0);
    assert.ok(o.signal instanceof AbortSignal);
  }
  assert.equal(upserts.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].calls, 2);
  assert.equal(lines[0].unpriced, 1);
  assert.equal(lines[0].accepted, res.body.estimated);
});

test("dish route: a failed batch still names its arm first, with every attempt counted", async () => {
  const { res, lines, seen } = await runDishCase(["http_400"]);
  assert.equal(res.status, 500);
  assert.deepEqual(Object.keys(res.body).slice(0, 2), ["arm", "arm_offset"]);
  assert.equal(seen.length, 1);
  assert.equal(lines[0].calls, 1);
  assert.equal(lines[0].accepted, 0);
});

test("dish route: a retry inside an arm with no dish left says so, so the harvester leaves its retries", async () => {
  const { res, seen } = await runDishCase([], { estimate: true, limit: 1, offset: 50, arm: "pilot" });
  assert.equal(res.status, 200);
  assert.equal(res.body.estimated, 0);
  assert.equal(res.body.arm_exhausted, true);
  assert.equal(seen.length, 0, "no model call");
  const plain = await runDishCase([], { estimate: true, limit: 1, offset: 50 });
  assert.equal("arm_exhausted" in plain.res.body, false);
});

// OPSMODEL-R3: a batch never exceeds the requested limit (at most 25), however long the queue the
// route reads to apply per-arm skips, with the pilot off or on, with zero or nonzero skips.
test("selectEstimateBatch: a long queue still gives at most n dishes, of one arm", () => {
  const rows = dishes(1000);
  const off = (r) => R.chooseModel("delivery_estimate", r.est_key, null, NOW).arm;
  assert.equal(R.selectEstimateBatch(rows, 0, 25, off).todo.length, 25);
  assert.equal(R.selectEstimateBatch(rows, 40, 25, off).todo[0], rows[40]);
  assert.equal(R.selectEstimateBatch(rows, 0, 1, off).todo.length, 1);
  assert.equal(R.selectEstimateBatch(rows, 0, 25, off, "baseline").todo.length, 25);
  const pilot = on({ ONYX_MODEL_PILOT_SHARE: "0.5" });
  const onArm = (r) => R.chooseModel("delivery_estimate", r.est_key, pilot, NOW).arm;
  for (const from of [0, 3, 17]) {
    const b = R.selectEstimateBatch(rows, from, 25, onArm);
    assert.equal(b.todo.length, 25, "a 1000-dish queue has 25 of either arm");
    assert.ok(b.todo.every((r) => onArm(r) === b.arm));
    assert.equal(b.todo[0], rows[from]);
    // the harvester's one-dish retries after this batch failed walk exactly its dishes
    const retried = b.todo.map((_, k) => R.selectEstimateBatch(rows, b.armOffset + k, 1, onArm, b.arm).todo[0]);
    assert.deepEqual(retried, b.todo);
    assert.equal(R.selectEstimateBatch(rows, from, 1, onArm).todo.length, 1);
  }
});

for (const pilotTask of ["", "delivery_estimate"]) {
  for (const skips of [{ baseline: 0, pilot: 0 }, { baseline: 3, pilot: 2 }, undefined]) {
    for (const limit of [25, 1, undefined, 400]) {
      const name = `dish route, pilot ${pilotTask ? "on" : "off"}, skips ${JSON.stringify(skips)}, limit ${limit}: one call of at most ${limit === 1 ? 1 : 25} dishes`;
      test(name, async () => {
        const queued = Array.from({ length: 1000 }, (_, k) => genericDish(`q${String(k).padStart(4, "0")}`));
        const sent = [];
        const answer = (params) => {
          sent.push(JSON.parse(params.messages[0].content).items.length);
          return DISH_ANSWER(params);
        };
        const body = { estimate: true, ...(limit === undefined ? {} : { limit }), ...(skips ? { skips } : {}) };
        const { res, seen, upserts, reads } = await runDishCase([answer], body, { dishes: queued, pilot: pilotTask });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1, "one model call");
        const max = limit === 1 ? 1 : 25;
        assert.ok(sent[0] >= 1 && sent[0] <= max, `sent ${sent[0]} dishes, limit ${max}`);
        if (!pilotTask) {
          assert.equal(sent[0], max, "without a pilot a full batch is exactly the limit");
          const skipped = skips ? skips.baseline + skips.pilot : 0;
          assert.equal(reads[0], skipped + max, "without a pilot the read stops at the skips plus one batch");
        }
        assert.equal(res.body.estimated, sent[0]);
        assert.equal(upserts.reduce((a, u) => a + u.length, 0), sent[0], "every dish sent is stored");
      });
    }
  }
}

test("harvester keeps failed dishes per arm, and the route and playlist loop honour the budget", () => {
  const h = fs.readFileSync(path.join(SRC, "../../tools/ubereats_harvest/harvest.mjs"), "utf8");
  assert.match(h, /armSkips\[retryArm\]\+\+/);
  assert.match(h, /skips: \{ \.\.\.armSkips \}/);
  // full batches ask for 25, one-dish retries for 1: the bodies the route tests above send
  assert.match(h, /const limit = single > 0 \? 1 : 25;/);
  const route = read("app/api/delivery/items/import/route.ts");
  assert.match(route, /seen\[a\]\+\+ >= skipN\[a\]/);
  const pl = read("app/api/spotify/generate-playlist/route.ts");
  assert.match(pl, /withinBudget\(searchTracks/);
  assert.match(pl, /withinBudget\(runFeatureQuery/);
  // Playlist creation is a write: never raced away by the budget, at most one per request.
  assert.doesNotMatch(pl, /withinBudget\(createPlaylist/);
  assert.match(pl, /await createOnce\(\{/);
  assert.ok(R.PLAYLIST_REQUEST_BUDGET_MS + R.PLAYLIST_CREATE_GRACE_MS < 300_000, "grace stays under the default function limit");
  assert.match(pl, /if \(stop\.signal\.aborted\) throw/);
});
