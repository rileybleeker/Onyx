import { NextResponse } from "next/server";
import { groupOrders, itemsLabel } from "@/lib/online-orders";
import { loadOrders } from "@/lib/online-orders-server";

export const dynamic = "force-dynamic";

// GET /api/orders/summary: the counts Today shows (owner session only, via middleware).
// {status: "ready", attention, arrivingToday, onTheWay, top: [{merchant, label, reason}]} where top
// is up to three orders that need attention; {status: "not_connected"} until the tables exist.
export async function GET() {
  const data = await loadOrders();
  if (data.state === "error") return NextResponse.json({ error: "orders unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: { "Cache-Control": "no-store" } });
  const g = groupOrders(data.orders, data.marks, new Date());
  return NextResponse.json({
    status: "ready",
    attention: g.attention.length,
    arrivingToday: g.arrivingToday,
    onTheWay: g.arriving.length,
    top: g.attention.slice(0, 3).map((c) => ({ merchant: c.order.merchant, label: itemsLabel(c.order), reason: c.reason })),
  }, { headers: { "Cache-Control": "no-store" } });
}
