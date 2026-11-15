// Environment Sweet Spot on /analytics/hrv: pure logic, no React and no Supabase, so the same
// code runs in the ISR prefetch, in the browser and in tests/sweet-spot.test.cjs.
//
// The panel is DESCRIPTIVE: it groups nights by the level of one input and shows the mean of
// one outcome of the same night. The default view adjusts for nothing (association, not cause);
// the optional adjusted view (pipeline only) is still an association, not a causal estimate.
//
// Two sources feed the same view (SweetSpotView, bottom of this file):
//   * the analysis pipeline: hrv_analysis.py computes every (input, outcome) pair on each
//     retrain and stores it as pds.hrv_analysis_results dose_response_continuous / sweet_spot,
//     with an extra confounder-ADJUSTED version (an adjusted association, still not a causal
//     estimate). parseSweetSpotBaked validates that row.
//   * the browser: bucketSweetSpot + fitQuadratic on the nightly rows from the matview. This
//     is the fallback while the pipeline row is missing, failed, incomplete or out of step
//     with the tables below. It has no adjusted version.
// The pipeline's unadjusted arithmetic is a twin of the functions here: both are tested on the
// same analytic cases (tests/sweet-spot.test.cjs, tests/test_dose_response_continuous.py), and
// the Node test checks the pipeline's thresholds and input / outcome tables against this file.
//
// Row semantics (hrv_alignment.py): matrix row D holds the HRV / recovery / sleep of the sleep
// that CLOSES behavioral day D. Day-D inputs (meals, calories, caffeine) sit on the same row.
// Eight Sleep columns are keyed by the wake-up day, so the temperature of row D's sleep sits on
// row D+1 ("next_row" below).

/** Below this many nights the bucket chart is not drawn at all ("not enough nights yet"). */
export const SWEET_SPOT_MIN_NIGHTS_CHART = 20;
/** Below this many nights the fitted curve is hidden (bars only). */
export const SWEET_SPOT_MIN_NIGHTS_FIT = 30;
/** A peak is labelled only when the curve's bend is this many standard errors away from zero. */
export const SWEET_SPOT_MIN_CURVATURE_T = 2;
/** Buckets are widened (doubled) until the chart has at most this many. */
export const SWEET_SPOT_MAX_BUCKETS = 24;

export type SweetSpotXKey = "room" | "bed" | "mealGap" | "kcal" | "caf" | "cafBed";
export type SweetSpotYKey = "hrv" | "recovery" | "efficiency" | "deep";

/** One night, short keys (this array rides in the ISR payload). A missing key = no value. */
export type SweetSpotRow = { d: string } & Partial<Record<SweetSpotXKey | SweetSpotYKey, number>>;

export interface SweetSpotXMeta {
  label: string;
  /** Lower-case name used inside sentences. */
  noun: string;
  /** Column in pds.daily_health_matrix_behavioral_mat. */
  column: string;
  /** Which matrix row carries the input for the sleep on row D. */
  pairing: "same_row" | "next_row";
  /** Stored value -> displayed value (the Pod stores Celsius). */
  toDisplay: (raw: number) => number;
  /** Name of `toDisplay`, as hrv_analysis.py spells it (DOSE_RESPONSE_INPUTS). */
  transform: "identity" | "c_to_f";
  unit: string;
  /** Decimals used when a single input value is printed. */
  decimals: number;
  bucketSize: number;
  axisLabel: string;
  /** What the value is and how far to trust it. */
  caveat: string;
  /**
   * Replaces `caveat` when the chart comes from the analysis pipeline and the pipeline's
   * value differs from the matview's (caffeine: the feature matrix counts a logged-era day
   * with no caffeine entry as 0 mg, the matview leaves it empty).
   */
  pipelineCaveat?: string;
  /** How new nights arrive, for the "not enough nights yet" state. */
  fillsBy: string;
}

const cToF = (c: number) => (c * 9) / 5 + 32;
const same = (v: number) => v;

