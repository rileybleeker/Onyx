"use client";

import dynamic from "next/dynamic";

// Defers the Recharts-heavy page body to an async chunk so the app shell +
// nav paint immediately (perf pass 2026-06-10).
const HeartClient = dynamic(() => import("./HeartClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

export default function HeartPage() {
  return <HeartClient />;
}
