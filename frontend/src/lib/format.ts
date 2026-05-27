export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Convert a UTC instant to its ET (America/New_York) calendar date (YYYY-MM-DD).
// WHOOP's app labels each sleep by its wake-day, so callers should pass
// `sleep.end_time` (not start_time). For post-midnight bedtimes bedtime and wake
// land on the same date; for pre-midnight bedtimes they diverge — using end_time
// keeps us aligned with WHOOP's UI.
export function etDate(instant: string | null | undefined): string {
  if (!instant) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Shift a YYYY-MM-DD date string by `days` (positive forward, negative back).
// Operates in UTC to sidestep browser-TZ / DST edges since the input is
// already a calendar-date string.
export function shiftDate(yyyymmdd: string, days: number): string {
  if (!yyyymmdd) return "";
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The WHOOP "biological day" for a sleep event: pre-6 AM ET bedtimes are
// folded into the previous calendar day's nightly cycle; daytime and evening
// bedtimes stay on their own day. Equivalent to wake_day − 1 for typical
// post-midnight bedtimes, but lets daytime naps land on the actual day they
// occurred — which is what WHOOP's app does.
export function whoopSleepDay(startTime: string | null | undefined): string {
  if (!startTime) return "";
  const shifted = new Date(new Date(startTime).getTime() - 6 * 3600 * 1000);
  return etDate(shifted.toISOString());
}

/**
 * Format a duration expressed in SECONDS as "Xh Ym" or "Ym".
 *
 * Unit convention (canonical across the codebase):
 *   - Garmin + Eight Sleep store durations in SECONDS — pass directly.
 *   - WHOOP stores durations in MILLISECONDS — use `formatDurationMs` or
 *     divide by 1000 first. Passing raw WHOOP `_milli` values here renders
 *     durations 1000× too large.
 */
export function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Format a duration expressed in MILLISECONDS. Thin wrapper that converts
 * to seconds and delegates — exists so WHOOP `_milli` fields can be passed
 * directly without each caller risking the off-by-1000 bug.
 */
export function formatDurationMs(ms: number | null): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  return formatDuration(Math.round(ms / 1000));
}

// Second-precision duration for short events (lap times, intervals). Format:
// <60s → "30s"; <1h → "8:09"; ≥1h → "1:02:42".
export function formatShortDuration(seconds: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

export function formatDistance(meters: number | null): string {
  if (!meters) return "—";
  const miles = meters / 1609.344;
  if (miles >= 0.5) return `${miles.toFixed(1)} mi`;
  return `${Math.round(meters)} m`;
}

// ─── Canonical unit conversions ───
// Helpers live here (not in component files) so every conversion site reads
// from one source. format.ts is the canonical formatter per CLAUDE.md.
// Conversions are precise; rounding/formatting happens at display time only,
// so weekly / monthly averages don't accumulate per-cycle rounding error.
export const KJ_PER_KCAL = 4.184;
export const KG_PER_LB = 0.45359237;
export const LB_PER_KG = 1 / KG_PER_LB;

export const kjToKcal = (kj: number): number => kj / KJ_PER_KCAL;
export const kgToLb = (kg: number | null | undefined): number | null =>
  kg == null ? null : kg * LB_PER_KG;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;

/**
 * Format a kJ value as kcal for display. Rounds to the integer at the
 * boundary — pass the raw kJ; the helper handles the conversion AND the
 * rounding, so consumers can't accidentally pre-round and lose precision.
 */
export function formatKcal(kj: number | null | undefined): string {
  if (kj == null || Number.isNaN(kj)) return "—";
  return `${Math.round(kjToKcal(kj))} kcal`;
}

export function formatPace(speedMps: number | null): string {
  if (!speedMps || speedMps === 0) return "—";
  const minPerMile = 1609.344 / speedMps / 60;
  const mins = Math.floor(minPerMile);
  const secs = Math.round((minPerMile - mins) * 60);
  if (secs === 60) return `${mins + 1}:00 /mi`;
  return `${mins}:${secs.toString().padStart(2, "0")} /mi`;
}
