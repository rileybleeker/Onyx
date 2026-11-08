// Daily habit check-in: types shared by /api/habits/checkin and the /check-in screen.

export type CheckinAnswer = "Yes" | "No";

export interface CheckinItem {
  name: string; // the habit_journal question (verbatim Notion title)
  notionPageId: string;
  category: string;
  frequency: string;
  channel: "whoop" | "habit";
  /** core = answered every day (WHOOP-derived questions + daily habits); extra = weekly / ad-hoc habits, blank = not logged. */
  group: "core" | "extra";
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
