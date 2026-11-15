import { loadTravelPageData } from "@/lib/travel-server";
import TravelView from "./TravelView";

// ISR (perf pass 2026-06-11): was force-dynamic with a service-role client and
// an unbounded full-view scan on every visit. Now revalidated hourly to match
// the ETL cadence, reading via the shared server client (it already sets
// db.schema = "pds") and the 15-min matview. Reads and calculations live in
// lib/travel-server.ts + lib/travel.ts and the screen in TravelView.tsx, shared
// with the continuous scroll (FeedSection.tsx via GET /api/travel/page-data).
export const revalidate = 3600;

export default async function TravelPage() {
  const data = await loadTravelPageData();
  return <TravelView data={data} />;
}
