/**
 * Sleep wind-down streak (PROD-SLEEP-01, 2026-11-16): one evening action, weekly progress and honest streaks.
 * Riley chose progress and streaks as the incentive. Opt-in: nothing shows on Today until he sets it up on Log.
 * Storage: sql/sleep_winddown.sql. Rules in plain words: docs/sleep-winddown.md.
 *
 * The record of a night is the chosen habit's pds.habit_journal row for the behavioral day the evening belongs to
 * (Yes = wind-down done, No = confirmed miss, no row = not answered). The check-in, /habits, chat and the wind-down
 * button all write that one row, so nothing here can count a night twice. Rule version 1:
 *   - A night is ELIGIBLE from the goal's first version on, unless a planned pause covers it (paused nights are
 *     labelled and left out of every count; they never count as won, even when the habit was answered Yes).
 *   - win = Yes; missed = No; not answered = PENDING while it can still be answered here (tonight and the two
 *     nights before, the check-in's window), UNKNOWN after that. Neither pending nor unknown is ever a win.
 *   - Current streak: consecutive wins back from tonight. Paused and pending nights are skipped (they neither count
 *     nor break it); a confirmed miss ends it, and so does an unknown night (shown as unanswered, not as missed).
 *     The weekly count, the total and the personal best stay.
 *   - Weekly progress: wins in the last `windowNights` eligible nights against `winsNeeded` (default 5 of 7: a
 *     product target Riley can change, not a medical threshold).
 *   - The target time is local wall-clock time wherever Riley is. A "Started" tap records the server's clock and is
 *     shown on time / after the target of THAT night's goal version; a report made later carries no time. Timing is
 *     shown, never counted: a next-morning report counts the same as a tap.
 *   - Sleep data (WHOOP) is feedback only: it never marks a night and earns nothing.
 *
 * IMPORT-FREE (types only): bundled by name in tests. Tests: frontend/tests/sleep-winddown.test.cjs (synthetic).
 */

export const WINDDOWN_URL = "/api/sleep/winddown";
export const WINDDOWN_NIGHT_URL = "/api/sleep/winddown/night";
export const WINDDOWN_RULE_URL = "/api/sleep/winddown/rule";
export const WINDDOWN_PAUSE_URL = "/api/sleep/winddown/pause";
/** "Hide from Today": a layout choice, so a UI preference (pds.ui_preferences), not a table of its own. */
export const WINDDOWN_PREF_KEY = "sleep.winddown";
export const WINDDOWN_RULE_VERSION = 1;
/** Nights back from tonight that can still be answered here (the check-in's window). Older: /habits. */
export const WINDDOWN_ANSWER_DAYS_BACK = 2;
export const DEFAULT_WINS_NEEDED = 5;
export const DEFAULT_WINDOW_NIGHTS = 7;
export const MIN_WINDOW_NIGHTS = 3;
export const MAX_WINDOW_NIGHTS = 14;
/** Longest history evaluated for the personal best (about three years). */
export const MAX_HISTORY_NIGHTS = 1100;
export const STREAK_MILESTONES: readonly number[] = [3, 7, 14, 21, 30, 60, 100];
/** WHOOP nights read for the feedback line. */
export const SLEEP_FEEDBACK_NIGHTS = 14;
export const MAX_WINDDOWN_BODY_BYTES = 1024;
/** Today's quiet view lists the action from this long before the target time. */
export const WINDDOWN_LEAD_MS = 3 * 3_600_000;
/** Fired on window after a wind-down answer is saved, so a check-in on the same screen reloads that answer. */
export const WINDDOWN_SAVED_EVENT = "onyx:habit-answer";
/** A tap that was not saved yet (this device only; wiped on sign-out with every onyx* key). */
export const WINDDOWN_PENDING_KEY = "onyx.winddown.pending";
/** A tap older than this is not offered again. */
export const PENDING_MAX_AGE_MS = 3 * 24 * 3_600_000;

export type NightAnswer = "Yes" | "No";

