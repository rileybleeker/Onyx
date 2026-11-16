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
  assert.ok(p.tools.every((t) => t.blocked_domains.length > 0 && t.blocked_domains.length <= 64));
  assert.deepEqual(calls[0].options, { timeout: 120000 });
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
