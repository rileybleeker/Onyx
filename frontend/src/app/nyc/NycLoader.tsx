"use client";

import dynamic from "next/dynamic";
import type { NycLead } from "@/lib/nyc";

// Client wrapper hosting the dynamic(ssr:false) import (Next 15 forbids
// ssr:false in a Server Component). Leaflet touches `window` at import time,
// so the whole page body — map included — lives in this async chunk.
const NycClient = dynamic(() => import("./NycClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Speed (2026-11-15): start loading the page's code as soon as this module runs (with the page's first scripts)
// instead of after hydration, when the component above first renders; next/dynamic then finds the chunk on its
// way (one request, webpack shares it). A cold or freshly deployed load waited ~0.8 s for this request.
if (typeof window !== "undefined") void import("./NycClient").catch(() => {});

export default function NycLoader({ initial }: { initial: NycLead[] | null }) {
  return <NycClient initial={initial} />;
}