export interface WindDownRule {
  id: number;
  effectiveFrom: string;
  habitPageId: string;
  /** The habit's name when this version was saved (the current name comes from habitNames). */
  habitName: string;
  habitCategory: string | null;
  targetTime: string;
  /** The zone the target was set in (shown in the history; the target itself is local wall-clock time). */
  tz: string;
  winsNeeded: number;
  windowNights: number;
  ruleVersion: number;
  createdAt: string;
}
export interface WindDownPause { id: number; startDate: string; endDate: string | null; createdAt: string; endedAt: string | null }
export interface WindDownAnswerFact { date: string; question: string; answer: NightAnswer }
export interface WindDownStart { night: string; startedAt: string; localTime: string; tz: string; ruleId: number | null }
export interface WindDownSleepNight {
  /** The behavioral day whose evening this sleep followed (= the wind-down night). */
  night: string;
  asleepMin: number | null;
  /** Sleep onset, local wall clock (HH:MM) in the zone WHOOP recorded. */
  onset: string | null;
  syncedAt: string | null;
}
export interface WindDownPayload {
  /** not_connected: the tables are not in the database yet (nothing can be set up). */
  status: "not_set_up" | "ready" | "not_connected";
  /** Behavioral today on the server (pds.behavioral_today_now()). */
  today: string;
  hidden: boolean;
  /** Oldest first. */
  rules: WindDownRule[];
  /** Planned pauses that were not cancelled. */
  pauses: WindDownPause[];
  answers: WindDownAnswerFact[];
  starts: WindDownStart[];
  /** Habit page id -> its current name (pds.habit_name_map). */
  habitNames: Record<string, string>;
  sleep: { source: "WHOOP"; nights: WindDownSleepNight[]; failed: boolean };
  asOf: string;
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TZ = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;

export const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const isTime = (v: unknown): v is string => typeof v === "string" && TIME.test(v);
export const isZone = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && TZ.test(v);

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Minutes since 06:00 local (the behavioral day starts at 06:00): 21:00 = 900, 00:30 = 1110. */
export function eveningMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h * 60 + m - 360 + 1440) % 1440;
}
/** A start at or before the target, both local wall clock: 23:50 vs 22:30 is late, 00:10 is later still. */
export function startedOnTime(localTime: string, targetTime: string): boolean {
  return eveningMinutes(localTime) <= eveningMinutes(targetTime);
}

/** "Mon" for a night. */
export function nightWeekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
}
/** "Tonight", "Last night", or "Monday night". */
export function nightName(date: string, today: string): string {
  if (date === today) return "Tonight";
  if (date === addDays(today, -1)) return "Last night";
  return `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" })} night`;
}
/** "Mon, Nov 16" for a date. */
export function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
/** "10:30 PM" for "22:30" (no zone: the target is wall-clock time wherever Riley is). */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The target time of behavioral day `today` as an instant on this device (ms): a target before 06:00 is in the
 * small hours of the next calendar day. Wall-clock arithmetic in the device's zone, so a DST day is handled by Date
 * (a target inside the skipped spring-forward hour lands an hour later, never on another day).
 */
export function targetInstant(today: string, targetTime: string): number {
  const [y, mo, d] = today.split("-").map(Number);
  const [h, m] = targetTime.split(":").map(Number);
  return new Date(y, mo - 1, h < 6 ? d + 1 : d, h, m, 0, 0).getTime();
}

// ─── Rules over nights ──────────────────────────────────────────────────────────────────────────────────────

function byVersion(a: WindDownRule, b: WindDownRule): number {
  return a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : a.id - b.id;
}
/** Oldest first (the order the goal versions apply in). */
export function sortRules(rules: readonly WindDownRule[]): WindDownRule[] {
  return rules.slice().sort(byVersion);
}
/** The goal version in force on a night: the newest version whose effectiveFrom is on or before it. */
export function ruleFor(rules: readonly WindDownRule[], night: string): WindDownRule | null {
  return ruleInSorted(sortRules(rules), night);
}
function ruleInSorted(sorted: readonly WindDownRule[], night: string): WindDownRule | null {
  let hit: WindDownRule | null = null;
  for (const r of sorted) {
    if (r.effectiveFrom <= night) hit = r;
    else break;
  }
  return hit;
}
export function pauseOn(pauses: readonly WindDownPause[], night: string): WindDownPause | null {
  return pauses.find((p) => p.startDate <= night && (p.endDate === null || night <= p.endDate)) ?? null;
}
/** The habit the version names, as it is called now (a rename in Notion follows; the stored name is the fallback). */
export function questionOf(rule: WindDownRule, habitNames: Readonly<Record<string, string>>): string {
  return habitNames[rule.habitPageId] || rule.habitName;
}

export type NightStatus = "win" | "missed" | "pending" | "unknown" | "paused" | "before_start";
export interface NightView {
  date: string;
  status: NightStatus;
  answer: NightAnswer | null;
  ruleId: number | null;
  question: string | null;
  targetTime: string | null;
  /** A "Started" tap for this night, judged against the goal version it was made under. */
  start: { localTime: string; tz: string; onTime: boolean | null } | null;
  tonight: boolean;
  /** Can still be answered on Today / Log (tonight and the two nights before). */
  answerable: boolean;
}
export type StripItem = { kind: "night"; night: NightView } | { kind: "paused"; from: string; to: string; count: number };
export interface WindowView {
  size: number;
  needed: number;
  /** Oldest first: the eligible nights, with paused stretches between them as single items. */
  items: StripItem[];
  wins: number;
  /** Eligible nights in the window, the open ones included. */
  eligible: number;
  pending: number;
  unknown: number;
  missed: number;
  pausedNights: number;
  met: boolean;
  /** Wins plus nights still open could reach the goal. */
  reachable: boolean;
  /** Fewer eligible nights than the window so far (just started). */
  short: boolean;
}
export interface WindDownProgress {
  configured: boolean;
  today: string;
  hidden: boolean;
  rule: WindDownRule | null;
  /** The current habit name. */
  question: string | null;
  tonight: NightView | null;
  window: WindowView | null;
  streak: { current: number; best: number; pendingNights: number; stoppedAt: { date: string; status: "missed" | "unknown" } | null; newBest: boolean };
  /** Every eligible night since the first goal version that has been decided (open nights are not counted yet). */
  total: { wins: number; decided: number };
  /** Nights before tonight that can still be answered and are not yet (newest first). */
  openNights: NightView[];
  pause: WindDownPause | null;
  /** The next pause that has not started yet, if any. */
  nextPause: WindDownPause | null;
  milestone: string | null;
}

