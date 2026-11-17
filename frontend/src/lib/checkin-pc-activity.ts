// Pure rules for the /check-in pre-fills from pds.pc_activity_daily (the PC activity logger,
// tools/pc_activity_logger: coarse active minutes per hour and per program, never titles / URLs /
// keystrokes). No I/O here, so node --test can load it (tests/checkin-pc-activity.test.cjs, synthetic only).
//
// Contract, like every check-in pre-fill (2026-11-13): Yes only and only when the data is clear —
// absence is not proof, so this source NEVER suggests No. The screen shows each pre-fill with its
// source ("PC activity: …") and stores it only when Riley saves; the GET never writes.
import { isDayComplete } from "@/lib/screen-time";
import type { CheckinSuggestion } from "./checkin";

/** Explicit column list for every read of pds.pc_activity_daily (never select "*"). */
export const CHECKIN_PC_COLUMNS = "behavioral_date,active_minutes,late_active_minutes,minutes_by_app,synced_at";

/** Minutes in one mapped program before its question is pre-filled Yes (Riley, 2026-11-16). */
export const PC_HABIT_MIN_MINUTES = 20;
/** Late (21:00-on) PC minutes before a "Worked late" question is pre-filled Yes (Riley, 2026-11-16). */
export const PC_LATE_MIN_MINUTES = 45;
/** A question title containing this (case-insensitive) is read as the "worked late" question, if one exists. */
export const WORKED_LATE_MATCH = "worked late";

/**
 * Check-in question words → the programs (executable names as stored: lower case, no ".exe") that answer them.
 * code.exe / python.exe → the Python and AL words; excel.exe → Excel; pbidesktop.exe → BI.
 */
const TOKEN_GROUPS: Readonly<Record<string, { apps: readonly string[]; label: string }>> = {
  python: { apps: ["code", "python"], label: "Python" },
  al: { apps: ["code", "python"], label: "AL" },
  excel: { apps: ["excel"], label: "Excel" },
  bi: { apps: ["pbidesktop"], label: "Power BI" },
};

export interface PcActivityDay {
  date: string; // behavioral day, YYYY-MM-DD
  activeMinutes: number | null;
  lateMinutes: number | null; // active in hours starting 21:00-05:59 local
  byApp: Record<string, number>; // active minutes per program
  syncedAt: string | null;
  /** A sync happened after the day ended (synced_at >= day + 1 at 06:00 ET, lib/screen-time.ts): all the day's hours are in. */
  dayComplete: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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

/**
 * One raw row of pds.pc_activity_daily; null when the date is unusable. A day the logger never ran has no
 * row (a gap, never zero), and a day whose latest hourly upload is still from before the day ended is NOT
 * complete: its evening hours may not be in yet, so no pre-fill is offered from it.
 */
export function parsePcActivityRow(raw: unknown): PcActivityDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.behavioral_date === "string" ? r.behavioral_date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const syncedAt = typeof r.synced_at === "string" && Number.isFinite(Date.parse(r.synced_at)) ? r.synced_at : null;
  return {
    date,
    activeMinutes: num(r.active_minutes),
    lateMinutes: num(r.late_active_minutes),
    byApp: minutesMap(r.minutes_by_app),
    syncedAt,
    dayComplete: isDayComplete(date, syncedAt),
  };
}

/**
 * The words of a question title, lower case ("BI/Python/AL/Excel" → bi, python, al, excel). Matching is on
 * these words, not a raw substring: "al" as a substring would also hit "Have any alcoholic drinks?".
 */
export function questionTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Does any check-in question get a pre-fill from PC activity? (Lets the GET skip the read when not.) */
export function pcActivityApplies(names: Iterable<string>): boolean {
  for (const name of names) {
    if (name.toLowerCase().includes(WORKED_LATE_MATCH)) return true;
    for (const t of questionTokens(name)) if (t in TOKEN_GROUPS) return true;
  }
  return false;
}

/**
 * The pre-fills for one behavioral day. Yes only, and only from a COMPLETE day (see parsePcActivityRow):
 * a day still uploading or never logged leaves every question blank — never a No, never a Yes from partial
 * hours. "Worked late" reads the day's late minutes; a tooling question (any of the Python / AL / Excel /
 * BI words in its title) reads the minutes of the programs mapped to the words it names.
 */
export function pcActivitySuggestions(day: PcActivityDay, names: Iterable<string>): Record<string, CheckinSuggestion> {
  const out: Record<string, CheckinSuggestion> = {};
  if (!day.dayComplete) return out;
  for (const name of names) {
    if (name.toLowerCase().includes(WORKED_LATE_MATCH)) {
      if (day.lateMinutes != null && day.lateMinutes >= PC_LATE_MIN_MINUTES) {
        out[name] = { answer: "Yes", source: `PC activity: ${Math.round(day.lateMinutes)} min at the PC from 21:00 on` };
      }
      continue;
    }
    const minutes = new Map<string, number>(); // label → minutes over the group's programs
    for (const token of questionTokens(name)) {
      const g = TOKEN_GROUPS[token];
      if (!g || minutes.has(g.label)) continue;
      const m = g.apps.reduce((s, app) => s + (day.byApp[app] ?? 0), 0);
      if (m > 0) minutes.set(g.label, m);
    }
    const hit = [...minutes.entries()].filter(([, m]) => m >= PC_HABIT_MIN_MINUTES);
    if (hit.length) {
      out[name] = {
        answer: "Yes",
        source: `PC activity: ${hit.map(([label, m]) => `${Math.round(m)} min in ${label}`).join(", ")}`,
      };
    }
  }
  return out;
}
