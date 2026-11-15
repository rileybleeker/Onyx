"use client";

import { useEffect, useState } from "react";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { isTravelPageData, type TravelPageData } from "@/lib/travel";
import TravelView from "./TravelView";

// /analytics/travel inside the continuous scroll. The routed page renders on the server (ISR); here the same
// TravelView draws from GET /api/travel/page-data through the shared client cache: the cached copy at once,
// then the live answer.

const TRAVEL_URL = "/api/travel/page-data";
const check = (v: unknown) => {
  if (!isTravelPageData(v)) throw new Error("Unexpected travel answer");
};

export default function TravelFeedSection() {
  const [data, setData] = useState<TravelPageData | null>(() => {
    const v = clientCache.peek(TRAVEL_URL);
    return isTravelPageData(v) ? v : null;
  });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // An identical answer keeps the same object, so React skips the re-render.
    const show = (v: unknown) => {
      if (alive && isTravelPageData(v)) setData((prev) => (prev && sameJson(prev, v) ? prev : v));
    };
    void clientCache.read(TRAVEL_URL).then(show);
    cachedJson<TravelPageData>(TRAVEL_URL, { check })
      .then((v) => {
        if (!alive) return;
        setFailed(false);
        show(v);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (data) return <TravelView data={data} headingTestId="feed-page-heading" />;

  if (failed) {
    return (
      <div>
        <h2 data-testid="feed-page-heading" className="text-[28px] font-medium text-text-primary">Travel Analysis</h2>
        <p className="mt-3 text-sm text-text-secondary">Couldn&apos;t load Travel Analysis.</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
          className="mt-3 min-h-11 px-4 text-[13px] bg-white/5 border border-border-subtle rounded-control"
        >
          Try again
        </button>
      </div>
    );
  }

  // Same layout as the page (heading, four KPI tiles, the flights card), so nothing jumps when it arrives.
  return (
    <div aria-busy="true">
      <div className="mb-8">
        <h2 data-testid="feed-page-heading" className="text-[28px] font-medium text-text-primary">Travel Analysis</h2>
        <p role="status" className="sr-only">Loading Travel Analysis</p>
        <div aria-hidden="true" className="skeleton mt-2 h-4 w-2/3 max-w-sm" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-card border border-border-subtle bg-surface-card p-4">
            <div className="skeleton h-3 w-1/2" />
            <div className="skeleton mt-3 h-7 w-2/3" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="h-64 rounded-card border border-border-subtle bg-surface-card" />
    </div>
  );
}
