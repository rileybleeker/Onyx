/**
 * Finance ledger (pds.finance_accounts / finance_transactions / finance_balance_snapshots).
 *
 * PURE functions over plain rows: no imports, no network, no clock (callers pass `now`), so the
 * whole module runs under the offline unit tests with synthetic data. The thin server fetchers
 * live in finance-ledger-server.ts; nothing here may import them or touch Supabase.
 *
 * Sign convention (from the source export, verified on the real data): `amount_cents` is
 * EXPENSE-POSITIVE. A purchase is +, income and refunds are -. Cashflow ("money in") is the
 * negation. Balances use `kind` ('asset' | 'liability' | null) instead of a sign.
 */

/** Categories that move money between the owner's own accounts - never spending or income. */
export const NON_SPENDING_CATEGORIES: readonly string[] = [
  "Internal Transfers",
  "Credit Card Payment",
  "Savings Transfer",
];
/** A balance older than this is flagged stale (the harvester runs daily). */
export const STALE_BALANCE_HOURS = 48;
export const LIST_PAGE_SIZE = 50;
export const TREND_MONTHS = 12;
export const UNCATEGORIZED = "Uncategorized";
const NON_SPENDING_LOWER = new Set(NON_SPENDING_CATEGORIES.map((c) => c.toLowerCase()));

export type BalanceKind = "asset" | "liability";

export interface LedgerAccount {
  account_key: string;
  institution: string;
  account_name: string;
  account_type: string;
  mask: string | null;
}
export interface LedgerBalance {
  account_key: string;
  captured_at: string;
  balance_cents: number;
  currency: string;
  kind: BalanceKind | null;
}
export interface LedgerTxn {
  account_key: string;
  txn_date: string; // YYYY-MM-DD
  amount_cents: number; // expense-positive
  currency: string;
  category: string | null;
  ignored_from: string | null;
}

// ─── Row parsing (PostgREST gives unknown JSON; a malformed row is dropped and counted) ─────────

/** bigint arrives as a JSON number, or as a digit string past 2^53 - accept only safe integers. */
export function toCents(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseAccount(raw: unknown): LedgerAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.account_key);
  if (!key) return null;
  return {
    account_key: key,
    institution: str(r.institution)?.trim() || "Unknown institution",
    account_name: str(r.account_name)?.trim() || "Account",
    account_type: str(r.account_type)?.trim() || "",
    mask: str(r.mask)?.trim() || null,
  };
}
export function parseBalance(raw: unknown): LedgerBalance | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.account_key);
  const at = str(r.captured_at);
  const cents = toCents(r.balance_cents);
  if (!key || !at || cents === null) return null;
  const kind = (str(r.kind) ?? "").trim().toLowerCase();
  return {
    account_key: key,
    captured_at: at,
    balance_cents: cents,
    currency: (str(r.currency) ?? "USD").trim().toUpperCase() || "USD",
    // Anything the source did not label clearly stays null: unclassified, never guessed.
    kind: kind === "asset" || kind === "liability" ? kind : null,
  };
}
export function parseTxn(raw: unknown): LedgerTxn | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.account_key);
  const date = str(r.txn_date);
  const cents = toCents(r.amount_cents);
  if (!key || !isDay(date) || cents === null) return null;
  return {
    account_key: key,
    txn_date: date,
    amount_cents: cents,
    currency: (str(r.currency) ?? "USD").trim().toUpperCase() || "USD",
    category: str(r.category),
    ignored_from: str(r.ignored_from),
  };
}

// ─── Spending vs movement of money ──────────────────────────────────────────────────────────────

export const isNonSpendingCategory = (category: string | null | undefined): boolean =>
  NON_SPENDING_LOWER.has((category ?? "").trim().toLowerCase());
