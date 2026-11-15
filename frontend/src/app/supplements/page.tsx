"use client";

import dynamic from "next/dynamic";

// Defers the Recharts-heavy page body to an async chunk so the app shell +
// nav paint immediately (perf pass 2026-06-10).
const SupplementsClient = dynamic(() => import("./SupplementsClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Speed (2026-11-15): start loading the page's code as soon as this module runs (with the page's first scripts)
// instead of after hydration, when the component above first renders; next/dynamic then finds the chunk on its
// way (one request, webpack shares it). A cold or freshly deployed load waited ~0.8 s for this request.
if (typeof window !== "undefined") void import("./SupplementsClient").catch(() => {});

export default function SupplementsPage() {
  return <SupplementsClient />;
}
