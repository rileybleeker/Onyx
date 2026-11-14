// Environment Sweet Spot on /analytics/hrv: pure logic, no React and no Supabase, so the same
// code runs in the ISR prefetch, in the browser and in tests/sweet-spot.test.cjs.
//
// The panel is DESCRIPTIVE: it groups nights by the level of one input and shows the mean of
// one outcome of the same night. Nothing is adjusted for, so it shows association, not cause.
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
  unit: string;
  /** Decimals used when a single input value is printed. */
  decimals: number;
  bucketSize: number;
  axisLabel: string;
  /** What the value is and how far to trust it. */
  caveat: string;
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
    unit: "mg",
    decimals: 0,
    bucketSize: 100,
    axisLabel: "logged caffeine that day (mg, food + supplements)",
    caveat:
      "Caffeine logged for the day, food and supplements combined. Only days with at least one logged caffeine entry are included, so there is no zero-caffeine bucket to compare against.",
    fillsBy: "A night is added when caffeine is logged that day (Cronometer or /supplements).",
  },
  cafBed: {
    label: "Caffeine at bedtime",
    noun: "caffeine at bedtime",
    column: "caffeine_mg_at_bedtime",
    pairing: "same_row",
    toDisplay: same,
    unit: "mg",
    decimals: 0,
    bucketSize: 50,
    axisLabel: "estimated caffeine left at sleep onset (mg)",
    caveat:
      "An estimate of the caffeine still in your body at sleep onset: every logged dose decayed with a 5-hour half-life. Only days where every caffeine entry has a trustworthy clock time are included.",
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
}

export const SWEET_SPOT_Y: Record<SweetSpotYKey, SweetSpotYMeta> = {
  hrv: { label: "WHOOP HRV", noun: "HRV", column: "whoop_hrv_rmssd", unit: "ms", axisLabel: "WHOOP HRV (ms)", toDisplay: same },
  recovery: { label: "Recovery Score", noun: "recovery score", column: "whoop_recovery_score", unit: "%", axisLabel: "WHOOP Recovery (%)", toDisplay: same },
  efficiency: { label: "Sleep Efficiency", noun: "sleep efficiency", column: "whoop_sleep_efficiency", unit: "%", axisLabel: "WHOOP Sleep Efficiency (%)", toDisplay: same },
  deep: { label: "Deep Sleep", noun: "deep sleep", column: "whoop_deep_sleep_milli", unit: "min", axisLabel: "WHOOP Deep Sleep (min)", toDisplay: (ms) => ms / 60000 },
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
