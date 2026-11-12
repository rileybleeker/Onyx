/**
 * Recurring-charge ("subscription") detection over the finance ledger.
 *
 * PURE and deterministic: no network, no clock (callers pass `today` as YYYY-MM-DD), no Supabase.
 * The server loader lives in procurement-recurring-server.ts. Amounts are EXPENSE-POSITIVE cents
 * (see finance-ledger.ts); only counted USD purchases are considered, currencies are never mixed.
 */
import { classifyTxn, toCents } from "./finance-ledger";

export type RecurringCadence = "weekly" | "monthly" | "quarterly" | "annual";

export interface RecurringInput {
  txn_date: string; // YYYY-MM-DD
  name: string;
  custom_name: string | null;
  amount_cents: number;
  currency: string;
  category: string | null;
  ignored_from: string | null;
}

export interface DetectedSubscription {
  merchant: string;
  cadence: RecurringCadence;
  typicalCents: number;
  lastCharge: string;
  nextExpected: string;
  chargeCount: number;
  monthlyCents: number;
  status: "active" | "lapsed";
}

export type DetectedLoad =
  | { state: "ok"; subs: DetectedSubscription[]; total: number; today: string }
  | { state: "empty" }
  | { state: "error"; code: string };

/** Days of ledger history the loader reads. */
export const RECURRING_WINDOW_DAYS = 400;

const BANDS: Record<RecurringCadence, { min: number; max: number; minCharges: number }> = {
  weekly: { min: 6, max: 8, minCharges: 3 },
  monthly: { min: 26, max: 35, minCharges: 3 },
  quarterly: { min: 84, max: 98, minCharges: 3 },
  annual: { min: 350, max: 380, minCharges: 2 },
};
const CADENCES = Object.keys(BANDS) as RecurringCadence[];
const MIN_IN_BAND = 0.7;
const AMOUNT_TOLERANCE = 0.25;
const DAY_MS = 86_400_000;

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Strip store / reference numbers (#1234, long digit runs) so two spellings of a merchant merge. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/#\s*\d+/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[\s\-*#]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeMerchant(raw: string): string {
  return cleanLabel(raw).toLowerCase();
}

/** Parse one PostgREST row into a detector input; a malformed row is dropped (null). */
export function parseRecurringInput(raw: unknown): RecurringInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cents = toCents(r.amount_cents);
  if (!isDay(r.txn_date) || cents === null) return null;
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    txn_date: r.txn_date,
    name: s(r.name) ?? "",
    custom_name: s(r.custom_name),
    amount_cents: cents,
    currency: (s(r.currency) ?? "USD").trim().toUpperCase() || "USD",
    category: s(r.category),
    ignored_from: s(r.ignored_from),
  };
}

interface Charge {
  date: string;
  cents: number;
  label: string;
}

function classify(charges: Charge[], today: string): DetectedSubscription | null {
  // Several charges on one day count once (the largest), so a duplicate never makes a zero-day gap.
  const byDay = new Map<string, Charge>();
  for (const c of charges) {
    const prev = byDay.get(c.date);
    if (!prev || c.cents > prev.cents) byDay.set(c.date, c);
  }
  const list = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (list.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
  const medGap = median(gaps);
  const cadence = CADENCES.find((c) => medGap >= BANDS[c].min && medGap <= BANDS[c].max);
  if (!cadence) return null;
  const band = BANDS[cadence];
  if (list.length < band.minCharges) return null;
  const inBand = gaps.filter((g) => g >= band.min && g <= band.max).length;
  if (inBand / gaps.length < MIN_IN_BAND) return null;

  const recent = list.slice(-3).map((c) => c.cents);
  const typical = Math.round(median(recent));
  if (typical <= 0) return null;
  if (recent.some((c) => Math.abs(c - typical) > AMOUNT_TOLERANCE * typical)) return null;

  const last = list[list.length - 1];
  const typicalGap = Math.round(medGap);
  const nextExpected = addDays(last.date, typicalGap);
  const monthlyCents = Math.round(
    cadence === "weekly" ? (typical * 52) / 12 : cadence === "monthly" ? typical : cadence === "quarterly" ? typical / 3 : typical / 12,
  );
  const active = daysBetween(nextExpected, today) <= typicalGap / 2;
  return {
    merchant: cleanLabel(last.label) || last.label.trim(),
    cadence,
    typicalCents: typical,
    lastCharge: last.date,
    nextExpected,
    chargeCount: list.length,
    monthlyCents,
    status: active ? "active" : "lapsed",
  };
}

/** Detect recurring charges. Active first, then by monthly-equivalent descending. */
export function detectRecurring(txns: readonly RecurringInput[], today: string): DetectedSubscription[] {
  const groups = new Map<string, Charge[]>();
  for (const t of txns) {
    if (classifyTxn(t) !== "counted") continue;
    if (!(t.amount_cents > 0)) continue;
    if ((t.currency ?? "").trim().toUpperCase() !== "USD") continue;
    if (!isDay(t.txn_date)) continue;
    const label = (t.custom_name ?? "").trim() || (t.name ?? "").trim();
    const key = normalizeMerchant(label);
    if (!key) continue;
    const list = groups.get(key);
    const charge = { date: t.txn_date, cents: t.amount_cents, label };
    if (list) list.push(charge);
    else groups.set(key, [charge]);
  }
  const subs: DetectedSubscription[] = [];
  for (const charges of groups.values()) {
    const sub = classify(charges, today);
    if (sub) subs.push(sub);
  }
  return subs.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
      b.monthlyCents - a.monthlyCents ||
      (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0),
  );
}

/** Monthly-equivalent total of the active subscriptions, in cents. */
export function activeMonthlyTotal(subs: readonly DetectedSubscription[]): number {
  return subs.reduce((sum, s) => sum + (s.status === "active" ? s.monthlyCents : 0), 0);
}
