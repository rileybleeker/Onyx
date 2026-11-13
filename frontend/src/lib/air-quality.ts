/**
 * Pure helpers for the PM2.5 panel in the Environment section of /analytics/hrv.
 * Rows come from pds.air_quality_daily via GET /api/air-quality (one row per ET clock day).
 * No I/O here, so node --test can load it.
 */

export const AIR_QUALITY_COLUMNS =
  "calendar_date,pm25_mean,pm25_max,us_aqi_max,n_hours,latitude,longitude";
export const AIR_QUALITY_WINDOW_DAYS = 90;
/** A day with fewer hours than this is partial (today's row until the day ends). */
export const COMPLETE_DAY_MIN_HOURS = 20;
export const MEAN_WINDOW_DAYS = 30;

export interface AirDay {
  date: string; // YYYY-MM-DD, ET clock date
  pm25Mean: number | null;
  pm25Max: number | null;
  usAqiMax: number | null;
  nHours: number;
  partial: boolean;
}

export interface AirLocation {
  lat: number;
  lon: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isPartialDay(nHours: number): boolean {
  return nHours < COMPLETE_DAY_MIN_HOURS;
}

/** Parse one raw row; null when the date or hour count is unusable. */
export function parseAirRow(raw: unknown): (AirDay & { lat: number | null; lon: number | null }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.calendar_date === "string" ? r.calendar_date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const nHours = num(r.n_hours);
  if (nHours === null) return null;
  return {
    date,
    pm25Mean: num(r.pm25_mean),
    pm25Max: num(r.pm25_max),
    usAqiMax: num(r.us_aqi_max),
    nHours,
    partial: isPartialDay(nHours),
    lat: num(r.latitude),
    lon: num(r.longitude),
  };
}

/** Parse, drop unusable rows, sort ascending by date. */
export function shapeAirRows(rows: unknown[]): AirDay[] {
  const out: AirDay[] = [];
  for (const raw of rows) {
    const p = parseAirRow(raw);
    if (!p) continue;
    out.push({ date: p.date, pm25Mean: p.pm25Mean, pm25Max: p.pm25Max, usAqiMax: p.usAqiMax, nHours: p.nHours, partial: p.partial });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function hasMean(d: AirDay): boolean {
  return !d.partial && d.pm25Mean !== null;
}

/** Date of the newest complete day with a PM2.5 mean, or null. */
export function newestCompleteDate(days: AirDay[]): string | null {
  let best: string | null = null;
  for (const d of days) if (hasMean(d) && (best === null || d.date > best)) best = d.date;
  return best;
}

function shiftDate(date: string, deltaDays: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Mean of pm25_mean over complete days in the 30 calendar days ending at the newest complete
 * day. Partial days are ignored. Null for an empty list. Rounded to 0.1.
 */
export function mean30(days: AirDay[]): number | null {
  const newest = newestCompleteDate(days);
  if (newest === null) return null;
  const from = shiftDate(newest, -(MEAN_WINDOW_DAYS - 1));
  const vals = days.filter((d) => hasMean(d) && d.date >= from && d.date <= newest).map((d) => d.pm25Mean as number);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/** Chart points: complete days draw in `mean`, a partial day in `partialMean` (drawn dimmer). */
export interface AirChartPoint {
  date: string;
  mean: number | null;
  partialMean: number | null;
  max: number | null;
  usAqiMax: number | null;
  nHours: number;
}

export function chartPoints(days: AirDay[]): AirChartPoint[] {
  return days.map((d) => ({
    date: d.date,
    mean: d.partial ? null : d.pm25Mean,
    partialMean: d.partial ? d.pm25Mean : null,
    max: d.pm25Max,
    usAqiMax: d.usAqiMax,
    nHours: d.nHours,
  }));
}
