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
  assert.match(client, /useState<SweetSpotBaked \| null>\(initial\?\.envBaked \?\? null\)/);
  assert.match(client, /setEnvBaked\(prev => sameJson\(prev, d\.envBaked\) \? prev : d\.envBaked\)/);
  assert.match(client, /<SweetSpotPanel rows=\{envMatrix\} baked=\{envBaked\} \/>/);
  // The PM2.5 panel from PR #101 stays mounted right after it.
  assert.ok(client.indexOf("<SweetSpotPanel") < client.indexOf("<AirQualityPanel />"));

  const panel = fs.readFileSync(path.join(SRC, "app/analytics/hrv/SweetSpotPanel.tsx"), "utf8");
  const series = panel.match(/<(Bar|Line|Area)\b[^>]*>/g) ?? [];
  assert.equal(series.length, 2);
  for (const tag of series) assert.match(tag, /isAnimationActive=\{false\}/);
  assert.match(panel, /useState<SweetSpotXKey>\(SWEET_SPOT_DEFAULT_X\)/);
  assert.match(panel, /useState<SweetSpotYKey>\(SWEET_SPOT_DEFAULT_Y\)/);
  assert.match(panel, /Descriptive, not causal/);
  assert.match(panel, /Adjusted association, not a causal estimate/);
  assert.match(panel, /Not enough nights yet/);
  // The panel fetches nothing itself: every toggle derives from the data it is given.
  assert.ok(!/fetch\(|supabase/.test(panel));
});

// ---------------------------------------------------------------------------
// Pre-baked result from hrv_analysis.py (dose_response_continuous / sweet_spot)
// ---------------------------------------------------------------------------

// A pipeline pair shaped like hrv_analysis.dose_response_pair, built from synthetic points with
// the page's own arithmetic so a valid row is easy to make and then break on purpose.
function bakedFit(fit) {
  return {
    n: fit.n, status: fit.status,
    a: fit.curve ? fit.curve.a : null, b: fit.curve ? fit.curve.b : null, c: fit.curve ? fit.curve.c : null,
    r2: fit.curve ? fit.curve.r2 : null, t: fit.curve ? fit.curve.curvatureT : null,
    peak: fit.peak, x_min: fit.xMin, x_max: fit.xMax,
  };
}
function bakedPair(points, size, { adjusted = true } = {}) {
  const fit = S.fitQuadratic(points);
  const n = points.length;
  if (n < S.SWEET_SPOT_MIN_NIGHTS_CHART) {
    return { n, size, buckets: [], fit: bakedFit(fit), adj: { status: "too_few", n } };
  }
  const grid = S.bucketSweetSpot(points, size);
  const buckets = grid.buckets.map((b) => ({
    start: b.start, n: b.n, mean: b.meanY, sem: b.sem, sd: b.sd,
    fit: fit.curve ? S.predictQuadratic(fit.curve, b.mid) : null,
  }));
  const adj = adjusted
    ? {
      status: "ok", n,
      buckets: buckets.map((b) => ({
        n: b.n, mean: b.mean === null ? null : b.mean - 1, sem: b.sem, raw: b.mean, fit: b.fit === null ? null : b.fit - 1,
      })),
      fit: { ...bakedFit(fit), peak: fit.peak ? { x: fit.peak.x, y: fit.peak.y - 1 } : null },
    }
    : { status: "too_few", n: 12 };
  return { n, size: grid.size, buckets, fit: bakedFit(fit), adj };
}
function noisyParabola(seed, n = 60) {
  const rnd = noise(seed);
  return xs(n, 60, 76).map((x) => ({ x, y: -0.5 * (x - 68) ** 2 + 60 + 2 * rnd() }));
}
function bakedPayload(pairFor = (x) => bakedPair(noisyParabola(3), S.SWEET_SPOT_X[x].bucketSize)) {
  const inputs = {};
  for (const k of S.SWEET_SPOT_X_KEYS) {
    const m = S.SWEET_SPOT_X[k];
    inputs[k] = {
      column: m.column, transform: m.transform, bucket_size: m.bucketSize, in_matrix: true,
      zero_nights: k === "caf" ? 7 : 0, confounders: ["hrv_lag1", "day_of_week"],
      confounder_labels: ["Previous Day HRV", "Day of Week"],
    };
  }
  const pairs = [];
  for (const x of S.SWEET_SPOT_X_KEYS) for (const y of S.SWEET_SPOT_Y_KEYS) pairs.push({ x, y, ...pairFor(x, y) });
  return JSON.parse(JSON.stringify({
    version: 1, status: "ok", alignment: "same_night_v1", nights: 300, through: "2031-09-17",
    thresholds: { chart: 20, fit: 30, curvature_t: 2, max_buckets: 24, adjusted: 50 },
    adjusted_method: "Adjusted association, not a causal estimate.", inputs, pairs,
  }));
}

