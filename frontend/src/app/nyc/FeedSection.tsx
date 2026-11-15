"use client";

import { useState } from "react";
import type { NycLead } from "@/lib/nyc";
import { readFeedSeed } from "@/lib/feed-seed";
import NycLoader from "./NycLoader";

/**
 * NYC search as one page of the continuous scroll (components/ContinuousScroll.tsx): seeded from this
 * session's last leads (lib/feed-seed.ts) instead of the server; the page still revalidates on mount.
 */
export default function FeedSection() {
  const [seed] = useState(() => readFeedSeed<NycLead[]>("/nyc"));
  return <NycLoader initial={seed} />;
}
