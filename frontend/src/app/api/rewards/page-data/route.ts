import { NextResponse } from "next/server";
import { loadRewards } from "@/lib/rewards-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/rewards/page-data -> {now, load}
// What /rewards (page.tsx) passes to its view, for the page's section in the continuous scroll. Owner session only
// (middleware; never in isCiRoute()), same-origin GET, never cached by a browser or a CDN; the client keeps it in
// memory only (the /api/rewards prefix is in isSensitiveKey). A failed read answers 500 with the page's error state.
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  const now = new Date();
  const load = await loadRewards(now);
  return NextResponse.json({ now: now.toISOString(), load }, { status: load.kind === "error" ? 500 : 200, headers: NO_STORE });
}
