"use client";

import dynamic from "next/dynamic";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const BlandAltmanClient = dynamic(() => import("./BlandAltmanClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. MUST mirror the query in
// BlandAltmanClient's mount effect (same function, same args) — the client
// seeds its state from this and then silently revalidates on mount.
export interface BlandAltmanInitial {
  data: unknown[];
}

export default function BlandAltmanLoader({ initial }: { initial: BlandAltmanInitial | null }) {
  return <BlandAltmanClient initial={initial} />;
}
