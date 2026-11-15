"use client";

import { SectionSkeleton } from "./ui";

/**
 * /log Reading (placeholder: the section agent fills this file). One session through POST /api/reading/sessions
 * (recall stored verbatim). Suggestions: useLogDrafts("reading") (ReadingLogDraft).
 */
export default function ReadingSection() {
  return <SectionSkeleton section="reading" />;
}
