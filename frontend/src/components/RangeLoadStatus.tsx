"use client";

import { useCallback, useRef, useState } from "react";
import { rangeLabel, type Range } from "@/lib/queries";
import { finishRange, rangeStatus, rangeView, selectedRange, startRange, type RangeView } from "@/lib/range-load";

/**
 * The asked-for and the shown range of a dashboard (rules in lib/range-load.ts). The page's range effect
 * depends on `[range, attempt]`, calls `begin(range, silent)` before fetching and `finish(seq, range, ok)`
 * once it answered (not when the effect was cancelled). Labels use `view.shown`; the picker uses `selected`.
 */
export function useRangeLoad(initial: Range) {
  const [range, setRange] = useState<Range>(initial);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<RangeView<Range>>(() => rangeView(initial));
  const seqRef = useRef(0);
  // The shown range, readable from callbacks that outlive a render (a silent refresh of the shown rows).
  const shownRef = useRef<Range>(initial);
  const failedRef = useRef<Range | null>(null);

  const begin = useCallback((r: Range, silent = false) => {
    const seq = ++seqRef.current;
    failedRef.current = null;
    setView((v) => startRange(v, r, seq, silent));
    return seq;
  }, []);
  const finish = useCallback((seq: number, r: Range, ok: boolean) => {
    if (seq === seqRef.current) {
      if (ok) shownRef.current = r;
      failedRef.current = ok ? null : r;
    }
    setView((v) => finishRange(v, seq, r, ok));
  }, []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // Picking the range that just failed tries it again; picking any other range loads that one.
  const select = useCallback((r: Range) => {
    if (r === range) {
      if (failedRef.current === r) retry();
      return;
    }
    setRange(r);
  }, [range, retry]);

  return { range, attempt, view, selected: selectedRange(view), begin, finish, retry, select, shownRef };
}

/** "Loading last 90 days…", or "Couldn't load last 90 days. Showing last 30 days." with Retry. */
export default function RangeLoadStatus({ view, onRetry }: { view: RangeView<Range>; onRetry: () => void }) {
  const status = rangeStatus(view, rangeLabel);
  if (!status) return null;
  if (status.tone === "loading") {
    return <span role="status" className="text-[11px] font-mono text-text-tertiary animate-pulse">{status.text}</span>;
  }
  return (
    <span role="alert" className="inline-flex flex-wrap items-center gap-x-2 text-[12px]">
      <span className="text-down">{status.text}</span>
      <button type="button" onClick={onRetry} className="min-h-11 px-2 font-medium text-accent hover:underline">
        Retry
      </button>
    </span>
  );
}
