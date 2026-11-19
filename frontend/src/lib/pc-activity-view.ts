import { appLabel, type TopEntry } from "@/lib/screen-time";
import { CHECKIN_PC_COLUMNS, parsePcActivityRow, type PcActivityDay } from "@/lib/checkin-pc-activity";
import type { AiSync } from "@/lib/ai-usage";

/**
 * Pure helpers for the "PC" section of /screen-time: pds.pc_activity_daily (one row per behavioral day, filled by
 * the PC activity logger, tools/pc_activity_logger: active minutes per hour and per program, never titles).
 * lib/screen-time-server.ts reads the rows with the service role and hands them to summarizePc; only the
 * aggregates below leave the server (no per-day rows).
 * No I/O here, so node --test can load it (tests/pc-activity-view.test.cjs, synthetic rows only).
 */

/** Explicit column list for the read of pds.pc_activity_daily (never select "*"); the same as the check-in read. */
export const PC_VIEW_COLUMNS: string = CHECKIN_PC_COLUMNS;
export const PC_TOP_PROGRAMS = 10;

export type PcSummary =
  | { kind: "empty" }
  | {
      kind: "ok";
      /** Mean active minutes per complete day; null when no day in the window is complete yet. */
      activePerDay: number | null;
      /** Mean late (21:00-05:59) active minutes per complete day; null when no day is complete yet. */
      latePerDay: number | null;
      /** Days whose newest upload came after the day ended (isDayComplete): the per-day divisor. */
      completeDays: number;
      /** Distinct days with a readable row, complete or not. */
      loggedDays: number;
      /** Programs by minutes summed over every logged day of the window (totals, not per day). */
      topPrograms: TopEntry[];
      skippedRows: number;
    };

export type PcSync = AiSync;

/** What the page draws for the section; independent of the phone and AI data's own states. */
export type PcSection = { kind: "error"; hint: string } | (PcSummary & { sync: PcSync | null });

const isMinutes = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A row is used only with a usable date and numeric (not string) active and late minutes. */
function readRow(raw: unknown): PcActivityDay | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isMinutes(r.active_minutes) || !isMinutes(r.late_active_minutes)) return null;
  const day = parsePcActivityRow(raw);
  if (!day || !Number.isFinite(Date.parse(day.date + "T00:00:00Z"))) return null;
  return day;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Per-day means over complete days only (today, or a day whose newest upload predates its end, would pull the
 * mean down); program totals over every logged day. Unreadable rows are skipped and counted.
 */
export function summarizePc(rows: readonly unknown[]): PcSummary {
  const parsed: PcActivityDay[] = [];
  for (const raw of rows) {
    const d = readRow(raw);
    if (d) parsed.push(d);
  }
  if (!parsed.length) return { kind: "empty" };

  const logged = new Set<string>();
  const complete = new Set<string>();
  let active = 0;
  let late = 0;
  const programs = new Map<string, { minutes: number; days: Set<string> }>();
  for (const d of parsed) {
    logged.add(d.date);
    if (d.dayComplete) {
      complete.add(d.date);
      active += d.activeMinutes ?? 0;
      late += d.lateMinutes ?? 0;
    }
    for (const [app, m] of Object.entries(d.byApp)) {
      const p = programs.get(app) ?? { minutes: 0, days: new Set<string>() };
      p.minutes += m;
      p.days.add(d.date);
      programs.set(app, p);
    }
  }
  const all = [...programs.values()].reduce((s, p) => s + p.minutes, 0);
  const topPrograms: TopEntry[] = [...programs.entries()]
    .map(([key, p]) => ({
      key,
      label: appLabel(key),
      minutes: p.minutes,
      perDay: p.minutes / logged.size,
      daysUsed: p.days.size,
      share: all > 0 ? p.minutes / all : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || byKey(a.key, b.key))
    .slice(0, PC_TOP_PROGRAMS);

  const n = complete.size;
  return {
    kind: "ok",
    activePerDay: n > 0 ? active / n : null,
    latePerDay: n > 0 ? late / n : null,
    completeDays: n,
    loggedDays: logged.size,
    topPrograms,
    skippedRows: rows.length - parsed.length,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isSync = (v: unknown) =>
  v === null ||
  (isObject(v) && (v.at === null || typeof v.at === "string") && (v.status === null || typeof v.status === "string"));

/** A fetched or cached section checked like the server's own shape. */
export function isPcSection(v: unknown): v is PcSection {
  if (!isObject(v)) return false;
  if (v.kind === "error") return typeof v.hint === "string";
  if (v.kind === "empty") return isSync(v.sync);
  return (
    v.kind === "ok" &&
    isSync(v.sync) &&
    isNumOrNull(v.activePerDay) &&
    isNumOrNull(v.latePerDay) &&
    isNum(v.completeDays) &&
    isNum(v.loggedDays) &&
    isNum(v.skippedRows) &&
    Array.isArray(v.topPrograms) &&
    v.topPrograms.every(
      (p) =>
        isObject(p) && typeof p.key === "string" && typeof p.label === "string" && isNum(p.minutes) && isNum(p.perDay) && isNum(p.share),
    )
  );
}
