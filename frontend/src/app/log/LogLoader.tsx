"use client";

import dynamic from "next/dynamic";
// First: on a full page load of /log the Uber Eats section's Supabase reads start as soon as this module runs, before
// the frame and the sections below are evaluated (./early-delivery-start.ts, read-only).
import "./early-delivery-start";
import LogSkeleton from "./LogSkeleton";
// The screen's code (the frame and every section, ./LogClient.tsx) ships in this page's own first scripts, which the
// HTML loads in parallel with the framework, instead of in chunks requested only once this module has run.
import "./LogClient";

// Client-only (ssr:false), like the other personalizable client pages: the saved layout is read from localStorage in
// the first render, so nothing moves after paint. The server HTML is the skeleton, painted at once.
const LogClient = dynamic(() => import("./LogClient"), { ssr: false, loading: () => <LogSkeleton /> });

export default function LogLoader({ headingTestId }: { headingTestId?: string } = {}) {
  return <LogClient headingTestId={headingTestId} />;
}
