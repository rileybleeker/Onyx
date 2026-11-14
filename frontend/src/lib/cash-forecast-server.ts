import "server-only";
import { etDate } from "@/lib/format";
import { accountLabel, parseAccount, parseBalance, toCents } from "@/lib/finance-ledger";
import { fetchPaged, serviceClient } from "@/lib/finance-ledger-server";
import { forecastCash, type ForecastAccount, type ForecastBalance, type ForecastResult, type ForecastTxn } from "@/lib/cash-forecast";
import { driversToInputs, itemRowToPlanned, type DriverRow, type ItemInput, type ItemRow } from "@/lib/cash-forecast-store";
import { applyToProfile, hasLevers, scenarioCardPayments, scenarioItems, type ScenarioParams } from "@/lib/cash-forecast-scenario";
import { computeTaxYear, federalMarginalRate, parseTaxProfile, taxCashItems, type TaxProfile, type TaxYearResult } from "@/lib/tax-plan";

/**
 * Server-side reads and writes for the cash forecast (/financials/forecast). SERVICE ROLE ONLY: the finance
 * and plan tables are service-role only, this module must never reach a client component ("server-only"), and
 * the caller sits behind the owner-only middleware. Explicit columns, no row contents in logs (codes only).
 */

const TXN_COLS = "account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";
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
        category: typeof r.category === "string" ? r.category : null,
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
    const { settings, cardTerms, growth } = driversToInputs(drivers);

    // Tax plan for this year and next; its payments, refunds and after-tax bonus become planned cash lines.
    const profile = parseTaxProfile(drivers.find((d) => d.key === "tax")?.value);
    const year = Number(today.slice(0, 4));
    const taxFor = (p: TaxProfile | null) => (p ? [computeTaxYear(p, year, today), computeTaxYear(p, year + 1, today)] : []);
    const tax = taxFor(profile);
    const manual = itemRows.map(itemRowToPlanned);
    const baseInput = { today, now, accounts, txns, balances, cardTerms, growth, settings };
    const result = forecastCash({ ...baseInput, planned: [...manual, ...(profile ? taxCashItems(profile, tax, today) : [])] });

    // What-if: the same history with the levers applied (computed here, so the browser never gets the ledger).
    let scenario: { params: ScenarioParams; result: ForecastResult; tax: TaxYearResult[] } | null = null;
    if (hasLevers(levers)) {
      const sp = profile ? applyToProfile(profile, levers) : null;
      const sTax = taxFor(sp);
      const adjustments: { streamId: string; from: string; amountCents: number }[] = [];
      const pay = result.streams.filter((x) => x.kind === "income").sort((a, b) => b.typicalCents - a.typicalCents)[0];
      if (pay && profile && levers.preTax !== undefined) {
        const delta = Math.round(levers.preTax * 100) - profile.preTaxAnnualCents;
        const keep = 1 - (federalMarginalRate(profile, year) + 5) / 100;
        adjustments.push({ streamId: pay.id, from: today, amountCents: pay.typicalCents - Math.round((delta / 12) * keep) });
      }
      const extra = scenarioItems(levers, sp ?? ({ moveDate: null } as TaxProfile), today);
      const sResult = forecastCash({
        ...baseInput,
        planned: [...manual, ...(sp ? taxCashItems(sp, sTax, today) : []), ...extra],
        adjustments,
        extraCardPayments: scenarioCardPayments(levers, today),
      });
      scenario = { params: levers, result: sResult, tax: sTax };
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
