"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Autosaver, messageOf, type AutosaveState, type AutosaverOptions } from "@/lib/autosave";
import { formRetainer, type RetainOptions } from "@/lib/autosave-retain";
import { useUnsavedWork } from "@/lib/use-unsaved-work";

export type UseAutosave<T> = {
  state: AutosaveState;
  /** A new value from the form (see Autosaver.change). */
  change: (value: T, opts?: { delayMs?: number | null }) => void;
  /** Save now (blur, Enter). True when nothing is left unsaved (false after a failure or with incomplete input). */
  flush: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  setBaseline: (value: T) => void;
  reset: (baseline?: T) => void;
  /** Anything not saved yet. */
  dirty: boolean;
  /**
   * True when a failed save is armed to retry on its own right now. Read live from the saver, not from `state`:
   * `state` is the last render's copy and lags right after a failure (a load that runs at once still sees "saving").
   */
  retryArmed: () => boolean;
};

/**
 * React side of lib/autosave.ts. The latest `save` / `ready` / `same` are always used (no stale closures). What is
 * still waiting is sent when the page is hidden or left (keepalive) and when the form unmounts, and counts as
 * unsaved work so the automatic updater never reloads over it (lib/unsaved-work.ts). After an unmount nothing is
 * retried: a form whose entry must survive its component uses useRetainedAutosave below.
 */
export function useAutosave<T>(name: string, opts: Omit<AutosaverOptions<T>, "onState">, baseline?: T): UseAutosave<T> {
  const [state, setState] = useState<AutosaveState>({ status: "idle", error: null, retrying: false, savedAt: null });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const alive = useRef(true);
  const [saver] = useState(
    () =>
      new Autosaver<T>(
        {
          save: (v, ctx) => optsRef.current.save(v, ctx),
          ready: (v) => optsRef.current.ready?.(v),
          same: (a, b) => (optsRef.current.same ? optsRef.current.same(a, b) : JSON.stringify(a) === JSON.stringify(b)),
          unknownOutcome: (e) => optsRef.current.unknownOutcome?.(e) ?? false,
          describeError: (e) => (optsRef.current.describeError ?? messageOf)(e),
          delayMs: opts.delayMs,
          retryDelaysMs: opts.retryDelaysMs,
          onState: (s) => {
            if (alive.current) setState(s);
          },
        },
        baseline,
      ),
  );

  useEffect(() => {
    alive.current = true;
    const hidden = () => {
      if (document.visibilityState === "hidden") void saver.flush(true);
    };
    const leave = () => void saver.flush(true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      alive.current = false;
      // Unmount (navigation, the scroll dropping the section): send what is waiting once, then stop (no retries
      // with nothing on screen to show them). React's dev double mount runs this cleanup and mounts the same saver
      // again before the flush settles, so it is only stopped when it is still unmounted then.
      void saver.flush(true).finally(() => {
        if (!alive.current) saver.dispose();
      });
    };
  }, [saver]);

  const dirty = state.status === "waiting" || state.status === "saving" || state.status === "error" || state.status === "incomplete";
  useUnsavedWork(dirty, `autosave:${name}`);

  const change = useCallback((value: T, o?: { delayMs?: number | null }) => saver.change(value, o), [saver]);
  const flush = useCallback(() => saver.flush(), [saver]);
  const retry = useCallback(() => saver.retry(), [saver]);
  const setBaseline = useCallback((value: T) => saver.setBaseline(value), [saver]);
  const reset = useCallback((b?: T) => saver.reset(b), [saver]);
  const retryArmed = useCallback(() => saver.state.retrying, [saver]);

  return useMemo(
    () => ({ state, change, flush, retry, setBaseline, reset, dirty, retryArmed }),
    [state, change, flush, retry, setBaseline, reset, dirty, retryArmed],
  );
}

export type UseRetainedAutosave<T, D> = UseAutosave<T> & {
  /**
   * The form's own state (its fields, the row it made, the operation key of a create). Kept with the saver while the
   * form holds unsaved work, so the next copy of the component shows the same entry and a retry sends the same key.
   * Read and write it directly (it is a plain object, memory only); keep React state for what is drawn.
   */
  data: D;
  /** This mount took over an entry an earlier copy left unsaved (incomplete, failed or still waiting). */
  restored: boolean;
};

/**
 * useAutosave for a form whose entry must survive its component (lib/autosave-retain.ts): unmounting it (navigation,
 * a hidden or moved part, the scroll dropping the page) sends what is waiting once and, if anything is still not saved,
 * keeps the saver (retrying on its own) and `data` for the next mount, still counted as unsaved work. One form per
 * `name`: use a name only one form on the screen has. Taking a kept form over sends nothing. Its `save` also gets
 * `cancelled()` (lib/autosave-retain.ts RetainedSaveContext): check it after every await, a session end stops the save.
 * A kept form found at render and let go as clean before the effect (a background retry got through) is taken back
 * live, never left with a disposed saver that would drop later edits (FormRetainer.revive).
 */
export function useRetainedAutosave<T, D extends object>(
  name: string,
  opts: RetainOptions<T>,
  initData: () => D,
  baseline?: T,
): UseRetainedAutosave<T, D> {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [taken] = useState(() => {
    const found = formRetainer.find<T, D>(name);
    if (found) return { form: found, restored: found.saver.dirty };
    return { form: formRetainer.create<T, D>(name, initData(), opts, baseline), restored: false };
  });
  const form = taken.form;
  const saver = form.saver;
  const [state, setState] = useState<AutosaveState>(() => saver.state);
  // Unmounted (cleanup ran, no setup since): a late call is not a reason to take a let-go form back.
  const left = useRef(false);

  useEffect(() => {
    let alive = true;
    left.current = false;
    const listener = (s: AutosaveState) => {
      if (alive) setState(s);
    };
    form.source = () => optsRef.current;
    // attach() takes back a form let go as clean between this render and now (FormRetainer.revive).
    formRetainer.attach(form, listener);
    setState(saver.state); // anything that happened between the render and now (a background retry)
    const hidden = () => {
      if (document.visibilityState === "hidden") void saver.flush(true);
    };
    const leave = () => void saver.flush(true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      alive = false;
      left.current = true;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      void formRetainer.detach(form, listener);
    };
  }, [form, saver]);

  const dirty = state.status === "waiting" || state.status === "saving" || state.status === "error" || state.status === "incomplete";
  useUnsavedWork(dirty, `autosave:${name}`);

  // An edit (or a save) after the render but before the effect attached: the form may have been let go as clean in
  // between (a background retry got through), so it is taken back first instead of dropping the edit.
  const live = useCallback(() => {
    if (!left.current) formRetainer.revive(form);
    return saver;
  }, [form, saver]);
  const change = useCallback((value: T, o?: { delayMs?: number | null }) => live().change(value, o), [live]);
  const flush = useCallback(() => live().flush(), [live]);
  const retry = useCallback(() => live().retry(), [live]);
  const setBaseline = useCallback((value: T) => saver.setBaseline(value), [saver]);
  const reset = useCallback((b?: T) => saver.reset(b), [saver]);
  const retryArmed = useCallback(() => saver.state.retrying, [saver]);

  return useMemo(
    () => ({ state, change, flush, retry, setBaseline, reset, dirty, retryArmed, data: form.data, restored: taken.restored }),
    [state, change, flush, retry, setBaseline, reset, dirty, retryArmed, form, taken.restored],
  );
}
