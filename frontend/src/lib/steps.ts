// Daily steps for display, from the two devices that count them.
//
//   Garmin  pds.garmin_daily_summary.total_steps, one row per clock day. The watch is rarely
//           worn, and an unworn day still has a row with 0 (or null) steps.
//   WHOOP   pds.whoop_cycles.step_count, one count per WHOOP cycle (whoop_etl.py, /v2/cycle).
//           WHOOP sends null, never 0, when it has no step data.
//
// A WHOOP cycle starts at a sleep onset and runs to the next one, so the cycle whose
// onyx_behavioral_date is D counts the waking day D + 1 (checked against Garmin on the days
// both exist: see hrv_alignment.py). The same rule the HRV pipeline uses
// (hrv_analysis.merge_whoop_steps_features), so the page and the analysis agree on the day.
//
// Garmin is shown on a day it has steps; WHOOP fills every other day. The two are never
// added together, and each day says which device it came from.

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

/** The waking day a WHOOP cycle's totals describe: its behavioral date + 1 day. */
export function whoopStepsDay(cycle: WhoopStepsRow | null | undefined): string | null {
  const m = typeof cycle?.onyx_behavioral_date === "string" ? DAY_RE.exec(cycle.onyx_behavioral_date) : null;
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return Number.isNaN(next.getTime()) ? null : next.toISOString().slice(0, 10);
}

function cycleSeconds(c: WhoopStepsRow): number | null {
  if (!c.start_time || !c.end_time) return null;
  const s = Date.parse(c.start_time);
  const e = Date.parse(c.end_time);
  return Number.isFinite(s) && Number.isFinite(e) ? (e - s) / 1000 : null;
}

/**
 * One WHOOP count per waking day: the longest closed cycle, as the matrix view and the
 * pipeline pick it (latest start breaks a tie); the open cycle is used only for a day that
 * has no closed one.
 */
export function whoopDailySteps(cycles: readonly (WhoopStepsRow | null | undefined)[]): DailySteps[] {
  const best = new Map<string, { row: DailySteps; seconds: number | null; start: number }>();
  for (const c of cycles ?? []) {
    if (!c) continue;
    const day = whoopStepsDay(c);
    const steps = parseSteps(c.step_count);
    if (day === null || steps === null) continue;
    const seconds = cycleSeconds(c);
    const start = c.start_time ? Date.parse(c.start_time) : NaN;
    const candidate = {
      row: { day, steps, source: "WHOOP" as const, partial: seconds === null },
      seconds,
      start: Number.isFinite(start) ? start : -Infinity,
    };
    const held = best.get(day);
    if (!held) {
      best.set(day, candidate);
      continue;
    }
    const a = candidate.seconds;
    const b = held.seconds;
    const wins =
      a !== null && b === null ? true
      : a === null && b !== null ? false
      : a !== null && b !== null && a !== b ? a > b
      : candidate.start > held.start;
    if (wins) best.set(day, candidate);
  }
  return [...best.values()].map((v) => v.row).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
}

/** Garmin where the watch counted steps that day, WHOOP on every other day. Sorted by day. */
export function mergeDailySteps(
  summaries: readonly (GarminStepsRow | null | undefined)[],
  cycles: readonly (WhoopStepsRow | null | undefined)[],
): DailySteps[] {
  const byDay = new Map<string, DailySteps>();
  for (const w of whoopDailySteps(cycles)) byDay.set(w.day, w);
  for (const g of summaries ?? []) {
    const m = typeof g?.calendar_date === "string" ? DAY_RE.exec(g.calendar_date) : null;
    const steps = parseSteps(g?.total_steps);
    if (!m || steps === null || steps <= 0) continue; // 0 = watch not worn
    const day = m[0];
    byDay.set(day, { day, steps, source: "GARMIN", partial: false });
  }
  return [...byDay.values()].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
}

/** Badge for a chart of these days: the one device, or both. Undefined when there is nothing to show. */
export function stepsSourceLabel(days: readonly DailySteps[]): "GARMIN" | "WHOOP" | "GARMIN + WHOOP" | undefined {
  const garmin = days.some((d) => d.source === "GARMIN");
  const whoop = days.some((d) => d.source === "WHOOP");
  return garmin && whoop ? "GARMIN + WHOOP" : garmin ? "GARMIN" : whoop ? "WHOOP" : undefined;
}
