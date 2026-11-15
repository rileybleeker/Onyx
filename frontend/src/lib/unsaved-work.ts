/**
 * Unsaved work the automatic updater must never throw away (Onyx#326, Riley 2026-11-15).
 * Focus alone was the old rule (lib/app-update.ts isBusy): type a journal paragraph, tap a button, and the next
 * update check reloaded the page and lost the words. This registry keeps the protection after blur:
 *  - forms say when they hold unsaved edits (setDirty / the useUnsavedWork hook) and clear it on save or discard;
 *  - every write the page sends (fetch with a method other than GET/HEAD) counts as pending until it settles;
 *  - as a safety net for forms that never registered, text typed into a field counts as unsaved while that field
 *    is still on the page and not empty, until a write succeeds after the typing.
 * While any of these holds, the updater shows its "Update ready" button instead of reloading.
 * No React, no DOM globals at import time; unit-tested in tests/unsaved-work.test.cjs.
 */

type Field = { isConnected?: boolean; value?: unknown; textContent?: string | null; isContentEditable?: boolean };

export class UnsavedWork {
  private dirty = new Set<string>();
  private pending = 0;
  private typed = new Set<Field>();
  private typedSeq = 0;

  /** A form reports whether it holds edits that are not saved yet. */
  setDirty(key: string, isDirty: boolean): void {
    if (isDirty) this.dirty.add(key);
    else this.dirty.delete(key);
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
    for (const f of [...this.typed]) {
      if (f.isConnected === false) {
        this.typed.delete(f);
        continue;
      }
      const v = f.isContentEditable ? (f.textContent ?? "") : typeof f.value === "string" ? f.value : "";
      if (v.trim()) return true;
      this.typed.delete(f); // emptied again: nothing to lose
    }
    return false;
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