interface Index { answers: Map<string, NightAnswer>; starts: Map<string, WindDownStart>; rulesById: Map<number, WindDownRule> }
function index(p: WindDownPayload): Index {
  const answers = new Map<string, NightAnswer>();
  for (const a of p.answers) if (!answers.has(`${a.date}|${a.question}`)) answers.set(`${a.date}|${a.question}`, a.answer);
  const starts = new Map<string, WindDownStart>();
  for (const s of p.starts) if (!starts.has(s.night)) starts.set(s.night, s);
  return { answers, starts, rulesById: new Map(p.rules.map((r) => [r.id, r] as const)) };
}

function evaluate(p: WindDownPayload, sorted: readonly WindDownRule[], ix: Index, date: string): NightView {
  const tonight = date === p.today;
  const answerable = date <= p.today && date >= addDays(p.today, -WINDDOWN_ANSWER_DAYS_BACK);
  const rule = ruleInSorted(sorted, date);
  if (!rule) return { date, status: "before_start", answer: null, ruleId: null, question: null, targetTime: null, start: null, tonight, answerable: false };
  const question = questionOf(rule, p.habitNames);
  const answer = ix.answers.get(`${date}|${question}`) ?? null;
  const started = answer === "Yes" ? ix.starts.get(date) ?? null : null;
  // A start is judged against the version in force when it was tapped (stored with it), else the night's version.
  const startRule = started?.ruleId != null ? ix.rulesById.get(started.ruleId) ?? rule : rule;
  const start = started ? { localTime: started.localTime, tz: started.tz, onTime: isTime(started.localTime) ? startedOnTime(started.localTime, startRule.targetTime) : null } : null;
  let status: NightStatus;
  if (pauseOn(p.pauses, date)) status = "paused";
  else if (answer === "Yes") status = "win";
  else if (answer === "No") status = "missed";
  else status = answerable ? "pending" : "unknown";
  return { date, status, answer, ruleId: rule.id, question, targetTime: rule.targetTime, start, tonight, answerable };
}

const NOT_SET_UP_STREAK = { current: 0, best: 0, pendingNights: 0, stoppedAt: null, newBest: false };

