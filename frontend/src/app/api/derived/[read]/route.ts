import { NextRequest, NextResponse } from "next/server";
import { checkSince, isDerivedRead } from "@/lib/derived-reads";
import { DERIVED_READERS, readFailureCode } from "@/lib/derived-reads-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/derived/<name>[?since=YYYY-MM-DD]: the rows of ONE fixed materialized-view read (lib/derived-reads.ts:
 * the names, their date rule; lib/derived-reads-server.ts: the queries, explicit columns, service role), for the
 * browser, which must not read a matview directly (no row security on a matview: any signed-in account would see
 * every row). Answers {rows}. Owner session only: middleware is the gate (getClaims sub = the owner, else a
 * redirect to /login) and this path is deliberately NOT in isCiRoute. GET only, same-origin, never cached by the
 * browser or CDN. A failed read answers 500 and logs the read name and a database code only, never row data.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ read: string }> }) {
  // A same-origin fetch sends Sec-Fetch-Site: same-origin; a request another site caused is refused.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  const { read } = await params;
  if (!isDerivedRead(read)) return NextResponse.json({ error: "unknown_read" }, { status: 404, headers: NO_STORE });
  const query = req.nextUrl.searchParams;
  const keys = [...query.keys()];
  if (keys.some((k) => k !== "since") || keys.length > 1) {
    return NextResponse.json({ error: "bad_query" }, { status: 400, headers: NO_STORE });
  }
  const since = checkSince(read, query.get("since"));
  if (!since.ok) return NextResponse.json({ error: "bad_since" }, { status: 400, headers: NO_STORE });
  try {
    const rows = await DERIVED_READERS[read](since.since);
    return NextResponse.json({ rows }, { headers: NO_STORE });
  } catch (e) {
    console.error(`[api/derived/${read}] read failed`, readFailureCode(e));
    return NextResponse.json({ error: "unavailable" }, { status: 500, headers: NO_STORE });
  }
}
