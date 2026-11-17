// Run: node --test tests/log-supplement-batch.test.cjs
// /log Supplements, "Log a product" several at once: logEach (lib/log-supplement-batch.ts) writes each checked product
// on its own, in order, and tracks each result. A product that logged is never sent again (so a retry cannot log it
// twice); a failure does not stop the rest; a throw counts as not saved.
// SYNTHETIC DATA ONLY: invented product ids and names; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const B = loadTs("lib/log-supplement-batch.ts");
const items = (...keys) => keys.map((key) => ({ key }));

test("all succeed: every item is logged, in the order given", async () => {
  const sent = [];
  const out = await B.logEach(items("p-a", "p-b", "p-c"), async (it) => { sent.push(it.key); return null; });
  assert.deepEqual(sent, ["p-a", "p-b", "p-c"]);
  for (const k of ["p-a", "p-b", "p-c"]) assert.deepEqual(out.get(k), { status: "logged", error: null });
});

test("one failure: it stays failed with its message, the others still log", async () => {
  const out = await B.logEach(items("p-a", "p-b", "p-c"), async (it) => (it.key === "p-b" ? "Synthetic refusal" : null));
  assert.deepEqual(out.get("p-a"), { status: "logged", error: null });
  assert.deepEqual(out.get("p-b"), { status: "failed", error: "Synthetic refusal" });
  assert.deepEqual(out.get("p-c"), { status: "logged", error: null });
});

test("a throw counts as not saved, with a short message; the run goes on", async () => {
  const out = await B.logEach(items("p-a", "p-b"), async (it) => {
    if (it.key === "p-a") throw new Error("synthetic network failure");
    return null;
  });
  assert.equal(out.get("p-a").status, "failed");
  assert.equal(out.get("p-a").error, "No answer from Onyx");
  assert.equal(out.get("p-b").status, "logged");
});

test("a retry sends only what failed: a logged product is never sent again", async () => {
  const first = await B.logEach(items("p-a", "p-b"), async (it) => (it.key === "p-b" ? "Synthetic refusal" : null));
  const sent = [];
  const second = await B.logEach(items("p-a", "p-b"), async (it) => { sent.push(it.key); return null; }, first);
  assert.deepEqual(sent, ["p-b"], "p-a logged the first time and is not sent again");
  assert.equal(second.get("p-a").status, "logged");
  assert.equal(second.get("p-b").status, "logged");
});

test("a retry of a logged product sends nothing at all", async () => {
  const first = await B.logEach(items("p-a"), async () => null);
  let calls = 0;
  const second = await B.logEach(items("p-a"), async () => { calls += 1; return null; }, first);
  assert.equal(calls, 0);
  assert.equal(second.get("p-a").status, "logged");
});

test("the previous map is not mutated; onResult reports each item as it lands", async () => {
  const first = new Map([["p-x", { status: "failed", error: "old" }]]);
  const seen = [];
  const out = await B.logEach(items("p-x", "p-y"), async () => null, first, (k, r) => seen.push([k, r.status]));
  assert.equal(first.get("p-x").error, "old", "input untouched");
  assert.deepEqual(seen, [["p-x", "logged"], ["p-y", "logged"]]);
  assert.equal(out.get("p-x").status, "logged");
});

test("an empty or missing error text is still a failure, never a success", async () => {
  const out = await B.logEach(items("p-a", "p-b"), async (it) => (it.key === "p-a" ? "" : undefined));
  assert.equal(out.get("p-a").status, "failed");
  assert.equal(out.get("p-b").status, "failed");
});
