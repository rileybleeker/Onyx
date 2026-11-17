// READ-QUIZ-01: the one model call helper (lib/reading-model.ts), against an injected fake client. No network,
// no API key, synthetic prompts only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

function FakeAnthropic() {}
const M = loadTs("lib/reading-model.ts", { "@anthropic-ai/sdk": FakeAnthropic });

/** A fake client: answers (or throws) from `script`, in order, and records every request. */
function fakeClient(script) {
  const calls = [];
  const client = {
    beta: {
      messages: {
        stream(params, options) {
          calls.push({ params: structuredClone(params), options });
          const next = script.shift();
          return {
            finalMessage: async () => {
              if (next instanceof Error || (next && next.__throw)) throw next.__throw ?? next;
              return next;
            },
          };
        },
      },
    },
  };
  return { client: M.asBankClient(client), calls };
}
const usage = (o = {}) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, ...o });
const msg = (stop_reason, content = [{ type: "text", text: "Synthetic notes." }], o = {}) => ({ model: "claude-sonnet-5-5", stop_reason, content, usage: usage(), ...o });
const spec = (o = {}) => ({ model: "claude-sonnet-5-5", effort: "medium", system: "Synthetic system prompt.", user: "Synthetic user turn.", maxTokens: 16000, ...o });

test("the request: server-side fallback beta + fallbacks default, explicit effort, no thinking, cached system prefix", async () => {
  const { client, calls } = fakeClient([msg("end_turn")]);
  const r = await M.bankModelCall(client, spec({ tools: [M.webSearchTool(2), M.webFetchTool(2)], timeoutMs: 120000 }));
  assert.equal(r.ok, true);
  const p = calls[0].params;
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal("thinking" in p, false, "thinking is never sent (disabled is a 400 on these models)");
  assert.deepEqual(p.system.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(p.model, "claude-sonnet-5-5");
  assert.equal(p.max_tokens, 16000);
  assert.deepEqual(p.messages, [{ role: "user", content: "Synthetic user turn." }]);
  assert.deepEqual(p.tools.map((t) => [t.type, t.name, t.max_uses]), [["web_search_20260209", "web_search", 2], ["web_fetch_20260209", "web_fetch", 2]]);
  assert.deepEqual(p.tools[1].citations, { enabled: true });
  assert.equal(p.tools[1].max_content_tokens, 12000);
  // The _20260209 tools default to running from code execution (dynamic filtering), and an answer built from code
  // output carries no citations at all (map stored no_sources, 2026-11-17): both are called directly.
  assert.deepEqual(p.tools.map((t) => t.allowed_callers), [["direct"], ["direct"]], "no dynamic filtering: citations need direct calls");
  assert.ok(p.tools.every((t) => t.blocked_domains.length > 0 && t.blocked_domains.length <= 64));
  assert.equal(calls[0].options.timeout, 120000);
  assert.equal(typeof calls[0].options.signal?.aborted, "boolean", "one abort signal bounds the whole call, SDK retries included");
});

test("the deadline: timeoutMs, else the step's STEP_MAX_SECONDS, else the longest step's; never the SDK's 10 minutes", async () => {
  const B = loadTs("lib/reading-bank.ts");
  assert.equal(M.callDeadlineMs({ timeoutMs: 45000 }), 45000);
  assert.equal(M.callDeadlineMs({ step: "grade" }), B.STEP_MAX_SECONDS.grade * 1000);
  assert.equal(M.callDeadlineMs({ step: "build" }), B.STEP_MAX_SECONDS.build * 1000);
  assert.equal(M.callDeadlineMs({}), Math.max(...Object.values(B.STEP_MAX_SECONDS)) * 1000);
  const { client, calls } = fakeClient([msg("end_turn")]);
  await M.bankModelCall(client, spec({ step: "highlights" }));
  assert.equal(calls[0].options.timeout, B.STEP_MAX_SECONDS.highlights * 1000);
});

test("a timed-out or dropped call may have been billed: it says so (the worker charges the reservation); a 4xx does not", async () => {
  const timeout = await M.bankModelCall(fakeClient([{ __throw: Object.assign(new Error("Synthetic"), { name: "APIConnectionTimeoutError" }) }]).client, spec());
  assert.deepEqual([timeout.code, timeout.maybeBilled], ["timeout", true]);
  const aborted = await M.bankModelCall(fakeClient([{ __throw: Object.assign(new Error("Synthetic"), { name: "APIUserAbortError" }) }]).client, spec());
  assert.deepEqual([aborted.code, aborted.maybeBilled], ["timeout", true]);
  const drop = await M.bankModelCall(fakeClient([{ __throw: Object.assign(new Error("Synthetic"), { name: "APIConnectionError" }) }]).client, spec());
  assert.deepEqual([drop.code, drop.maybeBilled], ["connection", true]);
  const bad = await M.bankModelCall(fakeClient([{ __throw: { status: 400, message: "Synthetic" } }]).client, spec());
  assert.deepEqual([bad.code, bad.maybeBilled], ["bad_request", false]);
  const refused = await M.bankModelCall(fakeClient([msg("refusal")]).client, spec());
  assert.equal(refused.maybeBilled, false, "a refusal reports its usage");
});

test("maxCostCents: no continuation once the next turn could pass it (the claim's headroom)", async () => {
  // Each turn costs 100 cents (500k input tokens on Sonnet 5.5).
  const paused = () => msg("pause_turn", [], { usage: usage({ input_tokens: 500_000 }) });
  const { client, calls } = fakeClient([paused(), paused(), msg("end_turn")]);
  const r = await M.bankModelCall(client, spec({ maxCostCents: 150 }));
  assert.deepEqual([r.ok, r.code, r.retryable], [false, "cost_limit", true]);
  assert.equal(calls.length, 1, "the second turn (re-sending the first) would pass 150");
  assert.equal(r.costCents, 100);
  const roomy = await M.bankModelCall(fakeClient([paused(), msg("end_turn")]).client, spec({ maxCostCents: 1000 }));
  assert.equal(roomy.ok, true);
});

test("structured output: the schema goes in output_config.format and the JSON is parsed", async () => {
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const { client, calls } = fakeClient([msg("end_turn", [{ type: "text", text: '{"ok":true}' }])]);
  const r = await M.bankModelCall(client, spec({ effort: "low", schema }));
  assert.deepEqual(calls[0].params.output_config, { effort: "low", format: { type: "json_schema", schema } });
  assert.deepEqual(r.json, { ok: true });
  const bad = await M.bankModelCall(fakeClient([msg("end_turn", [{ type: "text", text: "not json" }])]).client, spec({ schema }));
  assert.deepEqual([bad.ok, bad.code, bad.retryable], [false, "bad_output", true]);
});

test("stop reasons are read before content: refusal fails, max_tokens retries, other stops are bad output", async () => {
  const refusal = await M.bankModelCall(fakeClient([msg("refusal", [], { usage: usage({ input_tokens: 1000 }) })]).client, spec());
  assert.deepEqual([refusal.ok, refusal.code, refusal.retryable], [false, "refusal", false]);
  assert.ok(refusal.costCents > 0, "a refused call still costs what it used");
  const long = await M.bankModelCall(fakeClient([msg("max_tokens")]).client, spec());
  assert.deepEqual([long.code, long.retryable], ["max_tokens", true]);
  const odd = await M.bankModelCall(fakeClient([msg("tool_use")]).client, spec());
  assert.equal(odd.code, "bad_output");
});

test("pause_turn is continued with the answer so far, up to 3 times", async () => {
  const paused = (n) => msg("pause_turn", [{ type: "server_tool_use", id: `s${n}`, name: "web_search", input: {} }], { usage: usage({ input_tokens: 100, output_tokens: 10 }) });
  const { client, calls } = fakeClient([paused(1), paused(2), msg("end_turn", [{ type: "text", text: "Done." }], { usage: usage({ input_tokens: 100, output_tokens: 10 }) })]);
  const r = await M.bankModelCall(client, spec());
  assert.equal(r.ok, true);
  assert.equal(r.continuations, 2);
  assert.equal(r.text, "Done.");
  assert.equal(r.content.length, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].params.messages[1], { role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] });
  assert.equal(calls[2].params.messages[1].content.length, 2);
  assert.equal(r.usage.calls, 3);
  assert.equal(r.usage.input_tokens, 300);
  const limit = await M.bankModelCall(fakeClient([paused(1), paused(2), paused(3), paused(4)]).client, spec());
  assert.deepEqual([limit.ok, limit.code], [false, "pause_limit"]);
});

