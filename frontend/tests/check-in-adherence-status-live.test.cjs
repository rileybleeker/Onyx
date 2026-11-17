// Run from frontend: node --test tests/check-in-adherence-status-live.test.cjs
// Reads the component source as text. No app server, auth or personal data is used.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const src = fs.readFileSync(path.join(SRC, "app/check-in/ExperimentAdherence.tsx"), "utf8");

test("saving state is a polite status live region", () => {
  assert.match(src, /<span role="status"[^>]*>Saving…<\/span>/);
});

test("saved state is a polite status live region", () => {
  assert.match(src, /<span role="status"[^>]*><Check [^>]*\/> Saved<\/span>/);
});

test("saved-as-you-tap state is a polite status live region", () => {
  assert.match(src, /<span role="status"[^>]*>Saved as you tap\.<\/span>/);
});

test("save error is an alert live region", () => {
  assert.match(src, /<span role="alert"[^>]*>\{error\}<\/span>/);
});
