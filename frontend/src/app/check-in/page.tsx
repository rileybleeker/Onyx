import { Suspense } from "react";
import CheckInClient from "./CheckInClient";
import { earlyFetchScript } from "@/lib/early-fetch";

// Daily habit check-in. Not ISR: it is a write surface whose content depends on the day and on saved answers.
export const dynamic = "force-dynamic";

// The screen's first read (GET /api/habits/checkin, the day's questions and answers) starts with the HTML instead of
// after the JavaScript and hydration (lib/early-fetch.ts); CheckInClient takes that response for its first load.
// Only a full page load runs it: React does not run a script it inserts during an in-app navigation, where the
// client cache already shows the last copy at once.
const EARLY = earlyFetchScript("/api/habits/checkin", true);

export default function CheckInPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: EARLY }} />
      <Suspense fallback={null}>
        <CheckInClient />
      </Suspense>
    </>
  );
}
