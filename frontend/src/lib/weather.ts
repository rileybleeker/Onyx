/**
 * Pure helpers for the Weather panel next to the PM2.5 panel on /analytics/hrv.
 * Rows come from pds.weather_daily via GET /api/weather (one row per ET clock day, metric
 * units). The panel shows US units, converted here. No I/O, so node --test can load it.
 */

export const WEATHER_COLUMNS =
  "calendar_date,temperature_max,temperature_min,temperature_mean,apparent_temp_max,humidity_mean," +
  "dew_point_mean,pressure_mean,precipitation_sum,wind_speed_max,cloud_cover_mean,daylight_hours," +
  "sunshine_hours,uv_index_max,night_temp_mean,night_hours,n_hours,latitude,longitude";
export const WEATHER_WINDOW_DAYS = 90;
/**
 * The shortest full ET clock day (spring-forward; a normal day has 24 hourly values, fall-back 25).
 * Same rule as WX_MIN_HOURS in hrv_analysis.py.
 */
export const COMPLETE_DAY_MIN_HOURS = 23;
/** The 01:00-08:00 ET night needs this many hourly values (8 normally, 7 / 9 on DST days). */
export const NIGHT_MIN_HOURS = 7;
export const MEAN_WINDOW_DAYS = 30;

export interface WeatherDay {
  date: string; // YYYY-MM-DD, ET clock date
  highF: number | null;
  lowF: number | null;
  meanF: number | null;
  feelsHighF: number | null;
  /** Mean of the 01:00-08:00 ET hours of this clock day (the night that started the evening before). */
  nightF: number | null;
  dewPointF: number | null;
  humidity: number | null; // %
  pressure: number | null; // hPa at the surface
  rainIn: number | null;
  windMph: number | null;
  cloud: number | null; // %
  daylightH: number | null;
  sunshineH: number | null;
  uvMax: number | null;
  nHours: number;
  partial: boolean;
}