export const SWEET_SPOT_X: Record<SweetSpotXKey, SweetSpotXMeta> = {
  room: {
    label: "Room temp",
    noun: "room temp",
    column: "eight_sleep_room_temp",
    pairing: "next_row",
    toDisplay: cToF,
    transform: "c_to_f",
    unit: "°F",
    decimals: 1,
    bucketSize: 2,
    axisLabel: "median room temp (°F · Pod sensor, uncalibrated)",
    caveat:
      "The Pod's room-temp sensor sits on the unit (in or under the bed) and reads warmer than a wall thermostat by an unknown amount. The shape (peak vs trough) is usable; the absolute Fahrenheit values are not.",
    fillsBy: "One night is added per Eight Sleep sync.",
  },
  bed: {
    label: "Bed temp",
    noun: "bed temp",
    column: "eight_sleep_bed_temp",
    pairing: "next_row",
    toDisplay: cToF,
    transform: "c_to_f",
    unit: "°F",
    decimals: 1,
    bucketSize: 2,
    axisLabel: "median bed-surface temp (°F · Pod sensor)",
    caveat:
      "Bed temp reflects both the Pod's heating / cooling setpoint and your body warming the surface, so it is partly an output of how hot you slept. Read a peak as the bed temp your best nights converged on, not as a setpoint recommendation.",
    fillsBy: "One night is added per Eight Sleep sync.",
  },
  mealGap: {
    label: "Last meal to bed",
    noun: "last-meal-to-bed gap",
    column: "meal_last_meal_to_bedtime_min",
    pairing: "same_row",
    toDisplay: same,
    transform: "identity",
    unit: "min",
    decimals: 0,
    bucketSize: 60,
    axisLabel: "last meal to sleep onset (min)",
    caveat:
      "Minutes from the last logged meal to WHOOP sleep onset, from Cronometer entry times. It is only as accurate as the logging: a meal entered late reads as a shorter gap, and a negative value means the entry was stamped after sleep onset.",
    fillsBy: "A night is added when that day's meals are logged in Cronometer with times.",
  },
  kcal: {
    label: "Calories",
    noun: "calories",
    column: "nutrition_calories",
    pairing: "same_row",
    toDisplay: same,
    transform: "identity",
    unit: "kcal",
    decimals: 0,
    bucketSize: 250,
    axisLabel: "logged calories that day (kcal)",
    caveat:
      "Calories logged for the day (Cronometer; MyFitnessPal before the 2026-05-31 switch). A day that was only partly logged counts as a low-calorie day, and days with no food log are left out.",
    fillsBy: "A night is added when that day's food is logged in Cronometer.",
  },
  caf: {
    label: "Caffeine total",
    noun: "total caffeine",
    column: "caffeine_total_mg",
    pairing: "same_row",
    toDisplay: same,
    transform: "identity",
    unit: "mg",
    decimals: 0,
    bucketSize: 100,
    axisLabel: "logged caffeine that day (mg, food + supplements)",
    caveat:
      "Caffeine logged for the day, food and supplements combined. Only days with at least one logged caffeine entry are included, so there is no zero-caffeine bucket to compare against.",
    pipelineCaveat:
      "Caffeine logged for the day, food and supplements combined. Since caffeine logging began, a day with no caffeine entry but other logging that day (a supplement dose or a food entry) counts as 0 mg, so the lowest bucket mixes real caffeine-free days with days when the caffeine was not logged.",
    fillsBy: "A night is added when caffeine is logged that day (Cronometer or /supplements).",
  },
  cafBed: {
    label: "Caffeine at bedtime",
    noun: "caffeine at bedtime",
    column: "caffeine_mg_at_bedtime",
    pairing: "same_row",
    toDisplay: same,
    transform: "identity",
    unit: "mg",
    decimals: 0,
    bucketSize: 50,
    axisLabel: "estimated caffeine left at sleep onset (mg)",
    caveat:
      "An estimate of the caffeine still in your body at sleep onset: every logged dose decayed with a 5-hour half-life. Only days where every caffeine entry has a trustworthy clock time are included.",
    pipelineCaveat:
      "An estimate of the caffeine still in your body at sleep onset: every logged dose decayed with a 5-hour half-life. Days where a caffeine entry has no trustworthy clock time are left out. Since caffeine logging began, a day with no caffeine entry but other logging that day counts as 0 mg, so the lowest bucket mixes real caffeine-free days with days when the caffeine was not logged.",
    fillsBy: "A night is added when every caffeine entry that day has a real clock time and the sleep is scored.",
  },
};

export interface SweetSpotYMeta {
  label: string;
  /** Lower-case name used inside sentences. */
  noun: string;
  column: string;
  unit: string;
  axisLabel: string;
  toDisplay: (raw: number) => number;
  /** Name of `toDisplay`, as hrv_analysis.py spells it (DOSE_RESPONSE_OUTCOMES). */
  transform: "identity" | "ms_to_min";
}

export const SWEET_SPOT_Y: Record<SweetSpotYKey, SweetSpotYMeta> = {
  hrv: { label: "WHOOP HRV", noun: "HRV", column: "whoop_hrv_rmssd", unit: "ms", axisLabel: "WHOOP HRV (ms)", toDisplay: same, transform: "identity" },
  recovery: { label: "Recovery Score", noun: "recovery score", column: "whoop_recovery_score", unit: "%", axisLabel: "WHOOP Recovery (%)", toDisplay: same, transform: "identity" },
  efficiency: { label: "Sleep Efficiency", noun: "sleep efficiency", column: "whoop_sleep_efficiency", unit: "%", axisLabel: "WHOOP Sleep Efficiency (%)", toDisplay: same, transform: "identity" },
  deep: { label: "Deep Sleep", noun: "deep sleep", column: "whoop_deep_sleep_milli", unit: "min", axisLabel: "WHOOP Deep Sleep (min)", toDisplay: (ms) => ms / 60000, transform: "ms_to_min" },
};