test("cost from usage: tokens by model, cache reads and writes, web searches; an unknown served model is priced high", () => {
  assert.equal(M.costCents("claude-sonnet-5-5", usage({ input_tokens: 1_000_000 })), 200);
  assert.equal(M.costCents("claude-sonnet-5-5", usage({ output_tokens: 1_000_000 })), 1000);
  assert.equal(M.costCents("claude-sonnet-5-5", usage({ cache_read_input_tokens: 1_000_000 })), 10);
  assert.equal(M.costCents("claude-sonnet-5-5", usage({ cache_creation_input_tokens: 1_000_000 })), 250);
  assert.equal(M.costCents("claude-opus-5-5", usage({ input_tokens: 1_000_000, output_tokens: 100_000 })), 600);
  assert.equal(M.costCents("claude-sonnet-5-5", usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } })), 3);
  assert.equal(M.costCents("some-other-model", usage({ input_tokens: 1_000_000 })), 500);
});

test("the call's cost sums every response, priced by the model that served it", async () => {
  const { client } = fakeClient([
    msg("pause_turn", [], { usage: usage({ input_tokens: 500_000, server_tool_use: { web_search_requests: 2 } }) }),
    msg("end_turn", undefined, { model: "claude-opus-5-5", usage: usage({ input_tokens: 500_000 }) }),
  ]);
  const r = await M.bankModelCall(client, spec());
  assert.equal(r.costCents, 100 + 2 + 200);
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.usage.web_search_requests, 2);
});

