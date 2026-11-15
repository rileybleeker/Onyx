"use client";

import { useState } from "react";
import { readFeedSeed } from "@/lib/feed-seed";
import HrvLoader, { type HrvInitial } from "./HrvLoader";

/**
 * This page as one page of the continuous scroll (components/ContinuousScroll.tsx): the same Loader as the
 * routed page, seeded from the client cache instead of the server (lib/feed-seed.ts: this session's last
 * default-view data, or nothing on the first visit); the page still revalidates on mount.
 */
export default function FeedSection() {
  const [seed] = useState(() => readFeedSeed<HrvInitial>("/analytics/hrv"));
  return <HrvLoader initial={seed} headingTestId="feed-page-heading" />;
}
