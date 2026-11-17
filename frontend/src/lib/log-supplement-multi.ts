/**
 * The /log Supplements "Log a product" selection (docs/agents/supplements.md "Supplements on /log"): Riley taps
 * several products, each gets its own amount + unit, the times and the day are shared, and ONE button logs them all,
 * one POST /api/supplements/log-product per product (the existing route, never a new write route). Pure and
 * import-free (tests/log-supplement-multi.test.cjs); the section holds the state and makes the requests.
 *
 * Replay safety lives here, in what the section is allowed to send:
 *   - an item whose answer CONFIRMED a save (`saved`, or `already`: the server skipped the same timed entry because
 *     it exists) is never sent again, so Retry / "Log selected" cannot write it twice;
 *   - an item whose answer never came (the request threw, a 5xx, an unreadable reply, or the server's own "may be
 *     saved" flag) is `unconfirmed`, NOT saved: it is not part of "Log selected", it waits for its own explicit
 *     "Log again" tap (the server's duplicate skip only knows a timed entry, so a blind re-send of an untimed
 *     "now" dose could write it twice);
 *   - only a definite refusal (a 4xx) is `refused` and goes out again with the rest.
 */

/** One dose row the server wrote (`logged` in the route's answer). */
export interface LoggedDose {
  intake_id: number;
  time: string | null;
}

export type Outcome =
  /** Sent (or queued behind others in this batch); the answer is not in yet. */
  | { kind: "saving" }
  /** Confirmed: the route answered ok with rows written. */
  | { kind: "saved"; label: string; doses: number; intakeDate: string | null; logged: LoggedDose[]; skipped: number }
  /** Confirmed: the route answered ok and every time of it already existed (its duplicate skip): nothing new written. */
  | { kind: "already"; label: string; intakeDate: string | null; skipped: number }
  /** Definitely not saved: the request was refused (a 4xx) or never sent (an amount that is not a number). */
  | { kind: "refused"; error: string }
  /** The answer was lost: the dose may or may not be saved. */
  | { kind: "unconfirmed"; error: string };

export interface SelectedItem {
  productId: string;
  /** The amount as typed: "" = one serving (the label's). */
  amount: string;
  /** "serving" | a weight / IU | the product's own count unit (lib/supplement-intake.ts dosesFor reads them). */
  unit: string;
  /** null = not sent yet. */
  outcome: Outcome | null;
}

export type Selection = readonly SelectedItem[];

export const EMPTY_SELECTION: Selection = [];
/** Requests in flight at once for one "Log selected" (the products are different, so the writes are independent). */
export const LOG_CONCURRENCY = 3;

export const isConfirmed = (o: Outcome | null | undefined): boolean => o?.kind === "saved" || o?.kind === "already";
export const isSaving = (o: Outcome | null | undefined): boolean => o?.kind === "saving";

/** The route's errors end with a hint for the chat model ("Ask which one."); on screen the picker is the answer. */
export const screenError = (msg: string): string => msg.replace(/\s*Ask (how many servings were taken|which one)\.?$/, "");

export const isSelected = (sel: Selection, productId: string): boolean => sel.some((i) => i.productId === productId);

/**
 * Tap on an option: a product not selected is added (one serving, nothing sent); a selected one is removed. An item
 * that is being saved stays (its answer is on its way); a confirmed one is removed from this list only (the dose
 * itself stays logged, it is under "Logged today" with Undo).
 */
export function toggleItem(sel: Selection, productId: string): Selection {
  const at = sel.findIndex((i) => i.productId === productId);
  if (at === -1) return [...sel, { productId, amount: "", unit: "serving", outcome: null }];
  if (isSaving(sel[at].outcome)) return sel;
  return sel.filter((_, i) => i !== at);
}

/**
 * Select a product with a dose already in (a Say it suggestion moved in with Edit). A product already waiting gets
 * the new dose; a confirmed one is replaced by a fresh entry (this is a new dose, the saved one stays logged); one
 * being saved is left alone.
 */
export function addWithDose(sel: Selection, productId: string, dose: { amount: string; unit: string }): Selection {
  const at = sel.findIndex((i) => i.productId === productId);
  const fresh: SelectedItem = { productId, amount: dose.amount, unit: dose.unit, outcome: null };
  if (at === -1) return [...sel, fresh];
  if (isSaving(sel[at].outcome)) return sel;
  return sel.map((i, k) => (k === at ? fresh : i));
}

/** Edit one item's amount and / or unit. Only an item that is still waiting can change (not one saved, saving or unconfirmed). */
export function setItemDose(sel: Selection, productId: string, patch: { amount?: string; unit?: string }): Selection {
  return sel.map((i) => {
    if (i.productId !== productId) return i;
    const kind = i.outcome?.kind;
    if (kind === "saved" || kind === "already" || kind === "saving" || kind === "unconfirmed") return i;
    // A refusal belongs to the dose it answered: a changed dose starts again without it.
    return { ...i, amount: patch.amount ?? i.amount, unit: patch.unit ?? i.unit, outcome: null };
  });
}

/** An amount field: "" = one serving (null), else a positive finite number; anything else is "invalid". */
export function parseAmount(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : "invalid";
}

/**
 * What "Log selected" sends: every item not sent yet or refused. Never a confirmed item (replay safety), never one
 * being saved, and an unconfirmed one only when `includeUnconfirmed` and it is named in `only` (its own "Log again").
 */
