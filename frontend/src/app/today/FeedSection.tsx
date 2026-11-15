"use client";

import TodayClient from "./TodayClient";

/** Today as one page of the continuous scroll (components/ContinuousScroll.tsx): its panels read the client cache. */
export default function FeedSection() {
  return <TodayClient headingTestId="feed-page-heading" />;
}
