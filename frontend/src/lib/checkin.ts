// Daily habit check-in: types and pure rules shared by /api/habits/checkin and the /check-in screen.

export type CheckinAnswer = "Yes" | "No";

export interface CheckinItem {
  name: string; // the habit_journal question (verbatim Notion title)
  notionPageId: string;
  category: string;
  frequency: string;
  channel: "whoop" | "habit";
  /** core = answered every day (WHOOP-derived questions + daily habits); extra = weekly / ad-hoc / occasional habits, blank = not logged. */
  group: "core" | "extra";
  /** A sleep question: asked per finished night (CheckinPayload.nights), not on a day tab. */
  sleep: boolean;
}

/** One finished night. `date` = the behavior day that night closes; its answers are stored on that day. */
export interface CheckinNight {
  date: string;
  answers: Record<string, CheckinAnswer>; // saved sleep answers
  suggestions: Record<string, CheckinSuggestion>;
  /** Last answer given to each sleep-kit question before this night: what the "usual kit" tap fills in. */
  usualKit: Record<string, CheckinAnswer>;
}

export interface CheckinSuggestion {
  answer: CheckinAnswer;
  source: string; // shown next to the pre-filled answer, e.g. "Cronometer: 28 g alcohol"
}

export interface CheckinDay {
  date: string;
  answered: number; // core questions answered
  total: number; // core questions
}

export interface CheckinPayload {
  date: string;
  today: string; // behavioral today
  items: CheckinItem[];
  answers: Record<string, CheckinAnswer>;
  suggestions: Record<string, CheckinSuggestion>;
  /** The finished nights the sleep questions are asked for, newest first (last night, then the one before). */
  nights: CheckinNight[];
  /** today and the two days before, with progress over the DAYTIME core questions, for the catch-up tabs */
  days: CheckinDay[];
}

/** Days back (from behavioral today) the check-in accepts. Older days stay unlogged on purpose. */
export const CHECKIN_MAX_DAYS_BACK = 2;

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Less typing (2026-11-13) ────────────────────────────────────────────────
// The check-in asked 38 Yes/No questions a night and was abandoned after 3 days. Three changes cut it down
// without guessing an answer for Riley:
//  1. OCCASIONAL questions move to the collapsed "Also did" section (blank = not logged).
//  2. More pre-fills from data Onyx already holds, each labeled with its source and only when the data is clear.
//  3. One tap for the sleep kit (the last answer given to each kit question) and one for "No for the rest".
//  4. Sleep is asked for nights that already happened ("Last night"), never for tonight.
// Question titles are the frozen habit names; a rename in Notion simply drops the question out of a list here.

/** What Riley wears to sleep. One "usual kit" tap answers all of them. */
export const SLEEP_KIT: readonly string[] = [
  "Wore mouth tape while sleeping?",
  "Slept with a nightguard or retainer?",
  "Wore a nasal strip while sleeping?",
  "Wore ear plugs to bed?",
  "Wore a sleep mask?",
];

export const Q_SAME_BED = "Slept in the same bed as usual?";
export const Q_SCREEN_IN_BED = "Viewed a screen device in bed?";
export const Q_JOURNALED = "Journaled your thoughts?";
export const Q_READ_IN_BED = "Read (non-screened device) while in bed?";

/**
 * Questions about a night's sleep. An answer stored on behavior day D describes the night that CLOSES day D
 * (the HRV pipeline scores day D's answers against that sleep; see hrv_alignment.py), so on day D itself that
 * night has not happened yet. The check-in therefore never asks them on a day tab: it asks them per finished
 * night (sleepNights) and stores each night's answers on the day it closes. A sleep question that is also
 * OCCASIONAL (read in bed) is an optional row in the night block: blank = not logged.
 * Other write paths follow the same rule: the chat tool stores a sleep answer with no date on yesterday
 * (sleepAnswerDate), and the /habits "Today's Habits" checklist leaves these questions out.
 */
export const SLEEP_QUESTIONS: ReadonlySet<string> = new Set([...SLEEP_KIT, Q_SAME_BED, Q_SCREEN_IN_BED, Q_READ_IN_BED]);

/** Where a sleep answer given "now" belongs: the newest finished night = the behavior day before today. */
export function sleepAnswerDate(today: string): string {
  return addDays(today, -1);
}

/**
 * Behavioral today when pds.behavioral_today_now() cannot be reached: Eastern clock time minus 6 hours.
 * (The plain Eastern date would be a day ahead between midnight and 06:00 and turn "last night" into tonight.)
 */