export const SWEET_SPOT_X_KEYS = Object.keys(SWEET_SPOT_X) as SweetSpotXKey[];
export const SWEET_SPOT_Y_KEYS = Object.keys(SWEET_SPOT_Y) as SweetSpotYKey[];

/** The panel's default axes. The data fn takes no arguments, so every toggle derives locally. */
export const SWEET_SPOT_DEFAULT_X: SweetSpotXKey = "room";
export const SWEET_SPOT_DEFAULT_Y: SweetSpotYKey = "hrv";

/** Explicit all-scalar select list for the matview read (no jsonb columns). */
export const SWEET_SPOT_COLUMNS = [
  "onyx_behavioral_date",
  ...SWEET_SPOT_Y_KEYS.map((k) => SWEET_SPOT_Y[k].column),
  ...SWEET_SPOT_X_KEYS.map((k) => SWEET_SPOT_X[k].column),
].join(",");

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function nextDay(d: string): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().split("T")[0];
}

/**
 * Raw matview rows -> one compact row per night that has HRV and at least one input.
 * Values stay in stored units (rounded to 2 decimals); display conversion happens per axis.
 * Output is ordered by date, which the client's sameJson bailout relies on.
 */
export function shapeSweetSpotRows(raw: ReadonlyArray<Record<string, unknown>>): SweetSpotRow[] {
  const byDate = new Map<string, Record<string, unknown>>();
  for (const r of raw) {
    if (r && typeof r.onyx_behavioral_date === "string") byDate.set(r.onyx_behavioral_date, r);
  }
  const out: SweetSpotRow[] = [];
  for (const d of [...byDate.keys()].sort()) {
    const r = byDate.get(d)!;
    if (num(r[SWEET_SPOT_Y.hrv.column]) === null) continue;
    const row: SweetSpotRow = { d };
    for (const k of SWEET_SPOT_Y_KEYS) {
      const v = num(r[SWEET_SPOT_Y[k].column]);
      if (v !== null) row[k] = round2(v);
    }
    const next = byDate.get(nextDay(d));
    let hasInput = false;
    for (const k of SWEET_SPOT_X_KEYS) {
      const meta = SWEET_SPOT_X[k];
      const src = meta.pairing === "next_row" ? next : r;
      const v = src ? num(src[meta.column]) : null;
      if (v !== null) {
        row[k] = round2(v);
        hasInput = true;
      }
    }
    if (hasInput) out.push(row);
  }
  return out;
}

export interface SweetSpotPoint {
  x: number;
  y: number;
}

/** Nightly (input, outcome) pairs in DISPLAY units for one axis pair. */
export function sweetSpotPoints(
  rows: ReadonlyArray<SweetSpotRow>,
  xKey: SweetSpotXKey,
  yKey: SweetSpotYKey,
): SweetSpotPoint[] {
  const xMeta = SWEET_SPOT_X[xKey];
  const yMeta = SWEET_SPOT_Y[yKey];
  const pts: SweetSpotPoint[] = [];
  for (const r of rows) {
    const xRaw = num(r[xKey]);
    const yRaw = num(r[yKey]);
    if (xRaw === null || yRaw === null) continue;
    pts.push({ x: xMeta.toDisplay(xRaw), y: yMeta.toDisplay(yRaw) });
  }
  return pts;
}

export interface SweetSpotBucket {
  start: number;
  end: number;
  mid: number;
  n: number;
  /** null for a bucket with no nights (kept so the axis stays evenly spaced). */
  meanY: number | null;
  sem: number | null;
  sd: number | null;
}

/**
 * Group points into equal-width buckets and return every bucket between the lowest and the
 * highest one, empty ones included, so the category axis is evenly spaced and a curve drawn
 * across it is not distorted. The width is doubled until at most `maxBuckets` remain.
 */
