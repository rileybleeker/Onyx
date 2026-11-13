import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  MARK_COLUMNS,
  ORDER_COLUMNS,
  ORDERS_WINDOW_DAYS,
  parseMarkRow,
  parseOrderRow,
  type OnlineOrder,
  type OrderMark,
} from "@/lib/online-orders";

/**
 * Server-side reads of pds.online_orders / pds.online_order_marks. SERVICE ROLE ONLY: the tables
 * have RLS on, no policies and no grants to anon / authenticated, so the browser never queries
 * them, and "server-only" keeps this module out of client bundles. Callers (app/orders/page.tsx,
 * /api/orders/*) sit behind the owner-only middleware. Errors log a code only, never row content.
 */

export function ordersDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface OrdersSync {
  at: string;
  status: string;
  error: string | null;
}

export type OrdersLoad =
  | { state: "ready"; orders: OnlineOrder[]; marks: OrderMark[]; lastSync: OrdersSync | null }
  | { state: "not_connected"; lastSync: OrdersSync | null }
  | { state: "error" };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

export async function loadOrders(now: Date = new Date()): Promise<OrdersLoad> {
  const db = ordersDb();
  const since = new Date(now.getTime() - ORDERS_WINDOW_DAYS * 86_400_000).toISOString();
  const [ordersRes, marksRes, syncRes] = await Promise.all([
    db.from("online_orders").select(ORDER_COLUMNS)
      .gte("last_event_at", since)
      .order("last_event_at", { ascending: false })
      .order("order_key", { ascending: true })
      .limit(1000),
    db.from("online_order_marks").select(MARK_COLUMNS).order("alias_key", { ascending: true }).limit(2000),
    db.from("sync_log").select("sync_start,status,error_message")
      .eq("source", "online_orders").eq("data_type", "email")
      .order("sync_start", { ascending: false }).limit(1),
  ]);
  const sync = syncRes.error ? null : syncRes.data?.[0];
  const lastSync: OrdersSync | null = sync?.sync_start
    ? { at: String(sync.sync_start), status: String(sync.status ?? "unknown"), error: (sync.error_message as string | null) ?? null }
    : null;
  if (ordersRes.error || marksRes.error) {
    const code = ordersRes.error?.code ?? marksRes.error?.code ?? "";
    if (MISSING_TABLE.has(code)) return { state: "not_connected", lastSync };
    console.error("online orders read failed:", code || "unknown");
    return { state: "error" };
  }
  const orders = (ordersRes.data ?? []).map(parseOrderRow).filter((o): o is OnlineOrder => o !== null);
  const marks = (marksRes.data ?? []).map(parseMarkRow).filter((m): m is OrderMark => m !== null);
  return { state: "ready", orders, marks, lastSync };
}