test("pipeline twin: hrv_analysis.py thresholds and input / outcome tables match this file", (t) => {
  const py = path.join(SRC, "..", "..", "hrv_analysis.py");
  if (!fs.existsSync(py)) return t.skip("hrv_analysis.py is not in this checkout");
  const src = fs.readFileSync(py, "utf8").replace(/\r\n/g, "\n");
  const num = (name) => Number(src.match(new RegExp(`^${name} = ([0-9.]+)`, "m"))[1]);
  assert.equal(num("DOSE_MIN_NIGHTS_CHART"), S.SWEET_SPOT_MIN_NIGHTS_CHART);
  assert.equal(num("DOSE_MIN_NIGHTS_FIT"), S.SWEET_SPOT_MIN_NIGHTS_FIT);
  assert.equal(num("DOSE_MIN_CURVATURE_T"), S.SWEET_SPOT_MIN_CURVATURE_T);
  assert.equal(num("DOSE_MAX_BUCKETS"), S.SWEET_SPOT_MAX_BUCKETS);
  assert.equal(num("DOSE_MIN_NIGHTS_ADJUSTED"), S.SWEET_SPOT_MIN_NIGHTS_ADJUSTED);
  assert.equal(num("DOSE_RESPONSE_VERSION"), S.SWEET_SPOT_BAKED_VERSION);
  assert.deepEqual(
    [src.match(/^DOSE_RESPONSE_RESULT_TYPE = "(\w+)"/m)[1], src.match(/^DOSE_RESPONSE_RESULT_KEY = "(\w+)"/m)[1]],
    [...S.SWEET_SPOT_RESULT],
  );

  const block = (name) => {
    const at = src.indexOf(`\n${name} = (`);
    assert.ok(at >= 0, `${name} not found`);
    return src.slice(at, src.indexOf("\n)", at));
  };
  const inputs = [...block("DOSE_RESPONSE_INPUTS").matchAll(/\("(\w+)", "(\w+)", "(\w+)", ([0-9.]+)\)/g)]
    .map((m) => [m[1], m[2], m[3], Number(m[4])]);
  assert.deepEqual(inputs, S.SWEET_SPOT_X_KEYS.map((k) => {
    const m = S.SWEET_SPOT_X[k];
    return [k, m.column, m.transform, m.bucketSize];
  }));
  const outcomes = [...block("DOSE_RESPONSE_OUTCOMES").matchAll(/\("(\w+)", (TARGET|"\w+"), "(\w+)"\)/g)]
    .map((m) => [m[1], m[2] === "TARGET" ? "whoop_hrv_rmssd" : m[2].slice(1, -1), m[3]]);
  assert.deepEqual(outcomes, S.SWEET_SPOT_Y_KEYS.map((k) => [k, S.SWEET_SPOT_Y[k].column, S.SWEET_SPOT_Y[k].transform]));
  // Every Celsius input is converted the same way on both sides.
  for (const k of S.SWEET_SPOT_X_KEYS) {
    const m = S.SWEET_SPOT_X[k];
    close(m.toDisplay(20), m.transform === "c_to_f" ? 68 : 20, 1e-12, `${k} toDisplay`);
  }
  close(S.SWEET_SPOT_Y.deep.toDisplay(6_000_000), 100, 1e-12, "deep sleep ms -> min");
});

