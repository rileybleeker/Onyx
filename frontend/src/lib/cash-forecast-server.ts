import "server-only";
import { etDate } from "@/lib/format";
import { accountLabel, parseAccount, parseBalance, toCents } from "@/lib/finance-ledger";
import { fetchPaged, loadCategoryFixes, serviceClient } from "@/lib/finance-ledger-server";
import { fixedCategory } from "@/lib/finance-categories";
import { computeGoals, type GoalRow, type GoalView } from "@/lib/finance-goals";
import { moveItems, parseMovePlan, type MovePlan } from "@/lib/finance-plan";
import { forecastCash, poolBalanceAt, type ForecastAccount, type ForecastBalance, type ForecastResult, type ForecastTxn } from "@/lib/cash-forecast";
import { driversToInputs, itemRowToPlanned, type DriverRow, type ItemInput, type ItemRow } from "@/lib/cash-forecast-store";
import { applyToProfile, hasLevers, scenarioCardPayments, scenarioItems, type ScenarioParams } from "@/lib/cash-forecast-scenario";
import { computeTaxYear, federalMarginalRate, parseTaxProfile, salaryFor, taxCashItems, type TaxProfile, type TaxYearResult } from "@/lib/tax-plan";

/**
 * Server-side reads and writes for the cash forecast (/financials/forecast). SERVICE ROLE ONLY: the finance
 * and plan tables are service-role only, this module must never reach a client component ("server-only"), and
 * the caller sits behind the owner-only middleware. Explicit columns, no row contents in logs (codes only).
 */

const TXN_COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
const HISTORY_DAYS = 450;
const MAX_PAGES = 40;

export interface PlanItemView {
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
    const [acc, bal, txn] = await Promise.all([
      db.from("finance_accounts").select("account_key,institution,account_name,account_type,mask"),
      fetchPaged((f, t) => db.from("finance_balance_snapshots").select("account_key,captured_at,balance_cents,currency,kind", { count: "exact" }).gte("captured_at", balSince).order("captured_at", { ascending: true }).range(f, t), MAX_PAGES),
      fetchPaged((f, t) => db.from("finance_transactions").select(TXN_COLS, { count: "exact" }).gte("txn_date", since).order("txn_date", { ascending: true }).order("txn_key", { ascending: true }).range(f, t), MAX_PAGES),
    ]);
    if (acc.error) return { kind: "error", code: acc.error.code ?? "accounts" };
    const parsedAccounts = (acc.data ?? []).map(parseAccount).filter((a): a is NonNullable<typeof a> => !!a);
    if (!parsedAccounts.length) return { kind: "empty" };
    const accounts: ForecastAccount[] = parsedAccounts.map((a) => ({ account_key: a.account_key, account_type: a.account_type, label: accountLabel(a) }));
    const balances: ForecastBalance[] = bal.rows.map(parseBalance).filter((b): b is NonNullable<typeof b> => !!b);
    const fixes = await loadCategoryFixes(db);
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

    // Plan inputs: a missing table (migration not applied) shows the forecast without them.
    let setupPending = false;
    const [itemsRes, driversRes] = await Promise.all([
      db.from("finance_plan_items").select("id,label,item_date,amount_cents,certainty,repeat_unit,repeat_every,repeat_count,note").is("removed_at", null).order("item_date", { ascending: true }),
      db.from("finance_plan_drivers").select("key,value"),
    ]);
    if (itemsRes.error || driversRes.error) setupPending = true;
    const itemRows = ((itemsRes.data ?? []) as ItemRow[]).map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
    const drivers = ((driversRes.data ?? []) as DriverRow[]).filter((d) => d && typeof d.key === "string" && d.value && typeof d.value === "object");
    const { settings, cardTerms, growth, adjustments: savedAdjust } = driversToInputs(drivers);

    // Tax plan for this year and next; its payments, refunds and after-tax bonus become planned cash lines.
    // The move plan (driver "move") is the single source of the move date: it also sets the tax residency change.
    const move = parseMovePlan(drivers.find((d) => d.key === "move")?.value);
    const rawProfile = parseTaxProfile(drivers.find((d) => d.key === "tax")?.value);
    const profile = rawProfile && move ? { ...rawProfile, moveDate: move.date } : rawProfile;
    const year = Number(today.slice(0, 4));
    // Three tax years: this one, next (the move), and the one after (the next January bonus as a NY/NYC resident).
    const taxFor = (p: TaxProfile | null) => (p ? [0, 1, 2].map((k) => computeTaxYear(p, year + k, today)) : []);
    const tax = taxFor(profile);
    const manual = itemRows.map(itemRowToPlanned);
    const baseInput = { today, now, accounts, txns, balances, cardTerms, growth, settings: { ...settings, horizonDays: 730 } };
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
      const sp = profile ? applyToProfile(profile, levers) : null;
      const sTax = taxFor(sp);
      const adjustments: { streamId: string; from: string; amountCents?: number; stop?: boolean }[] = [...raiseAdjust(sp, result), ...savedAdjust];
      const pay = result.streams.filter((x) => x.kind === "income").sort((a, b) => b.typicalCents - a.typicalCents)[0];
      if (pay && profile && levers.preTax !== undefined) {
        const delta = Math.round(levers.preTax * 100) - profile.preTaxAnnualCents;
        const keep = 1 - (federalMarginalRate(profile, year) + 5) / 100;
        adjustments.push({ streamId: pay.id, from: today, amountCents: pay.typicalCents - Math.round((delta / 12) * keep) });
      }
      const extra = scenarioItems(levers, sp ?? ({ moveDate: null } as TaxProfile), today);
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
      scenario = { params: levers, result: sResult, tax: sTax };
    }
    // Forecast vs actual: snapshots of past weeks against the balance rebuilt from the ledger.
    const accuracy: AccuracyRow[] = [];
    const snaps = await db.from("finance_forecast_snapshots").select("as_of,week_end,likely_cents,low_cents,high_cents").lt("week_end", today).order("week_end", { ascending: false }).limit(200);
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
    const goalRes = await db.from("finance_goals").select("id,name,target_cents,target_date,account_key").is("removed_at", null).order("target_date", { ascending: true });
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
    if (bal.truncated || txn.truncated) result.warnings.push("Part of the history was not read (page limit), so the forecast may be off.");
    const items: PlanItemView[] = itemRows.map((r) => ({
      id: r.id,
      label: r.label,
      date: r.item_date,
      amountCents: r.amount_cents,
      certainty: r.certainty,
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
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
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