export function bucketSweetSpot(
  points: ReadonlyArray<SweetSpotPoint>,
  bucketSize: number,
  maxBuckets: number = SWEET_SPOT_MAX_BUCKETS,
): { size: number; buckets: SweetSpotBucket[] } {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  let size = bucketSize > 0 && Number.isFinite(bucketSize) ? bucketSize : 1;
  if (pts.length === 0) return { size, buckets: [] };
  let lo = 0;
  let hi = 0;
  for (;;) {
    lo = Infinity;
    hi = -Infinity;
    for (const p of pts) {
      const i = Math.floor(p.x / size);
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (hi - lo + 1 <= Math.max(1, maxBuckets)) break;
    size *= 2;
  }
  const groups: number[][] = Array.from({ length: hi - lo + 1 }, () => []);
  for (const p of pts) groups[Math.floor(p.x / size) - lo].push(p.y);
  const buckets = groups.map((ys, j) => {
    const start = (lo + j) * size;
    const n = ys.length;
    const base = { start, end: start + size, mid: start + size / 2, n };
    if (n === 0) return { ...base, meanY: null, sem: null, sd: null };
    const mean = ys.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? ys.reduce((s, y) => s + (y - mean) ** 2, 0) / (n - 1) : 0;
    const sd = Math.sqrt(variance);
    return { ...base, meanY: mean, sem: n > 1 ? sd / Math.sqrt(n) : 0, sd };
  });
  return { size, buckets };
}

export type QuadraticFitStatus =
  /** Curve drawn and a peak labelled. */
  | "ok"
  /** Fewer nights than the minimum: no curve. */
  | "too_few"
  /** Fewer than three distinct input values (or a singular system): no curve. */
  | "degenerate"
  /** Curve drawn; its bend cannot be told apart from a straight line. */
  | "flat"
  /** Curve drawn; it bends upward, so its turning point is a low, not a high. */
  | "convex"
  /** Curve drawn; it bends downward but the high point is outside the observed inputs. */
  | "outside_range";

export interface QuadraticCurve {
  /** y = a*x^2 + b*x + c in display units. */
  a: number;
  b: number;
  c: number;
  r2: number;
  /** Quadratic coefficient divided by its standard error (negative = bends downward). */
  curvatureT: number;
  /** Centered / scaled form used for evaluation (numerically stable for large x). */
  xMean: number;
  xSd: number;
  yMean: number;
  ySd: number;
  A: number;
  B: number;
  C: number;
}

export interface QuadraticFit {
  n: number;
  status: QuadraticFitStatus;
  curve: QuadraticCurve | null;
  /** The fitted high point; only when status is "ok". */
  peak: SweetSpotPoint | null;
  xMin: number | null;
  xMax: number | null;
}

function invert3(m: number[][]): number[][] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const scale = Math.max(...m.flat().map(Math.abs), 1);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 * scale ** 3) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * Ordinary least-squares parabola through the nightly points (not through the bucket means).
 *
 * A peak is reported only when ALL of these hold; otherwise `peak` is null and `status` says why:
 *   1. at least `minN` nights (and three distinct input values),
 *   2. the curve bends downward (concave),
 *   3. the bend is at least SWEET_SPOT_MIN_CURVATURE_T standard errors from zero, so a flat or
 *      straight-line relationship with a little noise does not produce a "sweet spot",
 *   4. the high point lies strictly inside the observed input range (no extrapolated peak).
 *
 * The standard error treats nights as independent, which they are not (HRV drifts slowly), so
 * the threshold is a noise filter, not a significance test.
 */