test("baked result: a valid payload is used for every pair and needs no nightly rows", () => {
  const baked = S.parseSweetSpotBaked(bakedPayload(), "2031-09-18T04:00:00Z");
  assert.equal(baked.status, "ok");
  assert.equal(baked.computedAt, "2031-09-18T04:00:00Z");
  assert.equal(baked.through, "2031-09-17");
  assert.equal(Object.keys(baked.pairs).length, S.SWEET_SPOT_X_KEYS.length * S.SWEET_SPOT_Y_KEYS.length);
  assert.ok(S.sweetSpotBakedIsComplete(baked));
  assert.deepEqual(baked.inputs.caf, { zeroNights: 7, confounders: ["Previous Day HRV", "Day of Week"] });
  const pair = baked.pairs[S.sweetSpotPairKey("room", "hrv")];
  assert.equal(pair.n, 60);
  assert.equal(pair.fit.status, "ok");
  assert.equal(pair.adj.status, "ok");
  assert.equal(pair.adj.buckets.length, pair.buckets.length);
  // A string computed_at only; anything else is "unknown".
  assert.equal(S.parseSweetSpotBaked(bakedPayload(), 12345).computedAt, null);
});

test("baked result: unusable payloads are refused as a whole", () => {
  for (const bad of [null, undefined, "x", [], 42]) assert.equal(S.parseSweetSpotBaked(bad), null);
  assert.equal(S.parseSweetSpotBaked({ ...bakedPayload(), version: 2 }), null, "another payload version");
  assert.equal(S.parseSweetSpotBaked({ ...bakedPayload(), status: "weird" }), null);
  for (const [k, v] of [["chart", 25], ["fit", 40], ["curvature_t", 3], ["max_buckets", 12], ["adjusted", 60]]) {
    const p = bakedPayload();
    p.thresholds[k] = v;
    assert.equal(S.parseSweetSpotBaked(p), null, `threshold ${k} differs from this file`);
  }
  // A failed retrain is kept (so the panel can say so) but carries nothing to draw.
  const failed = S.parseSweetSpotBaked({ version: 1, status: "failed", error: "KeyError: x", pairs: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(failed)), { status: "failed", computedAt: null, through: null, pairs: {}, inputs: {} });
  assert.equal(S.sweetSpotBakedIsComplete(failed), false);
  assert.equal(S.sweetSpotBakedIsComplete(null), false);
});

