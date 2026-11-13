import type { Metadata } from "next";
import { loadOrders } from "@/lib/online-orders-server";
import OrdersClient from "./OrdersClient";

// Private data read with the service role: rendered per request, never cached or prerendered.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Orders - Onyx", robots: { index: false, follow: false } };

export default async function OrdersPage() {
  const now = new Date();
  let data: Awaited<ReturnType<typeof loadOrders>>;
  try {
    data = await loadOrders(now);
  } catch {
    data = { state: "error" };
  }
  return <OrdersClient data={data} nowIso={now.toISOString()} />;
}
