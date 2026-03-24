/**
 * Statistical utility functions for the Health Insights page.
 * All functions are null-safe and handle edge cases gracefully.
 */

/** Filter to indices where both values are finite numbers */
export function cleanPairs(xs: (number | null | undefined)[], ys: (number | null | undefined)[]): [number[], number[]] {
  const cx: number[] = [];
  const cy: number[] = [];
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x != null && y != null && isFinite(x) && isFinite(y)) {
      cx.push(x);
      cy.push(y);
    }
  }
  return [cx, cy];
}

/** Arithmetic mean (returns 0 for empty) */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Pearson correlation coefficient. Returns null if < minPairs valid pairs. */
export function pearsonR(rawX: (number | null | undefined)[], rawY: (number | null | undefined)[], minPairs = 5): number | null {
  const [xs, ys] = cleanPairs(rawX, rawY);
  if (xs.length < minPairs) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return num / denom;
}

/** Linear regression: slope, intercept, r². Returns null if < minPairs. */
export function linearRegression(
  rawX: (number | null | undefined)[],
  rawY: (number | null | undefined)[],
  minPairs = 5
): { slope: number; intercept: number; r2: number; n: number } | null {
  const [xs, ys] = cleanPairs(rawX, rawY);
  if (xs.length < minPairs) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0) return null;
  const slope = num / dx2;
  const intercept = my - slope * mx;
  const denom = dx2 * dy2;
  const r2 = denom === 0 ? 0 : (num * num) / denom;
  return { slope, intercept, r2, n: xs.length };
}

/** Two-point array for rendering a Recharts trend line */
export function trendLine(
  reg: { slope: number; intercept: number } | null,
  xMin: number,
  xMax: number
): { x: number; y: number }[] {
  if (!reg) return [];
  return [
    { x: xMin, y: reg.slope * xMin + reg.intercept },
    { x: xMax, y: reg.slope * xMax + reg.intercept },
  ];
}

/** Fixed-width bins with label, min, max, and items */
export function binBy<T>(
  data: T[],
  accessor: (d: T) => number | null | undefined,
  binSize: number,
  rangeMin: number,
  rangeMax: number
): { label: string; min: number; max: number; items: T[] }[] {
  const bins: { label: string; min: number; max: number; items: T[] }[] = [];
  for (let lo = rangeMin; lo < rangeMax; lo += binSize) {
    const hi = lo + binSize;
    bins.push({ label: `${lo}–${hi}`, min: lo, max: hi, items: [] });
  }
  for (const d of data) {
    const v = accessor(d);
    if (v == null || !isFinite(v)) continue;
    const idx = Math.min(Math.floor((v - rangeMin) / binSize), bins.length - 1);
    if (idx >= 0 && idx < bins.length) bins[idx].items.push(d);
  }
  return bins;
}

/** Lookback rolling average. Returns null if insufficient window. */
export function rollingAvg(
  values: (number | null | undefined)[],
  window: number
): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const v = values[j];
      if (v != null && isFinite(v)) {
        sum += v;
        count++;
      }
    }
    result.push(count > 0 ? sum / count : null);
  }
  return result;
}

/**
 * Intraclass Correlation Coefficient — ICC(3,1) two-way mixed, consistency.
 * Takes an array of "rater" arrays (one per source/device), all same length,
 * aligned by index (e.g. day). Only rows where ALL raters have a finite value
 * are included. Returns null if fewer than minRows complete rows.
 */
export function icc(
  raters: (number | null | undefined)[][],
  minRows = 5
): { value: number; n: number; k: number } | null {
  const k = raters.length;
  if (k < 2) return null;
  const len = Math.min(...raters.map((r) => r.length));

  const rows: number[][] = [];
  for (let i = 0; i < len; i++) {
    const row: number[] = [];
    let valid = true;
    for (let j = 0; j < k; j++) {
      const v = raters[j][i];
      if (v == null || !isFinite(v)) { valid = false; break; }
      row.push(v);
    }
    if (valid) rows.push(row);
  }

  const n = rows.length;
  if (n < minRows) return null;

  let grandSum = 0;
  for (const row of rows) for (const v of row) grandSum += v;
  const grandMean = grandSum / (n * k);

  const rowMeans = rows.map((row) => row.reduce((s, v) => s + v, 0) / k);

  const colMeans: number[] = [];
  for (let j = 0; j < k; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rows[i][j];
    colMeans.push(s / n);
  }

  let ssRows = 0;
  for (const rm of rowMeans) ssRows += (rm - grandMean) ** 2;
  ssRows *= k;

  let ssError = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      const residual = rows[i][j] - rowMeans[i] - colMeans[j] + grandMean;
      ssError += residual ** 2;
    }
  }

  const msR = ssRows / (n - 1);
  const msE = ssError / ((n - 1) * (k - 1));

  const denom = msR + (k - 1) * msE;
  if (denom === 0) return null;

  return { value: (msR - msE) / denom, n, k };
}

/**
 * Bland-Altman analysis for method comparison.
 * Returns bias (mean difference), SD of differences, and limits of agreement
 * (±1.96 SD), plus the individual (mean, diff) points for plotting.
 */
export function blandAltman(
  rawA: (number | null | undefined)[],
  rawB: (number | null | undefined)[],
  minPairs = 5
): {
  bias: number;
  sd: number;
  lowerLoA: number;
  upperLoA: number;
  points: { mean: number; diff: number }[];
  n: number;
} | null {
  const [a, b] = cleanPairs(rawA, rawB);
  if (a.length < minPairs) return null;

  const points: { mean: number; diff: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    points.push({ mean: (a[i] + b[i]) / 2, diff: a[i] - b[i] });
  }

  const diffs = points.map((p) => p.diff);
  const bias = mean(diffs);
  const sd = Math.sqrt(
    diffs.reduce((s, d) => s + (d - bias) ** 2, 0) / (diffs.length - 1)
  );

  return {
    bias,
    sd,
    lowerLoA: bias - 1.96 * sd,
    upperLoA: bias + 1.96 * sd,
    points,
    n: a.length,
  };
}

/** Linear interpolation quantile (expects sorted ascending array) */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
