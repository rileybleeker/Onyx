import { NextRequest } from "next/server";
import { NOT_CONNECTED } from "@/lib/care-google";
import { calendarStatus } from "@/lib/care-google-server";
import { careJson, loadCareItems, type CareLoad } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// GET /api/care/page-data: exactly what app/health/page.tsx hands to HealthClient, for the
// /health section of the continuous scroll (app/health/FeedSection.tsx), which renders in the
// browser. {initial: CareLoad, calendar: CalendarStatus}; a failed care-items read is
// {state: "error"} like on the page, so the view shows its own "Couldn't load" state.
// Owner session only: middleware is the gate and this path is not in its CI-token carve-out.
// GET only, same-origin, no-store. The client keeps the answer in memory only (persist: false).
// Logs carry a database error code only (inside loadCareItems), never item text.
export async function GET(req: NextRequest) {
  // A same-origin GET carries no Origin header; Sec-Fetch-Site says which site caused it.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return careJson({ error: "cross_origin" }, 403);
  // Same reads and fallbacks as the page. The calendar status makes no Google call, and no
  // database call until credentials exist.
  const [initial, calendar] = await Promise.all([
    loadCareItems().catch((): CareLoad => ({ state: "error" })),
    calendarStatus().catch(() => NOT_CONNECTED),
  ]);
  return careJson({ initial, calendar });
}
