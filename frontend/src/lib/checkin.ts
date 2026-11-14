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
  /** About the night that closes the behavior day (tonight, on the Today tab). */
  sleep: boolean;
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
  /** Last answer given to each sleep-kit question before `date`: what the "usual kit" tap fills in. */
  usualKit: Record<string, CheckinAnswer>;
  /** today and the two days before, with progress, for the catch-up tabs */
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

/**
 * Questions about the night that CLOSES the behavior day: on the Today tab that is tonight, not last night
 * (the HRV pipeline scores day D's answers against the sleep that ends day D; see hrv_alignment.py).
 */
export const SLEEP_QUESTIONS: ReadonlySet<string> = new Set([...SLEEP_KIT, Q_SAME_BED, Q_SCREEN_IN_BED]);

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

export function screenInBedSuggestion(minutesLastHour: number | string | null | undefined): CheckinSuggestion | null {
  if (minutesLastHour == null || minutesLastHour === "") return null;
  const m = Number(minutesLastHour);
  if (!Number.isFinite(m)) return null;
  if (m >= SCREEN_IN_BED_YES_MIN) return { answer: "Yes", source: `Screen Time: ${Math.round(m)} min on the phone in the hour before sleep` };
  if (m <= SCREEN_IN_BED_NO_MAX) return { answer: "No", source: "Screen Time: no phone use in the hour before sleep" };
  return null;
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
