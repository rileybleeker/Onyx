import "server-only";
import { etDate } from "@/lib/format";
import { LedgerQueryError, fetchPaged, serviceClient } from "@/lib/finance-ledger-server";
import {
  RECURRING_WINDOW_DAYS,
  activeMonthlyTotal,
  addDays,
  detectRecurring,
  parseRecurringInput,
  type DetectedLoad,
  type RecurringInput,
} from "@/lib/procurement-recurring";

/**
 * Server-side recurring-charge detection for /procurement. SERVICE ROLE ONLY (pds.finance_* has no
 * browser grants); never import from a client component. The page sits behind the owner login and
 * is rendered per request. Failures log an error code only - never a row, name or amount.
 */

const COLS = "txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const MAX_PAGES = 40;

export async function loadDetectedSubscriptions(now: Date = new Date()): Promise<DetectedLoad> {
  try {
    const db = serviceClient();
    const today = etDate(now.toISOString());
    const since = addDays(today, -RECURRING_WINDOW_DAYS);
    const { rows } = await fetchPaged(
      (from, to) =>
        db
          .from("finance_transactions")
          .select(COLS, { count: "exact" })
          .gte("txn_date", since)
          .order("txn_date", { ascending: false })
          .order("txn_key", { ascending: true })
          .range(from, to),
      MAX_PAGES,
    );
    if (rows.length === 0) return { state: "empty" };
    const inputs = rows.flatMap((r) => {
      const p = parseRecurringInput(r);
      return p ? [p] : [];
    }) as RecurringInput[];
    const subs = detectRecurring(inputs, today);
    return { state: "ok", subs, total: activeMonthlyTotal(subs), today };
  } catch (e) {
    const code = e instanceof LedgerQueryError && e.code ? e.code : "unexpected";
    console.error("[/procurement] recurring-charge query failed", code);
    return { state: "error", code };
  }
}