export function fitQuadratic(
  points: ReadonlyArray<SweetSpotPoint>,
  minN: number = SWEET_SPOT_MIN_NIGHTS_FIT,
): QuadraticFit {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n === 0) return { n, status: "too_few", curve: null, peak: null, xMin: null, xMax: null };
  let xMin = Infinity;
  let xMax = -Infinity;
  let sumX = 0;
  let sumY = 0;
  for (const p of pts) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    sumX += p.x;
    sumY += p.y;
  }
  const none = (status: QuadraticFitStatus): QuadraticFit => ({ n, status, curve: null, peak: null, xMin, xMax });
  // Four is the floor for a residual degree of freedom; the page uses the 30-night default.
  if (n < Math.max(minN, 4)) return none("too_few");
  if (new Set(pts.map((p) => p.x)).size < 3) return none("degenerate");

  const xMean = sumX / n;
  const yMean = sumY / n;
  const xSd = Math.sqrt(pts.reduce((s, p) => s + (p.x - xMean) ** 2, 0) / n);
  const ySd = Math.sqrt(pts.reduce((s, p) => s + (p.y - yMean) ** 2, 0) / n);
  if (!(xSd > 0)) return none("degenerate");

  const flatCurve = (A: number, B: number, C: number, r2: number, sd: number): QuadraticFit => {
    const a = (sd * A) / xSd ** 2;
    const b = sd * (B / xSd - (2 * A * xMean) / xSd ** 2);
    const c = yMean + sd * ((A * xMean ** 2) / xSd ** 2 - (B * xMean) / xSd + C);
    return {
      n, status: "flat", peak: null, xMin, xMax,
      curve: { a, b, c, r2, curvatureT: 0, xMean, xSd, yMean, ySd: sd, A, B, C },
    };
  };
  // Every night has (numerically) the same outcome: a horizontal line, no peak.
  if (!(ySd > 1e-12 * Math.max(1, Math.abs(yMean)))) return flatCurve(0, 0, 0, 0, 0);

  // Fit on centered, unit-variance x and y so the 3x3 system is well conditioned.
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  const uv = pts.map((p) => ({ u: (p.x - xMean) / xSd, v: (p.y - yMean) / ySd }));
  for (const { u, v } of uv) {
    const u2 = u * u;
    s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    t0 += v; t1 += u * v; t2 += u2 * v;
  }
  const inv = invert3([[s4, s3, s2], [s3, s2, s1], [s2, s1, n]]);
  if (!inv) return none("degenerate");
  const rhs = [t2, t1, t0];
  const [A, B, C] = inv.map((row) => row[0] * rhs[0] + row[1] * rhs[1] + row[2] * rhs[2]);
  let sse = 0;
  for (const { u, v } of uv) sse += (v - (A * u * u + B * u + C)) ** 2;
  const r2 = Math.min(1, Math.max(0, 1 - sse / n));

  // No measurable bend at all (e.g. points exactly on a straight line).
  if (Math.abs(A) < 1e-9) return flatCurve(0, B, C, r2, ySd);

  const exact = sse / n < 1e-18;
  const seA = Math.sqrt((sse / (n - 3)) * inv[0][0]);
  const curvatureT = exact || !(seA > 0) ? (A < 0 ? -Infinity : Infinity) : A / seA;

  const curve: QuadraticCurve = {
    a: (ySd * A) / xSd ** 2,
    b: ySd * (B / xSd - (2 * A * xMean) / xSd ** 2),
    c: yMean + ySd * ((A * xMean ** 2) / xSd ** 2 - (B * xMean) / xSd + C),
    r2, curvatureT, xMean, xSd, yMean, ySd, A, B, C,
  };
  const withStatus = (status: QuadraticFitStatus, peak: SweetSpotPoint | null = null): QuadraticFit =>
    ({ n, status, curve, peak, xMin, xMax });

  if (Math.abs(curvatureT) < SWEET_SPOT_MIN_CURVATURE_T) return withStatus("flat");
  if (A > 0) return withStatus("convex");
  const uStar = -B / (2 * A);
  const xStar = xMean + xSd * uStar;
  if (!(xStar > xMin && xStar < xMax)) return withStatus("outside_range");
  return withStatus("ok", { x: xStar, y: yMean + ySd * (C - (B * B) / (4 * A)) });
}

/** The fitted outcome at input `x` (display units). */
export function predictQuadratic(curve: QuadraticCurve, x: number): number {
  const u = (x - curve.xMean) / curve.xSd;
  return curve.yMean + curve.ySd * (curve.A * u * u + curve.B * u + curve.C);
}

// ---------------------------------------------------------------------------
// Pre-baked result from the analysis pipeline
// ---------------------------------------------------------------------------
// hrv_analysis.py (Phase 2.6) writes one row, pds.hrv_analysis_results
// dose_response_continuous / sweet_spot, on every retrain: every (input, outcome) pair,
// unadjusted (same arithmetic as above) and confounder-adjusted. Everything below treats that
// JSON as untrusted: a row that is missing, failed, from another payload version, or built
// from different columns / bucket widths / thresholds is not used, and the panel computes the
// chart from the nightly rows instead.

/** [result_type, result_key] of the pipeline row. */
export const SWEET_SPOT_RESULT = ["dose_response_continuous", "sweet_spot"] as const;
/** Payload version this code understands (DOSE_RESPONSE_VERSION in hrv_analysis.py). */
export const SWEET_SPOT_BAKED_VERSION = 1;
/** Nights with a complete confounder history the adjusted version needs (pipeline side). */
export const SWEET_SPOT_MIN_NIGHTS_ADJUSTED = 50;

export interface SweetSpotBakedFit {
  n: number;
  status: QuadraticFitStatus;
  /** y = a*x^2 + b*x + c in display units; null when no curve was fitted. */
  a: number | null;
  b: number | null;
  r2: number | null;
  /** Quadratic coefficient divided by its standard error. */
  t: number | null;
  peak: SweetSpotPoint | null;
  xMin: number | null;
  xMax: number | null;
}

export interface SweetSpotBakedBucket {
  start: number;
  n: number;
  mean: number | null;
  sem: number | null;
  sd: number | null;
  /** The fitted curve at the middle of the bucket; null when no curve was fitted. */
  fit: number | null;
}

