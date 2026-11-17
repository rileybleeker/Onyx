// Run: node --test tests/planned-account-name.test.cjs
// The planned-account input in PlanConfig.tsx keeps an accessible name after the placeholder
// disappears. Reads the component source as text. SYNTHETIC values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

test("the planned-account input has aria-label=\"Planned account name\"", () => {
  const file = path.join(SRC, "app/financials/forecast/PlanConfig.tsx");
  assert.ok(
    fs.readFileSync(file, "utf8").includes('aria-label="Planned account name"'),
    "PlanConfig.tsx should name the planned-account input",
  );
});

test("the adjust editor's date and amount inputs have aria-labels naming the stream", () => {
  const source = fs.readFileSync(path.join(SRC, "app/financials/forecast/PlanConfig.tsx"), "utf8");
  assert.ok(
    source.includes("aria-label={`Adjustment start date for ${s.label}`}"),
    "the adjust editor's date input should be named",
  );
  assert.ok(
    source.includes("aria-label={`Adjustment amount for ${s.label}`}"),
    "the adjust editor's amount input should be named",
  );
});
