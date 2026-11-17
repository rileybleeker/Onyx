import "server-only";
import { LedgerQueryError, serviceClient } from "@/lib/finance-service-client";
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
  type LedgerAccount,
  type LedgerBalance,
  type LedgerQuery,
  type LedgerTxn,
} from "@/lib/finance-ledger";
import { FINANCE_SOURCE, simplefinLedgerCard } from "@/lib/finance-status";
import { NO_FIXES, applyFixes, fixedCategory, type CategoryFixes } from "@/lib/finance-categories";
import { merchantKey } from "@/lib/procurement-recurring";

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
// txn_key + names are read too, for the category fixes (merchant rules / one-off overrides).
const WINDOW_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const LIST_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const HEARTBEAT_COLS = "status,sync_start,records_synced,duration_seconds,error_message";
const PAGE = 1000; // PostgREST's default max rows per request
const MAX_WINDOW_PAGES = 40; // 40k rows of window; beyond that the page says so
// The 12-month window is read with its next 3 pages in the same round trip (up to 4,000 rows in one round trip;
// fetchPaged uses them only when the first page is full). Same rows, same order as the step-based read.
const WINDOW_SPECULATE_PAGES = 3;

// The shapes this module returns live in finance-ledger-types.ts (types only), so client code can name them
// without importing this server module.
export type { LedgerData, LedgerLoad, ListRow } from "@/lib/finance-ledger-types";
import type { LedgerData, LedgerLoad, ListRow } from "@/lib/finance-ledger-types";

interface PgErr {
  code?: string;
  message?: string;
}
// The client and its error live in lib/finance-service-client.ts (a small module the stored-result routes load
// without this one); re-exported here so every existing import is unchanged.
export { LedgerQueryError, serviceClient };
type Db = ReturnType<typeof serviceClient>;

function check<T extends { error: PgErr | null }>(res: T): T {
  if (res.error) throw new LedgerQueryError(res.error.code ?? "unknown");
  return res;
}

type PageResult = { data: unknown[] | null; error: PgErr | null; count: number | null };

/**
 * Read every row of a query in pages. The first page asks for the exact row count; the remaining
 * pages are then requested all at once (in parallel) and joined in offset order, so the result is
 * the same as reading them one after another as long as `build` orders by a unique key.
 *
 * `withCount` tells `build` whether to ask for the count (only the first page needs it). The page
 * size is the number of rows the first page actually returned, so a project whose PostgREST
 * max-rows is lower than 1000 still returns every row instead of leaving gaps between pages.
 * Without a count (a builder that never asks for one) the pages are read one after another until
 * a short page. `truncated` is true when the page cap cut the read off before the count.
 */
