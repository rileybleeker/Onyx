"use client";

import dynamic from "next/dynamic";

// The same async chunk as the routed page and the warm-up (components/AppData.tsx), so a warmed page renders at once.
const HabitsClient = dynamic(() => import("./HabitsClient"), {
  ssr: false,
  loading: () => <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>,
});

/** Habits as one page of the continuous scroll (components/ContinuousScroll.tsx). */
export default function FeedSection() {
  return <HabitsClient headingTestId="feed-page-heading" />;
}
