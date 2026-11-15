/**
 * Budgets and spending insights over the finance ledger (/financials/budgets). PURE: no I/O, no clock (callers
 * pass `today`). Amounts in, like the ledger, are EXPENSE-POSITIVE cents; everything here reports spending as
 * positive cents. Only counted USD rows are used (card payments and transfers never count as spending, so a
 * purchase on a card counts once). Categories are taken AFTER the category fixes (lib/finance-categories.ts).
 */
import { classifyTxn, UNCATEGORIZED } from "./finance-ledger";
import { daysBetween, displayMerchant, merchantKey, rowLabel } from "./procurement-recurring";
import { wordKey } from "./finance-categories";

export const TOTAL_KEY = "__total__";
export const REVIEW_DAYS = 90;

export interface BudgetTxn {
  txn_key: string;
  account_key: string;
  txn_date: string;
  name: string;
  custom_name: string | null;
  amount_cents: number;
  currency: string;
  category: string | null;
  ignored_from: string | null;
}
export type BudgetStatus = "over" | "at-risk" | "ok" | "none";
export interface BudgetLine {
  category: string;
  budgetCents: number | null;
  spentCents: number;
  projectedCents: number;
  avg3Cents: number;
  suggestedCents: number;
  sameDaysAvgCents: number;
  lastMonthCents: number;
  status: BudgetStatus;
}
export interface MerchantTotal {
  key: string;
  label: string;
  category: string;
  cents: number;
  count: number;
  lastDate: string;
}
export interface BudgetsResult {
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
  lines: BudgetLine[];
  total: BudgetLine;
  incomeCents: number;
  incomeAvg3Cents: number;
  increases: { category: string; cents: number; usualCents: number }[];
  topMerchants: MerchantTotal[];
  uncategorized: MerchantTotal[];
  categoriesSeen: string[];
}