test("baked result: a pair built differently or malformed is dropped and computed in the browser", () => {
  const roomHrv = S.sweetSpotPairKey("room", "hrv");
  const count = (b) => Object.keys(b.pairs).length;

  // An input built from another column, transform or bucket width: all four of its pairs go.
  for (const [field, value] of [["column", "eight_sleep_bed_temp"], ["transform", "identity"], ["bucket_size", 1], ["in_matrix", false]]) {
    const p = bakedPayload();
    p.inputs.room[field] = value;
    const b = S.parseSweetSpotBaked(p);
    assert.equal(count(b), 20, field);
    assert.ok(!(roomHrv in b.pairs) && !("room" in b.inputs), field);
    assert.equal(S.sweetSpotBakedIsComplete(b), false);
  }

  // A pair the pipeline could not compute ("error"), and a partial run.
  const p = bakedPayload();
  p.status = "partial";
  p.pairs[0] = { x: "room", y: "hrv", error: "ZeroDivisionError: synthetic" };
  const partial = S.parseSweetSpotBaked(p);
  assert.equal(partial.status, "partial");
  assert.ok(!(roomHrv in partial.pairs));
  assert.equal(S.sweetSpotBakedIsComplete(partial), false);

  const kept = (mutate) => {
    const q = bakedPayload();
    mutate(q.pairs[0]);
    return roomHrv in S.parseSweetSpotBaked(q).pairs;
  };
  assert.equal(kept(() => {}), true, "control: the untouched pair is kept");
  assert.equal(kept((pr) => { pr.buckets[0].n += 1; }), false, "bucket nights must add up to n");
  assert.equal(kept((pr) => { pr.buckets.find((b) => b.n > 0).mean = null; }), false, "a filled bucket needs a mean");
  assert.equal(kept((pr) => { pr.n = 12; }), false, "no bars under the chart threshold");
  assert.equal(kept((pr) => { pr.fit.peak = null; }), false, "status ok needs its peak");
  assert.equal(kept((pr) => { pr.fit.a = null; }), false, "a drawn status needs its curve");
  assert.equal(kept((pr) => { pr.fit.status = "maybe"; }), false);
  assert.equal(kept((pr) => { pr.size = 0; }), false);

  // A malformed adjusted block costs only the adjusted view.
  const q = bakedPayload();
  q.pairs[0].adj.buckets.pop();
  const plainOnly = S.parseSweetSpotBaked(q).pairs[roomHrv];
  assert.ok(plainOnly && plainOnly.buckets.length > 0);
  assert.equal(plainOnly.adj.status, "unavailable");
  // The pipeline's own "no adjusted version" states pass through.
  const r = bakedPayload();
  r.pairs[0].adj = { status: "unavailable", n: 80 };
  r.pairs[1].adj = { status: "too_few", n: 41 };
  const states = S.parseSweetSpotBaked(r).pairs;
  assert.equal(states[roomHrv].adj.status, "unavailable");
  const roomRecovery = states[S.sweetSpotPairKey("room", "recovery")];
  assert.deepEqual([roomRecovery.adj.status, roomRecovery.adj.n], ["too_few", 41]);
});

test("one view: the pipeline pair when there is one, the browser computation otherwise", () => {
  const baked = S.parseSweetSpotBaked(bakedPayload(), "2031-09-18T04:00:00Z");
  const pair = baked.pairs[S.sweetSpotPairKey("room", "hrv")];

  const plain = S.sweetSpotView([], baked, "room", "hrv", false);
  assert.equal(plain.source, "pipeline");
  assert.equal(plain.adjusted, false);
  assert.equal(plain.n, pair.n);
  assert.deepEqual(plain.buckets.map((b) => [b.start, b.end, b.n, b.meanY]),
    pair.buckets.map((b) => [b.start, b.start + pair.size, b.n, b.mean]));
  assert.equal(plain.fit.status, "ok");
  assert.deepEqual(plain.fit.peak, pair.fit.peak);
  close(plain.fit.vertexX, plain.fit.peak.x, 1e-6, "vertex = peak for a concave fit");

  const adj = S.sweetSpotView([], baked, "room", "hrv", true);
  assert.equal(adj.adjusted, true);
  assert.equal(adj.source, "pipeline");
  for (const b of adj.buckets.filter((x) => x.meanY !== null)) {
    close(b.meanY, b.rawMeanY - 1, 1e-9, "adjusted bar next to the plain mean of the same nights");
  }
  assert.ok(adj.buckets.every((b) => b.sd === null));

  // Asked for the adjusted view of a pair that has none: the plain view, flagged as such.
  const noAdj = S.parseSweetSpotBaked(bakedPayload((x) => bakedPair(noisyParabola(3), S.SWEET_SPOT_X[x].bucketSize, { adjusted: false })));
  const fallback = S.sweetSpotView([], noAdj, "room", "hrv", true);
  assert.equal(fallback.adjusted, false);
  assert.equal(fallback.source, "pipeline");

  // No pipeline pair: computed here from the nightly rows, the same numbers as before.
  const rows = noisyParabola(9, 45).map((p, i) => ({
    d: new Date(Date.UTC(2031, 0, 1 + i)).toISOString().slice(0, 10),
    room: Math.round(((p.x - 32) * 5 / 9) * 100) / 100,
    hrv: Math.round(p.y * 100) / 100,
  }));
  const browser = S.sweetSpotView(rows, null, "room", "hrv", true);
  assert.equal(browser.source, "browser");
  assert.equal(browser.adjusted, false);
  const pts = S.sweetSpotPoints(rows, "room", "hrv");
  const grid = S.bucketSweetSpot(pts, S.SWEET_SPOT_X.room.bucketSize);
  const fit = S.fitQuadratic(pts);
  assert.equal(browser.n, 45);
  assert.deepEqual(browser.buckets.map((b) => [b.start, b.n, b.meanY]), grid.buckets.map((b) => [b.start, b.n, b.meanY]));
  assert.equal(browser.fit.status, fit.status);
  assert.deepEqual(browser.fit.peak, fit.peak);
  // A baked result without this pair (e.g. failed) also falls back to the rows.
  assert.equal(S.sweetSpotView(rows, S.parseSweetSpotBaked({ version: 1, status: "failed" }), "room", "hrv", false).source, "browser");
  // Under the chart threshold there are no bars from either source.
  assert.deepEqual(S.sweetSpotView(rows.slice(0, 10), null, "room", "hrv", false).buckets, []);

  // The night counts on the input selector come from the same source as the view.
  assert.equal(S.sweetSpotNights(rows, baked, "room", "hrv"), pair.n);
  assert.equal(S.sweetSpotNights(rows, null, "room", "hrv"), 45);
});

