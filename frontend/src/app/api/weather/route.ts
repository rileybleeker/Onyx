import { NextResponse } from "next/server";
import { loadWeather } from "@/lib/weather-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/weather: daily outdoor weather for the last 90 ET days (owner session only, via
// middleware; deliberately NOT in isCiRoute). {status: "ready", days, location} | {status: "not_connected"}.
export async function GET() {
  const data = await loadWeather();
  if (data.state === "error") return NextResponse.json({ error: "weather unavailable" }, { status: 500, headers: NO_STORE });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: NO_STORE });
  return NextResponse.json({ status: "ready", days: data.rows, location: data.location }, { headers: NO_STORE });
}