export function sendable(sel: Selection, opts: { only?: readonly string[]; includeUnconfirmed?: boolean } = {}): SelectedItem[] {
  return sel.filter((i) => {
    if (opts.only && !opts.only.includes(i.productId)) return false;
    const kind = i.outcome?.kind;
    if (kind === undefined || kind === "refused") return true;
    return kind === "unconfirmed" && !!opts.includeUnconfirmed && !!opts.only;
  });
}

/** The N of "Log selected (N)": what a plain tap would send. */
export const countToLog = (sel: Selection): number => sendable(sel).length;

/** Queue `ids` for sending (their outcome becomes "saving") and record `bad` ids as refused without sending them. */
export function beginSend(sel: Selection, ids: readonly string[], bad: ReadonlyMap<string, string> = new Map()): Selection {
  return sel.map((i) => {
    if (bad.has(i.productId)) return { ...i, outcome: { kind: "refused", error: bad.get(i.productId)! } };
    if (ids.includes(i.productId)) return { ...i, outcome: { kind: "saving" } };
    return i;
  });
}

/** An answer arrives for `productId`: kept only while that item is still waiting for it (never over another outcome). */
export function settle(sel: Selection, productId: string, outcome: Outcome): Selection {
  return sel.map((i) => (i.productId === productId && isSaving(i.outcome) ? { ...i, outcome } : i));
}

/** The dose of a saved item was removed (Undo): it is waiting again, with its amount and unit as they were. */
export function undone(sel: Selection, productId: string): Selection {
  return sel.map((i) => (i.productId === productId && i.outcome?.kind === "saved" ? { ...i, outcome: null } : i));
}

/** Undo removed only some of a saved item's rows: it keeps the ones still logged. */
export function keepLogged(sel: Selection, productId: string, stillLogged: readonly number[]): Selection {
  return sel.map((i) => {
    if (i.productId !== productId || i.outcome?.kind !== "saved") return i;
    const logged = i.outcome.logged.filter((l) => stillLogged.includes(l.intake_id));
    return logged.length ? { ...i, outcome: { ...i.outcome, logged } } : { ...i, outcome: null };
  });
}

export interface SelectionSummary {
  waiting: number;
  saving: number;
  saved: number;
  already: number;
  refused: number;
  unconfirmed: number;
}

export function summarize(sel: Selection): SelectionSummary {
  const s: SelectionSummary = { waiting: 0, saving: 0, saved: 0, already: 0, refused: 0, unconfirmed: 0 };
  for (const i of sel) {
    const kind = i.outcome?.kind;
    if (kind === undefined) s.waiting += 1;
    else s[kind] += 1;
  }
  return s;
}

/** "2 saved, 1 not saved" for the line under the list; "" while nothing was sent. */
export function summaryText(sum: SelectionSummary): string {
  const parts: string[] = [];
  if (sum.saved) parts.push(`${sum.saved} saved`);
  if (sum.already) parts.push(`${sum.already} already logged`);
  if (sum.refused) parts.push(`${sum.refused} not saved`);
  if (sum.unconfirmed) parts.push(`${sum.unconfirmed} not confirmed`);
  return parts.join(", ");
}

// ---- reading the route's answer ----

/** What the section got back from one POST: null when the request itself threw (no answer at all). */
export interface Answer {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

/**
 * One POST /api/supplements/log-product answer as an outcome. Only a definite answer settles it:
 *   ok with rows       -> saved;  ok with every time already there -> already;
 *   4xx (not 408)      -> refused (the route wrote nothing);
 * anything else is unconfirmed: no answer, 5xx, 408, the server's own `incomplete` flag (its insert may have
 * committed), or a 2xx that does not say ok with rows. `name` is the label to use when the answer names none.
 */
export function outcomeFromAnswer(answer: Answer | null, name: string): Outcome {
  if (!answer) return { kind: "unconfirmed", error: "No answer from Onyx" };
  const j = answer.json ?? {};
  if (j.incomplete === true) return { kind: "unconfirmed", error: "Onyx did not confirm it" };
  if (answer.ok && j.ok === true) {
    const logged = Array.isArray(j.logged)
      ? (j.logged as unknown[])
          .map((x) => x as Partial<LoggedDose> | null)
          .filter((x): x is LoggedDose => !!x && typeof x.intake_id === "number")
          .map((x) => ({ intake_id: x.intake_id, time: typeof x.time === "string" ? x.time : null }))
      : [];
    const skipped = Array.isArray(j.skipped_duplicates) ? j.skipped_duplicates.length : 0;
    const label = typeof j.product === "string" && j.product ? j.product : name;
    const intakeDate = typeof j.intake_date === "string" ? j.intake_date : null;
    if (logged.length > 0) return { kind: "saved", label, doses: Number(j.doses_each ?? 1), intakeDate, logged, skipped };
    if (skipped > 0) return { kind: "already", label, intakeDate, skipped };
    return { kind: "unconfirmed", error: "Onyx answered without a saved dose" };
  }
  if (answer.status >= 500 || answer.status === 408 || answer.status < 400) {
    return { kind: "unconfirmed", error: `Onyx did not confirm it (${answer.status})` };
  }
  const msg = typeof j.error === "string" && j.error ? screenError(j.error) : `Not saved (${answer.status})`;
  const cands =
    Array.isArray(j.candidates) && j.candidates.length > 1 && j.candidates.length <= 6 ? ` (${(j.candidates as string[]).join(", ")})` : "";
  return { kind: "refused", error: msg + cands };
}

/** Run `work` over `items` with at most `size` in flight at once; resolves when every item has finished. */
export async function runPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane));
}
