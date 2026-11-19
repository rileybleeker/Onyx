import "server-only";
import { LedgerQueryError, fetchPaged, loadCategoryFixes } from "@/lib/finance-ledger-server";
import { serviceClient } from "@/lib/finance-service-client";
import { applyFixes } from "@/lib/finance-categories";
import { etDate } from "@/lib/format";
import {
  HOTEL_PREFILTER,
  buildRewards,
  cardAccounts,
  parseBalanceRow,
  parseSettings,
  rewardsAlerts,
  trailingMonths,
  type AccountRow,
  type BalanceRow,
  type FlightRow,
  type RewardsAlert,
  type RewardsData,
  type SettingsPatch,
  type Txn,
} from "@/lib/rewards";

/**
 * Server-side reads of the rewards data. SERVICE ROLE ONLY: pds.rewards_* and pds.finance_* have RLS on, no policies
 * and no grants to anon / authenticated; this module must never reach a client component ("server-only"), and its
 * callers sit behind the owner-only middleware. Explicit column lists; logs carry an error code only, never a row.
 */

const BALANCE_COLS = "program,captured_at,balance,unit,status_tier,status_progress,expires_on,source";
const ACCOUNT_COLS = "account_key,institution,account_name";
const TXN_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,category,ignored_from";
const FLIGHT_COLS = "dep_local_date,dep_iata,arr_iata,carrier_code,status";
const MAX_PAGES = 12;

export type RewardsLoad = { kind: "ok"; data: RewardsData } | { kind: "error"; message: string; hint?: string };

const codeOf = (e: unknown): string => (e instanceof LedgerQueryError ? (e.code ?? "unknown") : "unexpected");
/** A table that is not there yet (migration not applied) is "no rows", not an error page. */
const MISSING = ["42P01", "PGRST205"];

type Db = ReturnType<typeof serviceClient>;

async function readBalances(db: Db): Promise<BalanceRow[]> {
  // Newest rows first; the table is tiny (a row per program per harvest), the newest per program is picked in code.
  const { data, error } = await db.from("rewards_balances").select(BALANCE_COLS).order("captured_at", { ascending: false }).limit(300);
  if (error) {
    if (error.code && MISSING.includes(error.code)) return [];
    throw new LedgerQueryError(error.code ?? "unknown");
  }
  return (data ?? []).map(parseBalanceRow).filter((r): r is BalanceRow => r !== null);
}

async function readSettings(db: Db) {
  const { data, error } = await db.from("rewards_settings").select("key,value").limit(50);
  if (error) {
    if (error.code && MISSING.includes(error.code)) return parseSettings([]);
    throw new LedgerQueryError(error.code ?? "unknown");
  }
  return parseSettings((data ?? []) as { key: unknown; value: unknown }[]);
}

const toTxn = (r: Record<string, unknown>): Txn | null => {
  const cents = typeof r.amount_cents === "number" ? r.amount_cents : typeof r.amount_cents === "string" ? Number(r.amount_cents) : NaN;
  if (typeof r.account_key !== "string" || typeof r.txn_date !== "string" || !Number.isSafeInteger(cents)) return null;
  return {
    account_key: r.account_key,
    txn_date: r.txn_date,
    name: typeof r.name === "string" ? r.name : null,
    custom_name: typeof r.custom_name === "string" ? r.custom_name : null,
    amount_cents: cents,
    category: typeof r.category === "string" ? r.category : null,
    ignored_from: typeof r.ignored_from === "string" ? r.ignored_from : null,
  };
};

/** Every word the hotel prefilter looks for, as one PostgREST `or` list over both name columns. */
const hotelFilter = () =>
  HOTEL_PREFILTER.flatMap((w) => {
    const safe = w.replace(/[^A-Z0-9 ]/g, "").replace(/ /g, "*");
    return [`name.ilike.*${safe}*`, `custom_name.ilike.*${safe}*`];
  }).join(",");

