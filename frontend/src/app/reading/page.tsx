import { Suspense } from "react";
import ReadingClient from "./ReadingClient";

// Reading quest. Not ISR: it is a write surface (sessions, highlights, review
// grades) whose numbers change with every tap — same rule as /supplements and
// /check-in.
export const dynamic = "force-dynamic";

export default function ReadingPage() {
  return (
    <Suspense fallback={null}>
      <ReadingClient />
    </Suspense>
  );
}
