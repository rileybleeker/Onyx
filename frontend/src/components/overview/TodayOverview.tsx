"use client";

import dynamic from "next/dynamic";

/**
 * The overview under Today's panels, loaded as its own chunk after Today has rendered: Today's first paint
 * and first-load JavaScript stay what they were. It sits below the fold, so the reserved space is never seen
 * empty. tests/today-regression.cjs swaps this file for the overview itself.
 */
const Overview = dynamic(() => import("./Overview"), {
  ssr: false,
  loading: () => <div aria-hidden="true" style={{ minHeight: 1200 }} />,
});

export default function TodayOverview() {
  return <Overview />;
}
