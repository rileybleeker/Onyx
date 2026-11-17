/**
 * Voluntary learning pacing on top of the existing Reading module (PROD-T06). Pure and import-free
 * (tests/learning-pacing.test.cjs).
 *
 * What it is: a few CHOSEN settings (one goal, a weekly rhythm, a pause, whether XP / streak / level / deadline
 * furniture is shown) stored as one UI preference (`reading.pacing`, pds.ui_preferences: layout-class data, no new
 * table), and ONE suggested next action built from what Reading already records (sessions, due reviews, the next
 * chapter). Nothing here is a second completion store and nothing here writes on its own.
 *
 * Rules the copy and the code keep:
 * - Rest is legitimate. Pausing, a quiet week or a low-energy choice never produces a debt, an "overdue", a
 *   "behind" or a penalty. The weekly count is shown as "N of M", never as a miss.
 * - Unknown is not missed. When the sessions could not be read, the week shows no count and no claim.
 * - Defaults keep today's behaviour: incentives (XP, streak, level, badges, pace) stay visible until Riley turns
 *   them off. The weekly rhythm is shown only after Riley saved settings (opt-in); before that the suggestion is
 *   only the next action.
 * - History is never touched: hiding furniture hides it, it does not delete or recompute anything.
 */

export const LEARNING_PREF_KEY = "reading.pacing";
/** = uiPrefUrl(LEARNING_PREF_KEY) (lib/ui-preferences.ts; the test keeps them equal). */
export const LEARNING_PREF_URL = "/api/ui/preferences?key=reading.pacing";

export const GOAL_MAX = 120;
export const SESSIONS_PER_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
export const SESSION_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90] as const;
/** The low-energy option is always this long, whatever the chosen session length. */
export const LOW_ENERGY_MINUTES = 5;
export const MAX_PAUSE_DAYS = 365;

export interface LearningPrefs {
  v: 1;
  /** One short sentence Riley chose; empty = none. Shown, never scored. */
  goal: string;
  /** Chosen rhythm: this many sessions a week, about this long. A suggestion, never a quota. */
  weeklySessions: number;
  sessionMinutes: number;
  /** Last day of a pause (YYYY-MM-DD, inclusive), null = not paused. While paused nothing is suggested. */
  pauseUntil: string | null;
  /** Show XP, level, streak, badges, pace and deadline furniture. Default true (today's behaviour). */
  showIncentives: boolean;
}

export const DEFAULT_PREFS: LearningPrefs = {
  v: 1,
  goal: "",
  weeklySessions: 2,
  sessionMinutes: 20,
  pauseUntil: null,
  showIncentives: true,
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !YMD.test(v)) return false;
  const d = new Date(v + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function oneOf<T extends number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "number" && (allowed as readonly number[]).includes(v) ? (v as T) : fallback;
}

/**
 * What GET /api/ui/preferences answered (its `value`). Tolerant: a missing or malformed field falls back to its
 * default, so an old or hand-edited value can never break the page. `configured` is false when nothing was saved.
 */
export function parsePrefs(value: unknown): { prefs: LearningPrefs; configured: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { prefs: { ...DEFAULT_PREFS }, configured: false };
  const r = value as Record<string, unknown>;
  const goal = typeof r.goal === "string" ? r.goal.replace(/\s+/g, " ").trim().slice(0, GOAL_MAX) : "";
  return {
    configured: true,
    prefs: {
      v: 1,
      goal,
      weeklySessions: oneOf(r.weeklySessions, SESSIONS_PER_WEEK, DEFAULT_PREFS.weeklySessions),
      sessionMinutes: oneOf(r.sessionMinutes, SESSION_MINUTES, DEFAULT_PREFS.sessionMinutes),
      pauseUntil: isYmd(r.pauseUntil) ? r.pauseUntil : null,
      showIncentives: r.showIncentives === false ? false : true,
    },
  };
}

/** Why a value cannot be saved (shown as the form's refusal), or null. */
export function prefsError(p: LearningPrefs, today: string): string | null {
  if (p.goal.length > GOAL_MAX) return `The goal can be at most ${GOAL_MAX} characters.`;
  if (!(SESSIONS_PER_WEEK as readonly number[]).includes(p.weeklySessions)) return "Choose 1 to 7 sessions a week.";
  if (!(SESSION_MINUTES as readonly number[]).includes(p.sessionMinutes)) return "Choose one of the listed session lengths.";
  if (p.pauseUntil !== null) {
    if (!isYmd(p.pauseUntil)) return "The pause date is not a valid day.";
    if (p.pauseUntil > addDays(today, MAX_PAUSE_DAYS)) return "A pause can be at most a year long.";
  }
  return null;
}

/** The exact object sent to PUT /api/ui/preferences (a small JSON object, well under its 4 KB cap). */
export function prefsBody(p: LearningPrefs): { key: string; value: LearningPrefs } {
  return { key: LEARNING_PREF_KEY, value: { ...p, goal: p.goal.replace(/\s+/g, " ").trim().slice(0, GOAL_MAX) } };
}

