import "server-only";
import { etDate } from "@/lib/format";
import { accountLabel, parseAccount, parseBalance, toCents } from "@/lib/finance-ledger";
import { fetchPaged, loadCategoryFixes, serviceClient } from "@/lib/finance-ledger-server";
import { fixedCategory } from "@/lib/finance-categories";
import { computeGoals, type GoalRow, type GoalView } from "@/lib/finance-goals";
import { moveItems, parseMovePlan, type MovePlan } from "@/lib/finance-plan";
import { forecastCash, poolAccountKeys, poolBalanceAt, type ForecastAccount, type ForecastBalance, type ForecastResult, type ForecastTxn } from "@/lib/cash-forecast";
import { applyLeaveOut, driversToInputs, itemRowToPlanned, nextLeaveOutVersion, type DriverRow, type ItemInput, type ItemRow, type LeaveOutStore } from "@/lib/cash-forecast-store";
import { applyToProfile, hasLevers, scenarioCardPayments, scenarioItems, type ScenarioParams } from "@/lib/cash-forecast-scenario";
import { computeTaxYear, federalMarginalRate, parseTaxProfile, salaryFor, taxCashItems, taxYearsFor, type TaxProfile, type TaxYearResult } from "@/lib/tax-plan";
import { addDays } from "@/lib/procurement-recurring";
import { FORECAST } from "@/lib/cash-forecast-config";

/**
 * Server-side reads and writes for the cash forecast (/financials/forecast). SERVICE ROLE ONLY: the finance
 * and plan tables are service-role only, this module must never reach a client component ("server-only"), and
 * the caller sits behind the owner-only middleware. Explicit columns, no row contents in logs (codes only).
 */

const TXN_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const BAL_COLS = "account_key,captured_at,balance_cents,currency,kind";
const HISTORY_DAYS = 450;
/** The forecast runs two years ahead; the tax years are picked from the same window. */
const HORIZON_DAYS = 730;
const MAX_PAGES = 40;
/** Accounts, planned items and plan drivers are a few dozen rows each; 10 pages (10k rows) is far beyond that, and a
 * read that still stops there is reported (quality.historyTruncated / planTruncated), never treated as complete. */
const SMALL_MAX_PAGES = 10;

/**
 * Balance rows as the forecast reads them. A row the ledger parser rejects (no usable amount, no date), or one whose
 * date does not parse (it could be the newest), does not vanish: it is kept as an UNUSABLE balance of its account
 * (amount NaN, its date if it has one), so the engine's gate sees it (unvaluedDebt: a newest row with no usable amount
 * could be a debt, so the amount is withheld, also when the account is left out) instead of an older row looking
 * current or the account looking merely missing (which Leave it out would clear, counting it as $0). A row with no
 * account key cannot be matched to any account: it is counted in `unmatched` (quality.balanceRowsUnmatched withholds
 * the amount). Rows parseBalance accepts with a readable date are returned as parsed.
 */
export function forecastBalanceRows(rows: readonly unknown[]): { usable: ForecastBalance[]; rejected: ForecastBalance[]; unmatched: number } {
  const usable: ForecastBalance[] = [];
  const rejected: ForecastBalance[] = [];
  let unmatched = 0;
  for (const raw of rows) {
    const b = parseBalance(raw);
    if (b && Number.isFinite(b.balance_cents) && Number.isFinite(Date.parse(b.captured_at))) {
      usable.push(b);
      continue;
    }
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof r.account_key !== "string" || !r.account_key) {
      unmatched++;
      continue;
    }
    const currency = typeof r.currency === "string" && r.currency.trim() ? r.currency.trim().toUpperCase() : "USD";
    const kind = typeof r.kind === "string" ? r.kind.trim().toLowerCase() : "";
    rejected.push({
      account_key: r.account_key,
      captured_at: typeof r.captured_at === "string" ? r.captured_at : "",
      balance_cents: Number.NaN,
      currency,
      kind: kind === "asset" || kind === "liability" ? kind : null,
    });
  }
  return { usable, rejected, unmatched };
}

type PagedRows = { rows: unknown[]; truncated: boolean; failed: boolean };
/** A paged read that never throws: a failed read is `failed` (its code logged, never a row), a capped one `truncated`. */
async function pagedRows(what: string, build: Parameters<typeof fetchPaged>[0], maxPages: number): Promise<PagedRows> {
  try {
    const r = await fetchPaged(build, maxPages);
    return { rows: r.rows, truncated: r.truncated, failed: false };
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : null;
    console.error(`${what} read failed: ${typeof code === "string" ? code : "unknown"}`);
    return { rows: [], truncated: false, failed: true };
  }
}

