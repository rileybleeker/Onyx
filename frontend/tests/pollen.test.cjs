// Run: node --test tests/pollen.test.cjs
// Pollen panel logic (lib/pollen.ts) and GET /api/pollen's answers. SYNTHETIC counts and dates only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/pollen.ts");

// The ET clock date "now" for these fixtures; the newest air day a range can show is the day before.
const TODAY = "2031-01-01";

function row(date, total, extra = {}) {
  return { count_date: date, total_count: total, count_level: "low", tree_level: null, grass_level: null, weed_level: null, mold_level: null, ...extra };
}

test("a count published on P is plotted on air day P - 1, across month, year and leap boundaries", () => {
  assert.equal(P.airDateFor("2030-03-01"), "2030-02-28");
  assert.equal(P.airDateFor("2032-03-01"), "2032-02-29");
  assert.equal(P.airDateFor("2031-01-01"), "2030-12-31");
  assert.equal(P.airDateFor("2030-05-01"), "2030-04-30");
  const days = P.shapePollenRows([row("2031-01-01", 12), row("2030-03-01", 7)]);
  assert.deepEqual(days.map((d) => [d.countDate, d.airDate]), [["2030-03-01", "2030-02-28"], ["2031-01-01", "2030-12-31"]]);
  const pts = P.chartPoints(days, "90d", TODAY);
  const last = pts[pts.length - 1];
  assert.deepEqual([last.date, last.countDate, last.total], ["2030-12-31", "2031-01-01", 12]);
});

test("a day without a count stays a gap, never 0", () => {
  const days = P.shapePollenRows([row("2030-12-30", 40), row("2031-01-01", 60)]);
  const pts = P.chartPoints(days, "90d", TODAY);
  const byDate = new Map(pts.map((p) => [p.date, p]));
  assert.equal(byDate.get("2030-12-29").total, 40);
  assert.deepEqual(byDate.get("2030-12-30"), { date: "2030-12-30", countDate: null, total: null, level: null });
  assert.equal(byDate.get("2030-12-31").total, 60);
  assert.equal(byDate.get("2030-12-01").total, null);
  assert.equal(P.countsInRange(pts), 2);
});

test("a published 0 is a real 0", () => {
  const days = P.shapePollenRows([row("2030-12-31", 0), row("2030-12-30", "0")]);
  assert.deepEqual(days.map((d) => d.total), [0, 0]);
  const pts = P.chartPoints(days, "90d", TODAY);
  assert.equal(pts.find((p) => p.date === "2030-12-30").total, 0);
  assert.equal(pts.find((p) => p.date === "2030-12-29").total, 0);
  assert.equal(P.countsInRange(pts), 2);
});

test("levels: any case, trimmed; an unknown word or a non-string is null", () => {
  assert.equal(P.parseLevel("HIGH"), "high");
  assert.equal(P.parseLevel(" Low "), "low");
  assert.equal(P.parseLevel("medium"), "medium");
  assert.equal(P.parseLevel("Extreme"), "extreme");
  assert.equal(P.parseLevel("severe"), null);
  assert.equal(P.parseLevel(""), null);
  assert.equal(P.parseLevel(3), null);
  assert.equal(P.parseLevel(null), null);
  const [d] = P.shapePollenRows([row("2030-04-08", 900, { count_level: "Extreme", tree_level: "HIGH", grass_level: "low", weed_level: "bogus", mold_level: "Medium" })]);
  assert.deepEqual([d.level, d.tree, d.grass, d.weed, d.mold], ["extreme", "high", "low", null, "medium"]);
});

test("malformed rows are dropped", () => {
  const days = P.shapePollenRows([
    null, "x", { count_date: "nope", total_count: 3 }, row("2030-02-30", 3), row("2030-01-02", null),
    row("2030-01-03", -1), row("2030-01-04", 1.5), row("2030-01-05", "abc"), { count_date: "2030-01-06" },
    row("2030-01-07", 5), row("2030-01-07", 6),
  ]);
  assert.deepEqual(days.map((d) => [d.countDate, d.total]), [["2030-01-07", 5]]);
});

test("ranges end yesterday (ET) and cover 90 days, 1 year or 2 years of air days", () => {
  assert.equal(P.DEFAULT_POLLEN_RANGE, "1y");
  assert.deepEqual(P.rangeBounds("90d", TODAY), { from: "2030-10-03", to: "2030-12-31" });
  assert.deepEqual(P.rangeBounds("1y", TODAY), { from: "2030-01-01", to: "2030-12-31" });
  assert.deepEqual(P.rangeBounds("2y", TODAY), { from: "2029-01-01", to: "2030-12-31" });
  const days = P.shapePollenRows([row("2029-01-02", 1), row("2030-01-02", 2), row("2030-10-04", 3), row("2030-10-03", 4)]);
  for (const [range, n, counts] of [["90d", 90, 1], ["1y", 365, 3], ["2y", 730, 4]]) {
    const pts = P.chartPoints(days, range, TODAY);
    assert.equal(pts.length, n, range);
    assert.equal(P.countsInRange(pts), counts, range);
  }
  assert.equal(P.countsInRange(P.chartPoints([], "1y", TODAY)), 0);
});

test("the newest count is the latest published date", () => {
  const days = P.shapePollenRows([row("2030-03-02", 1), row("2030-03-05", 2), row("2030-03-03", 3)]);
  assert.equal(P.newestCount(days).countDate, "2030-03-05");
  assert.equal(P.newestCount(days).airDate, "2030-03-04");
  assert.equal(P.newestCount([]), null);
});

function loadRoute(answer) {
  let calls = 0;
  const stubs = {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) } },
    "@/lib/pollen-server": { loadPollen: async () => { calls += 1; return answer; } },
  };
  const route = loadTs("app/api/pollen/route.ts", stubs);
  return { route, calls: () => calls };
}

test("route answers ready with days", async () => {
  const days = P.shapePollenRows([row("2030-03-02", 10)]);
  const { route, calls } = loadRoute({ state: "ready", rows: days });
  const res = await route.GET();
  assert.equal(calls(), 1);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ready", days });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("route answers not_connected when the table is missing", async () => {
  const { route } = loadRoute({ state: "not_connected" });
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "not_connected" });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("route answers 500 with a fixed message on any other read error", async () => {
  const { route } = loadRoute({ state: "error" });
  const res = await route.GET();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "pollen unavailable" });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("route is force-dynamic and outside the CI carve-out", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/pollen/route.ts"), "utf8");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes("/api/pollen"));
});

test("server reader is server-only, reads explicit columns with a limit and maps missing-table codes", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/pollen-server.ts"), "utf8");
  assert.ok(src.startsWith('import "server-only";'));
  assert.match(src, /\.select\(POLLEN_COLUMNS\)/);
  assert.match(src, /\.limit\(POLLEN_ROW_LIMIT\)/);
  assert.match(src, /"42P01", "PGRST205"/);
  assert.ok(!/contributors/.test(P.POLLEN_COLUMNS));
  assert.equal(P.POLLEN_WINDOW_DAYS, 730);
});
