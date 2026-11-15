import { NextRequest, NextResponse } from "next/server";
import { loadTravelPageData } from "@/lib/travel-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/travel/page-data: what /analytics/travel draws (trips, flights, the HRV trajectory and the
// outbound / return summaries; the HRV rows stay on the server), for that page inside the continuous scroll.
// Owner session only, via middleware (deliberately NOT in isCiRoute). Same reads as the page
// (lib/travel-server.ts): each section fails open to empty and logs a database code only.
export async function GET(req: NextRequest) {
  // A same-origin fetch sends Sec-Fetch-Site: same-origin; a request another site caused is refused.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json(await loadTravelPageData(), { headers: NO_STORE });
  } catch (e) {
    console.error("[api/travel/page-data] failed", (e as { name?: string } | null)?.name ?? "error");
    return NextResponse.json({ error: "travel unavailable" }, { status: 500, headers: NO_STORE });
  }
}
