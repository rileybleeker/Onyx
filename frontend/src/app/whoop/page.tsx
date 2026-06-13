import WhoopLoader, { type WhoopInitial } from "./WhoopLoader";
import {
  getWhoopRecovery, getWhoopCycles, getWhoopSleep, getBehaviorLog, rangeDays,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints charts from props with zero blocking
// browser→Supabase queries; the client then silently revalidates on mount
// (SWR), so a stale snapshot (single-user traffic can leave the cache cold
// overnight) heals in ~1s without a skeleton. lib/queries.ts runs server-side
// as-is: module-level anon supabase-js client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function WhoopPage() {
  let initial: WhoopInitial | null = null;
  try {
    // MUST equal WhoopClient's default range ("30d") — the client seeds its
    // charts from this without re-labeling, so a mismatch would silently
    // render wrong-window data.
    const days = rangeDays("30d");
    const [recovery, cycles, sleep, journal] = await Promise.all([
      getWhoopRecovery(days),
      getWhoopCycles(days),
      getWhoopSleep(days),
      getBehaviorLog(days),
    ]);
    initial = { recovery, cycles, sleep, journal };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/whoop] server prefetch failed; falling back to client fetch", e);
  }
  return <WhoopLoader initial={initial} />;
}
