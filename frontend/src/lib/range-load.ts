// Which range the data on a dashboard belongs to (Codex review #191, UI item 4). Pure: no React, no fetch.
//
// The dashboards used to relabel themselves with the newly picked range at once, while the charts still
// held the old range's rows; when that load failed, the old rows stayed under the new label. Here the range
// that was ASKED for and the range that is SHOWN are kept apart:
// - `shown`   the range of the rows on screen; every label and "N days avg" note uses it.
// - `pending` the range being loaded (the picker shows it as selected meanwhile), or null.
// - `failed`  the range whose last load failed (cleared by the next load), or null.
// Every load gets a sequence number; only the newest load's answer moves the view, so a slow answer for an
// old range can never land under a newer range's label.

export interface RangeView<R extends string> {
  shown: R;
  pending: R | null;
  failed: R | null;
  seq: number;
}

export function rangeView<R extends string>(initial: R): RangeView<R> {
  return { shown: initial, pending: null, failed: null, seq: 0 };
}

/** A load started. `silent` = a background revalidation of what is shown (no "Loading" hint). */
export function startRange<R extends string>(v: RangeView<R>, range: R, seq: number, silent = false): RangeView<R> {
  return { shown: v.shown, pending: silent ? null : range, failed: null, seq };
}

/** A load answered. Ignored unless it is the newest load. */
export function finishRange<R extends string>(v: RangeView<R>, seq: number, range: R, ok: boolean): RangeView<R> {
  if (seq !== v.seq) return v;
  return ok ? { shown: range, pending: null, failed: null, seq } : { shown: v.shown, pending: null, failed: range, seq };
}

/** The picker's selected value: what is loading, else what is shown (after a failure, what is still shown). */
export function selectedRange<R extends string>(v: RangeView<R>): R {
  return v.pending ?? v.shown;
}

/** The status line next to the picker, or null when the shown rows are the asked-for range. */
export function rangeStatus<R extends string>(v: RangeView<R>, label: (r: R) => string): { tone: "loading" | "error"; text: string } | null {
  if (v.pending !== null) return { tone: "loading", text: `Loading ${label(v.pending)}…` };
  if (v.failed !== null) {
    return {
      tone: "error",
      text: v.failed === v.shown ? `Couldn't refresh ${label(v.failed)}.` : `Couldn't load ${label(v.failed)}. Showing ${label(v.shown)}.`,
    };
  }
  return null;
}
