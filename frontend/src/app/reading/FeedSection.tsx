"use client";

import ReadingClient from "./ReadingClient";

// /reading inside the continuous scroll: the same screen as the routed page (data from the shared client
// cache under /api/reading, then a live GET).
export default function ReadingFeedSection() {
  return <ReadingClient feed />;
}
