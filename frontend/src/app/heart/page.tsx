import HeartLoader, { type HeartInitial } from "./HeartLoader";
import {
  getWhoopRecovery, getWhoopCycles, getHeartRateData, getDailySummaries, rangeDays,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints charts from props with zero blocking
// browser→Supabase queries; the client then silently revalidates on mount
// (SWR), so a stale snapshot (single-user traffic can leave the cache cold
// overnight) heals in ~1s without a skeleton. lib/queries.ts runs server-side
// as-is: module-level anon supabase-js client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function HeartPage() {
  let initial: HeartInitial | null = null;
  try {
    // MUST equal HeartClient's default range ("30d") — the client seeds its
    // charts from this without re-labeling, so a mismatch would silently
    // render wrong-window data.
    const days = rangeDays("30d");
    const [recovery, cycles, hr, summaries] = await Promise.all([
      getWhoopRecovery(days),
      getWhoopCycles(days),
      getHeartRateData(days),
      getDailySummaries(days),
    ]);
    initial = { recovery, cycles, hr, summaries };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/heart] server prefetch failed; falling back to client fetch", e);
  }
  return <HeartLoader initial={initial} />;
}
