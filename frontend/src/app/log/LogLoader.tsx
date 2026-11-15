"use client";

import dynamic from "next/dynamic";
import { takeLogEarlyMark } from "@/lib/log-early";
import { startEarlyDeliveryReads } from "./early-delivery";
import LogSkeleton from "./LogSkeleton";

// Client-only (ssr:false), like the other personalizable client pages: the saved layout is read from localStorage in
// the first render, so nothing moves after paint. The server HTML is the skeleton, painted at once.
const LogClient = dynamic(() => import("./LogClient"), { ssr: false, loading: () => <LogSkeleton /> });

if (typeof window !== "undefined") {
  // Start loading the screen's code with the page's first scripts, not after hydration: the frame and every
  // section's chunk at once (they used to wait for the frame's chunk, one round trip later). The Say it box and
  // the check-in, at the top of the default order, first.
  void import("./LogClient").catch(() => {});
  void import("./sections/SayIt").catch(() => {});
  void import("./sections/CheckIn").catch(() => {});
  void import("./sections/Journal").catch(() => {});
  void import("./sections/Supplements").catch(() => {});
  void import("./sections/UberEats").catch(() => {});
  void import("./sections/Weight").catch(() => {});
  void import("./sections/Reading").catch(() => {});
  // A full page load of /log (its inline script ran, lib/log-early.ts): the Uber Eats section's Supabase reads start
  // now too, read-only (./early-delivery.ts). The same-origin reads are already under way from the HTML.
  if (takeLogEarlyMark()) startEarlyDeliveryReads();
}

export default function LogLoader({ headingTestId }: { headingTestId?: string } = {}) {
  return <LogClient headingTestId={headingTestId} />;
}
