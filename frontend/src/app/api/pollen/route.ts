import { NextResponse } from "next/server";
import { loadPollen } from "@/lib/pollen-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/pollen: daily pollen counts published in the last 730 ET days (owner session only, via
// middleware; deliberately NOT in isCiRoute). {status: "ready", days} | {status: "not_connected"}.
export async function GET() {
  const data = await loadPollen();
  if (data.state === "error") return NextResponse.json({ error: "pollen unavailable" }, { status: 500, headers: NO_STORE });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: NO_STORE });
  return NextResponse.json({ status: "ready", days: data.rows }, { headers: NO_STORE });
}
