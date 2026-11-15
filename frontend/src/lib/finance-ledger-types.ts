/**
 * The shapes the finance ledger loader (finance-ledger-server.ts) returns. TYPES ONLY: no runtime code, so a
 * client component (the /financials section of the continuous scroll, app/financials/FeedSection.tsx) can name
 * them without importing the server module, which must never reach the browser.
 */
import type { FlowSummary, LedgerAccount, LedgerQuery, NetWorth, TrendPoint, TxnClass } from "@/lib/finance-ledger";
import type { FinanceCard } from "@/lib/finance-status";

export interface ListRow {
  txn_key: string;
  account_key: string;
  txn_date: string;
  title: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  excluded: Exclude<TxnClass, "counted"> | null;
  /** Normalized merchant label, the key a category rule uses. */
  merchant_key: string;
}
export interface LedgerData {
  query: LedgerQuery & { month: string };
  accounts: LedgerAccount[];
  accountLabels: Record<string, string>;
  months: string[];
  netWorth: NetWorth;
  flows: FlowSummary;
  trend: TrendPoint[];
  list: { rows: ListRow[]; total: number; page: number; pageCount: number; pageSize: number };
  freshness: FinanceCard | null;
  /** Rows that could not be read, and whether the 12-month window was cut off. */
  skippedRows: number;
  windowTruncated: boolean;
  /** The page asked for is past the end; page 1 is shown instead. */
  pageClamped: boolean;
}
export type LedgerLoad =
  | { kind: "error"; message: string; hint: string | null }
  | { kind: "empty"; freshness: FinanceCard | null }
  | { kind: "ok"; data: LedgerData };
