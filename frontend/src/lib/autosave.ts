/**
 * Autosave (Riley, 2026-11-15: "Onyx should autosave when I input data"). One small scheduler every form uses
 * instead of a Save button: a tap saves at once (short delay so a burst of taps is one request), typing saves after
 * a pause and when the field is left, and leaving the page saves what is still waiting.
 *
 * Rules:
 *  - change(value) replaces whatever is waiting; only the newest value is ever sent (single flight: while one save
 *    is under way the next waits, then sends the newest value if it still differs from what was saved).
 *  - A value equal to the last saved one (`same`, JSON by default) sends nothing.
 *  - `ready(value)` false = incomplete or invalid: nothing is sent, the status is "incomplete" (the form says why).
 *  - change(value, {delayMs: null}) waits for flush() (blur / Enter / page hidden) instead of a timer: for a value
 *    that may still be mid-typing (a weight that looks implausible, a journal entry's first words).
 *  - A save that throws AutosaveRefused (the server refused the value: 4xx) shows its message and is not retried
 *    until the value changes. Any other failure (offline, 5xx) is retried with backoff and shown as "not saved".
 *  - `unknownOutcome(error)` true = that failure may have stored the value anyway (no clear answer came back). Until
 *    a save succeeds (or reset / setBaseline say what is stored), no value counts as already saved: changing back to
 *    the last saved value is then sent too, instead of being dropped as "unchanged" while the server may hold the
 *    value whose answer was lost. Off by default (a form opts in when its server can tell such a failure apart).
 * No React, no DOM: unit-tested in tests/autosave.test.cjs. React: lib/use-autosave.ts; status line:
 * components/AutosaveStatus.tsx.
 */

export type AutosaveStatus = "idle" | "incomplete" | "waiting" | "saving" | "saved" | "error";

export interface AutosaveState {
  status: AutosaveStatus;
  /** Why the last save failed (error) or why nothing is sent (incomplete, from ready()). */
  error: string | null;
  /** True when the failure will be retried on its own (offline / server error). */
  retrying: boolean;
  /** When the server last accepted a value (ms). */
  savedAt: number | null;
}

/** The server refused this value (validation, conflict): shown, not retried until the value changes. */
export class AutosaveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutosaveRefused";
  }
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface AutosaverOptions<T> {
  /** Writes the value. Throw AutosaveRefused for a refusal, anything else for a failure worth retrying. */
  save: (value: T, ctx: { keepalive: boolean }) => Promise<void>;
  /** Delay after a change before saving (ms). Default 800. */
  delayMs?: number;
  /** null/undefined = ready to send; a string = not ready, shown as the reason. */
  ready?: (value: T) => string | null | undefined;
  same?: (a: T, b: T) => boolean;
  onState?: (s: AutosaveState) => void;
  /** Backoff for retryable failures. Default 2 s, 5 s, 15 s, then every 30 s. */
  retryDelaysMs?: number[];
  /**
   * True when this (non-refusal) failure may have stored the value anyway: the stored value is then unknown, so a
   * change back to the last saved value is sent rather than dropped (see the rules above). Default: never.
   */
  unknownOutcome?: (error: unknown) => boolean;
  timers?: Timers;
  now?: () => number;
}

const jsonSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function messageOf(e: unknown): string {
  if (e instanceof TypeError) return "Couldn't reach Onyx.";
  if (e instanceof Error && e.message) return e.message;
  return "Save failed.";
}

/**
 * The usual fetch wrapper for a save: a 4xx answer is a refusal (its `error` text), a 5xx or a network failure is
 * retried. Returns the parsed JSON body of a successful answer.
 */
export async function saveRequest(url: string, init: { method: string; body?: unknown; keepalive?: boolean }): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    keepalive: init.keepalive,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return json;
  const text = typeof json.error === "string" && json.error ? json.error : `Save failed (${res.status}).`;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new AutosaveRefused(text);
  throw new Error(text);
}

export class Autosaver<T> {
  private opts: AutosaverOptions<T>;
  private timers: Timers;
  private latest: { value: T; manual?: boolean } | null = null;
  private saved: { value: T } | null;
  private refused: { value: T } | null = null;
  /** A save failed with an unknown outcome (unknownOutcome): the server may hold that value instead of `saved`. */
  private unconfirmed = false;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private retries = 0;
  private inflight: Promise<void> | null = null;
  private disposed = false;
  state: AutosaveState = { status: "idle", error: null, retrying: false, savedAt: null };

