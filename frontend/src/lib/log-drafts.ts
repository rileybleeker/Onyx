/**
 * The Log screen's draft contract (/log, AGENTS.md "Log screen").
 *
 * The "Say it" box at the top of /log turns what Riley said or typed into SUGGESTIONS for the sections below it
 * (Check-in, Supplements, Uber Eats, Weight, Reading). It writes them here; each section subscribes to its own
 * key with `useLogDrafts(section)`, shows the suggestion in its own form with the mark FROM_WHAT_YOU_SAID, and
 * stores nothing until Riley taps THAT section's own Save, which goes through the section's existing write route
 * with its existing validation and date rules. A section clears its draft (`clear(draft.id)`) after a successful
 * save or when Riley dismisses the suggestion.
 *
 * Rules:
 *   - Memory only: nothing here reaches localStorage, IndexedDB or the server. A reload or sign-out (a full page
 *     load) drops every draft, and the words are never logged.
 *   - Nothing writes on page open: setting a draft never triggers a request; only a tap on a section's Save does.
 *   - One draft per section, the newest wins (a second "Say it" replaces the first). `id` increases with every
 *     write, so a section applies each draft once and `clear(id)` never removes a newer one.
 *   - A draft is a suggestion: a section never lets it overwrite something Riley tapped or typed since it loaded.
 *
 * Import-free apart from React (unit-tested offline: frontend/tests/log-drafts.test.cjs).
 */
import { useCallback, useSyncExternalStore } from "react";

// ---- what each section receives ------------------------------------------------------------------------------

/**
 * Check-in: the words themselves. The embedded check-in runs its own "Say it once" fill on them
 * (POST /api/habits/checkin/voice, which only reads), so the answers come back in the existing voice answer shape
 * ({answers, night, journal}) and become ordinary draft taps on the day tab on screen and last night's sleep, marked
 * "from what you said"; its own Save (POST /api/habits/checkin) stores them. At most VOICE_MAX_TEXT_CHARS (4000).
 */
export interface CheckinLogDraft {
  text: string;
}

/**
 * Supplements, one product from the /supplements list. Saved through POST /api/supplements/log-intake (one row per
 * time), with the same rules as the chat tool log_supplement_intake (lib/supplement-intake.ts): the product
 * resolves by name, brand or ingredient text (resolveProduct) when `product_id` is null; a weight amount is divided
 * by the label quantity and a count by the serving size (dosesFor).
 */
export interface SupplementProductDraft {
  kind: "product";
  /** pds.supplement_products.product_id when the Say it box already matched it; null = resolve `name`. */
  product_id: string | null;
  /** What was said: product name, brand or ingredient ("Adderall", "magnesium"). */
  name: string;
  /** Amount per time with its unit (15 + "mg", 2 + "capsules"); null = one serving (doses 1). */
  amount: number | null;
  unit: string | null;
  /**
   * Local wall-clock times "HH:MM", one intake each. [] = no time said: today -> now, an earlier day -> intake_time
   * NULL. A time before 06:00 is the awake tail of the behavioral day (it stays on `date`).
   */
  times: string[];
  /** Behavioral day "YYYY-MM-DD"; null = behavioral today (the route's pds.behavioral_today_now() default). */
  date: string | null;
}

/** Supplements, a whole stack ("my morning stack"). Saved through POST /api/supplements/stacks/log (logStackIntake). */
export interface SupplementStackDraft {
  kind: "stack";
  /** pds.supplement_stack.id when matched; null = match `name` (case-insensitive) against the active stacks. */
  stack_id: number | null;
  name: string;
  /** One local time "HH:MM"; null = now for today, no time for an earlier day (same rule as /supplements). */
  time: string | null;
  /** Behavioral day; null = behavioral today. */
  date: string | null;
}

export type SupplementLogDraft = SupplementProductDraft | SupplementStackDraft;

/** One of the delivery-day portion answers (PORTION_OPTIONS in lib/delivery-portion.ts): All, 3/4, 1/2, 1/4, None. */
export type PortionFraction = 1 | 0.75 | 0.5 | 0.25 | 0;
/** One of the leftover answers (LEFTOVER_OPTIONS keys in lib/delivery-leftovers.ts); shares are of what is LEFT. */
export type LeftoverAnswer = "1" | "0.75" | "0.5" | "0.25" | "not_today" | "threw_out";

/**
 * Uber Eats. `portion` = how much of a delivered dish was eaten on its delivery day: PATCH
 * /api/delivery/items/[item_id] {eaten_fraction}. `leftover` = a later day's leftover: PUT
 * /api/delivery/items/[item_id]/leftovers {date, fraction, threw_out?, time?}, where the section turns `answer` (a
 * share of what is left) into the body's share of the WHOLE dish with tokenForOption / splitToken. Both through
 * createPortionSaver, like /nutrition and /check-in.
 */
