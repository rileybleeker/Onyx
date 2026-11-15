"use client";

import { Suspense } from "react";
import CheckInClient from "./CheckInClient";

// /check-in inside the continuous scroll: the same screen as the routed page (data from the shared client
// cache, then a live GET), with the day tabs kept in the component instead of the address bar.
export default function CheckInFeedSection() {
  return (
    <Suspense fallback={null}>
      <CheckInClient feed />
    </Suspense>
  );
}