export async function fetchPaged(
  build: (from: number, to: number, withCount: boolean) => PromiseLike<PageResult>,
  maxPages: number,
  speculate = 0,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  // `speculate` (opt-in): the next `speculate` pages are also requested in the same round trip as the first one, at the
  // offsets a full page would use. They are used only when the first page came back full (PAGE rows); otherwise they are
  // dropped and the step-based reads below run as before. Reads of up to 1 + speculate full pages take one round trip.
  type Ahead = { ok: true; res: PageResult } | { ok: false; err: unknown };
  const ahead: Promise<Ahead>[] = Array.from({ length: speculate }, (_, i) => {
    const from = (i + 1) * PAGE;
    return Promise.resolve(build(from, from + PAGE - 1, false)).then(
      (res): Ahead => ({ ok: true, res }),
      (err: unknown): Ahead => ({ ok: false, err }),
    );
  });
  const first = check(await build(0, PAGE - 1, true));
  const rows: unknown[] = [...(first.data ?? [])];
  const step = rows.length;
  const total = typeof first.count === "number" ? first.count : null;
  if (step === 0 || (total !== null ? rows.length >= total : step < PAGE)) return { rows, truncated: false };

  if (total === null) {
    for (let i = 1; i < maxPages; i++) {
      const got = check(await build(rows.length, rows.length + PAGE - 1, false)).data ?? [];
      rows.push(...got);
      if (got.length < PAGE) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }

  const needed = Math.ceil(total / step);
  const later = Math.min(needed, maxPages) - 1;
  // Rows removed since the count: PostgREST answers a range past the end with 416 (PGRST103) -> no rows.
  const rowsOf = (res: PageResult) => (res.error?.code === "PGRST103" ? [] : (check(res).data ?? []));
  const pages = await Promise.all(
    Array.from({ length: later }, async (_, i) => {
      const from = (i + 1) * step;
      if (step === PAGE && i < ahead.length) {
        const got = await ahead[i];
        if (!got.ok) throw got.err;
        return rowsOf(got.res);
      }
      return rowsOf(await build(from, from + step - 1, false));
    }),
  );
  for (const got of pages) rows.push(...got);
  return { rows, truncated: needed > maxPages };
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
    .eq("source", FINANCE_SOURCE)
    .eq("data_type", dataType)
    .order("sync_start", { ascending: false })
    .limit(1);
  // The freshness line is context, not the ledger: a failed read just omits it.
  return error ? null : ((data?.[0] as Record<string, unknown> | undefined) ?? null);
}

const FIX_MAX_PAGES = 20; // 20k merchant rules or one-off fixes; a read that still stops there is reported

/**
 * Category fixes Riley made (merchant rules, one-off overrides). Fail-open: a missing table or a failed read
 * shows the source categories, never an error page. `failed` (optional, so other callers are unaffected) says a
 * read failed for another reason than a missing table; `truncated` says a read answered but stopped at its page
 * limit, so some fixes were not read. The cash forecast withholds its safe-to-move amount on either.
 *
 * Both tables are read in pages ordered by their primary key (fetchPaged): a single select would stop at the
 * server's row cap without an error and the missing fixes would go unnoticed.
 */
export async function loadCategoryFixes(db: Db): Promise<CategoryFixes & { failed?: boolean; truncated?: boolean }> {
  // A missing table (migration not applied) means no fixes were ever saved: the source categories are right.
  const MISSING = ["42P01", "PGRST205"];
  type FixRead = { rows: unknown[]; truncated: boolean; error: "missing" | "failed" | null };
  const read = async (build: Parameters<typeof fetchPaged>[0]): Promise<FixRead> => {
    try {
      const r = await fetchPaged(build, FIX_MAX_PAGES);
      return { rows: r.rows, truncated: r.truncated, error: null };
    } catch (e) {
      const code = e instanceof LedgerQueryError ? e.code : null;
      return { rows: [], truncated: false, error: code && MISSING.includes(code) ? "missing" : "failed" };
    }
  };
  const [rules, overrides] = await Promise.all([
    read((f, t, c) => db.from("finance_category_rules").select("merchant_key,category", c ? { count: "exact" } : undefined).order("merchant_key", { ascending: true }).range(f, t)),
    read((f, t, c) => db.from("finance_txn_categories").select("txn_key,category", c ? { count: "exact" } : undefined).order("txn_key", { ascending: true }).range(f, t)),
  ]);
  const failed = rules.error === "failed" || overrides.error === "failed";
  const truncated = rules.truncated || overrides.truncated;
  const fixes: CategoryFixes = {
    rules: new Map((rules.rows as { merchant_key: string; category: string }[]).map((r) => [r.merchant_key, r.category])),
    overrides: new Map((overrides.rows as { txn_key: string; category: string }[]).map((r) => [r.txn_key, r.category])),
  };
  return { ...fixes, ...(failed ? { failed } : {}), ...(truncated ? { truncated } : {}) };
}

export async function loadLedger(query: LedgerQuery, now: Date = new Date()): Promise<LedgerLoad> {
  let db: Db;
  try {
    db = serviceClient();
  } catch (e) {
    return fail(e);
  }
  try {
    const [fixes, accountsRes, minDate, maxDate, txHeartbeat, balHeartbeat] = await Promise.all([
      loadCategoryFixes(db),
      db.from("finance_accounts").select(ACCOUNT_COLS).order("institution").order("account_name").order("account_key"),
      dateEdge(db, true),
      dateEdge(db, false),
      heartbeat(db, "transactions"),
      heartbeat(db, "balances"),
    ]);
    const accounts = (check(accountsRes).data ?? [])
      .map(parseAccount)
      .filter((a): a is LedgerAccount => a !== null);
    const freshness =
      txHeartbeat || balHeartbeat ? simplefinLedgerCard(txHeartbeat, balHeartbeat, now.getTime()) : null;

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
    const windowRead = fetchPaged((from, to, withCount) => {
      let qb = db
        .from("finance_transactions")
        .select(WINDOW_COLS, withCount ? { count: "exact" } : undefined)
        .gte("txn_date", windowStart)
        .lt("txn_date", windowEnd);
      if (account) qb = qb.eq("account_key", account);
      return qb.order("txn_date", { ascending: false }).order("txn_key", { ascending: true }).range(from, to);
    }, MAX_WINDOW_PAGES, WINDOW_SPECULATE_PAGES);

    const listRead = readList(db, { ...query, month, account }, accounts, fixes);
    const [balanceReadRows, windowRaw, list] = await Promise.all([Promise.all(balanceReads), windowRead, listRead]);
    const balanceRows = balanceReadRows.flatMap((r) => (r.balance ? [r.balance] : []));

    const windowRows: LedgerTxn[] = [];
    let skipped = 0;
    for (const raw of applyFixes(windowRaw.rows as Record<string, unknown>[], fixes)) {
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
  fixes: CategoryFixes = NO_FIXES,
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
    const r0 = raw as Record<string, unknown>;
    const r: Record<string, unknown> = { ...r0, category: fixedCategory(r0, fixes) };
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
      merchant_key: merchantKey({ name, custom_name: custom || null }),
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