export async function loadRewards(now: Date = new Date()): Promise<RewardsLoad> {
  let db: Db;
  try {
    db = serviceClient();
  } catch (e) {
    return { kind: "error", message: "Rewards isn't connected.", hint: `Database credentials are missing (${codeOf(e)}).` };
  }
  const today = etDate(now.toISOString());
  try {
    const months = trailingMonths(today, 12);
    const windowStart = `${months[0]}-01`;
    const [balances, settings, accountsRes, fixes, flightsRes] = await Promise.all([
      readBalances(db),
      readSettings(db),
      db.from("finance_accounts").select(ACCOUNT_COLS).order("account_key"),
      loadCategoryFixes(db),
      // Delta context only: a failed read just leaves the line out.
      db.from("flights").select(FLIGHT_COLS).gte("dep_local_date", `${today.slice(0, 4)}-01-01`).order("dep_local_date").limit(500),
    ]);
    if (accountsRes.error) throw new LedgerQueryError(accountsRes.error.code ?? "unknown");
    const accounts = (accountsRes.data ?? []) as AccountRow[];

    const [windowRaw, hotelRes, earliestRes] = await Promise.all([
      fetchPaged(
        (from, to, withCount) =>
          db
            .from("finance_transactions")
            .select(TXN_COLS, withCount ? { count: "exact" } : undefined)
            .gte("txn_date", windowStart)
            .order("txn_date", { ascending: false })
            .order("txn_key", { ascending: true })
            .range(from, to),
        MAX_PAGES,
        3,
      ),
      db.from("finance_transactions").select(TXN_COLS).or(hotelFilter()).gt("amount_cents", 0).order("txn_date", { ascending: false }).limit(400),
      db.from("finance_transactions").select("txn_date").order("txn_date", { ascending: true }).limit(1),
    ]);
    if (hotelRes.error) throw new LedgerQueryError(hotelRes.error.code ?? "unknown");
    const fix = (rows: unknown[]) =>
      applyFixes(rows as Record<string, unknown>[], fixes).map(toTxn).filter((t): t is Txn => t !== null);
    const earliestRaw = (earliestRes.data?.[0] as { txn_date?: unknown } | undefined)?.txn_date;

    const data = buildRewards({
      today,
      balances,
      settings,
      accounts,
      windowTxns: fix(windowRaw.rows),
      hotelTxns: fix((hotelRes.data ?? []) as unknown[]),
      flights: flightsRes.error ? null : ((flightsRes.data ?? []) as FlightRow[]),
      earliest: typeof earliestRaw === "string" ? earliestRaw : null,
    });
    return { kind: "ok", data };
  } catch (e) {
    console.error("[rewards] load failed", codeOf(e));
    return { kind: "error", message: "Couldn't load rewards.", hint: "The database did not answer. Try again in a moment." };
  }
}

/**
 * What Today shows, from a LEAN read (this sits on the money-alerts path, which Today waits for): balances, the
 * settings, the Amex Platinum account's credit rows of this year and the hotel-brand purchases only; no full ledger
 * window. Fail-open: any failure or a slow read is "no rewards alerts" (the rewards page itself shows errors).
 */
export async function loadRewardsAlerts(now: Date = new Date(), limitMs = 1200): Promise<RewardsAlert[]> {
  const run = async (): Promise<RewardsAlert[]> => {
    const db = serviceClient();
    const today = etDate(now.toISOString());
    const [balances, settings, accountsRes, hotelRes] = await Promise.all([
      readBalances(db),
      readSettings(db),
      db.from("finance_accounts").select(ACCOUNT_COLS).order("account_key"),
      db.from("finance_transactions").select(TXN_COLS).or(hotelFilter()).gt("amount_cents", 0).order("txn_date", { ascending: false }).limit(400),
    ]);
    if (accountsRes.error || hotelRes.error) return [];
    const accounts = (accountsRes.data ?? []) as AccountRow[];
    const keys = [...cardAccounts(accounts)].filter(([, c]) => c === "amex_platinum").map(([k]) => k);
    const creditRes = keys.length
      ? await db.from("finance_transactions").select(TXN_COLS).in("account_key", keys).lt("amount_cents", 0).gte("txn_date", `${today.slice(0, 4)}-01-01`).limit(500)
      : { data: [] as unknown[], error: null };
    if (creditRes.error) return [];
    const conv = (rows: unknown[]) => rows.map((r) => toTxn(r as Record<string, unknown>)).filter((t): t is Txn => t !== null);
    const data = buildRewards({
      today,
      balances,
      settings,
      accounts,
      windowTxns: conv((creditRes.data ?? []) as unknown[]),
      hotelTxns: conv((hotelRes.data ?? []) as unknown[]),
      flights: null,
      earliest: null,
    });
    // Without the ledger's first day a "no stay seen" expiry is unknown, which never alerts: only dated ones do.
    return rewardsAlerts(data);
  };
  try {
    return await Promise.race([run(), new Promise<RewardsAlert[]>((resolve) => setTimeout(() => resolve([]), limitMs))]);
  } catch (e) {
    console.error("[rewards] alerts failed", codeOf(e));
    return [];
  }
}

/** Merge one settings patch into the stored row for its key (a valuation edit never drops the others). */
export async function saveSettings(patch: SettingsPatch): Promise<{ ok: true } | { ok: false; code: string }> {
  let db: Db;
  try {
    db = serviceClient();
  } catch {
    return { ok: false, code: "not-configured" };
  }
  try {
    let value: unknown = patch.value;
    if (patch.key === "valuations" || patch.key === "credits") {
      const { data, error } = await db.from("rewards_settings").select("value").eq("key", patch.key).limit(1);
      if (error && !(error.code && MISSING.includes(error.code))) return { ok: false, code: error.code ?? "unknown" };
      const prev = (data?.[0] as { value?: unknown } | undefined)?.value;
      value = { ...(prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {}), ...patch.value };
    }
    const { error } = await db.from("rewards_settings").upsert({ key: patch.key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return error ? { ok: false, code: error.code ?? "unknown" } : { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(e) };
  }
}