export interface PlanItemView {
  account: string | null;
  id: string;
  label: string;
  date: string;
  amountCents: number;
  certainty: string;
  repeat: string | null;
  note: string | null;
}
export interface ForecastAccountView {
  account_key: string;
  label: string;
  type: "cash" | "card" | "investment" | "other";
}
/** A past week: what a snapshot made about 4 weeks earlier said, and the balance that happened. */
export interface AccuracyRow {
  weekEnd: string;
  asOf: string;
  likely: number;
  low: number;
  high: number;
  actual: number;
}
export type ForecastLoad =
  | {
      kind: "ok";
      result: ForecastResult;
      items: PlanItemView[];
      drivers: DriverRow[];
      accounts: ForecastAccountView[];
      setupPending: boolean;
      profile: TaxProfile | null;
      tax: TaxYearResult[];
      scenario: { params: ScenarioParams; result: ForecastResult; tax: TaxYearResult[] } | null;
      saved: { slug: string; name: string; params: ScenarioParams }[];
      accuracy: AccuracyRow[];
      goals: GoalView[];
      move: MovePlan | null;
    }
  | { kind: "empty" }
  | { kind: "error"; code: string };

const typeOf = (t: string): ForecastAccountView["type"] => {
  const l = t.trim().toLowerCase();
  return l === "cash" ? "cash" : l.includes("credit") ? "card" : l === "investment" ? "investment" : "other";
};

