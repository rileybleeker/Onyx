// Offline checks for the Uber Rides /status card: Latest Data is the end of the recorded
// ride date range, never the import time. Synthetic values only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "src");
const load = (rel) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(SRC, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} };
  new Function("exports", "module", outputText)(mod.exports, mod);
  return mod.exports;
};
const { uberRidesLatestDataDate } = load("lib/uber-rides-status.ts");

test("older export: Latest Data is the range end, not the import day", () => {
  const entry = { sync_start: "2030-06-20T12:00:00+00:00", date_range_start: "2029-01-05", date_range_end: "2029-03-14" };
  assert.equal(uberRidesLatestDataDate(entry), "2029-03-14");
});

test("no recorded range: no date, never the import time", () => {
  assert.equal(uberRidesLatestDataDate({ sync_start: "2030-06-20T12:00:00+00:00", date_range_end: null }), null);
  assert.equal(uberRidesLatestDataDate({ sync_start: "2030-06-20T12:00:00+00:00" }), null);
  assert.equal(uberRidesLatestDataDate(null), null);
});

test("route reads date_range_end and uses the helper for the uber_rides card", () => {
  const src = fs.readFileSync(path.join(SRC, "app", "api", "status", "route.ts"), "utf8");
  assert.match(src, /SYNC_LOG_COLS = "[^"]*date_range_end"/);
  assert.match(src, /latestDataDate: uberRidesLatestDataDate\(entry\)/);
});