/** The source flags rows the owner told it to leave out ("budget", "everything", ...). */
export const isIgnored = (ignoredFrom: string | null | undefined): boolean => (ignoredFrom ?? "").trim() !== "";
export type TxnClass = "counted" | "ignored" | "transfer";
export function classifyTxn(t: { category: string | null; ignored_from: string | null }): TxnClass {
  if (isIgnored(t.ignored_from)) return "ignored";
  if (isNonSpendingCategory(t.category)) return "transfer";
  return "counted";
}
export const categoryLabel = (category: string | null | undefined): string =>
  (category ?? "").trim() || UNCATEGORIZED;

export interface CategoryTotal {
  category: string;
  outCents: number;
  count: number;
}
export interface FlowSummary {
  moneyInCents: number; // refunds included: they are money coming back in, not income
  moneyOutCents: number;
  netCents: number;
  counted: number;
  transfers: number; // excluded: movement between own accounts
  ignored: number; // excluded: flagged ignored by the source
  foreign: number; // excluded: not USD (never added to USD totals)
  categories: CategoryTotal[]; // outflow only, largest first
}

/** Money in / out for one set of rows (callers pre-filter the month and account). */
export function summarizeFlows(rows: readonly LedgerTxn[]): FlowSummary {
  let moneyIn = 0;
  let moneyOut = 0;
  let counted = 0;
  let transfers = 0;
  let ignored = 0;
  let foreign = 0;
  const cats = new Map<string, CategoryTotal>(); // Map, not an object: "__proto__" is a legal category
  for (const t of rows) {
    if (t.currency !== "USD") {
      foreign++;
      continue;
    }
    const cls = classifyTxn(t);
    if (cls === "ignored") {
      ignored++;
      continue;
    }
    if (cls === "transfer") {
      transfers++;
      continue;
    }
    counted++;
    if (t.amount_cents > 0) {
      moneyOut += t.amount_cents;
      const label = categoryLabel(t.category);
      const entry = cats.get(label) ?? { category: label, outCents: 0, count: 0 };
      entry.outCents += t.amount_cents;
      entry.count += 1;
      cats.set(label, entry);
    } else if (t.amount_cents < 0) {
      moneyIn += -t.amount_cents;
    }
  }
  const categories = [...cats.values()].sort(
    (a, b) => b.outCents - a.outCents || a.category.localeCompare(b.category),
  );
  return {
    moneyInCents: moneyIn,
    moneyOutCents: moneyOut,
    netCents: moneyIn - moneyOut,
    counted,
    transfers,
    ignored,
    foreign,
    categories,
  };
}

/** Top `limit` categories plus a roll-up of the rest, for a readable ranking. */
export function rankCategories(categories: readonly CategoryTotal[], limit = 12) {
  const top = categories.slice(0, limit);
  const rest = categories.slice(limit);
  return {
    top,
    otherCount: rest.length,
    otherCents: rest.reduce((n, c) => n + c.outCents, 0),
    maxCents: top.length ? top[0].outCents : 0,
  };
}

// ─── Months ─────────────────────────────────────────────────────────────────────────────────────

export const isMonthKey = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthOf = (date: string): string => date.slice(0, 7);
export const monthStart = (month: string): string => `${month}-01`;
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
/** `count` consecutive months ending at `end`, oldest first. */
export function trailingMonths(end: string, count = TREND_MONTHS): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(end, i - (count - 1)));
}
/** Every month from `min` to `max` inclusive, newest first, capped (a long ledger stays pickable). */
export function monthsBetween(min: string, max: string, cap = 60): string[] {
  const out: string[] = [];
  for (let m = max; m >= min && out.length < cap; m = shiftMonth(m, -1)) out.push(m);
  return out;
}
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  return short ? `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}` : `${MONTH_NAMES[m - 1]} ${y}`;
}

export interface TrendPoint {
  month: string;
  label: string;
  outCents: number;
  inCents: number;
}
/** Spending per month over `months` (zero where there is nothing); same exclusions as the flows. */
export function monthlyTrend(rows: readonly LedgerTxn[], months: readonly string[]): TrendPoint[] {
  const byMonth = new Map<string, LedgerTxn[]>();
  for (const t of rows) {
    const k = monthOf(t.txn_date);
    const list = byMonth.get(k);
    if (list) list.push(t);
    else byMonth.set(k, [t]);
  }
  return months.map((month) => {
    const s = summarizeFlows(byMonth.get(month) ?? []);
    return { month, label: monthLabel(month, true), outCents: s.moneyOutCents, inCents: s.moneyInCents };
  });
}