test("errors leave as codes only; the API message is never returned", async () => {
  const cases = [
    [{ status: 429, message: "Synthetic rate limit text" }, "rate_limited", true],
    [{ status: 529, message: "overloaded" }, "overloaded", true],
    [{ status: 500, message: "boom" }, "server_error", true],
    [{ status: 400, message: "Web search is not enabled for this organization" }, "web_search_disabled", false],
    [{ status: 401, message: "bad key" }, "auth", false],
    [{ status: 400, message: "Synthetic invalid request text" }, "bad_request", false],
    [Object.assign(new Error("Synthetic socket text"), { name: "APIConnectionError" }), "connection", true],
    [Object.assign(new Error("Synthetic timeout text"), { name: "APIConnectionTimeoutError" }), "timeout", true],
  ];
  for (const [err, code, retryable] of cases) {
    const r = await M.bankModelCall(fakeClient([{ __throw: err }]).client, spec());
    assert.deepEqual([r.ok, r.code, r.retryable], [false, code, retryable], code);
    assert.doesNotMatch(JSON.stringify(r), /Synthetic|enabled|bad key|boom/);
  }
});

test("defaultBankClient builds the SDK client with two retries", () => {
  let seen = null;
  function SDK(opts) {
    seen = opts;
    this.beta = { messages: { stream() {} } };
  }
  const M2 = loadTs("lib/reading-model.ts", { "@anthropic-ai/sdk": SDK });
  const c = M2.defaultBankClient("sk-synthetic");
  assert.deepEqual(seen, { apiKey: "sk-synthetic", maxRetries: 2 });
  assert.equal(typeof c.beta.messages.stream, "function");
});

/* ---------------- review round 2 ---------------- */

test("money is checked before the FIRST request too: a request whose bound passes maxCostCents is never sent", async () => {
  const s = spec({ maxTokens: 32000, model: "claude-opus-5-5" });
  const bound = M.requestBoundCents(s, [{ role: "user", content: s.user }]);
  assert.ok(bound >= 32000 * 25 / 1_000_000 * 100, "its whole output at the dearest known price");
  const { client, calls } = fakeClient([msg("end_turn")]);
  const r = await M.bankModelCall(client, { ...s, maxCostCents: bound - 1 });
  assert.deepEqual([r.ok, r.code, calls.length], [false, "cost_limit", 0]);
  const ok = await M.bankModelCall(fakeClient([msg("end_turn")]).client, { ...s, maxCostCents: bound + 1 });
  assert.equal(ok.ok, true);
  const prior = await M.bankModelCall(fakeClient([msg("end_turn")]).client, { ...s, maxCostCents: bound + 1, priorCostCents: 5 });
  assert.equal(prior.code, "cost_limit", "what the job spent on its earlier call counts");
});

test("the bound counts every allowed web search and fetch at full size", () => {
  const base = spec();
  const plain = M.requestBoundCents(base, []);
  const tooled = M.requestBoundCents({ ...base, tools: [M.webSearchTool(2), M.webFetchTool(3)] }, []);
  const extra = (2 * M.BOUND_SEARCH_TOKENS + 3 * 12000) * M.UNKNOWN_PRICE.input / 1_000_000 * 100 + 2 * M.WEB_SEARCH_CENTS;
  assert.ok(tooled - plain >= extra - 1, "searches, their results and every fetch's content");
});

test("reserve: called before every request with the job's possible total; a refusal sends nothing", async () => {
  const seen = [];
  const paused = () => msg("pause_turn", [], { usage: usage({ input_tokens: 100_000 }) });
  const { client, calls } = fakeClient([paused(), msg("end_turn")]);
  const r = await M.bankModelCall(client, spec({ priorCostCents: 3, reserve: async (t) => (seen.push(t), true) }));
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(seen[0] >= 3 + M.requestBoundCents(spec(), [{ role: "user", content: "Synthetic user turn." }]) - 0.01);
  assert.ok(seen[1] >= 3 + 20 + 20, "prior + the first turn's cost + at least that much again");
  const refused = fakeClient([msg("end_turn")]);
  const no = await M.bankModelCall(refused.client, spec({ reserve: async () => false }));
  assert.deepEqual([no.ok, no.code, refused.calls.length], [false, "cost_limit", 0]);
  const threw = fakeClient([msg("end_turn")]);
  const t = await M.bankModelCall(threw.client, spec({ reserve: async () => { throw new Error("Synthetic"); } }));
  assert.deepEqual([t.code, threw.calls.length], ["cost_limit", 0]);
});

