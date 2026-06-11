"use client";

import dynamic from "next/dynamic";
import type { HrvDashboardData } from "@/lib/queries-hrv";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const HrvAnalysisClient = dynamic(() => import("./HrvAnalysisClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. Mirrors loadHrvDashboard's
// return type exactly (same functions, same args as the Client's mount
// effect — both call loadHrvDashboard(rangeDays("30d"))); the Client seeds
// its state from this and then silently revalidates on mount.
export type HrvInitial = HrvDashboardData;

export default function HrvLoader({ initial }: { initial: HrvInitial | null }) {
  return <HrvAnalysisClient initial={initial} />;
}
