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

export default function NycLoader({ initial }: { initial: NycLead[] | null }) {
  return <NycClient initial={initial} />;
}
