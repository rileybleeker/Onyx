import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { etDay, groupOrders, itemsLabel, type ClassifiedOrder } from "@/lib/online-orders";
import { loadOrders } from "@/lib/online-orders-server";

export const dynamic = "force-dynamic";

// Which orders are in a group and where each stands, as an opaque fingerprint (no order detail leaves in it):
// Today's quiet view keys a "hide here" on it, so a different package with the same count is a new circumstance.
function groupVersion(list: readonly ClassifiedOrder[]): string {
  const lines = list.map((c) => [c.order.key, c.state, c.order.status, c.order.issue ?? "", c.due ?? "", c.reason].join("|")).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// GET /api/orders/summary: the counts Today shows (owner session only, via middleware).
// {status: "ready", attention, arrivingToday, onTheWay, top: [{merchant, label, reason}], attentionVersion,
// arrivingVersion} where top is up to three orders that need attention and the two versions fingerprint the
// orders behind the attention and arriving-today counts; {status: "not_connected"} until the tables exist.
export async function GET() {
  const data = await loadOrders();
  if (data.state === "error") return NextResponse.json({ error: "orders unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: { "Cache-Control": "no-store" } });
  const now = new Date();
  const g = groupOrders(data.orders, data.marks, now);
  const today = etDay(now);
  return NextResponse.json({
    status: "ready",
    attention: g.attention.length,
    arrivingToday: g.arrivingToday,
    onTheWay: g.arriving.length,
    top: g.attention.slice(0, 3).map((c) => ({ merchant: c.order.merchant, label: itemsLabel(c.order), reason: c.reason })),
    attentionVersion: groupVersion(g.attention),
    arrivingVersion: groupVersion(g.arriving.filter((c) => c.due === today)),
  }, { headers: { "Cache-Control": "no-store" } });
}