export interface SweetSpotBakedAdjusted {
  /** "too_few": under SWEET_SPOT_MIN_NIGHTS_ADJUSTED complete nights. "unavailable": no confounders. */
  status: "ok" | "too_few" | "unavailable";
  /** Nights with the input, the outcome and every confounder. */
  n: number;
  /** One entry per unadjusted bucket, same order. `raw` = the plain mean of the same nights. */
  buckets: { n: number; mean: number | null; sem: number | null; raw: number | null; fit: number | null }[];
  fit: SweetSpotBakedFit | null;
}

export interface SweetSpotBakedPair {
  n: number;
  /** Bucket width actually used (the configured width, doubled until the chart fits). */
  size: number;
  /** Empty under SWEET_SPOT_MIN_NIGHTS_CHART nights. */
  buckets: SweetSpotBakedBucket[];
  fit: SweetSpotBakedFit;
  adj: SweetSpotBakedAdjusted;
}

export interface SweetSpotBaked {
  /** "failed": the last retrain could not compute it (no pairs). "partial": some pairs missing. */
  status: "ok" | "partial" | "failed";
  /** When the retrain wrote the row (ISO timestamp). */
  computedAt: string | null;
  /** Behavioral date of the newest night included. */
  through: string | null;
  /** Usable pairs, keyed `${xKey}/${yKey}`. */
  pairs: Record<string, SweetSpotBakedPair>;
  /** Per input: nights whose value is exactly 0, and what the adjusted version adjusts for. */
  inputs: Partial<Record<SweetSpotXKey, { zeroNights: number; confounders: string[] }>>;
}

export const sweetSpotPairKey = (xKey: SweetSpotXKey, yKey: SweetSpotYKey) => `${xKey}/${yKey}`;

