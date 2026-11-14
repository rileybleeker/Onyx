/**
 * Pure helpers for iPhone Screen Time (pds.phone_usage_daily, one row per behavioral day, filled by
 * the Onyx Screen Time app). Used by the /screen-time page.
 * No I/O here, so node --test can load it (tests/screen-time.test.cjs, synthetic rows only).
 *
 * Two readiness rules, both mirrored from the HRV pipeline (hrv_analysis.py:merge_screen_time_features):
 *   complete      a sync happened after the day ended (synced_at >= day + 1 at 06:00 ET). The app
 *                 syncs around 10 AM for the days before, so the newest day is usually partial.
 *   bedtimeReady  complete, the WHOOP main sleep that closes the day is scored, and the sync is at
 *                 least an hour past sleep onset (so the hour that straddles onset was fully sent).
 *                 Only then are the two sleep-anchored estimates shown or used.
 */

/** Explicit column list for every read of pds.phone_usage_daily (never select "*"). */
export const SCREEN_TIME_COLUMNS =
  "behavioral_date,total_minutes,late_night_minutes,after_midnight_minutes,pickups,notifications," +
  "apps_used,sleep_start,minutes_last_hour_before_sleep_est,minutes_during_sleep_est," +
  "minutes_by_app,minutes_by_category,synced_at";

export const DEFAULT_WINDOW_DAYS = 30;
export const WINDOW_CHOICES = [14, 30, 90] as const;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 180;
export const TOP_LIST_LIMIT = 10;
/** Shown for apps Apple gave no category (the view stores them as "(none)"). */
export const NO_CATEGORY_LABEL = "Uncategorised";

