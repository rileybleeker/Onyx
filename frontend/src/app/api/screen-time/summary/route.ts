import { NextResponse } from "next/server";
import { loadScreenTime } from "@/lib/screen-time-server";
import { summarize } from "@/lib/screen-time";

export const dynamic = "force-dynamic";

/**
 * GET /api/screen-time/summary: the few numbers the overview card on Today shows (the last 7 days' totals,
 * the averages over complete days, the last sync). Read on the server with the service role through
 * lib/screen-time-server.ts, exactly like /screen-time (pds.phone_usage_* stays service-role only); answers
 * NO app or category names. Owner session only: NOT in middleware's isCiRoute() (only /api/screen-time/usage
 * is), never CDN-cached, and the client cache keeps it in memory only (lib/client-cache.ts isSensitiveKey).
 *
 * -> {status: "ready", days: [{date, totalMin, lateNightMin, pickups, complete}], avgTotalMin, avgLateNightMin,
 *     avgPickups, completeDays, sync} | {status: "empty", sync}; 500 when the read fails (code logged only).
 */

const NO_STORE = { "Cache-Control": "no-store" };
/** One more day than the chart shows, so the newest complete day is always in the window. */
const WINDOW_DAYS = 8;

export async function GET() {
  const load = await loadScreenTime(WINDOW_DAYS);
  if (load.kind === "error") return NextResponse.json({ error: "screen time unavailable" }, { status: 500, headers: NO_STORE });
  if (load.kind === "empty") return NextResponse.json({ status: "empty", sync: load.sync }, { headers: NO_STORE });
  const s = summarize(load.days);
  return NextResponse.json(
    {
      status: "ready",
      days: load.days.slice(-7).map((d) => ({ date: d.date, totalMin: d.totalMin, lateNightMin: d.lateNightMin, pickups: d.pickups, complete: d.complete })),
      avgTotalMin: s.avgTotalMin,
      avgLateNightMin: s.avgLateNightMin,
      avgPickups: s.avgPickups,
      completeDays: s.completeDays,
      sync: load.sync,
    },
    { headers: NO_STORE },
  );
}
