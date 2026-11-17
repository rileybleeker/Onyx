/**
 * Pure helpers for the Pollen panel in the Environment section of /analytics/hrv.
 * Rows come from pds.pollen_daily via GET /api/pollen (one row per PUBLISHED count).
 * No I/O here, so node --test can load it.
 *
 * Dates: the count published on count_date P covers the 24 h before that morning, so it is
 * plotted on air day P - 1 (sql/pollen_schema.sql). Date math is done on YYYY-MM-DD strings in
 * UTC, never with local-time Date parsing.
 *
 * Missing is missing: a day without a row is a gap (null), never 0. A published 0 is a real 0.
 */

export const POLLEN_COLUMNS =
  "count_date,total_count,count_level,tree_level,grass_level,weed_level,mold_level";
/** ET days read by the server (the 2-year range). */
export const POLLEN_WINDOW_DAYS = 730;
/** Row cap on the read: one row per day at most, with headroom. */
export const POLLEN_ROW_LIMIT = 1000;

export const POLLEN_LEVELS = ["low", "medium", "high", "extreme"] as const;
export type PollenLevel = (typeof POLLEN_LEVELS)[number];

export interface PollenDay {
  countDate: string; // YYYY-MM-DD, the date the count was published for
  airDate: string; // countDate - 1: the day the air was sampled
  total: number;
  level: PollenLevel | null;
  tree: PollenLevel | null;
  grass: PollenLevel | null;
  weed: PollenLevel | null;
  mold: PollenLevel | null;
}

export type PollenRange = "90d" | "1y" | "2y";
export const POLLEN_RANGES: Record<PollenRange, { label: string; days: number }> = {
  "90d": { label: "90 days", days: 90 },
  "1y": { label: "1 year", days: 365 },
  "2y": { label: "2 years", days: 730 },
};
export const POLLEN_RANGE_KEYS: PollenRange[] = ["90d", "1y", "2y"];
export const DEFAULT_POLLEN_RANGE: PollenRange = "1y";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written as YYYY-MM-DD (2030-02-30 is not). */
export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Move a YYYY-MM-DD date by whole days, in UTC. */
export function shiftDate(date: string, deltaDays: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The air day a count published on `countDate` describes. */
export function airDateFor(countDate: string): string {
  return shiftDate(countDate, -1);
}

/** The ET clock date of an instant, as YYYY-MM-DD. */
export function etDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** low / medium / high / extreme (any case, trimmed); anything else is null. */
export function parseLevel(v: unknown): PollenLevel | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (POLLEN_LEVELS as readonly string[]).includes(s) ? (s as PollenLevel) : null;
}

function count(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parse one raw row; null when the date or the total count is unusable. */
export function parsePollenRow(raw: unknown): PollenDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const countDate = typeof r.count_date === "string" ? r.count_date.slice(0, 10) : "";
  if (!isIsoDate(countDate)) return null;
  const total = count(r.total_count);
  if (total === null) return null;
  return {
    countDate,
    airDate: airDateFor(countDate),
    total,
    level: parseLevel(r.count_level),
    tree: parseLevel(r.tree_level),
    grass: parseLevel(r.grass_level),
    weed: parseLevel(r.weed_level),
    mold: parseLevel(r.mold_level),
  };
}

/** Parse, drop malformed rows and duplicate dates (first wins), sort ascending by count date. */
export function shapePollenRows(rows: unknown[]): PollenDay[] {
  const seen = new Set<string>();
  const out: PollenDay[] = [];
  for (const raw of rows) {
    const p = parsePollenRow(raw);
    if (!p || seen.has(p.countDate)) continue;
    seen.add(p.countDate);
    out.push(p);
  }
  return out.sort((a, b) => (a.countDate < b.countDate ? -1 : a.countDate > b.countDate ? 1 : 0));
}

/** The newest published count, or null. */
export function newestCount(days: PollenDay[]): PollenDay | null {
  let best: PollenDay | null = null;
  for (const d of days) if (best === null || d.countDate > best.countDate) best = d;
  return best;
}

/**
 * Air days covered by a range ending at yesterday (ET), the newest air day a count can describe
 * (today's count is published tomorrow morning).
 */
export function rangeBounds(range: PollenRange, etToday: string): { from: string; to: string } {
  const to = shiftDate(etToday, -1);
  return { from: shiftDate(to, -(POLLEN_RANGES[range].days - 1)), to };
}

export interface PollenPoint {
  date: string; // air day
  countDate: string | null; // publication date, null on a gap day
  total: number | null; // null = no count that day (a gap, never 0)
  level: PollenLevel | null;
}

/** One point per air day in the range; days without a count are null (no bar). */
export function chartPoints(days: PollenDay[], range: PollenRange, etToday: string): PollenPoint[] {
  const { from, to } = rangeBounds(range, etToday);
  const byAir = new Map<string, PollenDay>();
  for (const d of days) if (d.airDate >= from && d.airDate <= to) byAir.set(d.airDate, d);
  const out: PollenPoint[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    const d = byAir.get(date);
    out.push(d
      ? { date, countDate: d.countDate, total: d.total, level: d.level }
      : { date, countDate: null, total: null, level: null });
  }
  return out;
}

/** Counts inside the range (0 = show the empty state). */
export function countsInRange(points: PollenPoint[]): number {
  let n = 0;
  for (const p of points) if (p.total !== null) n += 1;
  return n;
}
