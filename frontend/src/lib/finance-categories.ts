/**
 * Category fixes for the finance ledger: "always file this merchant under X" rules and "just this transaction"
 * overrides (pds.finance_category_rules, pds.finance_txn_categories). PURE: no I/O. Applied when the ledger is
 * read, so the stored rows and the importer stay as they are.
 */
import { merchantKey, rowLabel } from "./procurement-recurring";

/** Categories offered in the picker: Rocket Money's usual set plus whatever the ledger already uses. */
export const STANDARD_CATEGORIES: readonly string[] = [
  "Auto & Transport",
  "Bills & Utilities",
  "Business",
  "Charity",
  "Credit Card Payment",
  "Dining & Drinks",
  "Education",
  "Entertainment & Rec.",
  "Family Care",
  "Fees",
  "Gifts",
  "Groceries",
  "Health & Wellness",
  "Home & Garden",
  "Income",
  "Insurance",
  "Internal Transfers",
  "Investments",
  "Legal",
  "Loan Payment",
  "Medical",
  "Personal Care",
  "Pets",
  "Rent",
  "Savings Transfer",
  "Shopping",
  "Software & Tech",
  "Taxes",
  "Travel & Vacation",
];

/**
 * A looser merchant key: the first three words with digits and punctuation removed. Groups charges whose
 * description carries a per-charge code (Privacy.com virtual cards, payroll references) under one merchant.
 */
export function wordKey(t: { name: string | null; custom_name: string | null }): string {
  return rowLabel(t)
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(" ");
}

export interface CategoryFixes {
  rules: ReadonlyMap<string, string>; // merchant key -> category
  overrides: ReadonlyMap<string, string>; // txn_key -> category
}
export const NO_FIXES: CategoryFixes = { rules: new Map(), overrides: new Map() };

export function isCategoryName(s: unknown): s is string {
  return typeof s === "string" && s.trim().length >= 1 && s.trim().length <= 60 && !/[<>{}]/.test(s);
}

/** The category a row is filed under after fixes: the transaction override, else the merchant rule, else the source's. */
export function fixedCategory(
  row: { txn_key?: unknown; name?: unknown; custom_name?: unknown; category?: unknown },
  fixes: CategoryFixes,
): string | null {
  const key = typeof row.txn_key === "string" ? row.txn_key : null;
  if (key) {
    const o = fixes.overrides.get(key);
    if (o) return o;
  }
  if (fixes.rules.size) {
    const t = { name: typeof row.name === "string" ? row.name : "", custom_name: typeof row.custom_name === "string" ? row.custom_name : null };
    const m = merchantKey(t);
    const r = (m ? fixes.rules.get(m) : undefined) ?? fixes.rules.get(wordKey(t));
    if (r) return r;
  }
  return typeof row.category === "string" ? row.category : null;
}

/** Raw PostgREST rows with their category fixed (a copy; the rest of each row is untouched). */
export function applyFixes<T extends Record<string, unknown>>(rows: readonly T[], fixes: CategoryFixes): T[] {
  if (!fixes.rules.size && !fixes.overrides.size) return rows as T[];
  return rows.map((r) => {
    const cat = fixedCategory(r, fixes);
    return cat === r.category ? r : { ...r, category: cat };
  });
}

export function categoryOptions(seen: Iterable<string | null>): string[] {
  const set = new Set<string>(STANDARD_CATEGORIES);
  for (const c of seen) if (c && c.trim()) set.add(c.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}
