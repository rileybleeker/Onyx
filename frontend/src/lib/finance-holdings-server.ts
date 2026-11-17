import "server-only";
import { serviceClient } from "@/lib/finance-service-client";
import { accountLabel } from "@/lib/finance-ledger";

/**
 * Investment positions and activity (SimpleFIN feed, 2026-11-17), read for /financials. SERVICE ROLE ONLY like the
 * rest of pds.finance_*: the tables have RLS on and no policies, the page sits behind the owner-only middleware,
 * every query lists its columns and nothing here logs row contents (a failure logs a code only).
 *
 * Fails open: a missing table (sql/finance_holdings.sql not applied) or a failed read gives `unavailable` and the
 * page shows a short line instead of the panel, never an error screen.
 */

export interface HoldingLine {
  holdingId: string;
  symbol: string | null;
  description: string | null;
  shares: number | null;
  marketValueCents: number | null;
  costBasisCents: number | null;
  currency: string;
}

export interface ActivityLine {
  txnKey: string;
  date: string;
  amountCents: number;
  name: string | null;
  currency: string;
}

export interface InvestmentAccount {
  accountKey: string;
  label: string;
  seenAt: string;
  holdings: HoldingLine[];
  activity: ActivityLine[];
}

export type InvestmentsLoad =
  | { status: "ok"; accounts: InvestmentAccount[] }
  | { status: "empty" }
  | { status: "unavailable" };

const ACTIVITY_DAYS = 90;
const ACTIVITY_PER_ACCOUNT = 15;

interface HoldingRow {
  account_key: string;
  holding_id: string;
  symbol: string | null;
  description: string | null;
  shares: number | string | null;
  market_value_cents: number | string | null;
  cost_basis_cents: number | string | null;
  currency: string | null;
  seen_at: string;
}
interface ActivityRow {
  txn_key: string;
  account_key: string;
  txn_date: string;
  amount_cents: number | string;
  name: string | null;
  currency: string | null;
}
interface AccountRow {
  account_key: string;
  institution: string;
  account_name: string;
  mask: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Keeps, per account, only the positions of its newest run (a position that left the account keeps an older seen_at). */
export function currentHoldings(rows: HoldingRow[]): Map<string, HoldingRow[]> {
  const newest = new Map<string, string>();
  for (const r of rows) {
    const t = newest.get(r.account_key);
    if (!t || r.seen_at > t) newest.set(r.account_key, r.seen_at);
  }
  const out = new Map<string, HoldingRow[]>();
  for (const r of rows) {
    if (r.seen_at !== newest.get(r.account_key)) continue;
    const list = out.get(r.account_key) ?? [];
    list.push(r);
    out.set(r.account_key, list);
  }
  return out;
}

export async function loadInvestments(now: Date = new Date()): Promise<InvestmentsLoad> {
  try {
    const db = serviceClient();
    const since = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000).toISOString().slice(0, 10);
    const [h, a, acc] = await Promise.all([
      db
        .from("finance_holdings")
        .select("account_key,holding_id,symbol,description,shares,market_value_cents,cost_basis_cents,currency,seen_at")
        .order("account_key")
        .order("holding_id")
        .limit(2000),
      db
        .from("finance_investment_activity")
        .select("txn_key,account_key,txn_date,amount_cents,name,currency")
        .gte("txn_date", since)
        .order("txn_date", { ascending: false })
        .order("txn_key")
        .limit(500),
      db.from("finance_accounts").select("account_key,institution,account_name,mask").eq("account_type", "Investment"),
    ]);
    for (const res of [h, a, acc]) {
      if (res.error) {
        console.error("finance holdings read failed", res.error.code ?? "unknown");
        return { status: "unavailable" };
      }
    }
    const holdingsByAccount = currentHoldings((h.data ?? []) as unknown as HoldingRow[]);
    const activity = (a.data ?? []) as unknown as ActivityRow[];
    const accounts: InvestmentAccount[] = [];
    for (const row of (acc.data ?? []) as unknown as AccountRow[]) {
      const hs = holdingsByAccount.get(row.account_key) ?? [];
      const acts = activity.filter((r) => r.account_key === row.account_key).slice(0, ACTIVITY_PER_ACCOUNT);
      if (!hs.length && !acts.length) continue;
      accounts.push({
        accountKey: row.account_key,
        label: accountLabel(row),
        seenAt: hs.reduce((m, r) => (r.seen_at > m ? r.seen_at : m), ""),
        holdings: hs.map((r) => ({
          holdingId: r.holding_id,
          symbol: r.symbol,
          description: r.description,
          shares: num(r.shares),
          marketValueCents: num(r.market_value_cents),
          costBasisCents: num(r.cost_basis_cents),
          currency: r.currency || "USD",
        })),
        activity: acts.map((r) => ({
          txnKey: r.txn_key,
          date: r.txn_date,
          amountCents: num(r.amount_cents) ?? 0,
          name: r.name,
          currency: r.currency || "USD",
        })),
      });
    }
    accounts.sort((x, y) => x.label.localeCompare(y.label));
    return accounts.length ? { status: "ok", accounts } : { status: "empty" };
  } catch (e) {
    console.error("finance holdings read failed", e instanceof Error ? e.name : "error");
    return { status: "unavailable" };
  }
}
