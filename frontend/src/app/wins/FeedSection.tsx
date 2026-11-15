"use client";

import { useEffect, useState } from "react";
import PageSkeleton from "@/components/PageSkeleton";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import type { Board } from "@/lib/wins";
import WinsBoard from "./WinsBoard";

const WINS_URL = "/api/wins";

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
  useEffect(() => {
    let alive = true;
    void clientCache.read<Board>(WINS_URL).then((cached) => {
      if (!alive || !cached) return;
      try { check(cached); } catch { return; }
      setBoard((prev) => prev ?? cached);
    });
    cachedJson<Board>(WINS_URL, { check })
      .then((next) => { if (alive) { setFailed(false); setBoard((prev) => (sameJson(prev, next) ? prev : next)); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  if (board) return <WinsBoard board={board} headingTestId="feed-page-heading" />;
  if (failed) return <p role="status" className="text-[13px] text-text-secondary">Couldn&apos;t load the Wins board.</p>;
  return <PageSkeleton title="Worth celebrating" />;
}
