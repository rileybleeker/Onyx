/**
 * Autosaving forms that outlive their component (PROD-T01, 2026-11-16). A Log section is unmounted when Riley navigates
 * away, hides or moves its part, or the continuous scroll drops the page around it; before this its form state and
 * its autosaver went with it: an incomplete entry was gone, and a save that failed offline was sent once more and then
 * dropped, without a word. A retained form keeps three things together, by name:
 *  - the Autosaver (lib/autosave.ts) with what is waiting, the failure and its retry timer;
 *  - `data`: the form's own state the component reads and writes (fields, the row it made, the operation key of a
 *    create), so a remount shows the same entry and a retry sends the same key (one event, never two);
 *  - the listeners of the component(s) showing it.
 * Rules:
 *  - When the last copy unmounts, what is waiting is sent once (keepalive). If the form is then clean (saved, or
 *    nothing entered) it is forgotten. Otherwise it is KEPT: it stays registered as unsaved work (the updater never
 *    reloads over it), a failure worth retrying keeps retrying on its own timer, and the next copy of the component
 *    takes it over (state, data and all). A kept form that becomes clean while nobody shows it (a retry got through)
 *    is forgotten then.
 *  - Taking a form over never sends anything (opening or scrolling never saves).
 *  - Memory only: nothing is written to storage, so a reload forgets it. A session end forgets it too, also without a
 *    reload: every wipe of the client's data (sign-out, a 401, a load without a session: wipeClientData in
 *    lib/client-cache.ts) fires CLIENT_WIPE_EVENT, and every kept form (and every copy still on screen) is dropped
 *    with its retry timer stopped; a save under way stops at its next step (RetainedSaveContext.cancelled), and an
 *    unmount whose send was pending then registers nothing.
 *    Bounded: one form per name, at most MAX_RETAINED names; a copy beyond that, or a second copy shown at the same
 *    time as the first, is not kept past its component.
 * No React, no DOM; React side in lib/use-autosave.ts (useRetainedAutosave). Unit-tested in tests/autosave-retain.test.cjs.
 */
import { Autosaver, type AutosaveState, type AutosaverOptions, type Timers } from "./autosave";
import { unsavedWork as defaultWork, type UnsavedWork } from "./unsaved-work";

export const MAX_RETAINED = 8;

/**
 * What a retained form's save gets. `cancelled()` turns true once the form was let go while the save ran (the session
 * ended: CLIENT_WIPE_EVENT). A save checks it after every await and stops there: no further request (a replay's
 * follow-up PATCH), no write to the form's data, no refetch into a cache that was just wiped.
 */
export type RetainedSaveContext = { keepalive: boolean; cancelled: () => boolean };
export type RetainedSave<T> = (value: T, ctx: RetainedSaveContext) => Promise<void>;

/** What the component showing the form supplies on every render (the latest closures are always used). */
export type FormSource<T> = Pick<AutosaverOptions<T>, "ready" | "same"> & { save: RetainedSave<T> };

export type RetainOptions<T> = Omit<AutosaverOptions<T>, "onState" | "save"> & { save: RetainedSave<T> };

const jsonSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class RetainedForm<T, D> {
  readonly saver: Autosaver<T>;
  /** The options of the component showing the form now (the last one while none is mounted). */
  source: () => FormSource<T>;
  readonly listeners = new Set<(s: AutosaveState) => void>();
  mounts = 0;
  /** Let go (forgotten when clean, or dropped at session end): its saver is disposed and a save under way stops. */
  released = false;

  constructor(
    readonly name: string,
    readonly data: D,
    opts: RetainOptions<T>,
    baseline: T | undefined,
    onState: (form: RetainedForm<T, D>, s: AutosaveState) => void,
    defaults: { timers?: Timers; now?: () => number },
  ) {
    this.source = () => opts;
    this.saver = new Autosaver<T>(
      {
        save: (v, ctx) => this.source().save(v, { keepalive: ctx.keepalive, cancelled: () => this.released }),
        ready: (v) => this.source().ready?.(v),
        same: (a, b) => (this.source().same ?? jsonSame)(a, b),
        delayMs: opts.delayMs,
        retryDelaysMs: opts.retryDelaysMs,
        timers: opts.timers ?? defaults.timers,
        now: opts.now ?? defaults.now,
        onState: (s) => onState(this, s),
      },
      baseline,
    );
  }
}

export class FormRetainer {
  private forms = new Map<string, RetainedForm<unknown, unknown>>();
  /** Every form a component shows now, kept or not (a copy beyond the bound): a session end stops these too. */
  private shown = new Set<RetainedForm<unknown, unknown>>();
  private work: UnsavedWork;
  private max: number;
  private defaults: { timers?: Timers; now?: () => number };

  constructor(deps: { work?: UnsavedWork; max?: number; timers?: Timers; now?: () => number } = {}) {
    this.work = deps.work ?? defaultWork;
    this.max = deps.max ?? MAX_RETAINED;
    this.defaults = { timers: deps.timers, now: deps.now };
  }

