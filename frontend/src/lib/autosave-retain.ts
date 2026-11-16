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
 *  - Memory only: nothing is written to storage, so a reload or a sign-out (a full load) forgets it. Bounded: one form
 *    per name, at most MAX_RETAINED names; a copy beyond that, or a second copy shown at the same time as the first,
 *    is not kept past its component.
 * No React, no DOM; React side in lib/use-autosave.ts (useRetainedAutosave). Unit-tested in tests/autosave-retain.test.cjs.
 */
import { Autosaver, type AutosaveState, type AutosaverOptions, type Timers } from "./autosave";
import { unsavedWork as defaultWork, type UnsavedWork } from "./unsaved-work";

export const MAX_RETAINED = 8;

/** What the component showing the form supplies on every render (the latest closures are always used). */
export type FormSource<T> = Pick<AutosaverOptions<T>, "save" | "ready" | "same">;

export type RetainOptions<T> = Omit<AutosaverOptions<T>, "onState">;

const jsonSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class RetainedForm<T, D> {
  readonly saver: Autosaver<T>;
  /** The options of the component showing the form now (the last one while none is mounted). */
  source: () => FormSource<T>;
  readonly listeners = new Set<(s: AutosaveState) => void>();
  mounts = 0;

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
        save: (v, ctx) => this.source().save(v, ctx),
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
    const cur = this.forms.get(form.name);
    if (this.owns(form)) {
      // Shown again: the component reports its own unsaved work while it is mounted.
      this.work.setDirty(FormRetainer.keyOf(form.name), false);
      return;
    }
    if (!cur && this.forms.size < this.max) this.forms.set(form.name, form as RetainedForm<unknown, unknown>);
  }

  /**
   * The component unmounts. Sends what is waiting once; then the form is forgotten when clean, or kept (registered as
   * unsaved work, retrying on its own) for the next copy. Resolves when that is decided.
   */
  async detach<T, D>(form: RetainedForm<T, D>, listener: (s: AutosaveState) => void): Promise<void> {
    form.listeners.delete(listener);
    form.mounts = Math.max(0, form.mounts - 1);
    if (form.mounts > 0) return;
    const key = FormRetainer.keyOf(form.name);
    const owned = this.owns(form);
    // Registered before the send, so an update check landing meanwhile never reloads over the entry.
    if (owned && form.saver.dirty) this.work.setDirty(key, true);
    try {
      await form.saver.flush(true);
    } catch {
      /* flush settles failures into the saver's state */
    }
    // Shown again before the send settled (React's development double mount, or Riley came straight back).
    if (form.mounts > 0) return;
    if (!owned) {
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

  /** Forget every kept form (tests; a sign-out reloads the page, which forgets them anyway). */
  clear(): void {
    for (const form of [...this.forms.values()]) this.release(form);
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
    if (this.owns(form)) this.forms.delete(form.name);
    this.work.setDirty(FormRetainer.keyOf(form.name), false);
    form.saver.dispose();
  }
}

/** The app's one retainer (memory only). */
export const formRetainer = new FormRetainer();
