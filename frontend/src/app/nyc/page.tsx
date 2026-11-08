import NycLoader from "./NycLoader";
import { getNycLeads, type NycLead } from "@/lib/nyc";

// ISR like the other read-mostly dashboards: the scout writes once a day, so
// an hourly snapshot is plenty; the client silently revalidates on mount via
// /api/nyc/leads, and Riley's own edits drop the snapshot (revalidateTag in
// the PATCH route).
export const revalidate = 3600;

export default async function NycPage() {
  let initial: NycLead[] | null = null;
  try {
    // MUST match the client's mount fetch (GET /api/nyc/leads → getNycLeads()):
    // same rows, same Number-descending order, so the sameJson bail-out holds.
    initial = await getNycLeads();
  } catch (e) {
    // Fail open: the client fetches itself and shows the error if it persists.
    console.error("[/nyc] server prefetch failed; falling back to client fetch", e);
  }
  return <NycLoader initial={initial} />;
}
