import BlandAltmanLoader, { type BlandAltmanInitial } from "./BlandAltmanLoader";
import { getHealthMatrix, rangeDays } from "@/lib/queries";

// ISR (perf pass 2026-06-11): prerender the page with the default range's
// data serialized into the RSC payload, revalidated hourly to match the ETL
// cadence. The browser paints charts from props with zero blocking
// browser→Supabase queries; the client then silently revalidates on mount
// (SWR), so a stale snapshot (single-user traffic can leave the cache cold
// overnight) heals in ~1s without a skeleton. lib/queries.ts runs server-side
// as-is: module-level anon supabase-js client, RLS grants anon read-only.
export const revalidate = 3600;

export default async function BlandAltmanPage() {
  let initial: BlandAltmanInitial | null = null;
  try {
    // MUST equal BlandAltmanClient's default range ("30d") — the client seeds
    // its charts from this without re-labeling, so a mismatch would silently
    // render wrong-window data.
    const data = await getHealthMatrix(rangeDays("30d"));
    initial = { data };
  } catch (e) {
    // Fail open: ship initial=null and the client fetches exactly as it did
    // pre-ISR. Never let a Supabase error break the build or the page.
    console.error("[/bland-altman] server prefetch failed; falling back to client fetch", e);
  }
  return <BlandAltmanLoader initial={initial} />;
}
