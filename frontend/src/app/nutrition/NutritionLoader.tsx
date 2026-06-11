"use client";

import dynamic from "next/dynamic";

// Client wrapper hosting the dynamic(ssr:false) import — Next 15 forbids
// ssr:false directly in a Server Component, and page.tsx became one for the
// ISR data prefetch (perf pass 2026-06-11). Keeping the page body in an async
// chunk preserves the 2026-06-10 bundle split (~104kB First Load JS).
const NutritionClient = dynamic(() => import("./NutritionClient"), {
  ssr: false,
  loading: () => (
    <div className="py-12 text-center text-[12px] font-mono text-text-tertiary">Loading…</div>
  ),
});

// Shape of the server-prefetched initial data. MUST mirror the analytics
// Promise.all in NutritionClient's range effect (same functions, same args) —
// the client seeds its state from this and then silently revalidates on mount.
// PARTIAL prefetch by design: behavioral-today, Cronometer servings, and the
// weight quick-log stay 100% client-side (write-coupled / dependent fetches).
export interface NutritionInitial {
  nutritionData: unknown[];
  burntData: unknown[];
  vitaminsData: unknown[];
  fullNutrients: unknown[];
}

export default function NutritionLoader({ initial }: { initial: NutritionInitial | null }) {
  return <NutritionClient initial={initial} />;
}
