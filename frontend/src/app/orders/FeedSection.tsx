"use client";

import PageSkeleton from "@/components/PageSkeleton";
import type { OrdersLoad } from "@/lib/online-orders-server";
import { useServerPageData } from "@/lib/server-page-data";
import OrdersClient from "./OrdersClient";

// /orders inside the continuous scroll: the same screen as the routed page (OrdersClient), with the data
// page.tsx renders on the server read from GET /api/orders/page-data through the shared client cache
// (a cached copy at once, then the live answer). Got it / Hide / Undo write exactly as on the page.

const URL = "/api/orders/page-data";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A cached or fetched answer checked like the server's own shape; throws on anything else. */
function readOrders(raw: unknown): OrdersLoad {
  if (isObject(raw)) {
    if (raw.state === "ready" && Array.isArray(raw.orders) && Array.isArray(raw.marks)) return raw as OrdersLoad;
    if (raw.state === "not_connected" || raw.state === "error") return raw as OrdersLoad;
  }
  throw new Error("malformed orders answer");
}

/** A failed read is shown when nothing else is, never cached. */
const complete = (data: OrdersLoad) => data.state !== "error";

export default function OrdersFeedSection() {
  const { data, version, failed } = useServerPageData(URL, readOrders, complete);
  // OrdersClient seeds its marks from the data once, so a different answer remounts it (key).
  if (data) return <OrdersClient key={version} data={data} nowIso={new Date().toISOString()} feed />;
  if (failed) return <OrdersClient data={{ state: "error" }} nowIso={new Date().toISOString()} feed />;
  return <PageSkeleton title="Orders" width="max-w-2xl" tiles={0} blocks={["h-40"]} list={4} />;
}
