import SleepLoader, { type SleepInitial } from "./SleepLoader";
import {
  getWhoopSleepAll, getWhoopRecovery, getWhoopCycles,
  getWhoopJournal, getEightSleepTrends, getDailySummaries, rangeDays,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints charts from props with zero blocking
// browser→Supabase queries; the client then silently revalidates on mount
// (SWR), so a stale snapshot (single-user traffic can leave the cache cold
// overnight) heals in ~1s without a skeleton. lib/queries.ts runs server-side
// as-is: module-level anon supabase-js client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function SleepPage() {
  let initial: SleepInitial | null = null;
  try {
    // MUST equal SleepClient's default range ("30d") — the client seeds its
    // charts from this without re-labeling, so a mismatch would silently
    // render wrong-window data.
    const days = rangeDays("30d");
    // Single whoop_sleep fetch (perf round 3): getWhoopSleep was a strict
    // subset of getWhoopSleepAll (same columns, minus the is_nap filter), so
    // the client derives the main-only rows from whoopSleepAll — shipping
    // both duplicated ~33kB of rows in the RSC payload.
    const [whoopSleepAll, whoopRecovery, whoopCycles, journal, eightSleep, summaries] =
      await Promise.all([
        getWhoopSleepAll(days),
        getWhoopRecovery(days),
        getWhoopCycles(days),
        getWhoopJournal(days),
        getEightSleepTrends(days),
        getDailySummaries(days),
      ]);
    initial = { whoopSleepAll, whoopRecovery, whoopCycles, journal, eightSleep, summaries };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/sleep] server prefetch failed; falling back to client fetch", e);
  }
  return <SleepLoader initial={initial} />;
}