export interface WeatherLocation {
  lat: number;
  lon: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function cToF(c: number | null): number | null {
  return c === null ? null : round((c * 9) / 5 + 32, 1);
}

export function mmToIn(mm: number | null): number | null {
  return mm === null ? null : round(mm / 25.4, 2);
}

export function kmhToMph(kmh: number | null): number | null {
  return kmh === null ? null : round(kmh / 1.609344, 1);
}

/**
 * A day is complete only when it is OVER (its date is before the ET clock date `etToday`) and
 * has all its hours. The hour count alone is not enough: today passes 20 hours in the evening
 * while its high, rain total and peak wind can still change. A past day short of hours (an API
 * gap or a half-written row) is partial too.
 */
export function isPartialDay(date: string, nHours: number, etToday: string): boolean {
  return date >= etToday || nHours < COMPLETE_DAY_MIN_HOURS;
}

/**
 * Parse one raw row (metric) into display units; null when the date or hour count is unusable.
 * `etToday` is the ET clock date (YYYY-MM-DD) at read time.
 */
export function parseWeatherRow(
  raw: unknown,
  etToday: string,
): { day: WeatherDay; lat: number | null; lon: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.calendar_date === "string" ? r.calendar_date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const nHours = num(r.n_hours);
  if (nHours === null) return null;
  const nightHours = num(r.night_hours) ?? 0;
  const day: WeatherDay = {
    date,
    highF: cToF(num(r.temperature_max)),
    lowF: cToF(num(r.temperature_min)),
    meanF: cToF(num(r.temperature_mean)),
    feelsHighF: cToF(num(r.apparent_temp_max)),
    nightF: nightHours >= NIGHT_MIN_HOURS ? cToF(num(r.night_temp_mean)) : null,
    dewPointF: cToF(num(r.dew_point_mean)),
    humidity: num(r.humidity_mean),
    pressure: num(r.pressure_mean),
    rainIn: mmToIn(num(r.precipitation_sum)),
    windMph: kmhToMph(num(r.wind_speed_max)),
    cloud: num(r.cloud_cover_mean),
    daylightH: num(r.daylight_hours),
    sunshineH: num(r.sunshine_hours),
    uvMax: num(r.uv_index_max),
    nHours,
    partial: isPartialDay(date, nHours, etToday),
  };
  return { day, lat: num(r.latitude), lon: num(r.longitude) };
}

/** Parse, drop unusable rows, sort ascending by date. */
export function shapeWeatherRows(rows: unknown[], etToday: string): WeatherDay[] {
  const out: WeatherDay[] = [];
  for (const raw of rows) {
    const p = parseWeatherRow(raw, etToday);
    if (p) out.push(p.day);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Date of the newest complete day, or null. */
export function newestCompleteDate(days: WeatherDay[]): string | null {
  let best: string | null = null;
  for (const d of days) if (!d.partial && (best === null || d.date > best)) best = d.date;
  return best;
}

function shiftDate(date: string, deltaDays: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function mean(vals: (number | null)[], digits = 1): number | null {
  const xs = vals.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return round(xs.reduce((a, b) => a + b, 0) / xs.length, digits);
}

export interface WeatherSummary {
  days: number;
  highF: number | null;
  nightF: number | null;
  humidity: number | null;
  sunshineH: number | null;
  rainIn: number | null; // total over the window
}

/**
 * Means over the complete days in the 30 calendar days ending at the newest complete day
 * (rain is the total). Partial days are ignored. Null for a list with no complete day.
 */
export function summary30(days: WeatherDay[]): WeatherSummary | null {
  const newest = newestCompleteDate(days);
  if (newest === null) return null;
  const from = shiftDate(newest, -(MEAN_WINDOW_DAYS - 1));
  const win = days.filter((d) => !d.partial && d.date >= from && d.date <= newest);
  const rain = win.map((d) => d.rainIn).filter((v): v is number => v !== null);
  return {
    days: win.length,
    highF: mean(win.map((d) => d.highF)),
    nightF: mean(win.map((d) => d.nightF)),
    humidity: mean(win.map((d) => d.humidity), 0),
    sunshineH: mean(win.map((d) => d.sunshineH)),
    rainIn: rain.length ? round(rain.reduce((a, b) => a + b, 0), 2) : null,
  };
}

export type WeatherMetric = "temperature" | "humidity" | "sun" | "rain" | "pressure";

export interface WeatherSeries {
  key: keyof WeatherChartPoint;
  name: string;
  /** Drawn thinner / dimmer than the first series. */
  secondary?: boolean;
  /** Plot against the right-hand axis (a different unit and scale from the first series). */
  rightAxis?: boolean;
}

export const WEATHER_METRICS: Record<WeatherMetric, { label: string; series: WeatherSeries[] }> = {
  temperature: {
    label: "Temperature",
    series: [
      { key: "highF", name: "High (°F)" },
      { key: "nightF", name: "Night 1-8 AM (°F)", secondary: true },
      { key: "feelsHighF", name: "Feels-like high (°F)", secondary: true },
    ],
  },
  humidity: {
    label: "Humidity",
    series: [
      { key: "humidity", name: "Relative humidity (%)" },
      { key: "dewPointF", name: "Dew point (°F)", secondary: true },
    ],
  },
  sun: {
    label: "Sun",
    series: [
      { key: "sunshineH", name: "Sunshine (h)" },
      { key: "daylightH", name: "Daylight (h)", secondary: true },
      { key: "uvMax", name: "Peak UV index", secondary: true },
    ],
  },
  rain: {
    label: "Rain & wind",
    series: [
      { key: "rainIn", name: "Rain (in)" },
      { key: "windMph", name: "Peak wind (mph)", secondary: true, rightAxis: true },
    ],
  },
  pressure: {
    label: "Pressure",
    series: [{ key: "pressure", name: "Surface pressure (hPa)" }],
  },
};
export const WEATHER_METRIC_KEYS = Object.keys(WEATHER_METRICS) as WeatherMetric[];

/**
 * Chart points. A partial day (today until it is over, or a day short of hours) is left out of
 * the daytime series, because its high, sunshine and rain are still growing; its night value is
 * already final and is kept.
 */
export interface WeatherChartPoint {
  date: string;
  highF: number | null;
  feelsHighF: number | null;
  nightF: number | null;
  humidity: number | null;
  dewPointF: number | null;
  sunshineH: number | null;
  daylightH: number | null;
  uvMax: number | null;
  rainIn: number | null;
  windMph: number | null;
  pressure: number | null;
}

export function chartPoints(days: WeatherDay[]): WeatherChartPoint[] {
  return days.map((d) => {
    const v = (x: number | null) => (d.partial ? null : x);
    return {
      date: d.date,
      highF: v(d.highF),
      feelsHighF: v(d.feelsHighF),
      nightF: d.nightF,
      humidity: v(d.humidity),
      dewPointF: v(d.dewPointF),
      sunshineH: v(d.sunshineH),
      daylightH: d.daylightH,
      uvMax: v(d.uvMax),
      rainIn: v(d.rainIn),
      windMph: v(d.windMph),
      pressure: v(d.pressure),
    };
  });
}