/** Everything Today and Log show, from one payload. Pure and deterministic: the same payload always gives the same answer. */
export function windDownProgress(p: WindDownPayload): WindDownProgress {
  const rules = sortRules(p.rules);
  if (p.status !== "ready" || rules.length === 0) {
    return {
      configured: false, today: p.today, hidden: p.hidden, rule: null, question: null, tonight: null, window: null,
      streak: { ...NOT_SET_UP_STREAK }, total: { wins: 0, decided: 0 }, openNights: [], pause: null, nextPause: null, milestone: null,
    };
  }
  const ix = index(p);
  const first = rules[0].effectiveFrom;
  const span = Math.min(Math.max(0, daysBetween(first, p.today)), MAX_HISTORY_NIGHTS);
  const nights: NightView[] = [];
  for (let i = span; i >= 0; i--) nights.push(evaluate(p, rules, ix, addDays(p.today, -i)));

  // Current streak: back from tonight.
  let current = 0;
  let pendingNights = 0;
  let stoppedAt: WindDownProgress["streak"]["stoppedAt"] = null;
  let runStart = nights.length; // index where the current run begins (for "new best")
  for (let i = nights.length - 1; i >= 0; i--) {
    const n = nights[i];
    if (n.status === "paused") continue;
    if (n.status === "pending") { pendingNights++; continue; }
    if (n.status === "win") { current++; runStart = i; continue; }
    if (n.status === "missed" || n.status === "unknown") stoppedAt = { date: n.date, status: n.status };
    break;
  }
  // Personal best: the same rules forward; the best before the current run tells a new best from an old one.
  let run = 0;
  let best = 0;
  let bestBefore = 0;
  for (let i = 0; i < nights.length; i++) {
    const n = nights[i];
    if (n.status === "paused" || n.status === "pending" || n.status === "before_start") continue;
    if (n.status === "win") {
      run++;
      best = Math.max(best, run);
      if (i < runStart) bestBefore = Math.max(bestBefore, run);
    } else run = 0;
  }

  // The weekly window: the last N eligible nights under the CURRENT version's goal.
  const rule = ruleInSorted(rules, p.today) ?? rules[rules.length - 1];
  const size = rule.windowNights;
  const items: StripItem[] = [];
  const picked: NightView[] = [];
  for (let i = nights.length - 1; i >= 0 && picked.length < size; i--) {
    const n = nights[i];
    if (n.status === "before_start") break;
    if (n.status === "paused") {
      const head = items[0];
      if (head && head.kind === "paused") { head.from = n.date; head.count++; }
      else items.unshift({ kind: "paused", from: n.date, to: n.date, count: 1 });
      continue;
    }
    picked.unshift(n);
    items.unshift({ kind: "night", night: n });
  }
  const count = (s: NightStatus) => picked.filter((n) => n.status === s).length;
  const wins = count("win");
  const pending = count("pending");
  const win: WindowView = {
    size, needed: rule.winsNeeded, items, wins, eligible: picked.length, pending, unknown: count("unknown"), missed: count("missed"),
    pausedNights: items.reduce((s, it) => s + (it.kind === "paused" ? it.count : 0), 0),
    met: wins >= rule.winsNeeded, reachable: wins + pending >= rule.winsNeeded, short: picked.length < size,
  };

  const decided = nights.filter((n) => n.status === "win" || n.status === "missed" || n.status === "unknown");
  const tonight = nights[nights.length - 1]?.date === p.today ? nights[nights.length - 1] : null;
  const openNights = nights.filter((n) => !n.tonight && n.status === "pending").reverse();
  const streak = { current, best, pendingNights, stoppedAt, newBest: current >= 2 && current > bestBefore && current === best };
  const upcoming = p.pauses.filter((x) => x.startDate > p.today).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const progress: WindDownProgress = {
    configured: true, today: p.today, hidden: p.hidden, rule, question: questionOf(rule, p.habitNames), tonight, window: win, streak,
    total: { wins: decided.filter((n) => n.status === "win").length, decided: decided.length },
    openNights, pause: pauseOn(p.pauses, p.today), nextPause: upcoming[0] ?? null, milestone: null,
  };
  progress.milestone = milestoneFor(progress);
  return progress;
}

/** One short, positive line at a meaningful moment; null otherwise. Never a reset scolding. */
export function milestoneFor(p: WindDownProgress): string | null {
  if (!p.configured || !p.window) return null;
  const { current } = p.streak;
  if (p.streak.newBest) return `New personal best: ${current} nights in a row.`;
  if (p.window.met && !p.window.short) return `${p.window.wins} of the last ${p.window.size} nights: goal met.`;
  if (STREAK_MILESTONES.includes(current)) return `${current} nights in a row.`;
  if (current === 0 && p.streak.stoppedAt?.status === "missed") return "A new streak can start tonight.";
  return null;
}

/** "4 of 6 nights · 1 open · 1 paused": the window in plain words. */
export function windowSummary(w: WindowView): string {
  const parts = [`${w.wins} of ${w.eligible} night${w.eligible === 1 ? "" : "s"}`];
  if (w.pending) parts.push(`${w.pending} open`);
  if (w.unknown) parts.push(`${w.unknown} unanswered`);
  if (w.pausedNights) parts.push(`${w.pausedNights} paused`);
  return parts.join(" · ");
}

export const NIGHT_STATUS_LABEL: Readonly<Record<NightStatus, string>> = {
  win: "Wound down",
  missed: "Missed",
  pending: "Not answered yet",
  unknown: "Not answered",
  paused: "Paused",
  before_start: "Before you started",
};

/** The payload with one night's answer replaced (an optimistic tap, or the server's answer to it). */
export function withAnswer(p: WindDownPayload, night: string, answer: NightAnswer | null): WindDownPayload {
  const rule = ruleFor(p.rules, night);
  if (!rule) return p;
  const question = questionOf(rule, p.habitNames);
  const answers = p.answers.filter((a) => !(a.date === night && a.question === question));
  if (answer) answers.push({ date: night, question, answer });
  const starts = answer === "Yes" ? p.starts : p.starts.filter((s) => s.night !== night);
  return { ...p, answers, starts };
}

/** The answer the payload holds for a night ("none" = not answered): what a tap is made against. */
export function answerOn(p: WindDownPayload, night: string): NightAnswer | "none" {
  const rule = ruleFor(p.rules, night);
  if (!rule) return "none";
  const question = questionOf(rule, p.habitNames);
  return p.answers.find((a) => a.date === night && a.question === question)?.answer ?? "none";
}

// ─── Today's quiet view ─────────────────────────────────────────────────────────────────────────────────────

