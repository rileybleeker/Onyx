// Run: node --test tests/air-quality.test.cjs
// PM2.5 panel logic (lib/air-quality.ts) and the route's access rules. SYNTHETIC numbers only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const A = loadTs("lib/air-quality.ts");

function row(date, mean, hours = 24, max = null) {
  return { calendar_date: date, pm25_mean: mean, pm25_max: max ?? mean * 2, us_aqi_max: 50, n_hours: hours, latitude: 10.5, longitude: 20.5 };
}

test("a day with fewer than 20 hours is partial", () => {
  assert.equal(A.isPartialDay(19), true);
  assert.equal(A.isPartialDay(20), false);
  assert.equal(A.isPartialDay(24), false);
  const days = A.shapeAirRows([row("2030-01-02", 5, 19), row("2030-01-01", 4, 24)]);
  assert.deepEqual(days.map((d) => [d.date, d.partial]), [["2030-01-01", false], ["2030-01-02", true]]);
});

test("rows with a bad date or hour count are dropped", () => {
  assert.equal(A.shapeAirRows([{ calendar_date: "nope", n_hours: 24 }, null, row("2030-01-01", 1, 24)]).length, 1);
});

test("30-day mean ignores partial days and handles empty", () => {
  assert.equal(A.mean30([]), null);
  const days = A.shapeAirRows([row("2030-01-01", 10), row("2030-01-02", 20), row("2030-01-03", 100, 5)]);
  assert.equal(A.mean30(days), 15);
  assert.equal(A.mean30(A.shapeAirRows([row("2030-01-03", 100, 5)])), null);
});

test("30-day mean only spans the 30 days ending at the newest complete day", () => {
  const days = A.shapeAirRows([row("2030-01-01", 100), row("2030-03-01", 10), row("2030-03-02", 20)]);
  assert.equal(A.mean30(days), 15);
});

test("newest complete day skips a partial today", () => {
  const days = A.shapeAirRows([row("2030-01-01", 1), row("2030-01-02", 2), row("2030-01-03", 3, 6)]);
  assert.equal(A.newestCompleteDate(days), "2030-01-02");
  assert.equal(A.newestCompleteDate([]), null);
});

test("chart points put a partial day in the dimmer series", () => {
  const pts = A.chartPoints(A.shapeAirRows([row("2030-01-01", 4), row("2030-01-02", 6, 3)]));
  assert.deepEqual([pts[0].mean, pts[0].partialMean], [4, null]);
  assert.deepEqual([pts[1].mean, pts[1].partialMean], [null, 6]);
});

test("route is force-dynamic, no-store, and outside the CI carve-out", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/air-quality/route.ts"), "utf8");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /no-store/);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes("air-quality"));
});

test("server reader starts with the server-only import", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/air-quality-server.ts"), "utf8");
  assert.ok(src.startsWith('import "server-only";'));
});