test("loadSweetSpot reads the nightly rows only when the pipeline result does not cover every pair", async () => {
  let reads = 0;
  const chain = {
    select() { return chain; }, or() { return chain; }, order() { return chain; }, range() { return chain; },
    then(resolve, reject) {
      reads++;
      const data = [{ onyx_behavioral_date: "2031-01-01", whoop_hrv_rmssd: 50, nutrition_calories: 2000 }];
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  const Q = loadTs("lib/queries-hrv.ts", { "@/lib/supabase": { supabase: { from: () => chain } }, "@/lib/queries": {} });

  const complete = await Q.loadSweetSpot({ result_json: bakedPayload(), computed_at: "2031-09-18T04:00:00Z" });
  assert.equal(reads, 0);
  assert.deepEqual(complete.rows, []);
  assert.equal(complete.baked.status, "ok");

  // Stored as a double-encoded string (pre-2026-05-26 rows): still read.
  const legacy = await Q.loadSweetSpot({ result_json: JSON.stringify(bakedPayload()) });
  assert.equal(reads, 0);
  assert.equal(legacy.baked.status, "ok");

  const none = await Q.loadSweetSpot(null);
  assert.equal(reads, 1);
  assert.equal(none.baked, null);
  assert.deepEqual(JSON.parse(JSON.stringify(none.rows)), [{ d: "2031-01-01", hrv: 50, kcal: 2000 }]);

  const unreadable = await Q.loadSweetSpot({ result_json: "{" });
  assert.equal(reads, 2);
  assert.equal(unreadable.baked, null);

  const p = bakedPayload();
  p.status = "partial";
  p.pairs[0] = { x: "room", y: "hrv", error: "synthetic" };
  const partial = await Q.loadSweetSpot({ result_json: p });
  assert.equal(reads, 3);
  assert.equal(partial.baked.status, "partial");
  assert.equal(partial.rows.length, 1);
});

test("dashboard wiring: the pipeline row rides the analysis batch, the matview read only backs it up", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/queries-hrv.ts"), "utf8");
  assert.match(src, /\["dose_response_continuous", "sweet_spot"\]/);
  assert.deepEqual([...S.SWEET_SPOT_RESULT], ["dose_response_continuous", "sweet_spot"]);
  const staticLoader = src.slice(src.indexOf("async function loadHrvStatic()"));
  assert.match(staticLoader, /panel\("dose_response_continuous", "sweet_spot"\)\.then\(loadSweetSpot\)/);
  assert.ok(!/getEnvDoseResponseData\(\)/.test(staticLoader.slice(0, staticLoader.indexOf("return {"))),
    "the matview is no longer read unconditionally on every page load");
  assert.match(staticLoader, /envBaked: sweetSpot\.baked/);
});