export type UberEatsLogDraft =
  | { kind: "portion"; item_id: number; fraction: PortionFraction }
  | {
      kind: "leftover";
      item_id: number;
      /** Behavior day it was eaten: the delivery day + 1 to + 3, never after behavioral today. */
      date: string;
      answer: LeftoverAnswer;
      /** Local "HH:MM" it was eaten (only with an amount); before 06:00 = the small hours closing `date`. */
      time: string | null;
    };

/** Weight in pounds. Saved through POST /api/weight {log_date, weight_kg} (lbToKg); a manual entry owns its day. */
export interface WeightLogDraft {
  lb: number;
  /** "YYYY-MM-DD"; null = the route's default (Eastern calendar today). */
  date: string | null;
}

/** Reading, one session. Saved through POST /api/reading/sessions (same fields as the /reading form). */
export interface ReadingLogDraft {
  /** pds.books.slug; null = the book being read now (the route's default: the newest book with status reading). */
  book: string | null;
  minutes: number | null;
  chapter_from: number | null;
  /** Required by the route before Save (a non-negative chapter number); null = not said, Riley fills it in. */
  chapter_through: number | null;
  medium: "audio" | "kindle" | "paper" | "other" | null;
  /** The from-memory note, VERBATIM (never summarized), or null. */
  recall: string | null;
  /** Behavioral day; null = the route's default. */
  date: string | null;
}

/** Section id -> the draft value it receives. Supplements and Uber Eats take several items at once. */
export interface LogDraftMap {
  checkin: CheckinLogDraft;
  supplements: SupplementLogDraft[];
  ubereats: UberEatsLogDraft[];
  weight: WeightLogDraft;
  reading: ReadingLogDraft;
}

export type LogSectionId = keyof LogDraftMap;

export const LOG_SECTIONS: readonly LogSectionId[] = ["checkin", "supplements", "ubereats", "weight", "reading"];

/** The mark shown next to a value that came from a draft (same words as the check-in's own Say it once). */
export const FROM_WHAT_YOU_SAID = "from what you said";

export interface LogDraft<S extends LogSectionId = LogSectionId> {
  section: S;
  /** Increases with every write (any section); a section applies each id once. */
  id: number;
  /** Date.now() when written. */
  at: number;
  /** The words the draft came from, for showing next to the suggestion. Memory only. */
  said: string;
  value: LogDraftMap[S];
}

// ---- the store -----------------------------------------------------------------------------------------------

type Store = { [S in LogSectionId]?: LogDraft<S> };

let drafts: Store = {};
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* a listener never breaks another */ }
  }
}

/** Replace a section's draft (the Say it box). Returns the stored draft. */
export function setLogDraft<S extends LogSectionId>(section: S, value: LogDraftMap[S], said = ""): LogDraft<S> {
  seq += 1;
  const draft = { section, id: seq, at: Date.now(), said, value } as LogDraft<S>;
  drafts = { ...drafts, [section]: draft };
  emit();
  return draft;
}

/** Several sections at once (one Say it answer), one notification. Sections absent from `values` keep their draft. */
export function setLogDrafts(values: { [S in LogSectionId]?: LogDraftMap[S] }, said = ""): void {
  const next: Store = { ...drafts };
  let changed = false;
  for (const section of LOG_SECTIONS) {
    const value = values[section];
    if (value === undefined) continue;
    seq += 1;
    (next as Record<string, LogDraft>)[section] = { section, id: seq, at: Date.now(), said, value } as LogDraft;
    changed = true;
  }
  if (!changed) return;
  drafts = next;
  emit();
}

export function getLogDraft<S extends LogSectionId>(section: S): LogDraft<S> | null {
  return (drafts[section] as LogDraft<S> | undefined) ?? null;
}

/** Remove a section's draft; with `id`, only when it is still that draft (a newer one stays). */
export function clearLogDraft(section: LogSectionId, id?: number): void {
  const cur = drafts[section];
  if (!cur || (id !== undefined && cur.id !== id)) return;
  const next: Store = { ...drafts };
  delete next[section];
  drafts = next;
  emit();
}

export function clearAllLogDrafts(): void {
  if (Object.keys(drafts).length === 0) return;
  drafts = {};
  emit();
}

export function subscribeLogDrafts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const noDraft = () => null;

/**
 * A section's current draft (re-renders when it changes) and `clear(id?)`. Apply `draft.value` to the form as a
 * suggestion marked FROM_WHAT_YOU_SAID; call `clear(draft.id)` after the section's Save succeeded or on dismiss.
 */
export function useLogDrafts<S extends LogSectionId>(section: S): { draft: LogDraft<S> | null; clear: (id?: number) => void } {
  const draft = useSyncExternalStore(subscribeLogDrafts, () => getLogDraft(section), noDraft);
  const clear = useCallback((id?: number) => clearLogDraft(section, id), [section]);
  return { draft, clear };
}
