// Run: node --test tests/preprocessing-status.test.cjs
// HRV forecast preprocessing fill (hrv_predict.py, PIPE-07): whether the served model was trained
// with the current sparse-feature fill. Static checks that the /status card is wired in the three
// places AGENTS.md "Every integration must appear on /status" names — the route has a cadence, a
// method, its own heartbeat read and a card that follows the newest heartbeat's status (missing
// heartbeat = unknown); the page lists the card, its badge and its history labels. No network, no
// database, no real data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");

test("the status route has a cadence, a method, its own heartbeat read and a card", () => {
  assert.match(route, /^\s+preprocessing: "With the HRV predict job/m);
  assert.match(route, /^\s+preprocessing:\s+\{ method: "automated"/m);
  assert.match(route, /\.eq\("source", "hrv_predict"\)\.eq\("data_type", "preprocessing"\)/);
  assert.match(route, /latestBySrcType\["hrv_predict\|preprocessing"\]/);
  assert.match(route, /label: "HRV Forecast Fill"/);
  // The card is status-driven: it derives from the newest heartbeat and never reads model rows.
  assert.doesNotMatch(route, /from\("hrv_predictions"\)[^;]*preprocessing/, "the card is heartbeat-driven");
});

test("the status page lists the card and labels its history", () => {
  assert.match(page, /preprocessing: "HRV FORECAST"/);
  assert.match(page, /preprocessing: "text-/);
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"preprocessing"/s);
  assert.match(page, /preprocessing: "Forecast fill"/);
  // The source label already exists (hrv_predict: "HRV Predict").
  assert.match(page, /hrv_predict: "HRV Predict"/);
});