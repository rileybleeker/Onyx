// Run: node --test tests/forecast-goal-accessible-names.test.cjs
// The savings-goal form in ProjectionParts.tsx gives each of its three unlabeled inputs an
// accessible name (aria-label), so screen readers do not announce them unnamed.
// Reads the component source as text. SYNTHETIC values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const src = fs.readFileSync(path.join(SRC, "app", "financials", "forecast", "ProjectionParts.tsx"), "utf8");

// The opening tag of the first <input> whose placeholder or type matches `marker`.
function inputTag(marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker not found: ${marker}`);
  const open = src.lastIndexOf("<input", start);
  const close = src.indexOf("/>", open);
  return src.slice(open, close + 2);
}

test("the goal name input has the aria-label Goal name", () => {
  assert.match(inputTag('placeholder="Goal (e.g. NYC move fund)"'), /aria-label="Goal name"/);
});

test("the goal target input has the aria-label Goal target amount", () => {
  assert.match(inputTag('placeholder="$ target"'), /aria-label="Goal target amount"/);
});

test("the goal date input has the aria-label Goal date", () => {
  assert.match(inputTag('type="date" value={date}'), /aria-label="Goal date"/);
});