/** What Today's attention model needs (lib/today-attention.ts windDownObligations). */
export interface WindDownAttention {
  today: string;
  targetTime: string;
  /** "10:30 PM" (today-attention.ts stays import-free, so the label is made here). */
  targetLabel: string;
  /** The target as an instant on this device (ms). */
  dueAt: number;
  /** From this instant (ms) the quiet view lists tonight's action: WINDDOWN_LEAD_MS before the target. */
  listFrom: number;
  /** The habit for tonight is unanswered and tonight is not paused. */
  open: boolean;
  streak: number;
  wins: number;
  needed: number;
  size: number;
}
export function windDownAttention(p: WindDownProgress): WindDownAttention | null {
  if (!p.configured || p.hidden || !p.rule || !p.window || !p.tonight) return null;
  const dueAt = targetInstant(p.today, p.rule.targetTime);
  return {
    today: p.today, targetTime: p.rule.targetTime, targetLabel: clockLabel(p.rule.targetTime), dueAt, listFrom: dueAt - WINDDOWN_LEAD_MS,
    open: p.tonight.status === "pending", streak: p.streak.current, wins: p.window.wins, needed: p.window.needed, size: p.window.size,
  };
}

// ─── Sleep feedback (WHOOP; never counted) ──────────────────────────────────────────────────────────────────

export interface SleepFeedback {
  lastNight: WindDownSleepNight | null;
  /** Onset spread over the last 7 nights with data: earliest and latest onset (HH:MM) and the spread in minutes. */
  onsetRange: { earliest: string; latest: string; spreadMin: number; nights: number } | null;
  newestSync: string | null;
  failed: boolean;
}
export function sleepFeedback(p: WindDownPayload): SleepFeedback {
  const nights = p.sleep?.nights ?? [];
  const lastNight = nights.find((n) => n.night === addDays(p.today, -1)) ?? null;
  const week = nights.filter((n) => n.onset && isTime(n.onset) && n.night >= addDays(p.today, -7) && n.night < p.today);
  // Onsets ordered from 18:00, so 23:40 and 00:20 are 40 minutes apart, not 23 hours.
  const key = (t: string) => { const [h, m] = t.split(":").map(Number); return (h * 60 + m - 1080 + 1440) % 1440; };
  let onsetRange: SleepFeedback["onsetRange"] = null;
  if (week.length >= 2) {
    const sorted = week.map((n) => n.onset as string).sort((a, b) => key(a) - key(b));
    onsetRange = { earliest: sorted[0], latest: sorted[sorted.length - 1], spreadMin: key(sorted[sorted.length - 1]) - key(sorted[0]), nights: week.length };
  }
  const synced = nights.map((n) => n.syncedAt).filter((s): s is string => !!s && Number.isFinite(Date.parse(s))).sort();
  return { lastNight, onsetRange, newestSync: synced.length ? synced[synced.length - 1] : null, failed: !!p.sleep?.failed };
}
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 60 ? `${h + 1} h 00 min` : `${h} h ${String(m).padStart(2, "0")} min`;
}

