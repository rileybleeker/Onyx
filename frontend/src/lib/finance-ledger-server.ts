import "server-only";
import { createClient } from "@supabase/supabase-js";
import { etDate } from "@/lib/format";
import {
  LIST_PAGE_SIZE,
  TREND_MONTHS,
  accountLabel,
  buildSearchFilter,
  computeNetWorth,
  monthOf,
  monthStart,
  monthsBetween,
  monthlyTrend,
  pageCount,
  pageWindow,
  parseAccount,
  parseBalance,
  parseTxn,
  shiftMonth,
  summarizeFlows,
  toCents,
  trailingMonths,
  classifyTxn,
  type FlowSummary,
  type LedgerAccount,
  type LedgerBalance,
  type LedgerQuery,
  type LedgerTxn,
  type NetWorth,
  type TrendPoint,
  type TxnClass,
} from "@/lib/finance-ledger";
import { financeLedgerCard, type FinanceCard } from "@/lib/finance-status";

/**
 * Server-side reads of the finance ledger. SERVICE ROLE ONLY: pds.finance_* has RLS on, no
 * policies and no grants to anon/authenticated, so the browser can never query it and this
 * module must never be imported from a client component ("server-only" enforces that at build
 * time). The caller (app/financials/page.tsx) sits behind the owner-only middleware.
 *
 * Every query lists its columns (never select "*"). Nothing here logs row contents: failures
 * log only an error code. The result is rendered per request - no ISR, no shared cache.
 */

const ACCOUNT_COLS = "account_key,institution,account_name,account_type,mask";
const BALANCE_COLS = "account_key,captured_at,balance_cents,currency,kind";
// The 12-month window needs only what the arithmetic uses.
const WINDOW_COLS = "account_key,txn_date,amount_cents,currency,category,ignored_from";
const LIST_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const HEARTBEAT_COLS = "status,sync_start,records_synced,duration_seconds,error_message";
const PAGE = 1000; // PostgREST's default max rows per request
const MAX_WINDOW_PAGES = 40; // 40k rows of window; beyond that the page says so

export interface ListRow {
  txn_key: string;
  account_key: string;
  txn_date: string;
  title: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  excluded: Exclude<TxnClass, "counted"> | null;
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

interface PgErr {
  code?: string;
  message?: string;
}
export class LedgerQueryError extends Error {
  constructor(readonly code: string | null) {
    super(code ?? "query failed");
  }
}

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new LedgerQueryError("not-configured");
  return createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
}
type Db = ReturnType<typeof serviceClient>;

function check<T extends { error: PgErr | null }>(res: T): T {
  if (res.error) throw new LedgerQueryError(res.error.code ?? "unknown");
  return res;
}

/**
 * Page through a query 1000 rows at a time. The exact row count (asked for on every page) decides
 * when to stop, so a project whose PostgREST max-rows is lower than 1000 still returns every row
 * instead of silently stopping after a short first page. `truncated` is true when the page cap cut
 * the read off before the count was reached.
 */
