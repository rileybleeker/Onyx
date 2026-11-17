import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { etDay, groupOrders, itemsLabel, type ClassifiedOrder } from "@/lib/online-orders";
import { loadOrders } from "@/lib/online-orders-server";

export const dynamic = "force-dynamic";

// Which orders are in a group and where each stands, as an opaque fingerprint (no order detail leaves in it):
// Today's quiet view keys a "hide here" on it, so a different package with the same count is a new circumstance.
// The reason text is left out (it carries a daily countdown, "N days ago", which is not a new circumstance); what
// it is built from that matters (state, status, issue, due date, part delivered) is in.
function groupVersion(list: readonly ClassifiedOrder[]): string {
  const lines = list.map((c) => [c.order.key, c.state, c.order.status, c.order.issue ?? "", c.due ?? "", c.order.partiallyDelivered ? "part" : ""].join("|")).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// GET /api/orders/summary: the counts Today shows (owner session only, via middleware).
// {status: "ready", attention, arrivingToday, onTheWay, top: [{merchant, label, reason}], attentionVersion,
// arrivingVersion, lastSync} where top is up to three orders that need attention, the two versions fingerprint the
// orders behind the attention and arriving-today counts and lastSync is the package email check's last run
// ({at, status}, never its error text; null when none could be read); {status: "not_connected"} until the tables exist.
export async function GET() {
  // Speed (2026-11-17): reads only the open orders (scope "open"); the counts below are unchanged by that (see online-orders.ts).
  const now = new Date();
  const data = await loadOrders(now, "open");
  if (data.state === "error") return NextResponse.json({ error: "orders unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  if (data.state === "not_connected") return NextResponse.json({ status: "not_connected" }, { headers: { "Cache-Control": "no-store" } });
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
    lastSync: data.lastSync ? { at: data.lastSync.at, status: data.lastSync.status } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
