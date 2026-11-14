// Run: node --test tests/sweet-spot.test.cjs
// Environment Sweet Spot (lib/sweet-spot.ts): the quadratic fit, the bucketing, the row shaping
// and the matview read in lib/queries-hrv.ts. SYNTHETIC numbers only, no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/sweet-spot.ts");

// Deterministic noise in [-1, 1) so the tests never depend on Math.random.
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}
const xs = (n, lo, hi) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? "value"}: ${a} vs ${b} (tol ${tol})`);

test("a known parabola recovers its vertex and coefficients", () => {
  // y = -0.5 (x - 68)^2 + 60  ->  a = -0.5, b = 68, c = -2252
  const pts = xs(40, 60, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 }));
  const fit = S.fitQuadratic(pts);
  assert.equal(fit.status, "ok");
  assert.equal(fit.n, 40);
  close(fit.peak.x, 68, 1e-6, "vertex x");
  close(fit.peak.y, 60, 1e-6, "vertex y");
  close(fit.curve.a, -0.5, 1e-8, "a");
  close(fit.curve.b, 68, 1e-6, "b");
  close(fit.curve.c, -2252, 1e-4, "c");
  close(fit.curve.r2, 1, 1e-9, "r2");
  close(S.predictQuadratic(fit.curve, 64), 52, 1e-6, "prediction");
  assert.deepEqual([fit.xMin, fit.xMax], [60, 76]);
});

test("a noisy parabola still lands near its vertex", () => {
  const rnd = noise(7);
  const pts = xs(120, 60, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 + 3 * rnd() }));
  const fit = S.fitQuadratic(pts);
  assert.equal(fit.status, "ok");
  close(fit.peak.x, 68, 0.5, "vertex x");
  close(fit.peak.y, 60, 1.5, "vertex y");
  assert.ok(fit.curve.curvatureT < -S.SWEET_SPOT_MIN_CURVATURE_T);
});

test("large input values (calorie scale) stay numerically stable", () => {
  const pts = xs(60, 1200, 4200).map((x) => ({ x, y: -0.00001 * (x - 2600) ** 2 + 55 }));
  const fit = S.fitQuadratic(pts);
  assert.equal(fit.status, "ok");
  close(fit.peak.x, 2600, 1e-3, "vertex x");
  close(fit.peak.y, 55, 1e-6, "vertex y");
});

test("flat data draws a line but names no peak", () => {
  const constant = S.fitQuadratic(xs(40, 60, 76).map((x) => ({ x, y: 50 })));
  assert.equal(constant.status, "flat");
  assert.equal(constant.peak, null);
  close(S.predictQuadratic(constant.curve, 70), 50, 1e-9, "flat prediction");

  // Pure noise around a constant, many seeds: a bend that is not clear of noise never yields a peak.
  let peaks = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = noise(seed);
    const fit = S.fitQuadratic(xs(40, 60, 76).map((x) => ({ x, y: 50 + 5 * rnd() })));
    assert.notEqual(fit.curve, null);
    if (fit.peak) {
      peaks++;
      assert.ok(Math.abs(fit.curve.curvatureT) >= S.SWEET_SPOT_MIN_CURVATURE_T);
    } else {
      assert.notEqual(fit.status, "ok");
    }
  }
  // The threshold is a noise filter, not a guarantee: about 2% of pure-noise samples still pass
  // it (39 of 2000 seeds when measured), which is why the panel words a weak bend as tentative.
  assert.ok(peaks <= 12, `noise produced ${peaks} peaks out of 200`);
});

test("a straight line has no peak", () => {
  const fit = S.fitQuadratic(xs(40, 0, 600).map((x) => ({ x, y: 2 * x + 1 })));
  assert.equal(fit.status, "flat");
  assert.equal(fit.peak, null);
  close(S.predictQuadratic(fit.curve, 300), 601, 1e-6, "line prediction");
});

test("a convex curve has no peak", () => {
  const fit = S.fitQuadratic(xs(40, 60, 76).map((x) => ({ x, y: 0.5 * (x - 68) ** 2 + 40 })));
  assert.equal(fit.status, "convex");
  assert.equal(fit.peak, null);
  assert.ok(fit.curve.a > 0);
});

test("a concave curve whose high point is outside the observed range has no peak", () => {
  const rising = S.fitQuadratic(xs(40, 60, 66).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 })));
  assert.equal(rising.status, "outside_range");
  assert.equal(rising.peak, null);
  assert.notEqual(rising.curve, null);
  const falling = S.fitQuadratic(xs(40, 70, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 })));
  assert.equal(falling.status, "outside_range");
  // A high point exactly on the edge of the data is not inside it.
  const edge = S.fitQuadratic(xs(40, 60, 68).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 })));
  assert.equal(edge.peak, null);
});

test("too few points: no curve and no peak", () => {
  const parabola = (n) => xs(n, 60, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 }));
  assert.equal(S.SWEET_SPOT_MIN_NIGHTS_FIT, 30);
  const under = S.fitQuadratic(parabola(29));
  assert.deepEqual([under.status, under.curve, under.peak, under.n], ["too_few", null, null, 29]);
  assert.equal(S.fitQuadratic(parabola(30)).status, "ok");
  assert.equal(S.fitQuadratic([]).status, "too_few");
  // The floor of 4 holds even when a caller asks for less.
  assert.equal(S.fitQuadratic(parabola(3), 1).status, "too_few");
});

test("fewer than three distinct input values is degenerate", () => {
  const two = Array.from({ length: 40 }, (_, i) => ({ x: i % 2 ? 60 : 70, y: 50 + (i % 5) }));
  assert.deepEqual([S.fitQuadratic(two).status, S.fitQuadratic(two).curve], ["degenerate", null]);
  const one = Array.from({ length: 40 }, (_, i) => ({ x: 65, y: 50 + (i % 5) }));
  assert.equal(S.fitQuadratic(one).status, "degenerate");
});

test("non-finite points are ignored", () => {
  const pts = xs(40, 60, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 }));
  const fit = S.fitQuadratic([...pts, { x: NaN, y: 1 }, { x: 1, y: Infinity }]);
  assert.equal(fit.n, 40);
  close(fit.peak.x, 68, 1e-6, "vertex x");
});

test("buckets: means, SEM, empty buckets kept, width doubled past the cap", () => {
  const { size, buckets } = S.bucketSweetSpot(
    [{ x: 60.5, y: 10 }, { x: 61.9, y: 20 }, { x: 66, y: 7 }, { x: NaN, y: 1 }], 2);
  assert.equal(size, 2);
  assert.deepEqual(buckets.map((b) => [b.start, b.end, b.n, b.meanY]), [[60, 62, 2, 15], [62, 64, 0, null], [64, 66, 0, null], [66, 68, 1, 7]]);
  close(buckets[0].sem, Math.sqrt(50) / Math.sqrt(2), 1e-9, "sem");
  assert.deepEqual([buckets[1].sem, buckets[1].sd, buckets[3].sem], [null, null, 0]);
  assert.equal(buckets[0].mid, 61);

  const wide = S.bucketSweetSpot([{ x: 0, y: 1 }, { x: 999, y: 2 }], 10, 24);
  assert.equal(wide.size, 80);
  assert.ok(wide.buckets.length <= 24);
  assert.equal(wide.buckets.reduce((s, b) => s + b.n, 0), 2);

  // Negative inputs (a meal logged after sleep onset) bucket below zero.
  const neg = S.bucketSweetSpot([{ x: -45, y: 1 }, { x: 10, y: 3 }], 60);
  assert.deepEqual(neg.buckets.map((b) => [b.start, b.n]), [[-60, 1], [0, 1]]);
  assert.deepEqual(S.bucketSweetSpot([], 2).buckets, []);
});

test("row shaping: temperature comes from the NEXT row, day inputs from the same row", () => {
  const raw = [
    // No HRV: never a night of its own, but it carries the temperature of 2030-01-02's sleep.
    { onyx_behavioral_date: "2030-01-03", whoop_hrv_rmssd: null, eight_sleep_room_temp: 21, eight_sleep_bed_temp: 30 },
    { onyx_behavioral_date: "2030-01-02", whoop_hrv_rmssd: "55.123456", whoop_recovery_score: 70, whoop_sleep_efficiency: 91.5,
      whoop_deep_sleep_milli: 5400000, eight_sleep_room_temp: 99, eight_sleep_bed_temp: 98,
      meal_last_meal_to_bedtime_min: "-45.19683", nutrition_calories: 2500, caffeine_total_mg: 200, caffeine_mg_at_bedtime: 12.345 },
    { onyx_behavioral_date: "2030-01-01", whoop_hrv_rmssd: 40, eight_sleep_room_temp: null, eight_sleep_bed_temp: null },
    { onyx_behavioral_date: "2030-01-05", whoop_hrv_rmssd: 60 },
    { onyx_behavioral_date: "2030-01-06", whoop_hrv_rmssd: 61, nutrition_calories: 1800 },
  ];
  const rows = S.shapeSweetSpotRows(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    // 01-01 pairs with the temperatures stored on 01-02.
    { d: "2030-01-01", hrv: 40, room: 99, bed: 98 },
    // 01-02 pairs with the temperatures stored on 01-03 and with its own day inputs.
    { d: "2030-01-02", hrv: 55.12, recovery: 70, efficiency: 91.5, deep: 5400000, room: 21, bed: 30, mealGap: -45.2, kcal: 2500, caf: 200, cafBed: 12.35 },
    // 01-03 has no HRV and 01-05 has no input: both dropped.
    { d: "2030-01-06", hrv: 61, kcal: 1800 },
  ]);
  // Same input in a different order gives byte-identical output (the sameJson bailout needs it).
  assert.equal(JSON.stringify(S.shapeSweetSpotRows([...raw].reverse())), JSON.stringify(rows));
});

test("points convert to display units (Celsius to Fahrenheit, ms to minutes)", () => {
  const rows = [{ d: "2030-01-01", hrv: 50, deep: 5400000, room: 20, kcal: 2000 }, { d: "2030-01-02", hrv: 51, kcal: 2100 }];
  assert.deepEqual(S.sweetSpotPoints(rows, "room", "hrv"), [{ x: 68, y: 50 }]);
  assert.deepEqual(S.sweetSpotPoints(rows, "kcal", "deep"), [{ x: 2000, y: 90 }]);
  assert.deepEqual(S.sweetSpotPoints(rows, "kcal", "hrv").length, 2);
  assert.deepEqual(S.sweetSpotPoints(rows, "cafBed", "hrv"), []);
});

test("options: the four day inputs are same-row, temperatures next-row, thresholds stated", () => {
  assert.deepEqual(S.SWEET_SPOT_X_KEYS, ["room", "bed", "mealGap", "kcal", "caf", "cafBed"]);
  assert.deepEqual(S.SWEET_SPOT_X_KEYS.map((k) => S.SWEET_SPOT_X[k].pairing),
    ["next_row", "next_row", "same_row", "same_row", "same_row", "same_row"]);
  assert.deepEqual(["mealGap", "kcal", "caf", "cafBed"].map((k) => S.SWEET_SPOT_X[k].column),
    ["meal_last_meal_to_bedtime_min", "nutrition_calories", "caffeine_total_mg", "caffeine_mg_at_bedtime"]);
  assert.deepEqual([S.SWEET_SPOT_DEFAULT_X, S.SWEET_SPOT_DEFAULT_Y], ["room", "hrv"]);
  assert.ok(S.SWEET_SPOT_MIN_NIGHTS_CHART < S.SWEET_SPOT_MIN_NIGHTS_FIT);
  for (const k of S.SWEET_SPOT_X_KEYS) assert.ok(S.SWEET_SPOT_X[k].caveat.length > 40 && S.SWEET_SPOT_X[k].fillsBy.length > 10);
});

test("the matview read uses the explicit scalar column list, pages, and shapes the rows", async () => {
  const cols = S.SWEET_SPOT_COLUMNS.split(",");
  assert.equal(new Set(cols).size, cols.length);
  assert.equal(cols.length, 11);
  assert.ok(!cols.some((c) => c === "*" || /json|raw/.test(c)));

  const calls = [];
  const page1 = Array.from({ length: 1000 }, (_, i) => {
    const d = new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10);
    return { onyx_behavioral_date: d, whoop_hrv_rmssd: 50, nutrition_calories: i === 0 ? 2000 : null };
  });
  const page2 = [{ onyx_behavioral_date: "2040-01-01", whoop_hrv_rmssd: 44, caffeine_total_mg: 150 }];
  const client = {
    from(table) {
      const q = { table };
      const chain = {
        select(c) { q.select = c; return chain; },
        or(f) { q.or = f; return chain; },
        order(k, o) { q.order = [k, o]; return chain; },
        range(a, b) { q.range = [a, b]; return chain; },
        then(resolve, reject) {
          calls.push(q);
          return Promise.resolve({ data: q.range[0] === 0 ? page1 : page2, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  const Q = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: client }, "@/lib/queries": {} });
  const out = await Q.getEnvDoseResponseData();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.range), [[0, 999], [1000, 1999]]);
  for (const c of calls) {
    assert.equal(c.table, "daily_health_matrix_behavioral_mat");
    assert.equal(c.select, S.SWEET_SPOT_COLUMNS);
    assert.deepEqual(c.order, ["onyx_behavioral_date", { ascending: true }]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    { d: "2030-01-01", hrv: 50, kcal: 2000 },
    { d: "2040-01-01", hrv: 44, caf: 150 },
  ]);
});

test("the matview read rejects on a PostgREST error so the ISR prefetch fails open", async () => {
  const chain = {
    select() { return chain; }, or() { return chain; }, order() { return chain; }, range() { return chain; },
    then(resolve, reject) { return Promise.resolve({ data: null, error: new Error("synthetic") }).then(resolve, reject); },
  };
  const Q = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: { from: () => chain } }, "@/lib/queries": {} });
  await assert.rejects(() => Q.getEnvDoseResponseData(), /synthetic/);
});

test("panel wiring: ISR seed + sameJson bailout kept, no animated series, labelled descriptive", () => {
  const client = fs.readFileSync(path.join(SRC, "app/analytics/hrv/HrvAnalysisClient.tsx"), "utf8");
  assert.match(client, /useState<SweetSpotRow\[\]>\(initial\?\.envMatrix \?\? \[\]\)/);
  assert.match(client, /setEnvMatrix\(prev => sameJson\(prev, d\.envMatrix\) \? prev : d\.envMatrix\)/);
  assert.match(client, /<SweetSpotPanel rows=\{envMatrix\} \/>/);
  // The PM2.5 panel from PR #101 stays mounted right after it.
  assert.ok(client.indexOf("<SweetSpotPanel") < client.indexOf("<AirQualityPanel />"));

  const panel = fs.readFileSync(path.join(SRC, "app/analytics/hrv/SweetSpotPanel.tsx"), "utf8");
  const series = panel.match(/<(Bar|Line|Area)\b[^>]*>/g) ?? [];
  assert.equal(series.length, 2);
  for (const tag of series) assert.match(tag, /isAnimationActive=\{false\}/);
  assert.match(panel, /useState<SweetSpotXKey>\(SWEET_SPOT_DEFAULT_X\)/);
  assert.match(panel, /useState<SweetSpotYKey>\(SWEET_SPOT_DEFAULT_Y\)/);
  assert.match(panel, /Descriptive, not causal/);
  assert.match(panel, /Not enough nights yet/);
  // The panel fetches nothing itself: every toggle derives from the rows it is given.
  assert.ok(!/fetch\(|supabase/.test(panel));
});
