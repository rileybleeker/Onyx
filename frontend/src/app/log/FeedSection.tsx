"use client";

import LogLoader from "./LogLoader";

/** /log as one page of the continuous scroll (components/ContinuousScroll.tsx): the same screen, same chunks. */
export default function LogFeedSection() {
  return <LogLoader headingTestId="feed-page-heading" />;
}
