// Pure state rules of the /check-in screen (no React, no storage): what a question shows, what an unsaved tap
// is worth, what each autosave sends, and when the day counts as done. Kept apart from CheckInClient.tsx so they can be tested for real
// (frontend/tests/checkin.test.cjs).
import type { CheckinAnswer, CheckinItem, CheckinNight, CheckinSuggestion } from "./checkin";

export type Origin = "saved" | "suggested" | "tapped";
export type Cell = { answer: CheckinAnswer; origin: Origin; source?: string };
export type Cells = Record<string, Cell>;
/** Answers to send: Yes / No, or null for "clear". The shape POSTed to /api/habits/checkin. */
export type Patch = Record<string, CheckinAnswer | null>;

/**
 * One unsaved tap. `base` = the answer stored on the server when the tap was made (null = none): if the stored
 * answer has changed since (saved from /habits or chat), the tap is out of date and the server wins.
 */
export type DraftEntry = { a: CheckinAnswer | null; base?: CheckinAnswer | null };
export type Draft = Record<string, DraftEntry>;

const isAnswer = (v: unknown): v is CheckinAnswer => v === "Yes" || v === "No";

/** Whatever was in storage → a clean draft. Older drafts stored the bare answer with no baseline. */
export function parseDraft(v: unknown): Draft {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Draft = {};
  for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
    if (e === null || isAnswer(e)) out[name] = { a: e };
    else if (e && typeof e === "object" && "a" in e) {
      const { a, base } = e as { a: unknown; base?: unknown };
      if (a === null || isAnswer(a)) out[name] = { a, base: isAnswer(base) ? base : base === null ? null : undefined };
    }
  }
  return out;
}

/** The draft after new taps, each stamped with the answer stored at that moment. */
export function draftWith(draft: Draft, patch: Patch, saved: Record<string, CheckinAnswer>): Draft {
  const next = { ...draft };
  for (const [name, a] of Object.entries(patch)) next[name] = { a, base: saved[name] ?? null };
  return next;
}

/** The draft after a save: what was sent and is still unchanged goes; a tap made mid-save stays. */
export function draftSettled(draft: Draft, posted: Patch, sent: Draft = draft): Draft {
  const next = { ...draft };
  for (const [name, a] of Object.entries(posted)) {
    if (!next[name]) continue;
    if (next[name] === sent[name] && next[name].a === a) delete next[name];
    // A newer tap was made against the old server value. Keep it against the value just saved.
    else next[name] = { ...next[name], base: a };
  }
  return next;
}

/** Saved answers, then pre-fills for what is still blank, then the local draft on top. Only `items` are kept. */
export function buildCells(
  items: CheckinItem[],
  saved: Record<string, CheckinAnswer>,
  suggestions: Record<string, CheckinSuggestion>,
  draft: Draft
): Cells {
  const next: Cells = {};
  for (const item of items) {
    const s = saved[item.name];
    const sug = suggestions[item.name];
    if (s) next[item.name] = { answer: s, origin: "saved" };
    else if (sug) next[item.name] = { answer: sug.answer, origin: "suggested", source: sug.source };
  }
  for (const [name, { a, base }] of Object.entries(draft)) {
    if (!items.some((i) => i.name === name)) continue;
    const stored = saved[name] ?? null;
    if (base !== undefined && base !== stored) continue; // the stored answer changed since the tap: server wins
    if (a === stored && (a !== null || !suggestions[name])) continue; // nothing pending (a null still blanks a pre-fill)
    if (a === null) delete next[name];
    else next[name] = { answer: a, origin: "tapped" };
  }
  return next;
}

/** What differs from what's stored: every set answer that differs, plus clears of stored answers. */
export function changesOf(items: CheckinItem[], saved: Record<string, CheckinAnswer>, cells: Cells): Patch {
  const out: Patch = {};
  for (const item of items) {
    const stored = saved[item.name];
    const cur = cells[item.name]?.answer;
    if (cur && cur !== stored) out[item.name] = cur;
    if (!cur && stored) out[item.name] = null;
  }
  return out;
}

/** True when the changes include something Riley did himself (a tap or a clear), not only pre-fills. */
export function touched(changes: Patch, cells: Cells): boolean {
  return Object.entries(changes).some(([name, a]) => a === null || cells[name]?.origin === "tapped");
}

/**
 * The night blocks on screen: last night always; an earlier night while its SAVED required answers are
 * incomplete (so it doesn't vanish mid-tap) or while it holds an unsaved tap (so that tap is never dropped).
 */
export function visibleNights(nights: CheckinNight[], sleepItems: CheckinItem[], nightCells: Record<string, Cells>): CheckinNight[] {
  if (!sleepItems.length) return [];
  return nights.filter(
    (n, i) =>
      i === 0 ||
      sleepItems.some((it) => it.group === "core" && !n.answers[it.name]) ||
      // (a night with no cells built yet has nothing pending: never read "no cells" as "everything cleared")
      (!!nightCells[n.date] && touched(changesOf(sleepItems, n.answers, nightCells[n.date]), nightCells[n.date]))
  );
}