  /** `baseline` = what is already stored, so changing back to it sends nothing. */
  constructor(opts: AutosaverOptions<T>, baseline?: T) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers;
    this.saved = baseline === undefined ? null : { value: baseline };
  }

  /** Replace the save function and other options (React re-renders) without losing what is waiting. */
  update(opts: AutosaverOptions<T>): void {
    this.opts = { ...opts, timers: this.timers };
  }

  private same(a: T, b: T): boolean {
    return (this.opts.same ?? jsonSame)(a, b);
  }

  /** `value` is known to be what the server holds (never while an earlier save's outcome is unknown). */
  private isSaved(value: T): boolean {
    return !!this.saved && !this.unconfirmed && this.same(value, this.saved.value);
  }

  private set(next: Partial<AutosaveState>): void {
    this.state = { ...this.state, ...next };
    this.opts.onState?.(this.state);
  }

  private clearTimers(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /** True while anything is not saved yet (waiting, saving, failed, or incomplete input). */
  get dirty(): boolean {
    const s = this.state.status;
    return s === "waiting" || s === "saving" || s === "error" || s === "incomplete";
  }

  /** What the server holds now (after loading fresh data). Nothing is sent; a waiting equal value is dropped. */
  setBaseline(value: T): void {
    this.saved = { value };
    this.unconfirmed = false; // fresh data says what is stored
    if (this.latest && this.same(this.latest.value, value) && !this.inflight) {
      this.clearTimers();
      this.latest = null;
      if (this.state.status !== "saved") this.set({ status: "idle", error: null, retrying: false });
    }
  }

  /**
   * Forget everything waiting (the form was reset on purpose: a new entry, an Undo, a removal). The last saved value
   * is forgotten too unless `baseline` says what the server holds now, so typing the same value again is sent.
   */
  reset(baseline?: T): void {
    this.clearTimers();
    this.latest = null;
    this.refused = null;
    this.unconfirmed = false;
    this.retries = 0;
    this.saved = baseline === undefined ? null : { value: baseline };
    this.set({ status: "idle", error: null, retrying: false });
  }

  /** A new value from the form. */
  change(value: T, opts?: { delayMs?: number | null }): void {
    if (this.disposed) return;
    const delay = opts && "delayMs" in opts ? opts.delayMs : (this.opts.delayMs ?? 800);
    this.latest = { value, manual: delay === null || delay === undefined };
    this.clearTimers();
    this.retries = 0;
    const why = this.opts.ready?.(value);
    if (why) {
      this.set({ status: "incomplete", error: why, retrying: false });
      return;
    }
    if (this.isSaved(value)) {
      if (!this.inflight) {
        this.latest = null;
        this.set({ status: this.state.savedAt ? "saved" : "idle", error: null, retrying: false });
      }
      return;
    }
    if (this.refused && this.same(value, this.refused.value)) return; // still the refused value: keep its message
    this.refused = null;
    if (!this.inflight) this.set({ status: "waiting", error: null, retrying: false });
    if (delay === null || delay === undefined) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /**
   * Save now whatever is waiting (blur, Enter, page hidden). Resolves when nothing is left in flight: true when
   * nothing is left unsaved (false after a failure, or with incomplete input), so a caller about to clear the form
   * (New entry, switching items) can keep it instead of dropping an edit.
   */
  async flush(keepalive = false): Promise<boolean> {
    await this.send(keepalive);
    return !this.dirty;
  }

  private async send(keepalive: boolean): Promise<void> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    let waited = false;
    while (this.inflight) {
      waited = true;
      await this.inflight;
    }
    // The save this flush waited on just failed: its retry timer (or Retry) sends again, not this flush at once.
    if (waited && this.state.status === "error") return;
    const next = this.latest;
    if (!next || this.disposed) return;
    if (this.opts.ready?.(next.value)) return;
    if (this.isSaved(next.value)) {
      this.latest = null;
      return;
    }
    if (this.refused && this.same(next.value, this.refused.value)) return;
    if (this.retryTimer !== null) {
      this.timers.clear(this.retryTimer);
      this.retryTimer = null;
    }
    this.inflight = this.run(next.value, keepalive);
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    // A change made while saving: send it too (its own timer may already have fired into the wait above).
    // A value that waits for flush() (delayMs: null) stays waiting.
    const after = this.latest;
    if (after && after !== next && !after.manual && this.timer === null && this.retryTimer === null && this.state.status !== "error") {
      await this.send(keepalive);
    }
  }

  /** Try again now after a failure. Same answer as flush(). */
  retry(): Promise<boolean> {
    this.refused = null;
    this.retries = 0;
    return this.flush();
  }

  private async run(value: T, keepalive: boolean): Promise<void> {
    this.set({ status: "saving", error: null, retrying: false });
    try {
      await this.opts.save(value, { keepalive });
      if (this.disposed) return;
      this.saved = { value };
      this.unconfirmed = false;
      this.retries = 0;
      const changed = !!this.latest && !this.same(this.latest.value, value);
      if (!changed) this.latest = null;
      this.set({ status: changed ? "waiting" : "saved", error: null, retrying: false, savedAt: (this.opts.now ?? Date.now)() });
    } catch (e) {
      if (this.disposed) return;
      if (e instanceof AutosaveRefused) {
        this.refused = { value };
        this.set({ status: "error", error: messageOf(e), retrying: false });
        return;
      }
      // The value may be stored even though this failed: from now on nothing counts as already saved (isSaved).
      if (this.opts.unknownOutcome?.(e)) this.unconfirmed = true;
      const delays = this.opts.retryDelaysMs ?? [2000, 5000, 15000, 30000];
      const wait = delays[Math.min(this.retries, delays.length - 1)];
      this.retries += 1;
      this.set({ status: "error", error: messageOf(e), retrying: true });
      this.retryTimer = this.timers.set(() => {
        this.retryTimer = null;
        void this.flush();
      }, wait);
    }
  }

  /** Stop timers (call flush(true) first to send what is waiting). */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  /**
   * Undo dispose() for a saver with nothing unsaved (lib/autosave-retain.ts: a form let go as clean is taken back by
   * the component that already holds it). Its last saved value stays its baseline. No-op while anything is unsaved.
   */
  revive(): void {
    if (!this.dirty) this.disposed = false;
  }
}