const FIT_STATUSES: readonly QuadraticFitStatus[] = ["ok", "too_few", "degenerate", "flat", "convex", "outside_range"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A finite number, or null. Unlike `num`, a string is not accepted (the payload is typed JSON). */
function fin(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function count(v: unknown): number | null {
  const n = fin(v);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
}

function parseBakedFit(v: unknown): SweetSpotBakedFit | null {
  if (!isObj(v)) return null;
  const n = count(v.n);
  const status = FIT_STATUSES.find((s) => s === v.status);
  if (n === null || !status) return null;
  const a = fin(v.a);
  const b = fin(v.b);
  const hasCurve = a !== null && b !== null;
  // A status that draws a curve must come with one, and a labelled peak with its point.
  if (hasCurve === (status === "too_few" || status === "degenerate")) return null;
  let peak: SweetSpotPoint | null = null;
  if (isObj(v.peak)) {
    const x = fin(v.peak.x);
    const y = fin(v.peak.y);
    if (x !== null && y !== null) peak = { x, y };
  }
  if ((status === "ok") !== (peak !== null)) return null;
  return { n, status, a, b, r2: fin(v.r2), t: fin(v.t), peak, xMin: fin(v.x_min), xMax: fin(v.x_max) };
}

function parseBakedPair(v: Record<string, unknown>): SweetSpotBakedPair | null {
  const n = count(v.n);
  const size = fin(v.size);
  const fit = parseBakedFit(v.fit);
  if (n === null || size === null || !(size > 0) || !fit || !Array.isArray(v.buckets)) return null;
  const buckets: SweetSpotBakedBucket[] = [];
  let nights = 0;
  for (const b of v.buckets) {
    if (!isObj(b)) return null;
    const start = fin(b.start);
    const bn = count(b.n);
    const mean = fin(b.mean);
    if (start === null || bn === null || (bn > 0) !== (mean !== null)) return null;
    nights += bn;
    buckets.push({ start, n: bn, mean, sem: fin(b.sem), sd: fin(b.sd), fit: fin(b.fit) });
  }
  // Buckets are drawn from SWEET_SPOT_MIN_NIGHTS_CHART nights up, and must account for every night.
  if ((n >= SWEET_SPOT_MIN_NIGHTS_CHART) !== (buckets.length > 0)) return null;
  if (buckets.length > 0 && nights !== n) return null;
  if (buckets.length > SWEET_SPOT_MAX_BUCKETS) return null;

  let adj: SweetSpotBakedAdjusted = { status: "unavailable", n: 0, buckets: [], fit: null };
  if (isObj(v.adj)) {
    const an = count(v.adj.n) ?? 0;
    if (v.adj.status === "too_few") adj = { status: "too_few", n: an, buckets: [], fit: null };
    if (v.adj.status === "ok" && Array.isArray(v.adj.buckets) && v.adj.buckets.length === buckets.length) {
      const afit = parseBakedFit(v.adj.fit);
      const ab: SweetSpotBakedAdjusted["buckets"] = [];
      let ok = afit !== null;
      for (const b of v.adj.buckets) {
        const bn = isObj(b) ? count(b.n) : null;
        const mean = isObj(b) ? fin(b.mean) : null;
        if (!isObj(b) || bn === null || (bn > 0) !== (mean !== null)) {
          ok = false;
          break;
        }
        ab.push({ n: bn, mean, sem: fin(b.sem), raw: fin(b.raw), fit: fin(b.fit) });
      }
      // A malformed adjusted block only costs the adjusted view, never the plain chart.
      if (ok) adj = { status: "ok", n: an, buckets: ab, fit: afit };
    }
  }
  return { n, size, buckets, fit, adj };
}

/**
 * The pipeline row's result_json -> a validated SweetSpotBaked, or null when it cannot be used
 * at all (no row, another payload version, or thresholds that differ from this file's).
 * A payload with status "failed" is returned with no pairs, so the panel can say so.
 * Pairs are kept only when their input was built from the same column, transform and bucket
 * width as SWEET_SPOT_X; anything else is dropped and computed in the browser.
 */
export function parseSweetSpotBaked(json: unknown, computedAt?: unknown): SweetSpotBaked | null {
  if (!isObj(json) || json.version !== SWEET_SPOT_BAKED_VERSION) return null;
  const base = {
    computedAt: typeof computedAt === "string" ? computedAt : null,
    through: typeof json.through === "string" ? json.through : null,
  };
  if (json.status === "failed") return { status: "failed", ...base, pairs: {}, inputs: {} };
  if (json.status !== "ok" && json.status !== "partial") return null;
  const th = isObj(json.thresholds) ? json.thresholds : {};
  if (
    th.chart !== SWEET_SPOT_MIN_NIGHTS_CHART || th.fit !== SWEET_SPOT_MIN_NIGHTS_FIT ||
    th.curvature_t !== SWEET_SPOT_MIN_CURVATURE_T || th.max_buckets !== SWEET_SPOT_MAX_BUCKETS ||
    th.adjusted !== SWEET_SPOT_MIN_NIGHTS_ADJUSTED
  ) return null;

  const rawInputs = isObj(json.inputs) ? json.inputs : {};
  const inputs: SweetSpotBaked["inputs"] = {};
  for (const k of SWEET_SPOT_X_KEYS) {
    const meta = SWEET_SPOT_X[k];
    const inp = rawInputs[k];
    // in_matrix false = the pipeline's matrix had no such column, so its "0 nights" says nothing.
    if (!isObj(inp) || inp.in_matrix !== true || inp.column !== meta.column ||
        inp.transform !== meta.transform || inp.bucket_size !== meta.bucketSize) continue;
    const labels = Array.isArray(inp.confounder_labels) ? inp.confounder_labels : [];
    inputs[k] = {
      zeroNights: count(inp.zero_nights) ?? 0,
      confounders: labels.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 80).slice(0, 20),
    };
  }

  const pairs: Record<string, SweetSpotBakedPair> = {};
  for (const p of Array.isArray(json.pairs) ? json.pairs : []) {
    if (!isObj(p) || "error" in p) continue;
    const xKey = SWEET_SPOT_X_KEYS.find((k) => k === p.x);
    const yKey = SWEET_SPOT_Y_KEYS.find((k) => k === p.y);
    if (!xKey || !yKey || !inputs[xKey]) continue;
    const pair = parseBakedPair(p);
    if (pair) pairs[sweetSpotPairKey(xKey, yKey)] = pair;
  }
  return { status: json.status, ...base, pairs, inputs };
}

/** True when the pipeline row covers every (input, outcome) pair, so the nightly rows are not needed. */
export function sweetSpotBakedIsComplete(baked: SweetSpotBaked | null): boolean {
  if (!baked || baked.status !== "ok") return false;
  return SWEET_SPOT_X_KEYS.every((x) => SWEET_SPOT_Y_KEYS.every((y) => sweetSpotPairKey(x, y) in baked.pairs));
}

// ---------------------------------------------------------------------------
// One view for the panel, whichever source produced it
// ---------------------------------------------------------------------------

export interface SweetSpotViewBucket {
  start: number;
  end: number;
  n: number;
  /** null for a bucket with no nights. */
  meanY: number | null;
  sem: number | null;
  /** Unadjusted views only. */
  sd: number | null;
  /** The fitted curve at the middle of the bucket. */
  fit: number | null;
  /** Adjusted views only: the plain mean of the same nights. */
  rawMeanY: number | null;
}

export interface SweetSpotViewFit {
  n: number;
  status: QuadraticFitStatus;
  hasCurve: boolean;
  r2: number | null;
  curvatureT: number | null;
  /** Where the parabola turns (may lie outside the data); null without a curve or a bend. */
  vertexX: number | null;
  peak: SweetSpotPoint | null;
  xMin: number | null;
  xMax: number | null;
}

export interface SweetSpotView {
  source: "pipeline" | "browser";
  adjusted: boolean;
  /** Nights behind this view (for an adjusted view: nights with every confounder). */
  n: number;
  size: number;
  /** Empty when there are too few nights to draw the chart. */
  buckets: SweetSpotViewBucket[];
  fit: SweetSpotViewFit;
}

function vertexOf(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a === 0) return null;
  const v = -b / (2 * a);
  return Number.isFinite(v) ? v : null;
}

