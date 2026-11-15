"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Autosaver, type AutosaveState, type AutosaverOptions } from "@/lib/autosave";
import { useUnsavedWork } from "@/lib/use-unsaved-work";

export type UseAutosave<T> = {
  state: AutosaveState;
  /** A new value from the form (see Autosaver.change). */
  change: (value: T, opts?: { delayMs?: number | null }) => void;
  /** Save now (blur, Enter). */
  flush: () => Promise<void>;
  retry: () => Promise<void>;
  setBaseline: (value: T) => void;
  reset: (baseline?: T) => void;
  /** Anything not saved yet. */
  dirty: boolean;
};

/**
 * React side of lib/autosave.ts. The latest `save` / `ready` / `same` are always used (no stale closures). What is
 * still waiting is sent when the page is hidden or left (keepalive) and when the form unmounts, and counts as
 * unsaved work so the automatic updater never reloads over it (lib/unsaved-work.ts).
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
      // Unmount (navigation, the scroll dropping the section): send what is waiting. Not disposed: React's dev
      // double mount runs this cleanup and then mounts the same saver again.
      void saver.flush(true);
    };
  }, [saver]);

  const dirty = state.status === "waiting" || state.status === "saving" || state.status === "error" || state.status === "incomplete";
  useUnsavedWork(dirty, `autosave:${name}`);

  const change = useCallback((value: T, o?: { delayMs?: number | null }) => saver.change(value, o), [saver]);
  const flush = useCallback(() => saver.flush(), [saver]);
  const retry = useCallback(() => saver.retry(), [saver]);
  const setBaseline = useCallback((value: T) => saver.setBaseline(value), [saver]);
  const reset = useCallback((b?: T) => saver.reset(b), [saver]);

  return useMemo(() => ({ state, change, flush, retry, setBaseline, reset, dirty }), [state, change, flush, retry, setBaseline, reset, dirty]);
}