export interface ScreenDay {
  date: string; // behavioral day, YYYY-MM-DD
  totalMin: number | null;
  lateNightMin: number | null; // hours starting 22:00-05:59 local
  afterMidnightMin: number | null; // hours starting 00:00-05:59 local (a subset of late night)
  pickups: number | null;
  notifications: number | null;
  appsUsed: number | null;
  sleepStart: string | null;
  lastHourBeforeSleepMin: number | null; // estimate (hourly data, overlap-weighted)
  duringSleepMin: number | null; // estimate
  byApp: Record<string, number>;
  byCategory: Record<string, number>;
  syncedAt: string | null;
  complete: boolean;
  bedtimeReady: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function instant(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

function minutesMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = num(raw);
    if (k && n !== null && n > 0) out[k] = n;
  }
  return out;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ET_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** "YYYY-MM-DDTHH" of an instant on the New York clock (sortable as text). */
export function etHourStamp(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p: Record<string, string> = {};
  for (const part of ET_STAMP.formatToParts(new Date(t))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}

/** The first behavioral day the page shows: `days` days ending at behavioral today (ET clock - 6 h). */
export function windowStart(now: Date, days: number): string {
  const stamp = etHourStamp(new Date(now.getTime() - 6 * 3_600_000).toISOString());
  return addDays((stamp ?? now.toISOString()).slice(0, 10), -(days - 1));
}

/** A day is complete once a sync happened after it ended: synced_at >= day + 1 at 06:00 ET. */
export function isDayComplete(date: string, syncedAt: string | null): boolean {
  if (!syncedAt) return false;
  const stamp = etHourStamp(syncedAt);
  return stamp !== null && stamp >= `${addDays(date, 1)}T06`;
}

/** Parse one raw row; null when the date is unusable. */
export function parseScreenRow(raw: unknown): ScreenDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.behavioral_date === "string" ? r.behavioral_date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const syncedAt = instant(r.synced_at);
  const sleepStart = instant(r.sleep_start);
  const complete = isDayComplete(date, syncedAt);
  const bedtimeReady =
    complete && sleepStart !== null && syncedAt !== null && Date.parse(syncedAt) >= Date.parse(sleepStart) + 3_600_000;
  return {
    date,
    totalMin: num(r.total_minutes),
    lateNightMin: num(r.late_night_minutes),
    afterMidnightMin: num(r.after_midnight_minutes),
    pickups: num(r.pickups),
    notifications: num(r.notifications),
    appsUsed: num(r.apps_used),
    sleepStart,
    lastHourBeforeSleepMin: bedtimeReady ? num(r.minutes_last_hour_before_sleep_est) : null,
    duringSleepMin: bedtimeReady ? num(r.minutes_during_sleep_est) : null,
    byApp: minutesMap(r.minutes_by_app),
    byCategory: minutesMap(r.minutes_by_category),
    syncedAt,
    complete,
    bedtimeReady,
  };
}

/** Parse, drop unusable rows, keep one row per day, sort ascending by date. */
export function shapeScreenRows(rows: readonly unknown[]): ScreenDay[] {
  const byDate = new Map<string, ScreenDay>();
  for (const raw of rows) {
    const d = parseScreenRow(raw);
    if (d && !byDate.has(d.date)) byDate.set(d.date, d);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** ?days= from the URL: 7 to 180, default 30. */
export function parseWindowDays(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s || !/^\d{1,4}$/.test(s)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Number(s)));
}

function mean(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface ScreenSummary {
  completeDays: number;
  partialDays: number;
  avgTotalMin: number | null;
  avgLateNightMin: number | null;
  avgAfterMidnightMin: number | null;
  avgPickups: number | null;
  avgNotifications: number | null;
  /** Days with a usable pre-sleep estimate, and their averages. */
  bedtimeDays: number;
  avgLastHourBeforeSleepMin: number | null;
  avgDuringSleepMin: number | null;
}

/** Averages over COMPLETE days only (a partial day would drag every average down). */
export function summarize(days: readonly ScreenDay[]): ScreenSummary {
  const done = days.filter((d) => d.complete);
  const bed = done.filter((d) => d.bedtimeReady && d.lastHourBeforeSleepMin !== null);
  return {
    completeDays: done.length,
    partialDays: days.length - done.length,
    avgTotalMin: mean(done.map((d) => d.totalMin)),
    avgLateNightMin: mean(done.map((d) => d.lateNightMin)),
    avgAfterMidnightMin: mean(done.map((d) => d.afterMidnightMin)),
    avgPickups: mean(done.map((d) => d.pickups)),
    avgNotifications: mean(done.map((d) => d.notifications)),
    bedtimeDays: bed.length,
    avgLastHourBeforeSleepMin: mean(bed.map((d) => d.lastHourBeforeSleepMin)),
    avgDuringSleepMin: mean(bed.map((d) => d.duringSleepMin)),
  };
}

export interface TopEntry {
  label: string;
  minutes: number; // total over the complete days in the window
  perDay: number; // minutes / complete days
  daysUsed: number;
  share: number; // of all minutes in this list's dimension, 0..1
}

/** Apps or categories ranked by total minutes over complete days. Ties break by name. */
export function topEntries(days: readonly ScreenDay[], key: "byApp" | "byCategory", limit = TOP_LIST_LIMIT): TopEntry[] {
  const done = days.filter((d) => d.complete);
  if (!done.length) return [];
  const totals = new Map<string, { minutes: number; daysUsed: number }>();
  let all = 0;
  for (const d of done) {
    for (const [name, minutes] of Object.entries(d[key])) {
      const label = key === "byCategory" && name === "(none)" ? NO_CATEGORY_LABEL : name;
      const t = totals.get(label) ?? { minutes: 0, daysUsed: 0 };
      t.minutes += minutes;
      t.daysUsed += 1;
      totals.set(label, t);
      all += minutes;
    }
  }
  return [...totals.entries()]
    .map(([label, t]) => ({
      label,
      minutes: t.minutes,
      perDay: t.minutes / done.length,
      daysUsed: t.daysUsed,
      share: all > 0 ? t.minutes / all : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, limit);
}

export interface ScreenPoint {
  date: string;
  label: string; // M/D
  total: number | null; // complete days
  totalPartial: number | null; // a day still syncing, drawn dimmer
  evening: number | null; // 22:00-23:59 (late night minus after midnight)
  afterMidnight: number | null; // 00:00-05:59
  pickups: number | null;
  notifications: number | null;
  lastHour: number | null;
  duringSleep: number | null;
}

/**
 * One point per calendar day from the first to the last row, so a day the app never reported is a
 * visible gap instead of two bars sliding together. A partial day only draws its (dim) total.
 */
export function chartPoints(days: readonly ScreenDay[]): ScreenPoint[] {
  if (!days.length) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: ScreenPoint[] = [];
  const last = days[days.length - 1].date;
  for (let date = days[0].date; date <= last; date = addDays(date, 1)) {
    const d = byDate.get(date);
    const done = d?.complete ? d : null;
    out.push({
      date,
      label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
      total: done?.totalMin ?? null,
      totalPartial: d && !d.complete ? d.totalMin : null,
      evening:
        done && done.lateNightMin !== null ? Math.max(0, done.lateNightMin - (done.afterMidnightMin ?? 0)) : null,
      afterMidnight: done?.afterMidnightMin ?? null,
      pickups: done?.pickups ?? null,
      notifications: done?.notifications ?? null,
      lastHour: done?.lastHourBeforeSleepMin ?? null,
      duringSleep: done?.duringSleepMin ?? null,
    });
  }
  return out;
}

/** 135 -> "2h 15m", 42.4 -> "42m", null -> "-". */
export function formatMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "-";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)}h ${rest}m` : `${Math.floor(m / 60)}h`;
}