/** The fallback: the chart computed here from the nightly rows (always unadjusted). */
export function sweetSpotViewFromRows(
  rows: ReadonlyArray<SweetSpotRow>,
  xKey: SweetSpotXKey,
  yKey: SweetSpotYKey,
): SweetSpotView {
  const points = sweetSpotPoints(rows, xKey, yKey);
  const fit = fitQuadratic(points);
  const viewFit: SweetSpotViewFit = {
    n: fit.n,
    status: fit.status,
    hasCurve: fit.curve !== null,
    r2: fit.curve?.r2 ?? null,
    curvatureT: fit.curve?.curvatureT ?? null,
    vertexX: fit.curve ? vertexOf(fit.curve.a, fit.curve.b) : null,
    peak: fit.peak,
    xMin: fit.xMin,
    xMax: fit.xMax,
  };
  const base = { source: "browser" as const, adjusted: false, n: points.length, fit: viewFit };
  const size = SWEET_SPOT_X[xKey].bucketSize;
  if (points.length < SWEET_SPOT_MIN_NIGHTS_CHART) return { ...base, size, buckets: [] };
  const grid = bucketSweetSpot(points, size);
  return {
    ...base,
    size: grid.size,
    buckets: grid.buckets.map((b) => ({
      start: b.start, end: b.end, n: b.n, meanY: b.meanY, sem: b.sem, sd: b.sd,
      fit: fit.curve ? predictQuadratic(fit.curve, b.mid) : null,
      rawMeanY: null,
    })),
  };
}

function bakedFitView(f: SweetSpotBakedFit): SweetSpotViewFit {
  return {
    n: f.n, status: f.status, hasCurve: f.a !== null && f.b !== null, r2: f.r2, curvatureT: f.t,
    vertexX: vertexOf(f.a, f.b), peak: f.peak, xMin: f.xMin, xMax: f.xMax,
  };
}

/**
 * The pipeline's result for one pair. `adjusted` asks for the confounder-adjusted version;
 * when the pair has none the unadjusted view is returned (check `view.adjusted`).
 */
export function sweetSpotViewFromBaked(pair: SweetSpotBakedPair, adjusted: boolean): SweetSpotView {
  if (adjusted && pair.adj.status === "ok" && pair.adj.fit) {
    return {
      source: "pipeline", adjusted: true, n: pair.adj.n, size: pair.size, fit: bakedFitView(pair.adj.fit),
      buckets: pair.buckets.map((b, i) => {
        const a = pair.adj.buckets[i];
        return { start: b.start, end: b.start + pair.size, n: a.n, meanY: a.mean, sem: a.sem, sd: null, fit: a.fit, rawMeanY: a.raw };
      }),
    };
  }
  return {
    source: "pipeline", adjusted: false, n: pair.n, size: pair.size, fit: bakedFitView(pair.fit),
    buckets: pair.buckets.map((b) => ({
      start: b.start, end: b.start + pair.size, n: b.n, meanY: b.mean, sem: b.sem, sd: b.sd, fit: b.fit, rawMeanY: null,
    })),
  };
}

/**
 * The view the panel draws: the pipeline's result for the pair when it has one, otherwise the
 * browser computation on `rows`.
 */
export function sweetSpotView(
  rows: ReadonlyArray<SweetSpotRow>,
  baked: SweetSpotBaked | null,
  xKey: SweetSpotXKey,
  yKey: SweetSpotYKey,
  adjusted: boolean,
): SweetSpotView {
  const pair = baked?.pairs[sweetSpotPairKey(xKey, yKey)];
  return pair ? sweetSpotViewFromBaked(pair, adjusted) : sweetSpotViewFromRows(rows, xKey, yKey);
}

/** Nights for one pair from the same source the view would use (shown on the input selector). */
export function sweetSpotNights(
  rows: ReadonlyArray<SweetSpotRow>,
  baked: SweetSpotBaked | null,
  xKey: SweetSpotXKey,
  yKey: SweetSpotYKey,
): number {
  const pair = baked?.pairs[sweetSpotPairKey(xKey, yKey)];
  return pair ? pair.n : sweetSpotPoints(rows, xKey, yKey).length;
}
