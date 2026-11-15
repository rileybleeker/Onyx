import { NextRequest, NextResponse } from "next/server";
import { getWins } from "@/lib/wins-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/wins: the Wins board (public GitHub pull-request highlights, lib/wins-server.ts) for the continuous
 * scroll's Wins page (app/wins/FeedSection.tsx). The /wins page itself still renders it on the server.
 * Owner session only (middleware; never in isCiRoute()), same-origin GET, never cached by a proxy.
 * Logs carry a code only.
 */
export async function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross-origin request refused" }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json(await getWins(), { headers: NO_STORE });
  } catch {
    console.error("[wins] board unavailable", "unexpected");
    return NextResponse.json({ error: "wins unavailable" }, { status: 500, headers: NO_STORE });
  }
}
