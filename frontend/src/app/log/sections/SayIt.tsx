"use client";

import { SectionSkeleton } from "./ui";

/**
 * /log "Say it" box (placeholder: the section agent fills this file). One typed or dictated note becomes drafts for
 * the sections below: write them with setLogDrafts({checkin: {text}, supplements: [...], ubereats: [...], weight,
 * reading}, said) from "@/lib/log-drafts". It writes nothing to the server except the read-only parse it needs, and
 * never on page open (AGENTS.md "Log screen").
 */

/**
 * true once this box replaces the check-in's own "Say it once" box: the embedded check-in then leaves that part
 * out (./CheckIn.tsx). It still fills from {checkin: {text}} drafts either way.
 */
export const REPLACES_CHECKIN_SAY_IT_ONCE = false;

export default function SayItSection() {
  return <SectionSkeleton section="sayit" />;
}
