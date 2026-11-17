// Write-capable sends must not go out unless their recovery record is kept on this device (SEC-04): if the storage is
// full or blocked, a reload that lost the answer would mint a new request id and write the same thing twice. The gate
// that refuses such a send (frontend/src/lib/chat-contract.ts) is exercised here with a fake localStorage whose
// setItem throws, and a structural check proves the chat page routes a blocked write-capable send to the visible
// message before it ever calls /api/chat. Read-only questions still send. Synthetic data only, no secrets.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadTs } = require("./helpers/load-ts.cjs");
const F = require("./helpers/source-facts.cjs");

const ep = loadTs("lib/chat-contract.ts");

const CONV = "0".repeat(63) + "1"; // a 64-hex conversation hash (never a real one)
const SEND = { conv: CONV, id: randomUUID(), at: Date.now() };

/** A fake window.localStorage whose setItem throws, exactly as storage-full / blocked reads on the device. */
function blockedStore() {
  return {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() {},
  };
}

test("a write-capable send whose record cannot be kept is refused with the visible message; read-only is not", () => {
  const store = blockedStore();
  // Confirms the record write itself fails on this device (the storage sim really is blocked).
  assert.throws(() => ep.storePendingSend(store, SEND), /QuotaExceededError/);
  // So the record is not kept, and a write-capable send must not go out: refused with the one short line.
  assert.deepEqual(ep.writeForwardGate(true, false), { ok: false, message: ep.WRITE_FORWARD_GATE_MESSAGE });
  assert.ok(ep.WRITE_FORWARD_GATE_MESSAGE, "the refusal has a visible message");
  // A read-only question may be sent even when no record is kept.
  assert.deepEqual(ep.writeForwardGate(false, false), { ok: true, message: null });
});

test("a write-capable send whose record IS kept goes out, and the message is not shown", () => {
  const store = { length: 1, key: (i) => (i === 0 ? "k" : null), getItem: (k) => (k === "k" ? "1" : null), setItem() {}, removeItem() {} };
  ep.storePendingSend(store, SEND);
  assert.deepEqual(ep.writeForwardGate(true, true), { ok: true, message: null });
});

test("the chat page holds a blocked write-capable send back and shows the message before it calls /api/chat", () => {
  const sf = F.parseFile("app/chat/page.tsx");
  const send = F.functionNamed(sf, "send");
  assert.ok(send, "chat/page.tsx exports a send function");
  const calls = F.calls(send);
  const gate = calls.find((c) => c.name === "writeForwardGate");
  assert.ok(gate, "send runs the write-forward gate");
  const refusal = calls.find((c) => c.name === "setError" && F.refName(c.node.arguments?.[0]) === "WRITE_FORWARD_GATE_MESSAGE");
  assert.ok(refusal, "the gate's refusal sets the visible WRITE_FORWARD_GATE_MESSAGE as the error");
  const fetchChat = calls.find((c) => c.name === "fetch" && F.literalText(c.node.arguments?.[0]) === "/api/chat");
  assert.ok(fetchChat, "send posts to /api/chat");
  let refusalIf = refusal.node;
  while (refusalIf && !F.ts.isIfStatement(refusalIf)) refusalIf = refusalIf.parent;
  assert.ok(refusalIf, "the refusal is inside an if");
  assert.ok(F.collect(refusalIf, (n) => F.ts.isReturnStatement(n)).length > 0, "the refusal returns without sending");
  assert.ok(refusalIf.pos < fetchChat.node.pos, "a blocked write-capable send returns before /api/chat is called");
});