import { NextResponse } from "next/server";
import { loadAirQuality } from "@/lib/air-quality-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/air-quality: daily PM2.5 for the last 90 ET days (owner session only, via middleware;
// deliberately NOT in isCiRoute). {status: "ready", days, location} | {status: "not_connected"}.
export async function GET() {
  const data = await loadAirQuality();
  if (data.state === "error") return NextResponse.json({ error: "air quality unavailable" }, { status: 500, headers: NO_STORE });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: NO_STORE });
  return NextResponse.json({ status: "ready", days: data.rows, location: data.location }, { headers: NO_STORE });
}
