"use client";

import { SectionSkeleton } from "./ui";

/**
 * /log Uber Eats (placeholder: the section agent fills this file). How much of each delivered dish was eaten
 * (PATCH /api/delivery/items/[itemId]) and leftovers (PUT /api/delivery/items/[itemId]/leftovers), through
 * createPortionSaver like /nutrition and /check-in. Suggestions: useLogDrafts("ubereats") (UberEatsLogDraft[]).
 */

/**
 * true once this section replaces the check-in's own Uber Eats parts: the embedded check-in then leaves out
 * "uber-eats" and "uber-eats-leftovers" (./CheckIn.tsx), so the dishes are asked once on this screen.
 */
export const REPLACES_CHECKIN_UBER_EATS = false;

export default function UberEatsSection() {
  return <SectionSkeleton section="ubereats" />;
}
