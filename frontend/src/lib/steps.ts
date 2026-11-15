// Daily steps for display, from the two devices that count them.
//
//   Garmin  pds.garmin_daily_summary.total_steps, one row per clock day. The watch is rarely
//           worn, and an unworn day still has a row with 0 (or null) steps.
//   WHOOP   pds.whoop_cycles.step_count, one count per WHOOP cycle (whoop_etl.py, /v2/cycle).
//           WHOOP sends null, never 0, when it has no step data.
//
// A WHOOP cycle starts at a sleep onset and runs to the next one, so its steps are the
// waking day after that onset. Each cycle is dated from its OWN start, in its local time
// (start_time + timezone_offset; America/New_York when the offset is missing): the
// behavioral day (-6 h rule) of the instant 12 h after the onset, i.e. (local start + 6 h)'s
// date. For a night-time onset that is the cycle's onyx_behavioral_date + 1; an onset
// between 06:00 and 18:00 local counts its own clock day. Cycles that land on the same day
// are added up (they are consecutive spans). The same rule as the HRV pipeline
// (hrv_alignment.cycle_waking_day, used by hrv_analysis.merge_whoop_steps_features), so the
// page and the analysis agree on the day.
//
// When both devices counted a day, the page shows the LARGER count, labelled with its
// device: the watch is often worn for only part of a day, and a partial-wear Garmin count is
// not a low-step day. The two counts are never added together. (The HRV pipeline uses WHOOP
// alone, every day; this choice is display only.)

export type StepSource = "GARMIN" | "WHOOP";

export interface DailySteps {
  /** Clock day, YYYY-MM-DD. */
  day: string;
  steps: number;
  source: StepSource;
  /** WHOOP's open cycle: the count so far, still rising. */
  partial: boolean;
}

export interface GarminStepsRow {
  calendar_date?: string | null;
  total_steps?: number | string | null;
}

export interface WhoopStepsRow {
  start_time?: string | null;
  end_time?: string | null;
  /** WHOOP's local offset at the cycle, e.g. "-04:00". */
  timezone_offset?: string | null;
  onyx_behavioral_date?: string | null;
  step_count?: number | string | null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** A whole, non-negative step count, or null. Booleans, text that is not a number, negatives and fractions are missing. */
export function parseSteps(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean" || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** 12 h after the onset, minus the 6 h behavioral-day offset. */
const ONSET_TO_WAKING_DAY_MS = (12 - 6) * HOUR_MS;

/** A WHOOP timezone_offset ("-04:00", "+0530", "-04") in minutes east of UTC, or null. */
export function offsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0);
  if (minutes > 14 * 60) return null;
  return m[1] === "+" ? minutes : -minutes;
}

let etFormat: Intl.DateTimeFormat | null = null;

/** America/New_York's offset from UTC at an instant, in minutes (negative = west). */
function etOffsetMinutes(ms: number): number {
  etFormat ??= new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts = etFormat.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((wall - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/** The waking day ("YYYY-MM-DD") whose steps a WHOOP cycle counts, from the cycle's own local start. */
export function whoopStepsDay(cycle: WhoopStepsRow | null | undefined): string | null {
  const start = typeof cycle?.start_time === "string" ? Date.parse(cycle.start_time) : NaN;
  if (!Number.isFinite(start)) return null;
  const offset = offsetMinutes(cycle?.timezone_offset) ?? etOffsetMinutes(start);
  const day = new Date(start + offset * MINUTE_MS + ONSET_TO_WAKING_DAY_MS);
  return Number.isNaN(day.getTime()) ? null : day.toISOString().slice(0, 10);
}

const byDay = (x: DailySteps, y: DailySteps) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0);

/**
 * One WHOOP count per waking day: the sum of the cycles dated to it (consecutive spans, so
 * nothing is counted twice). A day that includes the open cycle is marked partial (the count
 * so far); a cycle without a count adds nothing.
 */
export function whoopDailySteps(cycles: readonly (WhoopStepsRow | null | undefined)[]): DailySteps[] {
  const days = new Map<string, DailySteps>();
  for (const c of cycles ?? []) {
    if (!c) continue;
    const day = whoopStepsDay(c);
    const steps = parseSteps(c.step_count);
    if (day === null || steps === null) continue;
    const open = !c.end_time;
    const held = days.get(day);
    if (held) {
      held.steps += steps;
      held.partial = held.partial || open;
    } else {
      days.set(day, { day, steps, source: "WHOOP", partial: open });
    }
  }
  return [...days.values()].sort(byDay);
}

/**
 * One count per day: the larger of Garmin's and WHOOP's, labelled with its device (WHOOP on a
 * tie). A Garmin day with 0 steps is "watch not worn" and never shown. Sorted by day.
 */
export function mergeDailySteps(
  summaries: readonly (GarminStepsRow | null | undefined)[],
  cycles: readonly (WhoopStepsRow | null | undefined)[],
): DailySteps[] {
  const out = new Map<string, DailySteps>();
  for (const w of whoopDailySteps(cycles)) out.set(w.day, w);
  for (const g of summaries ?? []) {
    const m = typeof g?.calendar_date === "string" ? DAY_RE.exec(g.calendar_date) : null;
    const steps = parseSteps(g?.total_steps);
    if (!m || steps === null || steps <= 0) continue; // 0 = watch not worn
    const day = m[0];
    const whoop = out.get(day);
    if (whoop && whoop.steps >= steps) continue;
    out.set(day, { day, steps, source: "GARMIN", partial: false });
  }
  return [...out.values()].sort(byDay);
}

/** Badge for a chart of these days: the one device, or both. Undefined when there is nothing to show. */
export function stepsSourceLabel(days: readonly DailySteps[]): "GARMIN" | "WHOOP" | "GARMIN + WHOOP" | undefined {
  const garmin = days.some((d) => d.source === "GARMIN");
  const whoop = days.some((d) => d.source === "WHOOP");
  return garmin && whoop ? "GARMIN + WHOOP" : garmin ? "GARMIN" : whoop ? "WHOOP" : undefined;
}
