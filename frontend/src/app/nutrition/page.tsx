import NutritionLoader, { type NutritionInitial } from "./NutritionLoader";
import {
  getNutrition, getWhoopCaloriesBurnt, getDailyVitamins, getDailyNutrientsFull,
  rangeDays,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// analytics data serialized into the RSC payload, revalidated hourly to match
// the ETL cadence. The browser paints the macro/vitamin charts from props with
// zero blocking browser→Supabase queries; the client then silently revalidates
// on mount (SWR), so a stale snapshot heals in ~1s without a skeleton.
// PARTIAL prefetch: only the analytics Promise.all block is prefetched here —
// /api/behavioral-today, getCronometerServings (depends on behavioral-today),
// and the write-coupled /api/weight quick-log stay client-side, untouched.
// lib/queries.ts runs server-side as-is: module-level anon supabase-js client,
// RLS grants anon read-only.
export const revalidate = 3600;

export default async function NutritionPage() {
  let initial: NutritionInitial | null = null;
  try {
    // MUST equal NutritionClient's default range ("30d") — the client seeds
    // its charts from this without re-labeling, so a mismatch would silently
    // render wrong-window data. Pass days explicitly: function-default args
    // are not guaranteed to match what the client's effect passes.
    const days = rangeDays("30d");
    const [nutritionData, burntData, vitaminsData, fullNutrients] =
      await Promise.all([
        getNutrition(days),
        getWhoopCaloriesBurnt(days),
        getDailyVitamins(days),
        getDailyNutrientsFull(days),
      ]);
    initial = { nutritionData, burntData, vitaminsData, fullNutrients };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/nutrition] server prefetch failed; falling back to client fetch", e);
  }
  return <NutritionLoader initial={initial} />;
}
