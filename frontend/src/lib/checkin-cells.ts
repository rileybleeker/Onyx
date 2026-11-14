// Pure state rules of the /check-in screen (no React, no storage): what a question shows, what an unsaved tap
// is worth, and what Save sends. Kept apart from CheckInClient.tsx so they can be tested for real
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
export function draftSettled(draft: Draft, posted: Patch): Draft {
  const next = { ...draft };
  for (const [name, a] of Object.entries(posted)) if (next[name] && next[name].a === a) delete next[name];
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
  /** Sent under the day tab's date. Empty = the day is not sent (and its reminder card is not settled). */
  dayPatch: Patch;
  /** Sent one request each, under the night's own date. */
  nightPatches: { date: string; changes: Patch }[];
  changeCount: number;
}

/**
 * What Save sends. A part (the day, or one night) is sent only when Riley touched it: tapped or cleared
 * something in it. Its pre-fills then go with it. Untouched pre-fills stay suggestions: today's can still
 * change (a workout later), and storing them would mark the day's check-in done.
 */
export function savePlan(args: {
  dayItems: CheckinItem[];
  dayAnswers: Record<string, CheckinAnswer>;
  cells: Cells;
  sleepItems: CheckinItem[];
  nights: CheckinNight[]; // the visible ones
  nightCells: Record<string, Cells>;
}): SavePlan {
  const dayChanges = changesOf(args.dayItems, args.dayAnswers, args.cells);
  const dayPatch = touched(dayChanges, args.cells) ? dayChanges : {};
  const nightPatches = args.nights
    .filter((n) => !!args.nightCells[n.date]) // no cells built for a night = nothing to send, never "clear it all"
    .map((n) => ({ date: n.date, changes: changesOf(args.sleepItems, n.answers, args.nightCells[n.date]), cells: args.nightCells[n.date] }))
    .filter((n) => touched(n.changes, n.cells))
    .map(({ date, changes }) => ({ date, changes }));
  const changeCount = Object.keys(dayPatch).length + nightPatches.reduce((sum, n) => sum + Object.keys(n.changes).length, 0);
  return { dayPatch, nightPatches, changeCount };
}
