"use client";

import { SectionSkeleton } from "./ui";

/**
 * /log Supplements (placeholder: the section agent fills this file). Stacks and single products, logged through the
 * existing routes (POST /api/supplements/stacks/log, POST /api/supplements/log-intake) with their date rules
 * (behavioral_today_now, intake_time). Suggestions: useLogDrafts("supplements") from "@/lib/log-drafts"
 * (SupplementLogDraft[]), shown with <DraftMark />, saved only on this section's own tap.
 */
export default function SupplementsSection() {
  return <SectionSkeleton section="supplements" />;
}