export async function loadForecast(now: Date = new Date(), levers: ScenarioParams = {}): Promise<ForecastLoad> {
  let db;
  try {
    db = serviceClient();
  } catch {
    return { kind: "error", code: "not-configured" };
  }
  try {
    const today = etDate(now.toISOString());
    const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
    const balSince = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    // Every read below is independent, so all of them start now (one round trip instead of five in a row);
    // each result is awaited where it is used. started() kicks off a lazy query builder and keeps a failure
    // from becoming an unhandled rejection when an earlier step returns first.
    const started = <T>(q: PromiseLike<T>): Promise<T> => {
      const p = Promise.resolve(q);
      p.catch(() => {});
      return p;
    };
    const fixesRead = started(loadCategoryFixes(db));
    // Planned items and plan drivers are read in pages (ordered by a unique key, so the pages join without gaps or
    // repeats): a single select would silently stop at the server's row cap, and a read that still stops at the page
    // limit is reported (quality.planTruncated), so the amount is never computed from part of the plan.
    const planRead = started(
      Promise.all([
        pagedRows(
          "plan items",
          (f, t, c) =>
            db
              .from("finance_plan_items")
              .select("id,label,item_date,amount_cents,certainty,repeat_unit,repeat_every,repeat_count,note,account_key", c ? { count: "exact" } : undefined)
              .is("removed_at", null)
              .order("item_date", { ascending: true })
              .order("id", { ascending: true })
              .range(f, t),
          SMALL_MAX_PAGES,
        ),
        pagedRows("plan drivers", (f, t, c) => db.from("finance_plan_drivers").select("key,value", c ? { count: "exact" } : undefined).order("key", { ascending: true }).range(f, t), SMALL_MAX_PAGES),
      ]),
    );
    const snapsRead = started(db.from("finance_forecast_snapshots").select("as_of,week_end,likely_cents,low_cents,high_cents").lt("week_end", today).order("week_end", { ascending: false }).limit(200));
    const goalsRead = started(db.from("finance_goals").select("id,name,target_cents,target_date,account_key").is("removed_at", null).order("target_date", { ascending: true }));
    // Accounts are paged like the history (a capped single select could drop a cash account from the check entirely);
    // a failed read is an error page, as before, and one cut off at its page limit withholds the amount.
    const [acc, bal, txn] = await Promise.all([
      fetchPaged((f, t, c) => db.from("finance_accounts").select("account_key,institution,account_name,account_type,mask", c ? { count: "exact" } : undefined).order("account_key", { ascending: true }).range(f, t), SMALL_MAX_PAGES),
      fetchPaged((f, t, c) => db.from("finance_balance_snapshots").select(BAL_COLS, c ? { count: "exact" } : undefined).gte("captured_at", balSince).order("captured_at", { ascending: true }).order("account_key", { ascending: true }).range(f, t), MAX_PAGES),
      fetchPaged((f, t, c) => db.from("finance_transactions").select(TXN_COLS, c ? { count: "exact" } : undefined).gte("txn_date", since).order("txn_date", { ascending: true }).order("txn_key", { ascending: true }).range(f, t), MAX_PAGES),
    ]);
    const parsedAccounts = acc.rows.map(parseAccount).filter((a): a is NonNullable<typeof a> => !!a);
    if (!parsedAccounts.length) return { kind: "empty" };
    const accounts: ForecastAccount[] = parsedAccounts.map((a) => ({ account_key: a.account_key, account_type: a.account_type, label: accountLabel(a) }));
    // Rows parseBalance rejects are kept as unusable balances (forecastBalanceRows), so the gate sees them.
    const read60 = forecastBalanceRows(bal.rows);
    const balances: ForecastBalance[] = read60.usable;
    const rejected: ForecastBalance[] = [...read60.rejected];
    let unmatched = read60.unmatched;
    // A cash account with no balance in the 60-day read (one the feed no longer refreshes, or a closed one): its
    // newest snapshot is read on its own and kept when it is SMALL or NEGATIVE (an overdraft, any size). Either way it
    // is too old to trust, so it withholds the amount (stale-balance) until Riley leaves the account out; a negative
    // one keeps lowering the amount after he does, so a known debt is never dropped to $0. A larger positive one
    // stays missing: the projection keeps counting it as $0 (as before) and the amount stays withheld until Riley
    // leaves it out. One limit-1 read per such account, only when there is one. A read that FAILS is not "no balance":
    // the account goes to quality.balanceUnreadable, which withholds the amount even when Riley left the account out
    // (an unread balance could be an overdraft). Forecast only: goals keep the 60-day balances.
    const seen = new Set(bal.rows.map((r) => (r as { account_key?: unknown }).account_key));
    const unseen = poolAccountKeys(accounts).filter((k) => !seen.has(k));
    const older: ForecastBalance[] = [];
    const unreadable: string[] = [];
    if (unseen.length) {
      const reads = await Promise.all(
        unseen.map((k) =>
          Promise.resolve(db.from("finance_balance_snapshots").select(BAL_COLS).eq("account_key", k).order("captured_at", { ascending: false }).limit(1)).catch(() => null),
        ),
      );
      reads.forEach((res, i) => {
        if (!res || res.error) {
          console.error(`older balance read failed: ${res?.error?.code ?? "unknown"}`);
          unreadable.push(unseen[i]);
          return;
        }
        // The newest snapshot decides: one parseBalance rejects is kept as unusable (the amount is withheld, also
        // when the account is left out), never skipped so the account looks merely missing.
        const got = forecastBalanceRows(res.data ?? []);
        rejected.push(...got.rejected);
        unmatched += got.unmatched;
        for (const b of got.usable) {
          const signed = b.kind === "liability" ? -Math.abs(b.balance_cents) : b.balance_cents;
          if (signed < 0 || Math.abs(b.balance_cents) < FORECAST.smallBalanceCents) older.push(b);
        }
      });
    }
    const fixes = await fixesRead;
    const txns: ForecastTxn[] = [];
    for (const raw of txn.rows) {
      const r = raw as Record<string, unknown>;
      const cents = toCents(r.amount_cents);
      if (typeof r.account_key !== "string" || typeof r.txn_date !== "string" || cents === null) continue;
      txns.push({
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

    // Plan inputs: a missing table (migration not applied) or a failed read shows the forecast without them, as an
    // estimate: setupPending withholds the safe-to-move amount (quality.planUnavailable below).
    const [itemsRes, driversRes] = await planRead;
    const setupPending = itemsRes.failed || driversRes.failed;
    const planTruncated = itemsRes.truncated || driversRes.truncated;
    const itemRows = (itemsRes.rows as ItemRow[]).map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
    const driverRows = driversRes.rows as DriverRow[];
    const drivers = driverRows.filter((d) => d && typeof d.key === "string" && d.value && typeof d.value === "object");
    const { settings, cardTerms, growth, adjustments: savedAdjust } = driversToInputs(drivers);

    // Tax plan; its payments, refunds and after-tax bonus become planned cash lines.
    // The move plan (driver "move") is the single source of the move date: it also sets the tax residency change.
    const move = parseMovePlan(drivers.find((d) => d.key === "move")?.value);
    const rawProfile = parseTaxProfile(drivers.find((d) => d.key === "tax")?.value);
    // A saved tax profile or move plan that no longer parses (stored by older code, or a parser change) drops its
    // tax payments or move costs from the forecast: that withholds the amount too (quality.planInvalid).
    const hasDriver = (key: string) => driverRows.some((d) => d && d.key === key);
    const planInvalid = (hasDriver("tax") && !rawProfile) || (hasDriver("move") && !move);
    const profile = rawProfile && move ? { ...rawProfile, moveDate: move.date } : rawProfile;
    const year = Number(today.slice(0, 4));
    // Tax years by cash date (taxYearsFor): every year with a line inside the forecast window, including LAST year
    // until its January estimate, April balance and refund are settled (they fall after New Year), through the year
    // the horizon ends in (this one, the move, the next January bonus as a NY/NYC resident).
    const taxYears = taxYearsFor(today, addDays(today, HORIZON_DAYS));
    const taxFor = (p: TaxProfile | null) => (p ? taxYears.map((y) => computeTaxYear(p, y, today)) : []);
    const tax = taxFor(profile);
    const manual = itemRows.map(itemRowToPlanned);
    // What the reads could not deliver: each withholds the safe-to-move amount in the base plan AND the what-if,
    // because both are computed from this one input (result.eligibility, lib/cash-forecast.ts).
    const quality = {
      historyTruncated: acc.truncated || bal.truncated || txn.truncated,
      planUnavailable: setupPending,
      planTruncated,
      planInvalid,
      categoriesUnavailable: fixes.failed === true,
      categoriesTruncated: fixes.truncated === true,
      ...(unreadable.length ? { balanceUnreadable: unreadable } : {}),
      ...(unmatched ? { balanceRowsUnmatched: unmatched } : {}),
    };
    // The engine reads the rejected rows too (its gate); goals below keep the usable 60-day balances only.
    const forecastBalances = [...balances, ...older, ...rejected];
    const baseInput = { today, now, accounts, txns, balances: forecastBalances, cardTerms, growth, settings: { ...settings, horizonDays: HORIZON_DAYS }, quality };
    const basePlanned = [...manual, ...(move ? moveItems(move) : []), ...(profile ? taxCashItems(profile, tax, today) : [])];
    let result = forecastCash({ ...baseInput, planned: basePlanned, adjustments: savedAdjust });
    // Annual raise: the paycheck stream grows each January (net pay scaled with gross; a planning approximation).
    const raiseAdjust = (p: TaxProfile | null, r: ForecastResult) => {
      const pay = r.streams.filter((x) => x.kind === "income").sort((a, b) => b.typicalCents - a.typicalCents)[0];
      if (!p || !pay || !(p.raisePct && p.raisePct > 0)) return [];
      const base = salaryFor(p, year);
      return [1, 2].map((k) => ({ streamId: pay.id, from: `${year + k}-01-01`, amountCents: Math.round((pay.typicalCents * salaryFor(p, year + k)) / base) }));
    };
    const baseAdjust = raiseAdjust(profile, result);
    if (baseAdjust.length) result = forecastCash({ ...baseInput, planned: basePlanned, adjustments: [...baseAdjust, ...savedAdjust] });

    // What-if: the same history with the levers applied (computed here, so the browser never gets the ledger).
    let scenario: { params: ScenarioParams; result: ForecastResult; tax: TaxYearResult[] } | null = null;
    if (hasLevers(levers)) {
      const sp = profile ? applyToProfile(profile, levers, today) : null;
      const sTax = taxFor(sp);
      const adjustments: { streamId: string; from: string; amountCents?: number; stop?: boolean }[] = [...raiseAdjust(sp, result), ...savedAdjust];
      const pay = result.streams.filter((x) => x.kind === "income").sort((a, b) => b.typicalCents - a.typicalCents)[0];
      if (pay && profile && levers.preTax !== undefined) {
        const delta = Math.round(levers.preTax * 100) - profile.preTaxAnnualCents;
        const keep = 1 - (federalMarginalRate(profile, year) + 5) / 100;
        adjustments.push({ streamId: pay.id, from: today, amountCents: pay.typicalCents - Math.round((delta / 12) * keep) });
      }
      // The levers' own cash lines, including the receipts of a change in other income (its tax is in sTax).
      const extra = scenarioItems(levers, sp ?? ({ moveDate: null, otherIncomeAnnualCents: 0 } as TaxProfile), today);
      const sResult = forecastCash({
        ...baseInput,
        planned: [
          ...manual,
          ...(move && levers.moveDate !== "none" ? moveItems(move, levers.moveDate ?? null) : []),
          ...(sp ? taxCashItems(sp, sTax, today) : []),
          ...extra,
        ],
        adjustments,
        extraCardPayments: scenarioCardPayments(levers, today),
      });
      if (!sp && extra.some((i) => i.id.startsWith("wi:other:"))) sResult.warnings.push("No tax profile yet: the other income is counted before tax.");
      scenario = { params: levers, result: sResult, tax: sTax };
    }
    // Forecast vs actual: snapshots of past weeks against the balance rebuilt from the ledger.
    const accuracy: AccuracyRow[] = [];
    const snaps = await snapsRead;
    if (!snaps.error && snaps.data?.length && result.state === "ok") {
      const poolSet = new Set(result.pool.map((p) => p.account_key));
      const poolTxns = txns.filter((t) => poolSet.has(t.account_key));
      const byWeek = new Map<string, { as_of: string; likely_cents: unknown; low_cents: unknown; high_cents: unknown }[]>();
      for (const r of snaps.data as { as_of: string; week_end: string; likely_cents: unknown; low_cents: unknown; high_cents: unknown }[]) {
        const list = byWeek.get(r.week_end) ?? [];
        list.push(r);
        byWeek.set(r.week_end, list);
      }
      for (const [weekEnd, list] of [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 8)) {
        const target = Date.parse(`${weekEnd}T00:00:00Z`) - 28 * 86_400_000;
        const pick = list.reduce((best, r) => (Math.abs(Date.parse(`${r.as_of}T00:00:00Z`) - target) < Math.abs(Date.parse(`${best.as_of}T00:00:00Z`) - target) ? r : best));
        accuracy.push({
          weekEnd,
          asOf: pick.as_of,
          likely: Number(pick.likely_cents),
          low: Number(pick.low_cents),
          high: Number(pick.high_cents),
          actual: poolBalanceAt(poolTxns, result.opening.cents, today, weekEnd),
        });
      }
    }
    // Savings goals: progress from the latest balances, and the forecast for goals on the cash pool.
    let goals: GoalView[] = [];
    const goalRes = await goalsRead;
    if (!goalRes.error && goalRes.data) {
      const latestBal = new Map<string, number>();
      const latestAt = new Map<string, string>();
      for (const b of balances) {
        if (!latestAt.has(b.account_key) || b.captured_at > latestAt.get(b.account_key)!) {
          latestAt.set(b.account_key, b.captured_at);
          latestBal.set(b.account_key, b.kind === "liability" ? -Math.abs(b.balance_cents) : b.balance_cents);
        }
      }
      const labels = new Map(accounts.map((a) => [a.account_key, a.label]));
      const rows = (goalRes.data as GoalRow[]).map((g) => ({ ...g, target_cents: Number(g.target_cents) }));
      goals = computeGoals(rows, latestBal, labels, result.opening.cents, result.days, today);
    }
    const saved = drivers
      .filter((d) => d.key.startsWith("scenario:"))
      .map((d) => ({ slug: d.key.slice(9), name: String((d.value as { name?: unknown }).name ?? d.key.slice(9)), params: ((d.value as { params?: ScenarioParams }).params ?? {}) as ScenarioParams }));
    const accountLabelsByKey = new Map<string, string>([
      ...parsedAccounts.map((a) => [a.account_key, accountLabel(a)] as [string, string]),
      ...drivers.filter((d) => d.key.startsWith("growth:virtual-")).map((d) => [d.key.slice(7), String((d.value as { label?: unknown }).label ?? d.key.slice(7))] as [string, string]),
    ]);
    const items: PlanItemView[] = itemRows.map((r) => ({
      id: r.id,
      label: r.label,
      date: r.item_date,
      amountCents: r.amount_cents,
      certainty: r.certainty,
      account: r.account_key ? (accountLabelsByKey.get(r.account_key) ?? r.account_key) : null,
      repeat: r.repeat_unit && r.repeat_count ? `${r.repeat_count} times, every ${r.repeat_every ?? 1} ${r.repeat_unit}${(r.repeat_every ?? 1) > 1 ? "s" : ""}` : null,
      note: r.note,
    }));
    return {
      kind: "ok",
      result,
      items,
      drivers,
      accounts: parsedAccounts.map((a) => ({ account_key: a.account_key, label: accountLabel(a), type: typeOf(a.account_type) })),
      setupPending,
      profile,
      tax,
      scenario,
      saved,
      accuracy,
      goals,
      move,
    };
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code ?? "unknown") : "unknown";
    console.error(`cash forecast load failed: ${code}`);
    return { kind: "error", code };
  }
}

export async function insertPlanItem(item: ItemInput): Promise<{ ok: true; id: string } | { ok: false; status: number }> {
  const db = serviceClient();
  const { data, error } = await db.from("finance_plan_items").insert(item).select("id").single();
  if (error || !data) {
    console.error(`plan item insert failed: ${error?.code ?? "unknown"}`);
    return { ok: false, status: 500 };
  }
  return { ok: true, id: (data as { id: string }).id };
}

export async function removePlanItem(id: string): Promise<{ ok: boolean; status: number }> {
  const db = serviceClient();
  const { data, error } = await db.from("finance_plan_items").update({ removed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).is("removed_at", null).select("id");
  if (error) {
    console.error(`plan item remove failed: ${error.code ?? "unknown"}`);
    return { ok: false, status: 500 };
  }
  return { ok: (data ?? []).length > 0, status: (data ?? []).length > 0 ? 200 : 404 };
}

export async function knownAccountKeys(): Promise<Set<string>> {
  const db = serviceClient();
  const { data, error } = await db.from("finance_accounts").select("account_key");
  if (error) throw Object.assign(new Error("accounts"), { code: error.code });
  return new Set((data ?? []).map((r) => (r as { account_key: string }).account_key));
}

export async function saveDriver(key: string, value: Record<string, unknown> | null): Promise<{ ok: boolean }> {
  const db = serviceClient();
  const res = value === null ? await db.from("finance_plan_drivers").delete().eq("key", key) : await db.from("finance_plan_drivers").upsert({ key, value, updated_at: new Date().toISOString() });
  if (res.error) {
    console.error(`plan driver save failed: ${res.error.code ?? "unknown"}`);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * The "safe-to-move" driver row as a compare-and-swap store (lib/cash-forecast-store.ts applyLeaveOut): the version is
 * the row's updated_at as read, and every write is conditional on it (an UPDATE / DELETE whose WHERE also names that
 * updated_at, an INSERT that fails on the primary key), so a write that lost a race changes nothing and is retried.
 * Invariant this relies on: only this store writes the "safe-to-move" row (saveDriver refuses that key through
 * parseDriverBody) and pds.finance_plan_drivers has no trigger that rewrites updated_at, so updated_at changes exactly
 * when this store writes (nextLeaveOutVersion keeps it moving forward). Logs a database code only.
 */
export function leaveOutStore(db: ReturnType<typeof serviceClient>): LeaveOutStore {
  const KEY = "safe-to-move";
  const table = () => db.from("finance_plan_drivers");
  const failed = (what: string, code: unknown) => {
    console.error(`plan driver ${what} failed: ${typeof code === "string" ? code : "unknown"}`);
    return "error" as const;
  };
  return {
    async read() {
      const { data, error } = await table().select("value,updated_at").eq("key", KEY);
      if (error) {
        failed("read", error.code);
        return { ok: false };
      }
      const row = (data ?? [])[0] as { value?: unknown; updated_at?: unknown } | undefined;
      if (!row) return { ok: true, row: null };
      if (typeof row.updated_at !== "string") {
        failed("read", "no-version");
        return { ok: false };
      }
      return { ok: true, row: { value: row.value ?? null, version: row.updated_at } };
    },
    async insert(value) {
      const { error } = await table().insert({ key: KEY, value, updated_at: nextLeaveOutVersion(null, Date.now()) });
      if (!error) return "ok";
      return error.code === "23505" ? "conflict" : failed("insert", error.code);
    },
    async update(version, value) {
      const { data, error } = await table().update({ value, updated_at: nextLeaveOutVersion(version, Date.now()) }).eq("key", KEY).eq("updated_at", version).select("key");
      if (error) return failed("update", error.code);
      return (data ?? []).length ? "ok" : "conflict";
    },
    async remove(version) {
      const { data, error } = await table().delete().eq("key", KEY).eq("updated_at", version).select("key");
      if (error) return failed("remove", error.code);
      return (data ?? []).length ? "ok" : "conflict";
    },
  };
}

/**
 * Leave one pool account out of the safe-to-move amount, or count it again: applied to the saved list with a
 * compare-and-swap and a bounded retry (applyLeaveOut), so two tabs changing different accounts both keep their change
 * and the page's possibly stale or empty copy of the drivers is never written back. A failed read saves nothing; a
 * change still colliding after the last retry answers 409 and saves nothing.
 */
export async function changeLeaveOut(account: string, leaveOut: boolean): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  return applyLeaveOut(leaveOutStore(serviceClient()), account, leaveOut);
}