const monthKey = (iso: string) => iso.slice(0, 7);
const dim = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const shift = (key: string, delta: number) => {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const roundUp10 = (cents: number) => Math.ceil(cents / 1000) * 1000;
const catOf = (t: BudgetTxn) => (t.category ?? "").trim() || UNCATEGORIZED;
const INCOME_RE = /^(income|paycheck|salary|interest income|dividends?|refunds? & reimbursements?)$/i;

export function computeBudgets(txns: readonly BudgetTxn[], budgets: ReadonlyMap<string, number>, today: string): BudgetsResult {
  const month = monthKey(today);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = dim(month);
  const prev = [1, 2, 3, 4, 5, 6].map((k) => shift(month, -k));
  const counted = txns.filter((t) => (t.currency ?? "USD").toUpperCase() === "USD" && classifyTxn(t) === "counted" && t.txn_date <= today);

  // Net by category and month; a category whose net over the window is money in is income, not spending.
  const byCatMonth = new Map<string, Map<string, number>>();
  const byCatMonthSameDays = new Map<string, Map<string, number>>();
  for (const t of counted) {
    const m = monthKey(t.txn_date);
    if (m !== month && !prev.includes(m)) continue;
    const c = catOf(t);
    const mm = byCatMonth.get(c) ?? new Map<string, number>();
    mm.set(m, (mm.get(m) ?? 0) + t.amount_cents);
    byCatMonth.set(c, mm);
    if (Number(t.txn_date.slice(8, 10)) <= dayOfMonth) {
      const sd = byCatMonthSameDays.get(c) ?? new Map<string, number>();
      sd.set(m, (sd.get(m) ?? 0) + t.amount_cents);
      byCatMonthSameDays.set(c, sd);
    }
  }
  const isIncome = (c: string) => INCOME_RE.test(c) || [...(byCatMonth.get(c)?.values() ?? [])].reduce((a, b) => a + b, 0) < 0;

  const lines: BudgetLine[] = [];
  let incomeCents = 0;
  const incomeMonths = [0, 0, 0];
  const cats = new Set<string>([...byCatMonth.keys(), ...[...budgets.keys()].filter((k) => k !== TOTAL_KEY)]);
  for (const c of cats) {
    const mm = byCatMonth.get(c) ?? new Map();
    if (isIncome(c)) {
      incomeCents += -(mm.get(month) ?? 0);
      prev.slice(0, 3).forEach((m, i) => (incomeMonths[i] += -(mm.get(m) ?? 0)));
      continue;
    }
    const spent = Math.max(0, mm.get(month) ?? 0);
    const last3 = prev.slice(0, 3).map((m) => Math.max(0, mm.get(m) ?? 0));
    const avg3 = Math.round(mean(last3));
    const sd = byCatMonthSameDays.get(c) ?? new Map();
    const sameDaysAvg = Math.round(mean(prev.slice(0, 3).map((m) => Math.max(0, sd.get(m) ?? 0))));
    const projected = Math.round(spent + avg3 * Math.max(0, (daysInMonth - dayOfMonth) / daysInMonth));
    const budget = budgets.get(c) ?? null;
    lines.push({
      category: c,
      budgetCents: budget,
      spentCents: spent,
      projectedCents: projected,
      avg3Cents: avg3,
      suggestedCents: roundUp10(median(last3)),
      sameDaysAvgCents: sameDaysAvg,
      lastMonthCents: last3[0],
      status: budget === null ? "none" : spent > budget ? "over" : projected > budget ? "at-risk" : "ok",
    });
  }
  lines.sort((a, b) => b.spentCents + b.avg3Cents - (a.spentCents + a.avg3Cents) || a.category.localeCompare(b.category));
  const sum = (f: (l: BudgetLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const catBudgets = lines.filter((l) => l.budgetCents !== null).reduce((s, l) => s + (l.budgetCents ?? 0), 0);
  const totalBudget = budgets.get(TOTAL_KEY) ?? (catBudgets > 0 ? catBudgets : null);
  const totalSpent = sum((l) => l.spentCents);
  const totalProjected = sum((l) => l.projectedCents);
  const total: BudgetLine = {
    category: "Total",
    budgetCents: totalBudget,
    spentCents: totalSpent,
    projectedCents: totalProjected,
    avg3Cents: sum((l) => l.avg3Cents),
    suggestedCents: roundUp10(sum((l) => l.suggestedCents)),
    sameDaysAvgCents: sum((l) => l.sameDaysAvgCents),
    lastMonthCents: sum((l) => l.lastMonthCents),
    status: totalBudget === null ? "none" : totalSpent > totalBudget ? "over" : totalProjected > totalBudget ? "at-risk" : "ok",
  };
  const increases = lines
    .filter((l) => l.spentCents - l.sameDaysAvgCents >= 5_000 && l.spentCents > l.sameDaysAvgCents * 1.25)
    .map((l) => ({ category: l.category, cents: l.spentCents, usualCents: l.sameDaysAvgCents }))
    .sort((a, b) => b.cents - b.usualCents - (a.cents - a.usualCents))
    .slice(0, 5);

  // Merchants: this month's biggest, and uncategorized ones from the last 90 days (to file with one tap).
  const group = (rows: BudgetTxn[], loose = false): MerchantTotal[] => {
    const map = new Map<string, MerchantTotal>();
    for (const t of rows) {
      // Review groups by the looser key, so a rule covers charges with per-charge codes (Privacy.com).
      const key = loose ? wordKey(t) || merchantKey(t) : merchantKey(t);
      if (!key) continue;
      const cur = map.get(key) ?? { key, label: displayMerchant(rowLabel(t)), category: catOf(t), cents: 0, count: 0, lastDate: t.txn_date };
      cur.cents += t.amount_cents;
      cur.count += 1;
      if (t.txn_date > cur.lastDate) cur.lastDate = t.txn_date;
      map.set(key, cur);
    }
    return [...map.values()];
  };
  const spendRows = counted.filter((t) => t.amount_cents > 0 && !isIncome(catOf(t)));
  const topMerchants = group(spendRows.filter((t) => monthKey(t.txn_date) === month)).sort((a, b) => b.cents - a.cents).slice(0, 8);
  const uncategorized = group(counted.filter((t) => catOf(t) === UNCATEGORIZED && daysBetween(t.txn_date, today) <= REVIEW_DAYS), true)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))
    .slice(0, 40);

  return {
    month,
    dayOfMonth,
    daysInMonth,
    lines,
    total,
    incomeCents,
    incomeAvg3Cents: Math.round(mean(incomeMonths)),
    increases,
    topMerchants,
    uncategorized,
    categoriesSeen: [...new Set(txns.map((t) => (t.category ?? "").trim()).filter(Boolean))],
  };
}
