"use client";

import dynamic from "next/dynamic";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const ActivitiesClient = dynamic(() => import("./ActivitiesClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. MUST mirror the FIRST-STAGE
// Promise.all in ActivitiesClient's mount effect (same 7 functions, same
// args) — the client seeds its state from this and then silently revalidates
// on mount. The derived second-stage getActivityLaps fetch is deliberately
// NOT covered: lapsByActivity stays client-computed (seeded empty).
export interface ActivitiesInitial {
  garmin: unknown[];
  whoop: unknown[];
  workouts: unknown[];
  summaries: unknown[];
  cycles: unknown[];
  hr: unknown[];
  recoveryContext: unknown[];
}

export default function ActivitiesLoader({ initial }: { initial: ActivitiesInitial | null }) {
  return <ActivitiesClient initial={initial} />;
}
