"use client";

import { Suspense } from "react";
import { InFeed } from "@/components/FeedContext";
import CheckInClient from "@/app/check-in/CheckInClient";
import { REPLACES_CHECKIN_JOURNAL_DRAFT } from "./Journal";
import { REPLACES_CHECKIN_SAY_IT_ONCE } from "./SayIt";
import { REPLACES_CHECKIN_UBER_EATS } from "./UberEats";
import { SectionSkeleton } from "./ui";

// Parts of the check-in another /log section now covers (each section's own flag), so nothing is asked twice.
const OMIT: readonly string[] = [
  ...(REPLACES_CHECKIN_SAY_IT_ONCE ? ["say-it-once"] : []),
  ...(REPLACES_CHECKIN_JOURNAL_DRAFT ? ["journal-draft"] : []),
  ...(REPLACES_CHECKIN_UBER_EATS ? ["uber-eats", "uber-eats-leftovers"] : []),
];

/**
 * /log Check-in: the existing check-in screen itself (CheckInClient, its own Save bar and draft rules), not a copy.
 * `feed`: the day tabs stay in the component (a router.replace would leave /log for /check-in). `embedded`: a section
 * heading and the Log screen's Say it drafts. <InFeed>: the check-in's own Personalize grid shows its saved layout
 * without claiming the Personalize entry or syncing it (the /log grid owns those), like a page drawn in the scroll.
 */
export default function CheckInSection() {
  return (
    <InFeed>
      <Suspense fallback={<SectionSkeleton section="checkin" />}>
        <CheckInClient feed embedded omitParts={OMIT} />
      </Suspense>
    </InFeed>
  );
}
