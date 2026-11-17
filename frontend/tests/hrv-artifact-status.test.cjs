// Run: node --test tests/hrv-artifact-status.test.cjs
// The HRV forecast's model-artifact heartbeat (hrv_predict|model_artifact) surfaced on the HRV
// Analysis /status card. Synthetic inputs only: no real checksums, no real messages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const { hrvArtifactState } = loadTs("lib/hrv-artifact-status.ts");

test("failed heartbeat maps to failed with its own message", () => {
  assert.deepEqual(
    hrvArtifactState({ status: "failed", error_message: "GUARD model_artifact: synthetic refusal" }),
    { status: "failed", errorMessage: "GUARD model_artifact: synthetic refusal" }
  );
});

test("'error' status (cronometer-style) also maps to failed", () => {
  assert.equal(hrvArtifactState({ status: "error", error_message: "synthetic" }).status, "failed");
});

test("partial heartbeat maps to degraded with its message", () => {
  const r = hrvArtifactState({ status: "partial", error_message: "synthetic partial note" });
  assert.equal(r.status, "partial");
  assert.equal(r.errorMessage, "synthetic partial note");
});

test("success maps to healthy with no message (even when the row carries one)", () => {
  assert.deepEqual(hrvArtifactState({ status: "success", error_message: "synthetic" }), {
    status: "success",
    errorMessage: null,
  });
});

test("no row maps to unknown and nothing errors", () => {
  assert.deepEqual(hrvArtifactState(null), { status: "unknown", errorMessage: null });
  // Missing / malformed fields never throw either.
  assert.deepEqual(hrvArtifactState({}), { status: "unknown", errorMessage: null });
  assert.deepEqual(hrvArtifactState({ status: 123, error_message: 42 }), { status: "unknown", errorMessage: null });
});

test("a blank message is dropped, not shown", () => {
  assert.deepEqual(
    hrvArtifactState({ status: "failed", error_message: "  " }),
    { status: "failed", errorMessage: null }
  );
});