export interface SavePlan {
  /** Sent under the day tab's date. Empty = the day is not sent. */
  dayPatch: Patch;
  /** Sent one request each, under the night's own date. */
  nightPatches: { date: string; changes: Patch }[];
  changeCount: number;
}

/** The answer each question shows: saved, tapped or pre-filled (a blank question has no cell). */
export function shownAnswers(cells: Cells): Record<string, CheckinAnswer> {
  return Object.fromEntries(Object.entries(cells).map(([name, c]) => [name, c.answer]));
}

/**
 * What each autosave sends (taps save on their own, a short delay after the last one). A part (the day, or one
 * night) is sent only when Riley touched it: tapped or cleared something in it. Its pre-fills then go with it.
 * Untouched pre-fills stay suggestions.
 *
 * Behavioral today (`dayIsToday`) is the exception for the day part: its pre-fills can still change (a workout
 * later turns "rest day: Yes" into No), and a stored answer outranks every later suggestion. So an autosave on
 * today sends only what Riley tapped or cleared, and the day's pre-fills go along only once the day is complete
 * counting them (every core daytime question shows a saved, tapped or pre-filled answer): the moment the check-in
 * is effectively done, which is also when its Agents card settles (dayComplete on the stored result). Earlier days
 * (the catch-up tabs) and the nights keep "pre-fills go with the first touch".
 */
export function savePlan(args: {
  dayItems: CheckinItem[];
  dayAnswers: Record<string, CheckinAnswer>;
  cells: Cells;
  sleepItems: CheckinItem[];
  nights: CheckinNight[]; // the visible ones
  nightCells: Record<string, Cells>;
  /** The day tab is behavioral today (its date equals the payload's `today`). */
  dayIsToday?: boolean;
}): SavePlan {
  const dayChanges = changesOf(args.dayItems, args.dayAnswers, args.cells);
  let dayPatch = touched(dayChanges, args.cells) ? dayChanges : {};
  if (args.dayIsToday && Object.keys(dayPatch).length && !dayComplete(args.dayItems, shownAnswers(args.cells))) {
    // Not done yet: only Riley's own taps and clears; the pre-fills wait (they are still suggestions).
    dayPatch = Object.fromEntries(Object.entries(dayPatch).filter(([name, a]) => a === null || args.cells[name]?.origin === "tapped"));
  }
  const nightPatches = args.nights
    .filter((n) => !!args.nightCells[n.date]) // no cells built for a night = nothing to send, never "clear it all"
    .map((n) => ({ date: n.date, changes: changesOf(args.sleepItems, n.answers, args.nightCells[n.date]), cells: args.nightCells[n.date] }))
    .filter((n) => touched(n.changes, n.cells))
    .map(({ date, changes }) => ({ date, changes }));
  const changeCount = Object.keys(dayPatch).length + nightPatches.reduce((sum, n) => sum + Object.keys(n.changes).length, 0);
  return { dayPatch, nightPatches, changeCount };
}

/**
 * The day's check-in is done once every core daytime question has a SAVED Yes or No: only then is the Agents card
 * settled (POST /onyx/checkin/done). (savePlan also asks it of the SHOWN answers, pre-fills included, to decide when
 * today's pre-fills are stored: they are stored in the same save that completes the day, so the card settles then.) Answers save as they are tapped (autosave, 2026-11-15), so there is no "Save
 * = done" moment any more; a half-answered day keeps its card, and the 9 AM re-post still reminds. Sleep questions
 * and "Also did" (extra) questions never count: a day with no core daytime question is never "done" here.
 */
export function dayComplete(dayItems: CheckinItem[], saved: Record<string, CheckinAnswer>): boolean {
  const core = dayItems.filter((i) => i.group === "core" && !i.sleep);
  return core.length > 0 && core.every((i) => saved[i.name] === "Yes" || saved[i.name] === "No");
}

/**
 * "Say it once": which of the text's answers become taps. Only Yes / No, only for `items` (the daytime
 * questions). Never over a row that is saved or was tapped by the time the answer arrives (`cells` must be the
 * CURRENT cells, not the ones from when the text was sent), and never over a row Riley changed while it was
 * being read (`changedSince`), even one he cleared. A data pre-fill is replaced.
 */
export function voicePatch(items: CheckinItem[], answers: Record<string, unknown>, cells: Cells, changedSince: ReadonlySet<string>): Patch {
  const patch: Patch = {};
  for (const item of items) {
    const a = answers[item.name];
    const cur = cells[item.name];
    if (!isAnswer(a) || changedSince.has(item.name) || cur?.origin === "saved" || cur?.origin === "tapped") continue;
    patch[item.name] = a;
  }
  return patch;
}
