// Run: node --test tests/apple-health.test.cjs
// Apple Health upload from the Onyx iPhone app (2026-11-17): pure validation in lib/apple-health.ts, and the
// wiring AGENTS.md asks for (exact CI path in middleware, /status card on the heartbeat only). Synthetic data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const lib = loadTs("lib/apple-health.ts");
const NOW = Date.parse("2026-11-17T15:00:00Z");

test("hourly rows: known metrics only, units set by the server, a repeat keeps the last", () => {
  const ok = lib.parseHourly(
    [
      { metric: "steps", start: "2026-11-17T12:00:00Z", value: 812 },
      { metric: "steps", start: "2026-11-17T12:00:00Z", value: 900 },
      { metric: "walking_speed_ms", start: "2026-11-17T12:00:00Z", value: 1.31, samples: 14 },
    ],
    "iphone",
    NOW,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.rows.length, 2);
  const steps = ok.rows.find((r) => r.metric === "steps");
  assert.equal(steps.value, 900);
  assert.equal(steps.unit, "count");
  assert.equal(steps.samples, null);
  assert.equal(ok.rows.find((r) => r.metric === "walking_speed_ms").samples, 14);
  assert.equal(lib.parseHourly([{ metric: "heart_rate", start: "2026-11-17T12:00:00Z", value: 60 }], "iphone", NOW).ok, false);
  assert.equal(lib.parseHourly([{ metric: "steps", start: "2026-11-17T12:00:00Z", value: -1 }], "iphone", NOW).ok, false);
  assert.equal(lib.parseHourly([{ metric: "steps", start: "2026-11-17T12:00:00Z", value: 99999 }], "iphone", NOW).ok, false);
  assert.equal(lib.parseHourly([{ metric: "steps", start: "2030-01-01T00:00:00Z", value: 5 }], "iphone", NOW).ok, false);
  assert.deepEqual(lib.parseHourly(undefined, "iphone", NOW), { ok: true, rows: [] });
});

test("workouts and State of Mind are validated and keyed by uuid", () => {
  const w = lib.parseWorkouts(
    [{ uuid: "a1", type: "running", start: "2026-11-16T10:00:00Z", end: "2026-11-16T10:30:00Z", duration_s: 1800, distance_m: 5000, source: "Strava" }],
    "iphone",
    NOW,
  );
  assert.equal(w.ok, true);
  assert.equal(w.rows[0].source_name, "Strava");
  assert.equal(w.rows[0].energy_kcal, null);
  assert.equal(
    lib.parseWorkouts([{ uuid: "a1", type: "running", start: "2026-11-16T10:30:00Z", end: "2026-11-16T10:00:00Z", duration_s: 1 }], "iphone", NOW).ok,
    false,
  );
  const m = lib.parseMind(
    [{ uuid: "m1", at: "2026-11-16T20:00:00Z", kind: "daily_mood", valence: 0.4, labels: ["calm", "calm", "happy"], associations: ["work"] }],
    "iphone",
    NOW,
  );
  assert.equal(m.ok, true);
  assert.deepEqual(m.rows[0].labels, ["calm", "happy"]);
  assert.equal(lib.parseMind([{ uuid: "m2", at: "2026-11-16T20:00:00Z", kind: "daily_mood", valence: 1.5 }], "iphone", NOW).ok, false);
  assert.equal(lib.parseMind([{ uuid: "m3", at: "2026-11-16T20:00:00Z", kind: "other", valence: 0 }], "iphone", NOW).ok, false);
});

test("a failure report becomes a heartbeat text without data", () => {
  assert.match(lib.healthFailureMessage({ stage: "access", message: "denied" }, "0.2.0 (3)"), /failed \(access\): denied \[app 0\.2\.0 \(3\)\]/);
  assert.match(lib.healthFailureMessage({ stage: "bogus" }, null), /failed \(unknown\): no detail/);
});

test("wiring: one exact CI path, the route never widens it, the card reads the heartbeat only", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.match(mw, /pathname === "\/api\/apple-health\/import"/);
  assert.doesNotMatch(mw, /startsWith\("\/api\/apple-health/);
  const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
  assert.match(route, /\["apple_health", "samples"\]/);
  assert.match(route, /latestBySrcType\["apple_health\|samples"\]/);
  assert.match(route, /label: "Apple Health"/);
  assert.doesNotMatch(route, /from\("apple_health_/);
  const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"apple_health"/s);
  assert.match(page, /apple_health: "Apple Health"/);
});
