"use client";

import { SectionSkeleton } from "./ui";

/**
 * /log Weight (placeholder: the section agent fills this file). Pounds in, POST /api/weight {log_date, weight_kg}
 * (a manual entry owns its day over the Tanita rollup). Suggestions: useLogDrafts("weight") (WeightLogDraft).
 */
export default function WeightSection() {
  return <SectionSkeleton section="weight" />;
}