test("with reserve, maxCostCents is not consulted: the database decides (and is the only gate that pauses a book at its cap)", async () => {
  const s = spec({ maxTokens: 32000, model: "claude-opus-5-5" });
  const bound = M.requestBoundCents(s, [{ role: "user", content: s.user }]);
  // A claim's headroom far under the request's bound would have refused it locally, before reserve ever ran.
  const seen = [];
  const sent = fakeClient([msg("end_turn")]);
  const ok = await M.bankModelCall(sent.client, { ...s, maxCostCents: 1, reserve: async (t) => (seen.push(t), true) });
  assert.equal(ok.ok, true, "reserve said yes, so the request goes out whatever the stale headroom says");
  assert.deepEqual([seen.length, sent.calls.length], [1, 1]);
  assert.ok(seen[0] >= bound - 0.01, "reserve is asked for the whole bound");
  const refused = fakeClient([msg("end_turn")]);
  const no = await M.bankModelCall(refused.client, { ...s, maxCostCents: 100000, reserve: async () => false });
  assert.deepEqual([no.ok, no.code, refused.calls.length], [false, "cost_limit", 0], "reserve said no: nothing is sent");
  // Without reserve the local check is still the gate.
  const local = fakeClient([msg("end_turn")]);
  const l = await M.bankModelCall(local.client, { ...s, maxCostCents: 1 });
  assert.deepEqual([l.ok, l.code, local.calls.length], [false, "cost_limit", 0]);
});

test("deadlineAt: a step's two calls share one deadline; a passed deadline sends nothing", async () => {
  const B = loadTs("lib/reading-bank.ts");
  const now = 1_000_000;
  assert.equal(M.callDeadlineMs({ step: "build", deadlineAt: now + 40_000 }, now), 40_000);
  assert.equal(M.callDeadlineMs({ step: "build", deadlineAt: now + 900_000 }, now), B.STEP_MAX_SECONDS.build * 1000);
  assert.equal(M.callDeadlineMs({ timeoutMs: 5000, deadlineAt: now - 1 }, now), 0);
  assert.equal(M.stepDeadlineAt("build", now), now + B.STEP_MAX_SECONDS.build * 1000);
  const { client, calls } = fakeClient([msg("end_turn")]);
  const r = await M.bankModelCall(client, spec({ step: "build", deadlineAt: Date.now() + 1000 }));
  assert.deepEqual([r.code, calls.length], ["timeout", 0], "less than MIN_TURN_MS left");
  const { client: c2, calls: k2 } = fakeClient([msg("end_turn")]);
  await M.bankModelCall(c2, spec({ step: "build", deadlineAt: Date.now() + 60_000 }));
  assert.ok(k2[0].options.timeout <= 60_000 && k2[0].options.timeout > 50_000);
});

test("a turn a server-side fallback served is priced at the dearer model, over every attempt in usage.iterations", () => {
  const iterations = [
    { type: "message", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: "fallback_message", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ];
  const sticky = { model: "claude-sonnet-5-5", content: [{ type: "text", text: "x" }], usage: usage({ input_tokens: 1_000_000, iterations }) };
  // The requested model's name, a fallback attempt: the serving model is unknown, so UNKNOWN_PRICE; both attempts.
  assert.equal(M.turnCostCents("claude-sonnet-5-5", sticky), 2 * M.UNKNOWN_PRICE.input * 100);
  const mid = { model: "claude-sonnet-5-5", content: [{ type: "text", text: "a" }, { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-opus-5-5" } }], usage: usage({ input_tokens: 1_000_000 }) };
  assert.equal(M.servedModel("claude-sonnet-5-5", mid), "claude-opus-5-5", "the fallback block, not message_start's model");
  assert.equal(M.turnCostCents("claude-sonnet-5-5", mid), 400);
  const plain = { model: "claude-sonnet-5-5", content: [], usage: usage({ input_tokens: 1_000_000 }) };
  assert.equal(M.fellBack("claude-sonnet-5-5", plain), false);
  assert.equal(M.turnCostCents("claude-sonnet-5-5", plain), 200);
  assert.deepEqual(M.billedTokens(usage({ input_tokens: 5, iterations })).input_tokens, 2_000_000);
});
