"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PageSkeleton from "@/components/PageSkeleton";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import type { Board } from "@/lib/wins";
import WinsBoard from "./WinsBoard";

const WINS_URL = "/api/wins";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

function check(data: unknown) {
  const b = data as Partial<Board> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.wins)) throw new Error("Invalid board");
}

/**
 * Wins as one page of the continuous scroll (components/ContinuousScroll.tsx). The routed /wins page renders
 * the board on the server; here it comes from GET /api/wins through the client cache (cached copy first,
 * then revalidated).
 */
export default function FeedSection() {
  const [board, setBoard] = useState<Board | null>(() => clientCache.peek<Board>(WINS_URL) ?? null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  // The revalidating request. Also run by "Try again"; the cache dedupes an identical in-flight request.
  const load = useCallback(() => {
    cachedJson<Board>(WINS_URL, { check })
      .then((next) => { if (alive.current) { setFailed(false); setBoard((prev) => (sameJson(prev, next) ? prev : next)); } })
      .catch(() => { if (alive.current) setFailed(true); });
  }, []);

  useEffect(() => {
    alive.current = true;
    void clientCache.read<Board>(WINS_URL).then((cached) => {
      if (!alive.current || !cached) return;
      try { check(cached); } catch { return; }
      setBoard((prev) => prev ?? cached);
    });
    load();
    return () => { alive.current = false; };
  }, [load]);

  if (board) return <WinsBoard board={board} headingTestId="feed-page-heading" />;
  if (failed) {
    return (
      <div>
        <p role="status" className="text-[13px] text-text-secondary">Couldn&apos;t load the Wins board.</p>
        <button
          type="button"
          onClick={() => {
            // Clearing `failed` shows the skeleton while the retry runs.
            setFailed(false);
            load();
          }}
          className={`mt-3 inline-flex min-h-11 items-center rounded-control px-3 text-[13px] text-accent underline underline-offset-4 ${focusRing}`}
        >
          Try again
        </button>
      </div>
    );
  }
  return <PageSkeleton title="Worth celebrating" />;
}
