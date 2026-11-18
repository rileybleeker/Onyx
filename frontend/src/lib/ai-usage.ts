import { addDays, type TopEntry } from "@/lib/screen-time";

/**
 * Pure helpers for the "AI tools" section of /screen-time: pds.ai_tool_usage_daily (one row per device,
 * behavioral day, tool and project folder name, filled by tools/ai_usage_harvest every 3 h on the PC).
 * lib/screen-time-server.ts reads the rows with the service role and hands them to summarizeAi; only the
 * aggregates below leave the server (no per-day rows, no tokens, no model names).
 * No I/O here (lib/screen-time.ts is pure too), so node --test can load it (tests/ai-usage-view.test.cjs,
 * synthetic rows only).
 */

/** Explicit column list for the read of pds.ai_tool_usage_daily (never select "*"). */
export const AI_USAGE_COLUMNS: string = "behavioral_date,tool,project,sessions,active_minutes,late_active_minutes";
export const AI_TOP_PROJECTS = 5;

const CLAUDE = "claude_code";
const CODEX = "codex";

export interface AiRow {
  date: string; // behavioral day, YYYY-MM-DD
  tool: string;
  project: string;
  sessions: number;
  activeMin: number;
  lateMin: number; // of activeMin, local 21:00-05:59
}

export interface AiToolShare {
  tool: string;
  label: string;
  minutes: number; // total over the window
  perDay: number;
  share: number; // of all active minutes, 0..1
}

export type AiSummary =
  | { kind: "empty" }
  | {
      kind: "ok";
      activePerDay: number;
      latePerDay: number;
      sessionsPerDay: number;
      /** Calendar days from the first day with a row through the newest one, inclusive (the divisor). */
      spanDays: number;
      skippedRows: number;
      byTool: AiToolShare[];
      topProjects: TopEntry[];
    };

export interface AiSync {
  status: string | null;
  at: string | null;
}

/** What the page draws for the section; independent of the phone data's own state. */
export type AiSection = { kind: "error"; hint: string } | (AiSummary & { sync: AiSync | null });

function count(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** "claude_code" / "claude-code" / "claude" are one tool. */
function toolKey(raw: string): string {
  const t = raw.trim().toLowerCase();
  return t === "claude-code" || t === "claude" ? CLAUDE : t;
}

export function toolLabel(key: string): string {
  return key === CLAUDE ? "Claude Code" : key === CODEX ? "Codex" : key;
}

/** Parse one raw row; null when the date, tool or project is unusable or a count is not a whole number. */
export function parseAiRow(raw: unknown): AiRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.behavioral_date === "string" ? r.behavioral_date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))) return null;
  if (typeof r.tool !== "string" || !r.tool.trim() || typeof r.project !== "string" || !r.project.trim()) return null;
  const sessions = count(r.sessions);
  const activeMin = count(r.active_minutes);
  const lateMin = count(r.late_active_minutes);
  if (sessions === null || activeMin === null || lateMin === null) return null;
  return { date, tool: toolKey(r.tool), project: r.project.trim(), sessions, activeMin, lateMin };
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sums over every device and project row, divided by the span from the first day with a row through the newest
 * one (a day inside it without rows is 0 use: the harvester runs every 3 h). Unreadable rows are skipped and counted.
 */
export function summarizeAi(rows: readonly unknown[]): AiSummary {
  const parsed: AiRow[] = [];
  for (const raw of rows) {
    const r = parseAiRow(raw);
    if (r) parsed.push(r);
  }
  if (!parsed.length) return { kind: "empty" };

  let first = parsed[0].date;
  let last = parsed[0].date;
  let active = 0;
  let late = 0;
  let sessions = 0;
  const tools = new Map<string, number>([
    [CLAUDE, 0],
    [CODEX, 0],
  ]);
  const projects = new Map<string, { minutes: number; days: Set<string> }>();
  for (const r of parsed) {
    if (r.date < first) first = r.date;
    if (r.date > last) last = r.date;
    active += r.activeMin;
    late += r.lateMin;
    sessions += r.sessions;
    tools.set(r.tool, (tools.get(r.tool) ?? 0) + r.activeMin);
    const p = projects.get(r.project) ?? { minutes: 0, days: new Set<string>() };
    p.minutes += r.activeMin;
    if (r.activeMin > 0) p.days.add(r.date);
    projects.set(r.project, p);
  }
  let spanDays = 1;
  // first through last inclusive: rows on day 1 and day 4 give 4.
  for (let d = first; d < last && spanDays <= 400; d = addDays(d, 1)) spanDays++;

  const share = (m: number) => (active > 0 ? m / active : 0);
  const fixed = [CLAUDE, CODEX];
  const rank = (tool: string) => {
    const i = fixed.indexOf(tool);
    return i === -1 ? fixed.length : i;
  };
  const byTool: AiToolShare[] = [...tools.entries()]
    .map(([tool, minutes]) => ({ tool, label: toolLabel(tool), minutes, perDay: minutes / spanDays, share: share(minutes) }))
    .sort((a, b) => rank(a.tool) - rank(b.tool) || b.minutes - a.minutes || byKey(a.tool, b.tool));

  const topProjects: TopEntry[] = [...projects.entries()]
    .filter(([, p]) => p.minutes > 0)
    .map(([name, p]) => ({
      key: name,
      label: name,
      minutes: p.minutes,
      perDay: p.minutes / spanDays,
      daysUsed: p.days.size,
      share: share(p.minutes),
    }))
    .sort((a, b) => b.minutes - a.minutes || byKey(a.key, b.key))
    .slice(0, AI_TOP_PROJECTS);

  return {
    kind: "ok",
    activePerDay: active / spanDays,
    latePerDay: late / spanDays,
    sessionsPerDay: sessions / spanDays,
    spanDays,
    skippedRows: rows.length - parsed.length,
    byTool,
    topProjects,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isAiSync = (v: unknown) =>
  v === null ||
  (isObject(v) && (v.at === null || typeof v.at === "string") && (v.status === null || typeof v.status === "string"));

/** A fetched or cached section checked like the server's own shape. */
export function isAiSection(v: unknown): v is AiSection {
  if (!isObject(v)) return false;
  if (v.kind === "error") return typeof v.hint === "string";
  if (v.kind === "empty") return isAiSync(v.sync);
  return (
    v.kind === "ok" &&
    isAiSync(v.sync) &&
    isNum(v.activePerDay) &&
    isNum(v.latePerDay) &&
    isNum(v.sessionsPerDay) &&
    isNum(v.spanDays) &&
    isNum(v.skippedRows) &&
    Array.isArray(v.byTool) &&
    v.byTool.every((t) => isObject(t) && typeof t.label === "string" && isNum(t.perDay) && isNum(t.share)) &&
    Array.isArray(v.topProjects) &&
    v.topProjects.every(
      (p) =>
        isObject(p) && typeof p.key === "string" && typeof p.label === "string" && isNum(p.minutes) && isNum(p.perDay) && isNum(p.share),
    )
  );
}
