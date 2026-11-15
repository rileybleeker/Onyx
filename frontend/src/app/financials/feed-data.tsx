"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GONE, SessionEndedError, clientCache, isGoneStatus, reportSessionEnded, sessionEnded } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";

/**
 * Data for the finance pages' sections in the continuous scroll (FeedSection.tsx next to each page.tsx).
 * One GET per page, /api/finance/page-data?page=..., answering exactly what that page.tsx passes to its view.
 * Shared client cache rules (lib/client-cache.ts): the cached copy shows at once, then the server answer
 * replaces it; the key starts with /api/finance, so it stays in memory only (isSensitiveKey) and any finance
 * write drops and refetches it (AppData invalidation, via the registered fetcher). A failed read is never
 * cached: the section keeps the last copy and says it could not refresh, or shows the page's own error state.
 */

export type FinanceFeedPage = "financials" | "forecast" | "budgets";
export interface FinancePageData<L> {
  /** Server time the load was computed for (ISO). */
  now: string;
  load: L;
}
export interface FeedFailure<L> {
  /** The page's own error state when the server sent one; null for a network or unreadable answer. */
  load: L | null;
}

/** Start reading when the section is this close to the screen. */
const NEAR = "1200px 0px";

export const financePageDataUrl = (page: FinanceFeedPage) => `/api/finance/page-data?page=${page}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** A usable answer for this page: an "ok" load carrying its view data, or an "empty" load. */
function usable(page: FinanceFeedPage, v: unknown): boolean {
  if (!isObj(v) || typeof v.now !== "string" || !isObj(v.load)) return false;
  const load = v.load;
  if (load.kind === "empty") return true;
  if (load.kind !== "ok") return false;
  return page === "financials" ? isObj(load.data) : isObj(load.result);
}

/** The server answered with the page's error state (or nothing readable). Never cached. */
class LoadFailed extends Error {
  constructor(readonly load: unknown) {
    super("load failed");
  }
}

function fetcherFor(page: FinanceFeedPage): () => Promise<unknown> {
  const url = financePageDataUrl(page);
  return async () => {
    const res = await fetch(url, { cache: "no-store" });
    if (sessionEnded(res)) {
      reportSessionEnded();
      throw new SessionEndedError();
    }
    if (isGoneStatus(res.status)) return GONE;
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new LoadFailed(isObj(body) && isObj(body.load) && body.load.kind === "error" ? body.load : null);
    if (!usable(page, body)) throw new LoadFailed(null);
    return body;
  };
}

export function useFinancePageData<L>(page: FinanceFeedPage) {
  const url = financePageDataUrl(page);
  const rootRef = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const [data, setData] = useState<FinancePageData<L> | null>(() => {
    const v = clientCache.peek(url);
    return usable(page, v) ? (v as FinancePageData<L>) : null;
  });
  const [failed, setFailed] = useState<FeedFailure<L> | null>(null);

  const adopt = useCallback(
    (v: unknown) => {
      if (!usable(page, v)) return false;
      // An identical answer keeps the same object, so React skips the re-render.
      setData((prev) => (sameJson(prev, v) ? prev : (v as FinancePageData<L>)));
      setFailed(null);
      return true;
    },
    [page],
  );

  /** Read the server's current answer (also what a view calls after it saved something). */
  const refresh = useCallback(() => {
    void clientCache
      .revalidate(url, fetcherFor(page))
      .then((v) => {
        if (alive.current && !adopt(v)) setFailed({ load: null });
      })
      .catch((e) => {
        if (!alive.current || e instanceof SessionEndedError) return;
        setFailed({ load: e instanceof LoadFailed ? (e.load as L | null) : null });
      });
  }, [url, page, adopt]);

  useEffect(() => {
    alive.current = true;
    clientCache.register(url, fetcherFor(page)); // a finance write elsewhere refetches it (AppData invalidation)
    // undefined (an invalidated entry being refetched) is ignored: the last copy stays until the new one lands.
    const off = clientCache.subscribe(url, (v) => {
      if (alive.current) adopt(v);
    });
    const el = rootRef.current;
    let stop = () => {};
    if (el && typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          refresh();
        },
        { rootMargin: NEAR },
      );
      io.observe(el);
      stop = () => io.disconnect();
    } else {
      refresh();
    }
    return () => {
      alive.current = false;
      off();
      stop();
    };
  }, [url, page, adopt, refresh]);

  return { rootRef, data, failed, refresh };
}

/** Shown under the heading until the first answer: roughly the page's layout, theme tokens, no animation. */
export function FeedSkeleton({ label, tiles, blocks, list = 0 }: { label: string; tiles: number; blocks: string[]; list?: number }) {
  return (
    <div className="space-y-5">
      <p role="status" className="sr-only">
        Loading {label}
      </p>
      <div aria-hidden="true" className="space-y-5">
        <div className={`grid gap-3 ${tiles >= 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
          {Array.from({ length: tiles }, (_, i) => (
            <div key={i} className="rounded-card border border-border-subtle bg-surface-card p-4">
              <div className="skeleton h-3 w-1/2" />
              <div className="skeleton mt-3 h-7 w-2/3" />
            </div>
          ))}
        </div>
        {blocks.map((h, i) => (
          <div key={i} className={`rounded-card border border-border-subtle bg-surface-card p-5 ${i === blocks.length - 1 && list > 0 ? "" : h}`}>
            <div className="skeleton h-4 w-40" />
            {i === blocks.length - 1 && list > 0 && (
              <div className="mt-5 space-y-3">
                {Array.from({ length: list }, (_, j) => (
                  <div key={j} className="skeleton h-9" />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A refresh failed while an earlier copy is on screen. */
export function StaleNote() {
  return (
    <p role="alert" className="text-[13px] text-mid">
      Could not refresh. Showing the last loaded copy.
    </p>
  );
}
