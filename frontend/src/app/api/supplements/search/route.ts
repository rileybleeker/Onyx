import { NextRequest, NextResponse } from "next/server";
import { dsldSearch } from "@/lib/dsld";

/**
 * GET /api/supplements/search?q=<query>&size=<n>
 *
 * Proxies DSLD search so the browser never directly hits the upstream
 * (lets us add caching / rate-limiting later without a frontend change).
 * Accepts brand names, product names, or UPC digit strings.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const size = Math.min(Number(req.nextUrl.searchParams.get("size") ?? 10), 25);
  if (!q) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  try {
    const hits = await dsldSearch(q, size);
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