// ─── The payload, checked ───────────────────────────────────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** GET /api/sleep/winddown, checked. Throws on a malformed answer (it is then neither cached nor shown). */
export function parseWindDownPayload(data: unknown): WindDownPayload {
  const v = obj(data);
  if (!v || (v.status !== "ready" && v.status !== "not_set_up" && v.status !== "not_connected") || !isDate(v.today) || typeof v.hidden !== "boolean") throw new Error("Invalid wind-down answer");
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  const rules: WindDownRule[] = [];
  for (const raw of list(v.rules)) {
    const r = obj(raw);
    if (!r || num(r.id) === null || !isDate(r.effectiveFrom) || !isTime(r.targetTime) || typeof r.habitPageId !== "string" || typeof r.habitName !== "string") continue;
    const winsNeeded = num(r.winsNeeded) ?? DEFAULT_WINS_NEEDED;
    const windowNights = num(r.windowNights) ?? DEFAULT_WINDOW_NIGHTS;
    if (winsNeeded < 1 || windowNights < MIN_WINDOW_NIGHTS || windowNights > MAX_WINDOW_NIGHTS || winsNeeded > windowNights) continue;
    rules.push({
      id: r.id as number, effectiveFrom: r.effectiveFrom, habitPageId: r.habitPageId, habitName: r.habitName, habitCategory: str(r.habitCategory),
      targetTime: r.targetTime, tz: str(r.tz) ?? "", winsNeeded, windowNights, ruleVersion: num(r.ruleVersion) ?? WINDDOWN_RULE_VERSION, createdAt: str(r.createdAt) ?? "",
    });
  }
  if (v.status === "ready" && rules.length === 0) throw new Error("Invalid wind-down answer");
  const pauses: WindDownPause[] = [];
  for (const raw of list(v.pauses)) {
    const r = obj(raw);
    if (!r || num(r.id) === null || !isDate(r.startDate) || (r.endDate !== null && !isDate(r.endDate))) continue;
    if (r.endDate !== null && (r.endDate as string) < r.startDate) continue;
    pauses.push({ id: r.id as number, startDate: r.startDate, endDate: (r.endDate as string | null) ?? null, createdAt: str(r.createdAt) ?? "", endedAt: str(r.endedAt) });
  }
  // One record per (night, habit): a repeated fact can never count twice.
  const seen = new Set<string>();
  const answers: WindDownAnswerFact[] = [];
  for (const raw of list(v.answers)) {
    const r = obj(raw);
    if (!r || !isDate(r.date) || typeof r.question !== "string" || (r.answer !== "Yes" && r.answer !== "No")) continue;
    const key = `${r.date}|${r.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push({ date: r.date, question: r.question, answer: r.answer });
  }
  const starts: WindDownStart[] = [];
  for (const raw of list(v.starts)) {
    const r = obj(raw);
    if (!r || !isDate(r.night) || !isTime(r.localTime) || typeof r.startedAt !== "string") continue;
    starts.push({ night: r.night, startedAt: r.startedAt, localTime: r.localTime, tz: str(r.tz) ?? "", ruleId: num(r.ruleId) });
  }
  const habitNames: Record<string, string> = {};
  const hn = obj(v.habitNames);
  if (hn) for (const [k, name] of Object.entries(hn)) if (PAGE_ID.test(k) && typeof name === "string" && name) habitNames[k] = name;
  const s = obj(v.sleep);
  const sleepNights: WindDownSleepNight[] = [];
  for (const raw of list(s?.nights)) {
    const r = obj(raw);
    if (!r || !isDate(r.night)) continue;
    sleepNights.push({ night: r.night, asleepMin: num(r.asleepMin), onset: isTime(r.onset) ? r.onset : null, syncedAt: str(r.syncedAt) });
  }
  return {
    status: v.status as WindDownPayload["status"], today: v.today, hidden: v.hidden, rules, pauses, answers, starts, habitNames,
    sleep: { source: "WHOOP", nights: sleepNights, failed: s?.failed === true }, asOf: str(v.asOf) ?? "",
  };
}

// ─── Request bodies ─────────────────────────────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
function exactKeys(body: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | string {
  const b = obj(body);
  if (!b) return "body must be a JSON object";
  for (const k of Object.keys(b)) if (!required.includes(k) && !optional.includes(k)) return `unknown field "${k}"`;
  for (const k of required) if (!(k in b)) return `${k} is required`;
  return b;
}

export interface NightBody { night: string; answer: NightAnswer | null; expect: NightAnswer | "none" | null; today: string }
/** POST /api/sleep/winddown/night: {night, answer: "Yes" | "No" | null, expect?: "Yes" | "No" | "none", today}. */
export function parseNightBody(body: unknown): Parsed<NightBody> {
  const b = exactKeys(body, ["night", "answer", "today"], ["expect"]);
  if (typeof b === "string") return { ok: false, error: b };
  if (!isDate(b.night)) return { ok: false, error: "night must be YYYY-MM-DD" };
  if (!isDate(b.today)) return { ok: false, error: "today must be YYYY-MM-DD" };
  if (b.answer !== null && b.answer !== "Yes" && b.answer !== "No") return { ok: false, error: "answer must be Yes, No or null" };
  const expect = b.expect === undefined ? null : b.expect;
  if (expect !== null && expect !== "Yes" && expect !== "No" && expect !== "none") return { ok: false, error: "expect must be Yes, No or none" };
  return { ok: true, value: { night: b.night, answer: b.answer as NightAnswer | null, expect: expect as NightBody["expect"], today: b.today } };
}

export interface RuleBody { habitPageId: string; targetTime: string; winsNeeded: number; windowNights: number; tz: string; today: string }
/** POST /api/sleep/winddown/rule: a new goal version from tonight on. Nothing is assumed: every field is Riley's choice. */
export function parseRuleBody(body: unknown): Parsed<RuleBody> {
  const b = exactKeys(body, ["habit_page_id", "target_time", "wins_needed", "window_nights", "tz", "today"]);
  if (typeof b === "string") return { ok: false, error: b };
  if (typeof b.habit_page_id !== "string" || !PAGE_ID.test(b.habit_page_id)) return { ok: false, error: "choose a habit" };
  if (!isTime(b.target_time)) return { ok: false, error: "choose a target time (HH:MM)" };
  const w = b.window_nights;
  const n = b.wins_needed;
  if (typeof w !== "number" || !Number.isInteger(w) || w < MIN_WINDOW_NIGHTS || w > MAX_WINDOW_NIGHTS) return { ok: false, error: `the window is ${MIN_WINDOW_NIGHTS} to ${MAX_WINDOW_NIGHTS} nights` };
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > w) return { ok: false, error: "wins needed is between 1 and the window" };
  if (!isZone(b.tz)) return { ok: false, error: "tz must be an IANA zone" };
  if (!isDate(b.today)) return { ok: false, error: "today must be YYYY-MM-DD" };
  return { ok: true, value: { habitPageId: b.habit_page_id, targetTime: b.target_time, winsNeeded: n, windowNights: w, tz: b.tz, today: b.today } };
}

export type PauseBody = { action: "add"; startDate: string; endDate: string | null; today: string } | { action: "end"; pauseId: number };
/** POST /api/sleep/winddown/pause {start_date, end_date|null, today}; PATCH {pause_id} ends or cancels one. */
export function parsePauseBody(body: unknown, method: "POST" | "PATCH"): Parsed<PauseBody> {
  if (method === "PATCH") {
    const b = exactKeys(body, ["pause_id"]);
    if (typeof b === "string") return { ok: false, error: b };
    if (typeof b.pause_id !== "number" || !Number.isInteger(b.pause_id) || b.pause_id < 1) return { ok: false, error: "pause_id must be a pause id" };
    return { ok: true, value: { action: "end", pauseId: b.pause_id } };
  }
  const b = exactKeys(body, ["start_date", "end_date", "today"]);
  if (typeof b === "string") return { ok: false, error: b };
  if (!isDate(b.start_date)) return { ok: false, error: "start_date must be YYYY-MM-DD" };
  if (b.end_date !== null && !isDate(b.end_date)) return { ok: false, error: "end_date must be YYYY-MM-DD or null" };
  if (b.end_date !== null && (b.end_date as string) < b.start_date) return { ok: false, error: "the pause ends before it starts" };
  if (!isDate(b.today)) return { ok: false, error: "today must be YYYY-MM-DD" };
  return { ok: true, value: { action: "add", startDate: b.start_date, endDate: (b.end_date as string | null) ?? null, today: b.today } };
}

/** The database's refusals (custom SQLSTATEs in sql/sleep_winddown.sql) as an HTTP status, a code and a message. */
export const WINDDOWN_DB_ERRORS: Readonly<Record<string, { status: number; code: string; error: string }>> = {
  OXW01: { status: 409, code: "goal_past", error: "A goal change applies from tonight on; earlier nights keep the goal they had." },
  OXW02: { status: 409, code: "goal_history", error: "Earlier goal versions are kept as they were." },
  OXW10: { status: 409, code: "stale", error: "A new day started since this screen loaded. It has been refreshed; tap again if you meant tonight." },
  OXW11: { status: 409, code: "future", error: "That night hasn't started yet." },
  OXW12: { status: 409, code: "too_old", error: "Nights more than two days back are corrected on the Habits page." },
  OXW13: { status: 409, code: "not_set_up", error: "The wind-down goal isn't set up for that night." },
  OXW14: { status: 409, code: "habit_gone", error: "The chosen habit is no longer in Onyx. Choose another one." },
  OXW15: { status: 409, code: "changed", error: "That night's answer changed somewhere else (check-in or Habits). It has been refreshed." },
  OXW20: { status: 409, code: "pause_past", error: "A pause can start tonight or later, not on a night that already passed." },
  OXW21: { status: 400, code: "pause_range", error: "The pause ends before it starts." },
  OXW22: { status: 409, code: "pause_overlap", error: "That overlaps a pause you already planned." },
  OXW23: { status: 404, code: "pause_gone", error: "That pause is no longer there." },
  OXW24: { status: 409, code: "pause_history", error: "Nights that already passed keep their pause as it was." },
};
/** A database error as the route's answer: a known refusal, or null (a failure: 500, code only in the log). */
export function windDownRefusal(e: { code?: unknown } | null | undefined): { status: number; code: string; error: string } | null {
  const code = e && typeof e.code === "string" ? e.code : "";
  return WINDDOWN_DB_ERRORS[code] ?? null;
}
/** The tables are not in the database yet (sql/sleep_winddown.sql not applied): a missing relation or function. */
export function isMissingStorage(e: { code?: unknown } | null | undefined): boolean {
  const code = e && typeof e.code === "string" ? e.code : "";
  return code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42883";
}

// ─── Saving one tap: retry, refusal, replay, recovery ──────────────────────────────────────────────────────

export interface NightIntent { night: string; answer: NightAnswer | null; expect: NightAnswer | "none"; today: string }
/** The server refused the tap (4xx): shown with its code, never retried on its own. */
export class WindDownRefused extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WindDownRefused";
  }
}
export type SaverState =
  | { status: "idle" }
  | { status: "saving"; intent: NightIntent }
  | { status: "retrying"; intent: NightIntent; error: string; attempt: number }
  | { status: "refused"; intent: NightIntent; error: string; code: string }
  | { status: "saved"; intent: NightIntent };
export interface SaverTimers { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
export interface SaverOptions {
  /** Sends one intent; resolves with the server's answer, throws WindDownRefused for a refusal, anything else to retry. */
  send: (intent: NightIntent) => Promise<unknown>;
  onState?: (s: SaverState) => void;
  onSaved?: (intent: NightIntent, answer: unknown) => void;
  onRefused?: (intent: NightIntent, error: WindDownRefused) => void;
  retryDelaysMs?: readonly number[];
  timers?: SaverTimers;
}

/**
 * One wind-down tap at a time. A failure that is not a refusal is retried with backoff (and at once by retryNow(),
 * e.g. when the device comes back online); the server treats a repeated tap as a no-op, so a retry after a lost
 * answer cannot count twice. A tap made while one is in flight waits and is sent next (the newest waiting tap wins).
 */
export class WindDownSaver {
  private state: SaverState = { status: "idle" };
  private inflight = false;
  private queued: NightIntent | null = null;
  private timer: unknown = null;
  private readonly delays: readonly number[];
  private readonly timers: SaverTimers;
  constructor(private readonly opts: SaverOptions) {
    this.delays = opts.retryDelaysMs ?? [2000, 5000, 15000, 30000];
    this.timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }
  get current(): SaverState { return this.state; }
  /** Something tapped is not saved yet (saving, waiting to retry, or waiting behind another tap). */
  get unsaved(): boolean { return this.inflight || this.queued !== null || this.state.status === "retrying"; }
  private set(s: SaverState) { this.state = s; this.opts.onState?.(s); }
  submit(intent: NightIntent) {
    if (this.inflight) { this.queued = intent; return; }
    this.clearTimer();
    void this.run(intent, 0);
  }
  /** Retry a tap that is waiting to retry, now (Retry, or the device came back online). A refusal is not retried. */
  retryNow() {
    if (this.inflight) return;
    const s = this.state;
    if (s.status !== "retrying") return;
    this.clearTimer();
    void this.run(s.intent, s.attempt);
  }
  /** Drop a tap that is waiting to retry or was refused (Riley gave up on it). */
  dismiss() {
    if (this.inflight) return;
    this.clearTimer();
    this.queued = null;
    this.set({ status: "idle" });
  }
  private clearTimer() { if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; } }
  private async run(intent: NightIntent, attempt: number) {
    this.inflight = true;
    this.set({ status: "saving", intent });
    try {
      const answer = await this.opts.send(intent);
      this.inflight = false;
      this.set({ status: "saved", intent });
      this.opts.onSaved?.(intent, answer);
    } catch (e) {
      this.inflight = false;
      if (e instanceof WindDownRefused) {
        this.set({ status: "refused", intent, error: e.message, code: e.code });
        this.opts.onRefused?.(intent, e);
      } else if (!this.queued) {
        const error = e instanceof TypeError ? "Couldn't reach Onyx." : e instanceof Error && e.message ? e.message : "Not saved.";
        const n = attempt + 1;
        this.set({ status: "retrying", intent, error, attempt: n });
        this.timer = this.timers.set(() => { this.timer = null; void this.run(intent, n); }, this.delays[Math.min(attempt, this.delays.length - 1)]);
      }
    }
    const next = this.queued;
    this.queued = null;
    if (next) void this.run(next, 0);
  }
}

/** A tap kept on this device until the server confirmed it (a closed tab or a lost connection must not lose it). */
export interface PendingTap extends NightIntent { at: number }
export function pendingRecord(intent: NightIntent, nowMs: number): string {
  return JSON.stringify({ ...intent, at: nowMs });
}
export function parsePending(raw: string | null | undefined): PendingTap | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  const r = obj(v);
  if (!r || !isDate(r.night) || !isDate(r.today) || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (r.answer !== null && r.answer !== "Yes" && r.answer !== "No") return null;
  if (r.expect !== "Yes" && r.expect !== "No" && r.expect !== "none") return null;
  return { night: r.night, answer: r.answer as NightAnswer | null, expect: r.expect, today: r.today, at: r.at };
}
/**
 * The kept tap worth offering again on this payload, or null: it must be under PENDING_MAX_AGE_MS old, for a night
 * still answerable here, and not already what the server holds (then it did land and the answer was lost). It is
 * OFFERED, never sent on its own: opening a page writes nothing. Sent with the payload's `today` (the night stays
 * the one tapped); a stored answer that moved meanwhile refuses it (OXW15) instead of overwriting it.
 */
export function pendingToOffer(tap: PendingTap | null, p: WindDownPayload | null, nowMs: number): NightIntent | null {
  if (!tap || !p || p.status !== "ready") return null;
  if (nowMs - tap.at > PENDING_MAX_AGE_MS || nowMs < tap.at - 60_000) return null;
  if (tap.night > p.today || tap.night < addDays(p.today, -WINDDOWN_ANSWER_DAYS_BACK)) return null;
  if (answerOn(p, tap.night) === (tap.answer ?? "none")) return null;
  return { night: tap.night, answer: tap.answer, expect: tap.expect, today: p.today };
}
