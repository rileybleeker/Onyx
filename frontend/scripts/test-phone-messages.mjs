// Synthetic tests for the disabled iPhone Messages gate (src/lib/phone-messages.ts).
// No network, no files outside the repo source, no credentials, no real messages.
// Run: node scripts/test-phone-messages.mjs   (CI auto-discovers scripts/test-*.mjs)
// The TypeScript module is compiled in-process with the repo's own `typescript`
// package, so this does not depend on the Node version's type-stripping support.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const lib = await loadTs("../src/lib/phone-messages.ts");
const {
  createPhoneMessagesService,
  isFlagOn,
  NO_CAPABILITIES,
  PHONE_MESSAGES_FLAG,
  PHONE_MESSAGES_SEND_FLAG,
} = lib;

async function loadTs(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
}

const SYNTH_BODY = "SYNTHETIC-BODY-do-not-leak";

function spyAdapter(caps = {}, overrides = {}) {
  const calls = { list: 0, read: 0, send: 0 };
  const adapter = {
    capabilities: { ...NO_CAPABILITIES, ...caps },
    async listConversations() {
      calls.list++;
      return [{ id: "synthetic-c1" }];
    },
    async readMessages() {
      calls.read++;
      return { messages: [{ id: "synthetic-m1" }], cursor: "c2" };
    },
    async send() {
      calls.send++;
      return { id: "synthetic-sent-1" };
    },
    ...overrides,
  };
  return { adapter, calls };
}

function makeService(env, adapter) {
  const state = { env, created: 0 };
  const service = createPhoneMessagesService({
    getEnv: () => state.env,
    createAdapter: adapter
      ? () => {
          state.created++;
          return adapter;
        }
      : undefined,
  });
  return { service, state };
}

const SEND = { conversationId: "synthetic-c1", recipient: "synthetic-r1", body: SYNTH_BODY };
const READ = { conversationId: "synthetic-c1", mode: "historical" };

test("flag is on only for the exact string 'true'", () => {
  for (const v of [undefined, "", "false", "1", "TRUE", "True", "yes", "on", " true", "true "]) {
    assert.equal(isFlagOn({ [PHONE_MESSAGES_FLAG]: v }, PHONE_MESSAGES_FLAG), false, JSON.stringify(v));
  }
  assert.equal(isFlagOn({ [PHONE_MESSAGES_FLAG]: "true" }, PHONE_MESSAGES_FLAG), true);
});

test("disabled by default: status is off, all capabilities false, nothing created", () => {
  const { adapter } = spyAdapter({ historicalRead: true, send: true });
  const { service, state } = makeService({}, adapter);
  const s = service.status();
  assert.equal(s.enabled, false);
  assert.equal(s.sendEnabled, false);
  assert.equal(s.adapterRegistered, false);
  assert.equal(s.reason, "flag_off");
  assert.deepEqual(s.capabilities, NO_CAPABILITIES);
  assert.equal(state.created, 0);
});

