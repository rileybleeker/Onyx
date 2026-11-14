import "server-only";
import { etDate } from "@/lib/format";
import { toCents } from "@/lib/finance-ledger";
import { fetchPaged, loadCategoryFixes, serviceClient } from "@/lib/finance-ledger-server";
import { categoryOptions, fixedCategory } from "@/lib/finance-categories";
import { computeBudgets, type BudgetTxn, type BudgetsResult } from "@/lib/finance-budgets";

/**
 * Server reads/writes for /financials/budgets. SERVICE ROLE ONLY ("server-only"; the caller is behind the
 * owner-only middleware). Explicit columns; logs carry error codes only, never rows.
 */
const COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";

export type BudgetsLoad =
  | { kind: "ok"; result: BudgetsResult; categories: string[]; rules: { merchantKey: string; category: string }[]; setupPending: boolean }
  | { kind: "empty" }
  | { kind: "error"; code: string };

export async function loadBudgetData(now: Date = new Date()): Promise<{ txns: BudgetTxn[]; budgets: Map<string, number>; today: string; rules: { merchantKey: string; category: string }[]; setupPending: boolean }> {
  const db = serviceClient();
  const today = etDate(now.toISOString());
  const since = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 200 * 86_400_000).toISOString().slice(0, 10);
  const [rows, fixes, budgetsRes] = await Promise.all([
    fetchPaged((f, t) => db.from("finance_transactions").select(COLS, { count: "exact" }).gte("txn_date", since).order("txn_date", { ascending: true }).order("txn_key", { ascending: true }).range(f, t), 40),
    loadCategoryFixes(db),
    db.from("finance_budgets").select("category,monthly_cents"),
  ]);
  const txns: BudgetTxn[] = [];
  for (const raw of rows.rows) {
    const r = raw as Record<string, unknown>;
    const cents = toCents(r.amount_cents);
    if (typeof r.txn_key !== "string" || typeof r.account_key !== "string" || typeof r.txn_date !== "string" || cents === null) continue;
    txns.push({
      txn_key: r.txn_key,
      account_key: r.account_key,
      txn_date: r.txn_date,
      name: typeof r.name === "string" ? r.name : "",
      custom_name: typeof r.custom_name === "string" ? r.custom_name : null,
      amount_cents: cents,
      currency: typeof r.currency === "string" ? r.currency : "USD",
      category: fixedCategory(r, fixes),
      ignored_from: typeof r.ignored_from === "string" ? r.ignored_from : null,
    });
  }
  const budgets = new Map<string, number>();
  for (const b of (budgetsRes.data ?? []) as { category: string; monthly_cents: unknown }[]) {
    const c = toCents(b.monthly_cents);
    if (c && c > 0) budgets.set(b.category, c);
  }
  return { txns, budgets, today, rules: [...fixes.rules.entries()].map(([merchantKey, category]) => ({ merchantKey, category })), setupPending: !!budgetsRes.error };
}

export async function loadBudgets(now: Date = new Date()): Promise<BudgetsLoad> {
  try {
    const d = await loadBudgetData(now);
    if (!d.txns.length) return { kind: "empty" };
    const result = computeBudgets(d.txns, d.budgets, d.today);
    return { kind: "ok", result, categories: categoryOptions(result.categoriesSeen), rules: d.rules.sort((a, b) => a.merchantKey.localeCompare(b.merchantKey)), setupPending: d.setupPending };
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
    console.error(`budgets load failed: ${code}`);
    return { kind: "error", code };
  }
}

export async function saveBudget(category: string, monthlyCents: number | null): Promise<boolean> {
  const db = serviceClient();
  const res = monthlyCents === null ? await db.from("finance_budgets").delete().eq("category", category) : await db.from("finance_budgets").upsert({ category, monthly_cents: monthlyCents, updated_at: new Date().toISOString() });
  if (res.error) console.error(`budget save failed: ${res.error.code ?? "unknown"}`);
  return !res.error;
}

export async function saveCategoryFix(kind: "rule" | "txn", key: string, category: string | null): Promise<boolean> {
  const db = serviceClient();
  const table = kind === "rule" ? "finance_category_rules" : "finance_txn_categories";
  const col = kind === "rule" ? "merchant_key" : "txn_key";
  const res = category === null ? await db.from(table).delete().eq(col, key) : await db.from(table).upsert({ [col]: key, category, updated_at: new Date().toISOString() });
  if (res.error) console.error(`category fix save failed: ${res.error.code ?? "unknown"}`);
  return !res.error;
}
