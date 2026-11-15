"use client";

import dynamic from "next/dynamic";
import { takeLogEarlyMark } from "@/lib/log-early";
import { startEarlyDeliveryReads } from "./early-delivery";
import LogSkeleton from "./LogSkeleton";
// The screen's code (the frame and every section, ./LogClient.tsx) ships in this page's own first scripts, which the
// HTML loads in parallel with the framework, instead of in chunks requested only once this module has run.
import "./LogClient";

// Client-only (ssr:false), like the other personalizable client pages: the saved layout is read from localStorage in
// the first render, so nothing moves after paint. The server HTML is the skeleton, painted at once.
const LogClient = dynamic(() => import("./LogClient"), { ssr: false, loading: () => <LogSkeleton /> });

// A full page load of /log (its inline script ran, lib/log-early.ts): the Uber Eats section's Supabase reads start
// now, read-only (./early-delivery.ts). The same-origin reads are already under way from the HTML.
if (typeof window !== "undefined" && takeLogEarlyMark()) startEarlyDeliveryReads();

export default function LogLoader({ headingTestId }: { headingTestId?: string } = {}) {
  return <LogClient headingTestId={headingTestId} />;
}