export function fallbackBehavioralToday(now: Date): string {
  // Same rule as SQL ((ts AT TIME ZONE tz) - 6h)::date: take the Eastern WALL clock, then subtract 6 hours.
  // (Subtracting from the instant first is an hour off on the two daylight-saving days.)
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") - 6)).toISOString().slice(0, 10);
}

/**
 * Every write path refuses a Yes/No to a sleep question dated behavioral today or later: that night has not
 * happened. Returns the message to show, or null when the write is fine (clearing is always allowed).
 */
export function sleepDateError(question: string, date: string, today: string, answer: unknown): string | null {
  if (answer === null || !SLEEP_QUESTIONS.has(question) || date < today) return null;
  return `"${question}" is about a night that already happened. Answer it for last night (${sleepAnswerDate(today)}) on the check-in; tonight is asked tomorrow.`;
}

/** How many finished nights the check-in asks about (same reach as the day tabs). */
export const CHECKIN_NIGHTS_BACK = 2;

/**
 * The nights that are over, newest first, as the behavior days they close: last night closed (today - 1).
 * `today` is behavioral today, so at 00:30 before bed "last night" is still the night before.
 */
export function sleepNights(today: string, frozenThrough?: string): string[] {
  return Array.from({ length: CHECKIN_NIGHTS_BACK }, (_, i) => addDays(today, -(i + 1))).filter((d) => !frozenThrough || d > frozenThrough);
}

const weekday = (date: string, style: "short" | "long") =>
  new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: style });

/** "Last night" + "Thu night → Fri morning": names a night so it cannot be mistaken for another one. */
export function nightLabel(night: string, today: string): { title: string; span: string } {
  return {
    title: night === addDays(today, -1) ? "Last night" : `${weekday(night, "long")} night`,
    span: `${weekday(night, "short")} night → ${weekday(addDays(night, 1), "short")} morning`,
  };
}

/**
 * Asked only in "Also did". On 2026-11-13 each of these had at most 4 Yes answers ever (most had none), so a
 * nightly No carried no information. Tapping Yes there still records the day. Move a name out of this list
 * to ask it every day again.
 */
export const OCCASIONAL: ReadonlySet<string> = new Set([
  "Dimmed your lights after sunset?",
  "Read (non-screened device) while in bed?",
  "Took a vacation day?",
  "MEMOS",
  "Case Study",
  "History",
  "Math",
  "Meditated",
  "Chess",
  "Substack",
  "Lumosity",
  "Duolingo Spanish",
  "News",
  "BI/Python/AL/Excel",
]);

export function groupFor(name: string, channel: "whoop" | "habit", frequency: string): "core" | "extra" {
  if (OCCASIONAL.has(name)) return "extra";
  return channel === "whoop" || frequency === "daily" || frequency === "weekdays" ? "core" : "extra";
}

/** The kit = the most recent answer to each kit question on a day before `before`. Unanswered questions are left out. */
export function usualKit(
  rows: { cycle_date: string; question: string; answer: string }[],
  before: string,
  kit: readonly string[] = SLEEP_KIT
): Record<string, CheckinAnswer> {
  const latest = new Map<string, { date: string; answer: CheckinAnswer }>();
  for (const r of rows) {
    if (!kit.includes(r.question) || r.cycle_date >= before) continue;
    if (r.answer !== "Yes" && r.answer !== "No") continue;
    const cur = latest.get(r.question);
    if (!cur || r.cycle_date > cur.date) latest.set(r.question, { date: r.cycle_date, answer: r.answer });
  }
  const out: Record<string, CheckinAnswer> = {};
  for (const q of kit) {
    const hit = latest.get(q);
    if (hit) out[q] = hit.answer;
  }
  return out;
}

/** "mouth tape, nightguard or retainer · no ear plugs": the short names shown on the kit button. */
export function kitSummary(kit: Record<string, CheckinAnswer>): string {
  const short = (q: string) =>
    q
      .replace(/^(Wore|Slept with) (an? )?/i, "")
      .replace(/ (while sleeping|to bed)\?$/i, "")
      .replace(/\?$/, "");
  const yes = Object.keys(kit)
    .filter((q) => kit[q] === "Yes")
    .map(short);
  const no = Object.keys(kit)
    .filter((q) => kit[q] === "No")
    .map((q) => `no ${short(q)}`);
  return [yes.join(", "), no.join(", ")].filter(Boolean).join(" · ");
}