// ─── Balances and net worth ─────────────────────────────────────────────────────────────────────

/** Newest snapshot per account (the fetcher asks for one, this keeps the contract if it gets more). */
export function latestBalances(rows: readonly LedgerBalance[]): Map<string, LedgerBalance> {
  const out = new Map<string, LedgerBalance>();
  for (const b of rows) {
    const cur = out.get(b.account_key);
    if (!cur || Date.parse(b.captured_at) > Date.parse(cur.captured_at)) out.set(b.account_key, b);
  }
  return out;
}
/** Unparseable capture times count as stale: a balance we cannot date is not a fresh one. */
export function isStale(capturedAt: string, now: Date, maxHours = STALE_BALANCE_HOURS): boolean {
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > maxHours * 3_600_000;
}
export function ageLabel(iso: string | null | undefined, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const mins = Math.floor((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
export function accountLabel(a: Pick<LedgerAccount, "institution" | "account_name" | "mask">): string {
  return `${a.institution} · ${a.account_name}${a.mask ? ` ••${a.mask}` : ""}`;
}

export interface BalanceLine {
  account: LedgerAccount;
  balance: LedgerBalance;
  stale: boolean;
  /** Signed effect on net worth in USD cents, or null when the line is left out of the totals. */
  contributionCents: number | null;
  /** Why a line is left out of the totals ('unclassified' | 'non-usd'), else null. */
  excluded: "unclassified" | "non-usd" | null;
}
export interface NetWorth {
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number; // amount owed, shown positive
  assets: BalanceLine[];
  liabilities: BalanceLine[];
  unclassified: BalanceLine[]; // kind null: listed, never guessed, not in the totals
  noBalance: LedgerAccount[]; // account exists but has no snapshot yet
  nonUsdCount: number;
  staleCount: number;
  oldestCapturedAt: string | null;
  includedCount: number;
}

/**
 * Net worth = assets - liabilities, from the newest balance per account.
 *  - kind 'asset': contributes its balance as stored (an overdrawn asset is negative).
 *  - kind 'liability': ALWAYS reduces net worth, by |balance|, whichever sign the source used
 *    for "amount owed".
 *  - kind null: not guessed from the account type; listed under `unclassified` and left out.
 *  - non-USD: never mixed into USD totals; listed and left out.
 */
export function computeNetWorth(
  accounts: readonly LedgerAccount[],
  balances: readonly LedgerBalance[],
  now: Date,
): NetWorth {
  const latest = latestBalances(balances);
  const assets: BalanceLine[] = [];
  const liabilities: BalanceLine[] = [];
  const unclassified: BalanceLine[] = [];
  const noBalance: LedgerAccount[] = [];
  let assetsCents = 0;
  let liabilitiesCents = 0;
  let nonUsdCount = 0;
  let staleCount = 0;
  let included = 0;
  let oldest: string | null = null;
  for (const account of accounts) {
    const balance = latest.get(account.account_key);
    if (!balance) {
      noBalance.push(account);
      continue;
    }
    const stale = isStale(balance.captured_at, now);
    if (stale) staleCount++;
    const usd = balance.currency === "USD";
    if (!usd) nonUsdCount++;
    let excluded: BalanceLine["excluded"] = null;
    let contribution: number | null = null;
    if (!balance.kind) excluded = "unclassified";
    else if (!usd) excluded = "non-usd";
    else if (balance.kind === "asset") contribution = balance.balance_cents;
    else contribution = -Math.abs(balance.balance_cents);
    const line: BalanceLine = { account, balance, stale, contributionCents: contribution, excluded };
    if (!balance.kind) unclassified.push(line);
    else if (balance.kind === "asset") assets.push(line);
    else liabilities.push(line);
    if (contribution !== null) {
      included++;
      if (balance.kind === "asset") assetsCents += contribution;
      else liabilitiesCents += -contribution;
      const ts = Date.parse(balance.captured_at);
      if (oldest === null || !Number.isFinite(ts) || ts < Date.parse(oldest)) oldest = balance.captured_at;
    }
  }
  const byMagnitude = (a: BalanceLine, b: BalanceLine) =>
    Math.abs(b.balance.balance_cents) - Math.abs(a.balance.balance_cents) ||
    accountLabel(a.account).localeCompare(accountLabel(b.account));
  assets.sort(byMagnitude);
  liabilities.sort(byMagnitude);
  unclassified.sort(byMagnitude);
  noBalance.sort((a, b) => accountLabel(a).localeCompare(accountLabel(b)));
  return {
    netWorthCents: assetsCents - liabilitiesCents,
    assetsCents,
    liabilitiesCents,
    assets,
    liabilities,
    unclassified,
    noBalance,
    nonUsdCount,
    staleCount,
    oldestCapturedAt: oldest,
    includedCount: included,
  };
}

// ─── Query string, search and paging ────────────────────────────────────────────────────────────

export interface LedgerQuery {
  month: string | null; // null = newest month with data (resolved by the fetcher)
  account: string | null;
  q: string;
  page: number;
  allMonths: boolean; // list search ignores the month picker
}
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Characters kept in a search term: nothing PostgREST's `or=(...)` syntax or ILIKE treats as special. */
export function sanitizeSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // "$1,234.50" is an amount search: drop the symbol and grouping commas rather than the digits.
  const text = searchAmountCents(raw) !== null ? raw.trim().replace(/^\$/, "").replace(/,/g, "") : raw;
  return text
    .replace(/[^A-Za-z0-9À-ɏ .'&#/+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
/** "12.50", "$12.50", "1,234.5" -> cents (unsigned), else null. */
export function searchAmountCents(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\$/, "");
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 1_000_000_000_000 ? cents : null;
}
/** PostgREST `or` filter for the transaction list, or null when the term is empty. */
export function buildSearchFilter(rawQ: string): string | null {
  const text = sanitizeSearch(rawQ);
  const parts: string[] = [];
  if (text) {
    for (const col of ["name", "custom_name", "category", "description"]) parts.push(`${col}.ilike.*${text}*`);
  }
  const cents = searchAmountCents(rawQ);
  if (cents !== null) parts.push(`amount_cents.eq.${cents}`, `amount_cents.eq.${-cents}`);
  return parts.length ? parts.join(",") : null;
}

export function parseLedgerQuery(sp: Record<string, string | string[] | undefined>): LedgerQuery {
  const month = first(sp.month);
  const account = first(sp.account);
  const page = Number.parseInt(first(sp.page) ?? "1", 10);
  return {
    month: isMonthKey(month) ? month : null,
    account: account && /^[0-9a-fA-F]{1,64}$/.test(account) ? account.toLowerCase() : null,
    q: sanitizeSearch(first(sp.q)),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 100_000) : 1,
    allMonths: first(sp.scope) === "all",
  };
}
/** Link to the same page with some fields changed. Defaults are left out of the URL. */
export function ledgerHref(current: LedgerQuery, over: Partial<LedgerQuery> = {}): string {
  const n = { ...current, ...over };
  const p = new URLSearchParams();
  if (n.month) p.set("month", n.month);
  if (n.account) p.set("account", n.account);
  if (n.q) p.set("q", n.q);
  if (n.allMonths) p.set("scope", "all");
  if (n.page > 1) p.set("page", String(n.page));
  const s = p.toString();
  return s ? `/financials?${s}` : "/financials";
}
export function pageWindow(page: number, size = LIST_PAGE_SIZE) {
  const from = (Math.max(1, page) - 1) * size;
  return { from, to: from + size - 1 };
}
export function pageCount(total: number, size = LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}