  /** The unsaved-work key of a kept form nobody shows (the component registers its own while mounted). */
  static keyOf(name: string): string {
    return `retained:${name}`;
  }

  /** The form an earlier copy of this component left (or the copy shown now), else null. No side effect. */
  find<T, D>(name: string): RetainedForm<T, D> | null {
    return (this.forms.get(name) as RetainedForm<T, D> | undefined) ?? null;
  }

  /** A new form. Not kept anywhere until a component shows it (attach): a discarded render leaves nothing behind. */
  create<T, D>(name: string, data: D, opts: RetainOptions<T>, baseline?: T): RetainedForm<T, D> {
    return new RetainedForm<T, D>(name, data, opts, baseline, (form, s) => this.stateChanged(form, s), this.defaults);
  }

  /** A component shows the form (mount). The first copy of a name is the one a remount takes over. */
  attach<T, D>(form: RetainedForm<T, D>, listener: (s: AutosaveState) => void): void {
    form.mounts += 1;
    form.listeners.add(listener);
    this.shown.add(form as RetainedForm<unknown, unknown>);
    const cur = this.forms.get(form.name);
    if (this.owns(form)) {
      // Shown again: the component reports its own unsaved work while it is mounted.
      this.work.setDirty(FormRetainer.keyOf(form.name), false);
      return;
    }
    // A form already let go (the session ended while a copy still held it) is never kept again.
    if (!cur && !form.released && this.forms.size < this.max) this.forms.set(form.name, form as RetainedForm<unknown, unknown>);
  }

  /**
   * The component unmounts. Sends what is waiting once; then the form is forgotten when clean, or kept (registered as
   * unsaved work, retrying on its own) for the next copy. Resolves when that is decided.
   */
  async detach<T, D>(form: RetainedForm<T, D>, listener: (s: AutosaveState) => void): Promise<void> {
    form.listeners.delete(listener);
    form.mounts = Math.max(0, form.mounts - 1);
    if (form.mounts > 0) return;
    this.shown.delete(form as RetainedForm<unknown, unknown>);
    const key = FormRetainer.keyOf(form.name);
    // Registered before the send, so an update check landing meanwhile never reloads over the entry.
    if (this.owns(form) && form.saver.dirty) this.work.setDirty(key, true);
    try {
      await form.saver.flush(true);
    } catch {
      /* flush settles failures into the saver's state */
    }
    // Shown again before the send settled (React's development double mount, or Riley came straight back).
    if (form.mounts > 0) return;
    // Ownership is read again AFTER the send: a session end (clear) while it was pending let the form go, cleared its
    // key and disposed its saver, which then keeps its last "saving" or "error" state (still dirty). Such a form, a
    // copy beyond the bound, and one whose name another form holds now, register nothing: no unsaved-work key that
    // nothing could clear, and a replacement under the same name is left as it is.
    if (!this.owns(form)) {
      form.saver.dispose();
      return;
    }
    if (!form.saver.dirty) this.release(form);
    else this.work.setDirty(key, true);
  }

  /** How many forms are kept (mounted or not). */
  get size(): number {
    return this.forms.size;
  }

  /**
   * Forget every kept form, shown or not: its retry timer stops, its unsaved-work key goes, and the next mount starts
   * empty (session end, CLIENT_WIPE_EVENT below). A copy still on screen keeps its fields but sends nothing more.
   */
  clear(): void {
    for (const form of [...this.forms.values(), ...this.shown]) this.release(form);
  }

  /** The form is the copy kept under its name. */
  private owns(form: { name: string }): boolean {
    return (this.forms.get(form.name) as object | undefined) === (form as object);
  }

  private stateChanged<T, D>(form: RetainedForm<T, D>, s: AutosaveState): void {
    for (const fn of [...form.listeners]) fn(s);
    // A kept form nobody shows became clean (a retry got through): nothing is left to keep.
    if (form.mounts === 0 && this.owns(form) && !form.saver.dirty) this.release(form);
  }

  private release<T, D>(form: RetainedForm<T, D>): void {
    const owned = this.owns(form);
    if (owned) this.forms.delete(form.name);
    form.released = true;
    // The name's key belongs to the form kept under it: a copy that was never kept leaves it alone.
    if (owned || !this.forms.has(form.name)) this.work.setDirty(FormRetainer.keyOf(form.name), false);
    form.saver.dispose();
  }
}

/** The app's one retainer (memory only). */
export const formRetainer = new FormRetainer();

/** CLIENT_WIPE_EVENT of lib/client-cache.ts (that module stays import-free, so the name is repeated here). */
export const CLIENT_WIPE_EVENT = "onyx:client-wipe";

// Session end: the client's data is wiped (sign-out, a 401, a load without a session), so every kept entry goes too,
// with its pending retries; nothing typed in this session is sent or shown after it.
{
  const target = globalThis as unknown as { addEventListener?: (type: string, fn: () => void) => void };
  if (typeof target.addEventListener === "function") target.addEventListener(CLIENT_WIPE_EVENT, () => formRetainer.clear());
}