/** Phone minutes in the hour before WHOOP sleep onset (hourly Screen Time buckets, so an estimate). */
export const SCREEN_IN_BED_YES_MIN = 10;
export const SCREEN_IN_BED_NO_MAX = 1;

/**
 * `syncedPastSleepOnset`: the phone uploaded its usage AFTER that night's sleep began, so the hour before sleep
 * is fully reported. Without it a low number may only mean "not uploaded yet", so it is never read as No.
 */
export function screenInBedSuggestion(minutesLastHour: number | string | null | undefined, syncedPastSleepOnset = true): CheckinSuggestion | null {
  if (minutesLastHour == null || minutesLastHour === "") return null;
  const m = Number(minutesLastHour);
  if (!Number.isFinite(m)) return null;
  if (m >= SCREEN_IN_BED_YES_MIN) return { answer: "Yes", source: `Screen Time: ${Math.round(m)} min on the phone in the hour before sleep` };
  if (m <= SCREEN_IN_BED_NO_MAX && syncedPastSleepOnset) return { answer: "No", source: "Screen Time: no phone use in the hour before sleep" };
  return null;
}

/** True when both instants are known and the upload is later than sleep onset. */
export function syncedAfter(syncedAt: string | null | undefined, sleepStart: string | null | undefined): boolean {
  if (!syncedAt || !sleepStart) return false;
  const a = Date.parse(syncedAt);
  const b = Date.parse(sleepStart);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/** A night counts as "in the usual bed" when Eight Sleep recorded at least this much sleep. */
export const SAME_BED_MIN_SECONDS = 3 * 3600;

/**
 * Eight Sleep keys a night by its wake-up date, so the night closing behavior day D is the row dated D + 1.
 * Checked against 126 past answers (2026-11-13): 93 of 97 Yes nights had such a row, 25 of 29 No nights had none.
 * `sleptSeconds` = the longest non-"away" row for D + 1 (null when there is none); `newestNight` = the newest
 * wake-up date Eight Sleep has. A missing night is only read as No once a LATER night has been synced.
 */
export function sameBedSuggestion(date: string, sleptSeconds: number | null, newestNight: string | null): CheckinSuggestion | null {
  if (sleptSeconds != null && sleptSeconds >= SAME_BED_MIN_SECONDS) {
    return { answer: "Yes", source: `Eight Sleep: ${(sleptSeconds / 3600).toFixed(1)} h in your bed` };
  }
  if (sleptSeconds == null && newestNight && newestNight >= addDays(date, 2)) {
    return { answer: "No", source: "Eight Sleep: no sleep recorded in your bed" };
  }
  return null;
}

/** Habits answered by time in an app (Screen Time bundle id). Yes only: no use proves nothing (web, another device). */
export const APP_HABITS: Readonly<Record<string, { bundleId: string; label: string }>> = {
  "Duolingo Spanish": { bundleId: "com.duolingo.DuolingoMobile", label: "Duolingo" },
  Substack: { bundleId: "com.substack.Substack", label: "Substack" },
  News: { bundleId: "com.apple.news", label: "Apple News" },
};
export const APP_HABIT_MIN_MINUTES = 3;

export function appHabitSuggestions(minutesByApp: Record<string, unknown> | null | undefined, names: ReadonlySet<string>): Record<string, CheckinSuggestion> {
  const out: Record<string, CheckinSuggestion> = {};
  if (!minutesByApp || typeof minutesByApp !== "object") return out;
  for (const [habit, { bundleId, label }] of Object.entries(APP_HABITS)) {
    if (!names.has(habit)) continue;
    const m = Number(minutesByApp[bundleId]);
    if (Number.isFinite(m) && m >= APP_HABIT_MIN_MINUTES) out[habit] = { answer: "Yes", source: `Screen Time: ${Math.round(m)} min in ${label}` };
  }
  return out;
}

/** A Notion journal entry on the day = Yes. No entry = No only once the day is over (an entry can still come tonight). */
export function journaledSuggestion(date: string, today: string, entryCount: number): CheckinSuggestion | null {
  if (entryCount > 0) return { answer: "Yes", source: entryCount === 1 ? "Journal entry in Notion" : `${entryCount} journal entries in Notion` };
  if (date < today) return { answer: "No", source: "No journal entry in Notion" };
  return null;
}
