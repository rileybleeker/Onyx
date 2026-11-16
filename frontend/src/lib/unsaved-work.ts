/**
 * Unsaved work the automatic updater must never throw away (Onyx#326, Riley 2026-11-15).
 * Focus alone was the old rule (lib/app-update.ts isBusy): type a journal paragraph, tap a button, and the next
 * update check reloaded the page and lost the words. This registry keeps the protection after blur:
 *  - forms say when they hold unsaved edits (setDirty / the useUnsavedWork hook) and clear it on save or discard;
 *  - every write the page sends (fetch with a method other than GET/HEAD) counts as pending until it settles;
 *  - as a safety net for forms that never registered, text typed into a field counts as unsaved while that field
 *    is still on the page and not empty, until a write succeeds after the typing.
 * While any of these holds, the updater shows its "Update ready" button instead of reloading.
 * The continuous scroll asks the same registry per page (hasIn): a page of the scroll holding unsaved work is never
 * unmounted for being far from the screen (PROD-T01), so its entry, focus and pending retry stay.
 * No React, no DOM globals at import time; unit-tested in tests/unsaved-work.test.cjs.
 */

/** The page of the scroll a typed field sits in: the nearest element carrying data-feed-route. */
type FeedSection = { getAttribute?: (name: string) => string | null };
type Field = {
  isConnected?: boolean;
  value?: unknown;
  textContent?: string | null;
  isContentEditable?: boolean;
  closest?: (selector: string) => FeedSection | null;
};

/** The attribute every page of the continuous scroll carries (components/ContinuousScroll.tsx). */
export const FEED_ROUTE_ATTR = "data-feed-route";

export class UnsavedWork {
  /** Registered forms with unsaved edits: key -> the page of the scroll they are drawn in (null: the routed page). */
  private dirty = new Map<string, string | null>();
  private pending = 0;
  private typed = new Set<Field>();
  private typedSeq = 0;
  private listeners = new Set<() => void>();

  /**
   * A form reports whether it holds edits that are not saved yet. `scope` = the page of the continuous scroll it is
   * drawn in ("/log"), null on the routed page or outside the scroll.
   */
  setDirty(key: string, isDirty: boolean, scope: string | null = null): void {
    const had = this.dirty.has(key);
    const before = had ? this.dirty.get(key) ?? null : undefined;
    if (isDirty) this.dirty.set(key, scope);
    else this.dirty.delete(key);
    const after = isDirty ? scope : undefined;
    if (before !== after) this.notify();
  }

  /** Called whenever a registered form becomes dirty or clean (not on every keystroke). Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* a listener's failure never stops another form from reporting */
      }
    }
  }

  /** A write started; call the returned function exactly once when it settles. ok = the server accepted it. */
  writeStarted(): (ok: boolean) => void {
    this.pending += 1;
    const seq = this.typedSeq;
    let done = false;
    return (ok: boolean) => {
      if (done) return;
      done = true;
      this.pending = Math.max(0, this.pending - 1);
      // A successful write after the last keystroke means that typing was saved (or sent somewhere on purpose).
      if (ok && seq === this.typedSeq) this.typed.clear();
    };
  }

  /** Text typed into a field the page did not register. */
  noteTyping(field: Field): void {
    this.typed.add(field);
    this.typedSeq += 1;
  }

  /** True while anything on the page would be lost by a reload. */
  has(): boolean {
    if (this.dirty.size > 0 || this.pending > 0) return true;
    for (const f of this.typedFields()) if (f) return true;
    return false;
  }

  /**
   * True while the page `scope` of the continuous scroll holds unsaved work: a registered form drawn in it, or text
   * typed into one of its fields that no write has saved yet. Writes in flight are not tied to a page (the page's
   * own form stays dirty until its save is acknowledged).
   */
  hasIn(scope: string): boolean {
    for (const s of this.dirty.values()) if (s === scope) return true;
    for (const f of this.typedFields()) {
      let section: FeedSection | null = null;
      try {
        section = typeof f.closest === "function" ? f.closest(`[${FEED_ROUTE_ATTR}]`) : null;
      } catch {
        section = null;
      }
      if (section && typeof section.getAttribute === "function" && section.getAttribute(FEED_ROUTE_ATTR) === scope) return true;
    }
    return false;
  }

  /** Typed fields still on the page and not empty (others are forgotten as they are found). */
  private *typedFields(): Generator<Field> {
    for (const f of [...this.typed]) {
      if (f.isConnected === false) {
        this.typed.delete(f);
        continue;
      }
      const v = f.isContentEditable ? (f.textContent ?? "") : typeof f.value === "string" ? f.value : "";
      if (v.trim()) {
        yield f;
        continue;
      }
      this.typed.delete(f); // emptied again: nothing to lose
    }
  }
}

export const unsavedWork = new UnsavedWork();

/** Text-like fields only: checkboxes, selects and sliders save on change and lose nothing worth a prompt. */
export function isTextField(el: unknown): el is Field {
  const e = el as { tagName?: string; type?: string; isContentEditable?: boolean; dataset?: Record<string, string | undefined> } | null;
  if (!e || typeof e.tagName !== "string") return false;
  if (e.dataset && e.dataset.unsavedIgnore !== undefined) return false;
  const tag = e.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const t = (e.type || "text").toLowerCase();
    return ["text", "email", "number", "tel", "url", "date", "time", "datetime-local"].includes(t);
  }
  return !!e.isContentEditable;
}

function isWrite(input: unknown, init?: { method?: string }): boolean {
  const fromRequest = typeof input === "object" && input !== null && "method" in input ? String((input as { method?: string }).method) : undefined;
  const method = (init?.method ?? fromRequest ?? "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD";
}

type Win = {
  fetch: (input: never, init?: never) => Promise<{ ok: boolean }>;
  document: { addEventListener(type: string, fn: (ev: { target: unknown }) => void, capture?: boolean): void };
};

const installed = new WeakSet<object>();

/** Count the page's writes and note typing. Idempotent per window. */
export function trackUnsavedWork(win: Win, work: UnsavedWork = unsavedWork): void {
  if (installed.has(win)) return;
  installed.add(win);
  const original = win.fetch.bind(win) as (input: unknown, init?: { method?: string }) => Promise<{ ok: boolean }>;
  win.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (!isWrite(input, init)) return original(input, init);
    const settle = work.writeStarted();
    try {
      const res = await original(input, init);
      settle(!!res?.ok);
      return res;
    } catch (e) {
      settle(false);
      throw e;
    }
  }) as Win["fetch"];
  win.document.addEventListener(
    "input",
    (ev) => {
      if (isTextField(ev.target)) work.noteTyping(ev.target);
    },
    true,
  );
}
