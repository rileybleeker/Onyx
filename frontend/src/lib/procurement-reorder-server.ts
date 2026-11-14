import "server-only";
import { etDate } from "@/lib/format";
import { LedgerQueryError, fetchPaged, serviceClient } from "@/lib/finance-ledger-server";
import { REORDER_WINDOW_DAYS, parseOrderInput, reorderSuggestions, type OrderInput, type ReorderLoad } from "@/lib/procurement-reorder";

/**
 * Server side of the purchase suggestions on /procurement. SERVICE ROLE ONLY: pds.online_orders
 * has no browser grants; never import this from a client component. It reads item names, the
 * store and the order dates of the last 540 days (explicit column list; that table holds no
 * prices, addresses or payment details) and nothing else. Restaurant delivery tables are not
 * read. Failures log an error code only - never an item or a store.
 */

const COLS = "order_key,merchant_name,items,status,ordered_at,shipped_at,first_event_at";
const MAX_PAGES = 10;
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const DAY_MS = 86_400_000;

export async function loadReorderSuggestions(now: Date = new Date()): Promise<ReorderLoad> {
  try {
    const db = serviceClient();
    const since = new Date(now.getTime() - REORDER_WINDOW_DAYS * DAY_MS).toISOString();
    const { rows } = await fetchPaged(
      (from, to) =>
        db
          .from("online_orders")
          .select(COLS, { count: "exact" })
          .gte("first_event_at", since)
          .order("first_event_at", { ascending: true })
          .order("order_key", { ascending: true })
          .range(from, to),
      MAX_PAGES,
    );
    const orders = rows.flatMap((r) => {
      const o = parseOrderInput(r, etDate);
      return o && o.items.length > 0 ? [o] : [];
    }) as OrderInput[];
    if (orders.length === 0) return { state: "empty" };
    const today = etDate(now.toISOString());
    return { state: "ok", today, orders: orders.length, ...reorderSuggestions(orders, today) };
  } catch (e) {
    const code = e instanceof LedgerQueryError && e.code ? e.code : "unexpected";
    if (MISSING_TABLE.has(code)) return { state: "not_connected" };
    console.error("[/procurement] order history read failed", code);
    return { state: "error", code };
  }
}
