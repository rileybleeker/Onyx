"use client";

import { useEffect, useState, type ReactNode } from "react";

// Breaks the single giant React mount commit on chart-dense pages (perf round
// 3, 2026-06-11). Profiling showed /sleep spent ~1.9s in ONE commit building
// 5,260 SVG nodes (~0.36 ms/node) before ANY chart became visible. Wrapping
// below-fold sections in <DeferredMount> lets the first commit build only the
// above-fold charts; deferred sections then mount ONE PER FRAME in document
// order via a module-level queue.
//
// Deliberately NOT IntersectionObserver-based: every section must mount
// unconditionally without user scroll, because the Playwright smoke suite
// asserts on below-fold content (e.g. the HRV Correlates bars) — with this
// scheduler everything is mounted within ~a dozen frames of first paint.
//
// The placeholder reserves minHeight so deferred mounting doesn't shift
// already-visible layout. Do NOT wrap above-the-fold content.

const queue: Array<() => void> = [];
let draining = false;

function drain() {
  const next = queue.shift();
  try {
    if (next) next();
  } finally {
    // Exception-safe: a throwing callback must not strand `draining=true`
    // with a never-drained queue (which would freeze every deferred section
    // on every subsequently visited page).
    if (queue.length > 0) {
      // One section per frame: each mounts in its own small commit instead of
      // contributing to one long task. setTimeout(0) after rAF yields to paint.
      requestAnimationFrame(() => setTimeout(drain, 0));
    } else {
      draining = false;
    }
  }
}

function enqueue(fn: () => void) {
  queue.push(fn);
  if (!draining) {
    draining = true;
    requestAnimationFrame(() => setTimeout(drain, 0));
  }
}

export default function DeferredMount({
  children,
  minHeight = 320,
  className,
}: {
  children: ReactNode;
  /** Approximate height of the real content, to avoid layout shift. */
  minHeight?: number;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    enqueue(() => {
      if (!cancelled) setShow(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return <div style={{ minHeight }} className={className} aria-hidden />;
  return <>{children}</>;
}
