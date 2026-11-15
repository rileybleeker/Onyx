"use client";
import { useEffect, useRef, useState } from "react";
import { clientCache, fetchJsonValue, GONE } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";

/** An answer in which a part failed on the server: shown when nothing else is, never cached. */
export class PartialAnswer<T> extends Error {
  constructor(readonly data: T) {
    super("partial answer");
  }
}

export type FeedPageData<T> = {
  /** What the view is seeded with: null until the first answer (cached or fresh). */
  data: T | null;
  /** Bumped when a fresh answer differs from the cached copy the view was seeded with: the view remounts with it. */
  version: number;
  /** The first read failed and there was nothing cached to show. */
  failed: boolean;
};

/**
 * The data a server-rendered page hands its view, read in the browser for that page's section of the
 * continuous scroll (the FeedSections under app/health).
 *
 * Client cache rules (lib/client-cache.ts): one key = the GET URL; a cached copy is checked like a fresh
 * answer (`read` throws on a malformed one) and shown at once; the mount fetch always runs and the server's
 * answer wins. Kept in memory only (persist: false; sensitive keys are memory only anyway). An answer
 * in which a part failed (`complete` false) is never cached: a cached copy keeps showing, otherwise the view
 * gets that answer and shows its own failure state for the part that failed.
 *
 * `read` and `complete` must be stable (module-level functions).
 */
export function useFeedPageData<T>(url: string, read: (raw: unknown) => T, complete: (data: T) => boolean): FeedPageData<T> {
  const [state, setState] = useState<FeedPageData<T>>(() => {
    const raw = clientCache.peek(url);
    if (raw === undefined) return { data: null, version: 0, failed: false };
    try {
      const data = read(raw);
      return { data: complete(data) ? data : null, version: 0, failed: false };
    } catch {
      return { data: null, version: 0, failed: false };
    }
  });
  const shown = useRef(state.data);

  useEffect(() => {
    let alive = true;
    const apply = (next: T) => {
      const previous = shown.current;
      if (previous !== null && sameJson(previous, next)) return;
      shown.current = next;
      setState((s) => ({ data: next, version: previous === null ? s.version : s.version + 1, failed: false }));
    };
    clientCache
      .revalidate(url, async () => {
        const raw = await fetchJsonValue(url);
        if (raw === GONE) return GONE;
        const data = read(raw);
        if (!complete(data)) throw new PartialAnswer(data);
        return raw;
      }, { persist: false })
      .then((raw) => {
        if (!alive) return;
        if (raw === undefined) throw new Error("gone");
        apply(read(raw));
      })
      .catch((error: unknown) => {
        if (!alive || shown.current !== null) return; // a failed refresh keeps what is on screen
        if (error instanceof PartialAnswer) apply(error.data as T);
        else setState((s) => ({ ...s, failed: true }));
      });
    return () => {
      alive = false;
    };
  }, [url, read, complete]);

  return state;
}
