import { NextRequest, NextResponse } from "next/server";
import { loadScreenTime } from "@/lib/screen-time-server";
import { parseWindowDays } from "@/lib/screen-time";
import { screenTimeViewData } from "@/lib/screen-time-view";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/screen-time/page-data?days=N: exactly what app/screen-time/page.tsx hands to ScreenTimeView for
 * the same ?days= (parseWindowDays: 7 to 180, default 30), for the /screen-time section of the continuous
 * scroll (app/screen-time/FeedSection.tsx). Read on the server with the service role through
 * lib/screen-time-server.ts, like the page (pds.phone_usage_* stays service-role only), and reduced to what
 * the screen shows (lib/screen-time-view.ts: averages, chart points, the two top-10 lists): no per-day app
 * breakdown leaves the server. A failed read is {kind: "error", hint} like on the page.
 * Owner session only: middleware is the gate and this path is NOT in its CI-token carve-out (only
 * /api/screen-time/usage is). GET only, same-origin, never cached by the browser or CDN, and the client
 * cache keeps /api/screen-time in memory only (isSensitiveKey). Logs a code only (inside the loader).
 */
export async function GET(req: NextRequest) {
  // A same-origin GET carries no Origin header; Sec-Fetch-Site says which site caused it.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  const windowDays = parseWindowDays(req.nextUrl.searchParams.get("days") ?? undefined);
  try {
    return NextResponse.json(screenTimeViewData(await loadScreenTime(windowDays)), { headers: NO_STORE });
  } catch {
    console.error("[api/screen-time/page-data] read failed");
    return NextResponse.json({ error: "screen time unavailable" }, { status: 500, headers: NO_STORE });
  }
}