export async function fetchPaged(
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PgErr | null; count: number | null }>,
  maxPages: number,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows: unknown[] = [];
  for (let i = 0; i < maxPages; i++) {
    const { data, count } = check(await build(rows.length, rows.length + PAGE - 1));
    const got = data ?? [];
    rows.push(...got);
    if (got.length === 0 || (typeof count === "number" ? rows.length >= count : got.length < PAGE)) {
      return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}

async function dateEdge(db: Db, ascending: boolean): Promise<string | null> {
  const { data } = check(
    await db.from("finance_transactions").select("txn_date").order("txn_date", { ascending }).limit(1),
  );
  const v = (data?.[0] as { txn_date?: unknown } | undefined)?.txn_date;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

async function heartbeat(db: Db, dataType: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("sync_log")
    .select(HEARTBEAT_COLS)
    .eq("source", "rocketmoney")
    .eq("data_type", dataType)
    .order("sync_start", { ascending: false })
    .limit(1);
  // The freshness line is context, not the ledger: a failed read just omits it.
  return error ? null : ((data?.[0] as Record<string, unknown> | undefined) ?? null);
}

export async function loadLedger(query: LedgerQuery, now: Date = new Date()): Promise<LedgerLoad> {
  let db: Db;
  try {
    db = serviceClient();
  } catch (e) {
    return fail(e);
  }
  try {
    const [accountsRes, minDate, maxDate, txHeartbeat, balHeartbeat, keepaliveHeartbeat] = await Promise.all([
      db.from("finance_accounts").select(ACCOUNT_COLS).order("institution").order("account_name").order("account_key"),
      dateEdge(db, true),
      dateEdge(db, false),
      heartbeat(db, "transactions"),
      heartbeat(db, "balances"),
      heartbeat(db, "keepalive"),
    ]);
    const accounts = (check(accountsRes).data ?? [])
      .map(parseAccount)
      .filter((a): a is LedgerAccount => a !== null);
    const freshness =
      txHeartbeat || balHeartbeat ? financeLedgerCard(txHeartbeat, balHeartbeat, now.getTime(), keepaliveHeartbeat) : null;

    if (accounts.length === 0 && maxDate === null) return { kind: "empty", freshness };

    // Month: the one asked for, else the newest month that has transactions, else this month (ET).
    const month = query.month ?? (maxDate ? monthOf(maxDate) : monthOf(etDate(now.toISOString())));
    const account = query.account && accounts.some((a) => a.account_key === query.account) ? query.account : null;
    const months = monthsBetween(minDate ? monthOf(minDate) : month, maxDate ? monthOf(maxDate) : month);
    if (!months.includes(month)) months.unshift(month);

    // Newest balance per account: one limit-1 read each (accounts are few; this avoids a full
    // snapshot history scan and any need for a database view).
    const balanceReads = accounts.map(async (a): Promise<{ balance: LedgerBalance | null; bad: boolean }> => {
      const { data } = check(
        await db
          .from("finance_balance_snapshots")
          .select(BALANCE_COLS)
          .eq("account_key", a.account_key)
          .order("captured_at", { ascending: false })
          .limit(1),
      );
      const balance = parseBalance(data?.[0]);
      return { balance, bad: !!data?.length && balance === null };
    });

    const windowStart = monthStart(trailingMonths(month, TREND_MONTHS)[0]);
    const windowEnd = monthStart(shiftMonth(month, 1)); // exclusive
    const windowRead = fetchPaged((from, to) => {
      let qb = db
        .from("finance_transactions")
        .select(WINDOW_COLS, { count: "exact" })
        .gte("txn_date", windowStart)
        .lt("txn_date", windowEnd);
      if (account) qb = qb.eq("account_key", account);
      return qb.order("txn_date", { ascending: false }).order("txn_key", { ascending: true }).range(from, to);
    }, MAX_WINDOW_PAGES);

    const listRead = readList(db, { ...query, month, account }, accounts);
    const [balanceReadRows, windowRaw, list] = await Promise.all([Promise.all(balanceReads), windowRead, listRead]);
    const balanceRows = balanceReadRows.flatMap((r) => (r.balance ? [r.balance] : []));

    const windowRows: LedgerTxn[] = [];
    let skipped = 0;
    for (const raw of windowRaw.rows) {
      const t = parseTxn(raw);
      if (t) windowRows.push(t);
      else skipped++;
    }
    const monthRows = windowRows.filter((t) => monthOf(t.txn_date) === month);
    const accountLabels: Record<string, string> = {};
    for (const a of accounts) accountLabels[a.account_key] = accountLabel(a);

    return {
      kind: "ok",
      data: {
        query: { ...query, month, account },
        accounts,
        accountLabels,
        months,
        netWorth: computeNetWorth(accounts, balanceRows, now),
        flows: summarizeFlows(monthRows),
        trend: monthlyTrend(windowRows, trailingMonths(month, TREND_MONTHS)),
        list: list.list,
        freshness,
        skippedRows: skipped + list.skipped + balanceReadRows.filter((r) => r.bad).length,
        windowTruncated: windowRaw.truncated,
        pageClamped: list.clamped,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

async function readList(
  db: Db,
  q: LedgerQuery & { month: string },
  accounts: readonly LedgerAccount[],
): Promise<{ list: LedgerData["list"]; skipped: number; clamped: boolean }> {
  const filter = buildSearchFilter(q.q);
  const run = async (page: number) => {
    let qb = db.from("finance_transactions").select(LIST_COLS, { count: "exact" });
    if (!q.allMonths) qb = qb.gte("txn_date", monthStart(q.month)).lt("txn_date", monthStart(shiftMonth(q.month, 1)));
    if (q.account) qb = qb.eq("account_key", q.account);
    if (filter) qb = qb.or(filter);
    const { from, to } = pageWindow(page);
    return qb.order("txn_date", { ascending: false }).order("txn_key", { ascending: true }).range(from, to);
  };
  let page = q.page;
  let clamped = false;
  let res = await run(page);
  // A page past the end is a 416 from PostgREST (PGRST103), not an empty list: fall back to page 1.
  if (res.error?.code === "PGRST103" && page > 1) {
    page = 1;
    clamped = true;
    res = await run(1);
  }
  const { data, count } = check(res);
  const known = new Set(accounts.map((a) => a.account_key));
  const rows: ListRow[] = [];
  let skipped = 0;
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    const t = parseTxn(r);
    const key = typeof r.txn_key === "string" ? r.txn_key : null;
    const name = typeof r.name === "string" ? r.name : "";
    if (!t || !key || !known.has(t.account_key)) {
      skipped++;
      continue;
    }
    const custom = typeof r.custom_name === "string" ? r.custom_name.trim() : "";
    const cls = classifyTxn(t);
    rows.push({
      txn_key: key,
      account_key: t.account_key,
      txn_date: t.txn_date,
      title: custom || name || "(no description)",
      amount_cents: toCents(r.amount_cents) ?? 0,
      currency: t.currency,
      category: t.category,
      excluded: cls === "counted" ? null : cls,
    });
  }
  const total = typeof count === "number" ? count : rows.length;
  return {
    list: { rows, total, page, pageCount: pageCount(total), pageSize: LIST_PAGE_SIZE },
    skipped,
    clamped,
  };
}

function fail(e: unknown): LedgerLoad {
  const code = e instanceof LedgerQueryError ? e.code : null;
  // Only the error code is logged - never a row, a name, an amount or a search term.
  console.error("[/financials] ledger query failed", code ?? "unexpected");
  const missing = code === "42P01" || code === "PGRST205" || code === "42501";
  return {
    kind: "error",
    message: "Couldn't load the ledger.",
    hint: missing
      ? "The finance tables are missing or not readable by the server (code " + code + ")."
      : code === "not-configured"
        ? "The server has no Supabase service credentials configured."
        : code
          ? `The database query failed (code ${code}). Try again in a moment.`
          : "An unexpected error occurred. Try again in a moment.",
  };
}
