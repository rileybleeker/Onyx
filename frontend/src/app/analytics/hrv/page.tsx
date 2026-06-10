"use client";

import dynamic from "next/dynamic";

// Defers the Recharts-heavy page body to an async chunk so the app shell +
// nav paint immediately (perf pass 2026-06-10). The page already rendered a
// loading state while fetching data; this fallback mirrors it.
const HrvAnalysisClient = dynamic(() => import("./HrvAnalysisClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

export default function HrvAnalysisPage() {
  return <HrvAnalysisClient />;
}
