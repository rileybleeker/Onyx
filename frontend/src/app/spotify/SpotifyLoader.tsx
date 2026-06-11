"use client";

import dynamic from "next/dynamic";
import type { getSpotifyDashboard, SpotifyDailySignatureRow } from "@/lib/queries";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const SpotifyClient = dynamic(() => import("./SpotifyClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. MUST mirror the main dashboard
// Promise.all in SpotifyClient's mount effect (same functions, same args) —
// the client seeds its state from this and then silently revalidates on
// mount. The user-paginated ledger is deliberately NOT prefetched; it stays a
// client-only fetch with its own loading state.
export interface SpotifyInitial {
  dashboard: Awaited<ReturnType<typeof getSpotifyDashboard>>;
  volume: SpotifyDailySignatureRow[];
  drift: SpotifyDailySignatureRow[];
}

export default function SpotifyLoader({ initial }: { initial: SpotifyInitial | null }) {
  return <SpotifyClient initial={initial} />;
}