test("disabled: list, read and send never create or call the adapter and never fetch", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches++;
    throw new Error("network must not be touched");
  };
  try {
    const { adapter, calls } = spyAdapter({ historicalRead: true, incrementalRead: true, send: true });
    // Even the send flag alone (without the main flag) must not open anything.
    for (const env of [{}, { [PHONE_MESSAGES_SEND_FLAG]: "true" }, { [PHONE_MESSAGES_FLAG]: "false" }]) {
      const { service, state } = makeService(env, adapter);
      assert.deepEqual(await service.listConversations(), { ok: false, reason: "flag_off" });
      assert.deepEqual(await service.readMessages(READ), { ok: false, reason: "flag_off" });
      assert.deepEqual(await service.send(SEND, { ...SEND }), { ok: false, reason: "flag_off" });
      assert.equal(state.created, 0);
    }
    assert.deepEqual(calls, { list: 0, read: 0, send: 0 });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("flag on but no adapter: unavailable, never a fabricated empty inbox", async () => {
  const { service } = makeService({ [PHONE_MESSAGES_FLAG]: "true" }, undefined);
  assert.equal(service.status().reason, "no_supported_adapter");
  assert.equal(service.status().adapterRegistered, false);
  for (const r of [await service.listConversations(), await service.readMessages(READ)]) {
    assert.deepEqual(r, { ok: false, reason: "no_supported_adapter" });
    assert.equal("value" in r, false);
  }
  assert.deepEqual(await service.send(SEND, { ...SEND }), { ok: false, reason: "send_flag_off" });
});

test("adapter factory returning null is treated as no adapter", async () => {
  const service = createPhoneMessagesService({
    getEnv: () => ({ [PHONE_MESSAGES_FLAG]: "true" }),
    createAdapter: () => null,
  });
  assert.deepEqual(await service.listConversations(), { ok: false, reason: "no_supported_adapter" });
});

test("status never creates the adapter even when enabled", () => {
  const { adapter } = spyAdapter({ historicalRead: true });
  const { service, state } = makeService({ [PHONE_MESSAGES_FLAG]: "true" }, adapter);
  const s = service.status();
  assert.equal(s.enabled, true);
  assert.equal(s.reason, "ready");
  assert.deepEqual(s.capabilities, NO_CAPABILITIES);
  assert.equal(state.created, 0);
});

test("enabled with a synthetic adapter: reads need the matching capability", async () => {
  const env = { [PHONE_MESSAGES_FLAG]: "true" };
  const hist = spyAdapter({ historicalRead: true });
  const a = makeService(env, hist.adapter).service;
  assert.equal((await a.readMessages(READ)).ok, true);
  assert.deepEqual(await a.readMessages({ ...READ, mode: "incremental", cursor: "c1" }), {
    ok: false,
    reason: "capability_missing",
  });
  assert.equal(hist.calls.read, 1);

  const incr = spyAdapter({ incrementalRead: true });
  const b = makeService(env, incr.adapter).service;
  assert.deepEqual(await b.readMessages(READ), { ok: false, reason: "capability_missing" });
  assert.equal(incr.calls.read, 0);
});

test("a read-only connection cannot send, whatever the adapter claims", async () => {
  const { adapter, calls } = spyAdapter({ historicalRead: true, send: true });
  const { service } = makeService({ [PHONE_MESSAGES_FLAG]: "true" }, adapter);
  assert.deepEqual(await service.send(SEND, { ...SEND }), { ok: false, reason: "send_flag_off" });
  assert.equal(calls.send, 0);
});

test("send needs the send flag, the capability and an exact approval", async () => {
  const env = { [PHONE_MESSAGES_FLAG]: "true", [PHONE_MESSAGES_SEND_FLAG]: "true" };

  const noCap = spyAdapter({ historicalRead: true });
  assert.deepEqual(await makeService(env, noCap.adapter).service.send(SEND, { ...SEND }), {
    ok: false,
    reason: "capability_missing",
  });

  const { adapter, calls } = spyAdapter({ send: true });
  const { service } = makeService(env, adapter);
  assert.deepEqual(await service.send(SEND, null), { ok: false, reason: "approval_missing" });
  for (const field of ["conversationId", "recipient", "body"]) {
    const wrong = { ...SEND, [field]: "something-else" };
    assert.deepEqual(await service.send(SEND, wrong), { ok: false, reason: "approval_missing" }, field);
  }
  assert.equal(calls.send, 0);

  assert.deepEqual(await service.send(SEND, { ...SEND }), { ok: true, value: { id: "synthetic-sent-1" } });
  assert.equal(calls.send, 1);
});

test("revocation: switching the flag off stops the very next call", async () => {
  const { adapter, calls } = spyAdapter({ historicalRead: true });
  const { service, state } = makeService({ [PHONE_MESSAGES_FLAG]: "true" }, adapter);
  assert.equal((await service.readMessages(READ)).ok, true);
  state.env = {};
  assert.deepEqual(await service.readMessages(READ), { ok: false, reason: "flag_off" });
  assert.deepEqual(await service.listConversations(), { ok: false, reason: "flag_off" });
  assert.equal(calls.read, 1);
  assert.equal(calls.list, 0);
});

test("adapter failures become a fixed code; adapter text and message bodies never escape", async () => {
  const boom = () => {
    throw new Error(`secret ${SYNTH_BODY} +15555550100`);
  };
  const { adapter } = spyAdapter(
    { historicalRead: true, send: true },
    {
      listConversations: async () => boom(),
      readMessages: async () => boom(),
      send: async () => boom(),
    },
  );
  const env = { [PHONE_MESSAGES_FLAG]: "true", [PHONE_MESSAGES_SEND_FLAG]: "true" };
  const { service } = makeService(env, adapter);
  const results = [
    await service.listConversations(),
    await service.readMessages(READ),
    await service.send(SEND, { ...SEND }),
  ];
  for (const r of results) {
    assert.deepEqual(r, { ok: false, reason: "adapter_error" });
    assert.equal(JSON.stringify(r).includes(SYNTH_BODY), false);
  }
  // A factory that throws is also contained.
  const thrower = createPhoneMessagesService({
    getEnv: () => env,
    createAdapter: () => boom(),
  });
  assert.deepEqual(await thrower.listConversations(), { ok: false, reason: "adapter_error" });
});

test("module source stays inert: no imports, network, filesystem or process state", () => {
  const src = readFileSync(new URL("../src/lib/phone-messages.ts", import.meta.url), "utf8");
  // Strip comments so the header that names these things does not trip the scan.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const banned = [/^\s*import\s/m, /\brequire\s*\(/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bprocess\./, /node:/, /\bfs\b/];
  for (const pattern of banned) {
    assert.equal(pattern.test(code), false, String(pattern));
  }
});

test("status route is GET-only and builds no adapter", () => {
  const src = readFileSync(new URL("../src/app/api/phone-messages/status/route.ts", import.meta.url), "utf8");
  assert.match(src, /export async function GET\b/);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(src), false, m);
  }
  assert.equal(/createAdapter/.test(src), false);
});
