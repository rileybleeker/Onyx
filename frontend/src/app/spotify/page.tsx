import SpotifyLoader, { type SpotifyInitial } from "./SpotifyLoader";
import {
  getSpotifyDashboard, getSpotifyDailyVolume, getSpotifyAudioFeatureDrift,
} from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints charts from props with zero blocking
// browser→Supabase queries; the client then silently revalidates on mount
// (SWR), so a stale snapshot (single-user traffic can leave the cache cold
// overnight) heals in ~1s without a skeleton. lib/queries.ts runs server-side
// as-is: module-level anon supabase-js client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function SpotifyPage() {
  let initial: SpotifyInitial | null = null;
  try {
    // MUST equal SpotifyClient's default range ("30d"), passed EXPLICITLY to
    // every call — the function defaults diverge from what the client's mount
    // effect passes (getSpotifyDailyVolume defaults to "90d",
    // getSpotifyAudioFeatureDrift to "60d"), so relying on defaults would
    // silently render wrong-window data. The user-paginated ledger fetch is
    // deliberately NOT prefetched (client-only, keeps its loading state).
    const [dashboard, volume, drift] = await Promise.all([
      getSpotifyDashboard("30d"),
      getSpotifyDailyVolume("30d"),
      getSpotifyAudioFeatureDrift("30d"),
    ]);
    initial = { dashboard, volume, drift };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/spotify] server prefetch failed; falling back to client fetch", e);
  }
  return <SpotifyLoader initial={initial} />;
}
