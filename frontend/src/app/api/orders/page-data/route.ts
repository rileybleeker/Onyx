import { NextRequest, NextResponse } from "next/server";
import { loadOrders } from "@/lib/online-orders-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/orders/page-data: exactly what app/orders/page.tsx hands to OrdersClient (the OrdersLoad:
// {state: "ready", orders, marks, lastSync} | {state: "not_connected", lastSync} | {state: "error"}),
// for the /orders section of the continuous scroll (app/orders/FeedSection.tsx). Read with the same
// server function as the page (lib/online-orders-server.ts, service role; the tables stay service-role
// only and the browser never queries them). Owner session only: middleware is the gate and this path is
// NOT in its CI-token carve-out (only /api/orders/amazon/import is). GET only, same-origin, never cached
// by the browser or CDN. Read-only: nothing is marked or written. Logs a code only, never order content.
export async function GET(req: NextRequest) {
  // A same-origin GET carries no Origin header; Sec-Fetch-Site says which site caused it.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json(await loadOrders(new Date()), { headers: NO_STORE });
  } catch {
    console.error("[api/orders/page-data] read failed");
    return NextResponse.json({ error: "orders unavailable" }, { status: 500, headers: NO_STORE });
  }
}
