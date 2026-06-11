import ActivitiesLoader, { type ActivitiesInitial } from "./ActivitiesLoader";
import {
  getActivities, getWhoopWorkouts, getWorkouts, getDailySummaries,
  getWhoopCycles, getHeartRateData, getRunningRecoveryContext, rangeDays,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints the activity list + charts from props with zero
// blocking browser→Supabase queries; the client then silently revalidates on
// mount (SWR), so a stale snapshot heals in ~1s without a skeleton.
// lib/queries.ts runs server-side as-is: module-level anon supabase-js
// client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function ActivitiesPage() {
  let initial: ActivitiesInitial | null = null;
  try {
    // MUST equal ActivitiesClient's default range ("30d") — the client seeds
    // its list/charts from this without re-labeling, so a mismatch would
    // silently render wrong-window data. Same 7 functions, same explicit
    // args as the client's mount-effect Promise.all (getWorkouts takes no
    // range — full planned-workout dim table, matching the effect).
    // DELIBERATELY NOT prefetched: the second-stage getActivityLaps fetch —
    // it derives its ids from recoveryContext client-side; the client seeds
    // lapsByActivity empty and fills it during the silent first revalidation.
    const days = rangeDays("30d");
    const [garmin, whoop, workouts, summaries, cycles, hr, recoveryContext] =
      await Promise.all([
        getActivities(days),
        getWhoopWorkouts(days),
        getWorkouts(),
        getDailySummaries(days),
        getWhoopCycles(days),
        getHeartRateData(days),
        getRunningRecoveryContext(days),
      ]);
    initial = { garmin, whoop, workouts, summaries, cycles, hr, recoveryContext };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/activities] server prefetch failed; falling back to client fetch", e);
  }
  return <ActivitiesLoader initial={initial} />;
}
