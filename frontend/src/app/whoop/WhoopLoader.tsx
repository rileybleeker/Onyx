"use client";

import dynamic from "next/dynamic";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const WhoopClient = dynamic(() => import("./WhoopClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. MUST mirror the Promise.all in
// WhoopClient's mount effect (same functions, same args) — the client seeds
// its state from this and then silently revalidates on mount.
export interface WhoopInitial {
  recovery: unknown[];
  cycles: unknown[];
  sleep: unknown[];
  journal: unknown[];
}

export default function WhoopLoader({ initial }: { initial: WhoopInitial | null }) {
  return <WhoopClient initial={initial} />;
}
