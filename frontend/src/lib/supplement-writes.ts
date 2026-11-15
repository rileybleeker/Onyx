// Write receipts for /supplements (Codex review #191, UI item 1). Pure: no React, no fetch.
//
// The page used to say "logged" before the POST answered and only printed failures to the console, and the
// stack "undo all" cleared its bar before the deletes ran and never looked at their answers. The rules here:
// - A write is "saving" until the server answers; only an OK answer makes it "saved".
// - A failed write stays on screen as "failed" with its request kept, so Retry re-sends exactly the same thing.
// - Before Retry re-sends, the page reads today's intakes: a request whose answer never arrived may still
//   have been written. A row that matches it (same product, or same stack, same day and same clock instant)
//   and that was not on screen when the request was sent, nor claimed by another write, is adopted as that
//   write's row instead of writing a second one. A write without a clock time cannot be matched this way.
// - A batch undo removes only what the server confirmed; the rest stays listed for another try.

export type WriteStatus = "saving" | "saved" | "failed";

/** One write the page started: one product, or a whole stack. */
export interface SupplementWrite {
  id: string; // client-side id
  kind: "intake" | "stack";
  label: string; // product or stack name, for the receipt
  date: string; // intake_date sent
  time: string | null; // intake_time sent (ISO) or null = no clock time
  productId: string | null; // kind "intake"
  stackName: string | null; // kind "stack" (its rows carry the note "Logged from stack: <name>")
  body: Record<string, unknown>; // the POST body, re-sent by Retry
  knownIds: number[]; // intake ids on screen when the request was first sent
  status: WriteStatus;
  savedIds: number[]; // intake ids the server confirmed (or adopted)
  error: string | null;
}

/** The fields of an intake row this module reads. */
export interface IntakeRowLike {
  intake_id: number;
  intake_date: string;
  intake_time: string | null;
  product_id: string;
  notes: string | null;
}

export const stackNote = (name: string) => `Logged from stack: ${name}`;

const instant = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function newWrite(args: {
  id: string;
  kind: "intake" | "stack";
  label: string;
  date: string;
  time: string | null;
  productId?: string | null;
  stackName?: string | null;
  body: Record<string, unknown>;
  knownIds: number[];
}): SupplementWrite {
  return {
    id: args.id,
    kind: args.kind,
    label: args.label,
    date: args.date,
    time: args.time,
    productId: args.productId ?? null,
    stackName: args.stackName ?? null,
    body: args.body,
    knownIds: [...args.knownIds],
    status: "saving",
    savedIds: [],
    error: null,
  };
}

/** Replace one write (by id); the list keeps its order. */
export function updateWrite(list: SupplementWrite[], id: string, patch: Partial<SupplementWrite>): SupplementWrite[] {
  return list.map((w) => (w.id === id ? { ...w, ...patch } : w));
}

/** Ids already accounted for by some write: never adopt them for another one. */
export function claimedIds(list: SupplementWrite[], except?: string): Set<number> {
  const out = new Set<number>();
  for (const w of list) if (w.id !== except) for (const i of w.savedIds) out.add(i);
  return out;
}

/**
 * The rows that are this write's saved copy, if the server wrote it although its answer never arrived.
 * Empty when nothing matches, or when the write has no clock time (nothing to match on).
 */
export function findSavedCopy(write: SupplementWrite, rows: IntakeRowLike[], claimed: Set<number>): number[] {
  const t = instant(write.time);
  if (t === null) return [];
  const known = new Set(write.knownIds);
  const matches = rows.filter((r) =>
    !known.has(r.intake_id) &&
    !claimed.has(r.intake_id) &&
    r.intake_date === write.date &&
    instant(r.intake_time) === t &&
    (write.kind === "intake" ? r.product_id === write.productId : r.notes === stackNote(write.stackName ?? "")),
  );
  // One intake write is one row; a stack write is all of its rows.
  return write.kind === "intake" ? matches.slice(0, 1).map((r) => r.intake_id) : matches.map((r) => r.intake_id);
}

/** What the receipt says. Success is a word plus the up color in the page, never the accent. */
export function receiptText(w: SupplementWrite, today: string, shortDate: (ymd: string) => string): string {
  const when = w.date === today ? "today" : shortDate(w.date);
  if (w.status === "saving") return `Saving ${w.label}…`;
  if (w.status === "saved") return `Saved ${w.label} · ${when}`;
  return `Not saved: ${w.label} · ${when}`;
}

/** Result of one batch-undo attempt: which deletes the server confirmed, and which must be tried again. */
export function batchUndoResult(ids: number[], ok: boolean[]): { removed: number[]; failed: number[] } {
  const removed: number[] = [];
  const failed: number[] = [];
  ids.forEach((id, i) => (ok[i] ? removed : failed).push(id));
  return { removed, failed };
}
