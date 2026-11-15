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

// Speed (2026-11-15): start loading the page's code as soon as this module runs (with the page's first scripts)
// instead of after hydration, when the component above first renders; next/dynamic then finds the chunk on its
// way (one request, webpack shares it). A cold or freshly deployed load waited ~0.8 s for this request.
if (typeof window !== "undefined") void import("./NutritionClient").catch(() => {});

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

// headingTestId: "feed-page-heading" when the continuous scroll renders this page (its FeedSection).
export default function NutritionLoader({ initial, headingTestId }: { initial: NutritionInitial | null; headingTestId?: string }) {
  return <NutritionClient initial={initial} headingTestId={headingTestId} />;
}
