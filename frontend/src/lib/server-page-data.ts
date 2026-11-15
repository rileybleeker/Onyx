"use client";

import { useEffect, useRef, useState } from "react";
import { clientCache, fetchJsonValue, GONE } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";

/** An answer in which a part failed on the server: shown when nothing else is, never cached. */
class PartialAnswer<T> extends Error {
  constructor(readonly data: T) {
    super("partial answer");
  }
}

export interface ServerPageData<T> {
  /** What the view is drawn from: null until the first answer (cached or fresh). */
  data: T | null;
  /** Bumped whenever the data on screen is replaced by a different answer (a view that seeds state from it remounts). */
  version: number;
  /** The read failed and there was nothing for this URL to show. */
  failed: boolean;
}

function seed<T>(url: string, read: (raw: unknown) => T, complete: (data: T) => boolean): T | null {
  const raw = clientCache.peek(url);
  if (raw === undefined) return null;
  try {
    const data = read(raw);
    return complete(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * The data a server-rendered (force-dynamic) page hands its view, read in the browser for that page's section
 * of the continuous scroll (the /orders, /procurement and /screen-time FeedSections), through the shared
 * client cache (lib/client-cache.ts):
 * - one key = the GET URL; a cached copy is checked like a fresh answer (`read` throws on a malformed one) and
 *   shown at once, from memory or, for keys allowed on disk, from the device's store;
 * - the mount fetch always runs and the server's answer wins (sameJson bailout when nothing changed);
 * - what may reach the disk is the cache's decision by key (finance, procurement, medical and screen time are
 *   memory only there); `persist: false` keeps any other key in memory too;
 * - an answer in which a part failed (`complete` false) is never cached: a copy already on screen keeps
 *   showing, otherwise the view gets that answer and shows its own failure state;
 * - a failed refresh keeps what is on screen; a failed read of a different URL (another window) reports
 *   `failed` instead of leaving the previous query's numbers up.
 *
 * `read` and `complete` must be stable (module-level functions).
 */
export function useServerPageData<T>(
  url: string,
  read: (raw: unknown) => T,
  complete: (data: T) => boolean,
  options: { persist?: boolean } = {},
): ServerPageData<T> {
  const persist = options.persist;
  const [state, setState] = useState<ServerPageData<T>>(() => ({ data: seed(url, read, complete), version: 0, failed: false }));
  const shown = useRef<{ url: string; data: T | null }>({ url, data: state.data });

  useEffect(() => {
    let alive = true;
    const onScreen = () => shown.current.url === url && shown.current.data !== null;
    const apply = (next: T) => {
      const previous = shown.current;
      if (previous.url === url && previous.data !== null && sameJson(previous.data, next)) return;
      shown.current = { url, data: next };
      setState((s) => ({ data: next, version: previous.data === null ? s.version : s.version + 1, failed: false }));
    };

    // Another URL than the one on screen (e.g. a different window): its cached copy, if there is one.
    if (shown.current.url !== url) {
      const cached = seed(url, read, complete);
      if (cached !== null) apply(cached);
    }
    // Reopening the app: a copy kept on this device until the live answer arrives.
    if (!onScreen()) {
      void clientCache.read(url).then((raw) => {
        if (!alive || raw === undefined || onScreen()) return;
        try {
          const data = read(raw);
          if (complete(data)) apply(data);
        } catch { /* a malformed copy is ignored; the live answer replaces it */ }
      });
    }

    const fetcher = async () => {
      const raw = await fetchJsonValue(url);
      if (raw === GONE) return GONE;
      const data = read(raw);
      if (!complete(data)) throw new PartialAnswer(data);
      return raw;
    };
    // A write on this page drops the entry; registered, it is refetched in the background, so the next
    // visit starts from the post-write answer. The section on screen keeps its own state (no remount).
    clientCache.register(url, fetcher);
    clientCache
      .revalidate(url, fetcher, { persist })
      .then((raw) => {
        if (!alive) return;
        if (raw === undefined) throw new Error("gone");
        apply(read(raw));
      })
      .catch((error: unknown) => {
        if (!alive || onScreen()) return;
        if (error instanceof PartialAnswer) {
          apply(error.data as T);
          return;
        }
        shown.current = { url, data: null };
        setState((s) => ({ data: null, version: s.version, failed: true }));
      });
    return () => {
      alive = false;
    };
  }, [url, read, complete, persist]);

  return state;
}