export function samePrefs(a: LearningPrefs, b: LearningPrefs): boolean {
  return (
    a.goal.trim() === b.goal.trim() &&
    a.weeklySessions === b.weeklySessions &&
    a.sessionMinutes === b.sessionMinutes &&
    a.pauseUntil === b.pauseUntil &&
    a.showIncentives === b.showIncentives
  );
}

export function isPaused(p: LearningPrefs, today: string): boolean {
  return p.pauseUntil !== null && today <= p.pauseUntil;
}

/** Monday of the week that holds `date` (a behavioral day; weeks are Monday to Sunday). */
export function weekStart(date: string): string {
  const dow = new Date(date + "T12:00:00Z").getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Distinct days with a recorded session in the week of `today`, up to and including `today`. */
export function sessionDaysThisWeek(sessionDates: readonly string[], today: string): number {
  const from = weekStart(today);
  const days = new Set<string>();
  for (const d of sessionDates) if (typeof d === "string" && d >= from && d <= today) days.add(d);
  return days.size;
}

export type PacingAction =
  | { kind: "paused"; until: string }
  | { kind: "rest"; done: number; goal: number }
  | { kind: "review"; due: number; minutes: number; lowEnergy: boolean }
  | { kind: "read"; chapter: number | null; bookTitle: string; minutes: number; lowEnergy: boolean }
  | { kind: "none" };

export interface PacingInput {
  prefs: LearningPrefs;
  /** False until Riley saved settings: the suggestion is then only the next action, with no weekly rhythm. */
  configured: boolean;
  today: string;
  /** Recorded session days, or null when they could not be read (unknown, never "none"). */
  sessionDates: readonly string[] | null;
  dueReviews: number | null;
  /** The book on screen; null = none in progress. */
  book: { title: string; status: string; chaptersDone: number; totalChapters: number } | null;
  /** The 5-minute choice for a low-energy day. */
  lowEnergy?: boolean;
}

/**
 * The ONE next action. Order: a pause wins; a week that already holds the chosen number of sessions says rest
 * (only when settings were saved); then a due review (smallest, concrete, from existing review data); then the next
 * chapter. Unknown inputs never produce a claim: unreadable sessions skip the weekly rest check, unreadable due
 * reviews skip the review.
 */
export function nextAction(i: PacingInput): PacingAction {
  const low = i.lowEnergy === true;
  const minutes = low ? LOW_ENERGY_MINUTES : i.prefs.sessionMinutes;
  if (i.configured && isPaused(i.prefs, i.today)) return { kind: "paused", until: i.prefs.pauseUntil as string };
  if (i.configured && !low && i.sessionDates !== null) {
    const done = sessionDaysThisWeek(i.sessionDates, i.today);
    if (done >= i.prefs.weeklySessions) return { kind: "rest", done, goal: i.prefs.weeklySessions };
  }
  if (i.dueReviews !== null && i.dueReviews > 0) return { kind: "review", due: i.dueReviews, minutes, lowEnergy: low };
  const b = i.book;
  if (b && b.status === "reading") {
    const known = b.totalChapters > 0 && Number.isFinite(b.chaptersDone) && b.chaptersDone >= 0;
    const next = known && b.chaptersDone < b.totalChapters ? b.chaptersDone + 1 : null;
    return { kind: "read", chapter: next, bookTitle: b.title, minutes, lowEnergy: low };
  }
  return { kind: "none" };
}

/** Where the action goes: Reading holds both the review card and the book's chapters and highlights. */
export function actionHref(_a: PacingAction): string {
  return "/reading";
}

/** One short line for the action. Never uses behind, overdue, missed or streak wording. */
export function actionText(a: PacingAction): string {
  switch (a.kind) {
    case "paused":
      return `Paused through ${a.until}. Nothing is due.`;
    case "rest":
      return `${a.done} of ${a.goal} sessions this week. Rest is fine.`;
    case "review":
      return `Review ${a.due === 1 ? "1 highlight" : `${a.due} highlights`}${a.lowEnergy ? ", just a few minutes" : ` (about ${a.minutes} min)`}.`;
    case "read": {
      const what = a.chapter !== null ? `${a.bookTitle}, chapter ${a.chapter}` : a.bookTitle;
      return `Read ${what} for about ${a.minutes} min.`;
    }
    default:
      return "";
  }
}

/** The weekly rhythm line, or null when it should not be shown (not saved, paused, or sessions unknown). */
export function weekLine(i: Pick<PacingInput, "prefs" | "configured" | "today" | "sessionDates">): string | null {
  if (!i.configured || i.sessionDates === null || isPaused(i.prefs, i.today)) return null;
  return `${sessionDaysThisWeek(i.sessionDates, i.today)} of ${i.prefs.weeklySessions} sessions this week`;
}
