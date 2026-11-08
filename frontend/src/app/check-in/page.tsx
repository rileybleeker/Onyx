import { Suspense } from "react";
import CheckInClient from "./CheckInClient";

// Daily habit check-in. Not ISR: it is a write surface whose content depends on the day and on saved answers.
export const dynamic = "force-dynamic";

export default function CheckInPage() {
  return (
    <Suspense fallback={null}>
      <CheckInClient />
    </Suspense>
  );
}
