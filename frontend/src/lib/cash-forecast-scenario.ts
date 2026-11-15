/**
 * What-if scenarios for the cash forecast (docs/cash-flow-forecast.md, Section 8). PURE: no I/O.
 * A scenario is a small set of levers carried in the page URL (so the server recomputes; the browser never gets
 * the transaction list) and, when saved, stored as a driver 'scenario:<slug>'. The base plan is never edited.
 */
import { addDays, addMonths } from "./procurement-recurring";
import type { PlannedItem } from "./cash-forecast";
import type { TaxProfile } from "./tax-plan";

export interface ScenarioParams {
  /** Bonus as a % of plan (100 = as planned). Applies to supplemental pay labelled "bonus". */
  bonusPct?: number;
  /** Months to move the bonus (+ later, - earlier). */
  bonusShiftMonths?: number;
  /** NYC move date (YYYY-MM-DD), or "none" to stay in Georgia. */
  moveDate?: string;
  /** Monthly rent change from the move (NYC rent minus current rent), dollars. */
  rentChange?: number;
  /** One-off moving costs on the move date, dollars. */
  movingCosts?: number;
  /** Change in everyday spending per month (+ more, - less), dollars. */
  spendChange?: number;
  /** Extra payment to a card, dollars, on a date. */
  payoffCard?: string;
  payoffAmount?: number;
  payoffDate?: string;
  /** Other (1099) income for the year, dollars. */
  otherIncome?: number;
  /** Pre-tax 401(k) / HSA contributions per year, dollars. */
  preTax?: number;
}

const NUM_KEYS = ["bonusPct", "bonusShiftMonths", "rentChange", "movingCosts", "spendChange", "payoffAmount", "otherIncome", "preTax"] as const;
const LIMITS: Record<(typeof NUM_KEYS)[number], [number, number]> = {
  bonusPct: [0, 300],
  bonusShiftMonths: [-12, 12],
  rentChange: [-20_000, 20_000],
  movingCosts: [0, 200_000],
  spendChange: [-50_000, 50_000],
  payoffAmount: [0, 1_000_000],
  otherIncome: [0, 2_000_000],
  preTax: [0, 100_000],
};
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Read levers from URL params (unknown keys and out-of-range values are dropped). */
export function parseScenarioParams(get: (k: string) => string | null | undefined): ScenarioParams {
  const out: ScenarioParams = {};
  for (const k of NUM_KEYS) {
    const raw = get(k);
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    const [lo, hi] = LIMITS[k];
    if (Number.isFinite(n) && n >= lo && n <= hi) out[k] = Math.round(n * 100) / 100;
  }
  const move = get("moveDate");
  if (move === "none" || isDay(move)) out.moveDate = move;
  const card = get("payoffCard");
  if (card && /^[A-Za-z0-9_-]{1,64}$/.test(card)) out.payoffCard = card;
  const pd = get("payoffDate");
  if (isDay(pd)) out.payoffDate = pd;
  return out;
}
export function scenarioToQuery(p: ScenarioParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
}
export const hasLevers = (p: ScenarioParams): boolean => Object.keys(p).length > 0;

/** The tax profile under the scenario (bonus size / timing, move date, other income, pre-tax savings). */
export function applyToProfile(profile: TaxProfile, p: ScenarioParams): TaxProfile {
  const next: TaxProfile = { ...profile, oneOffs: profile.oneOffs.map((o) => ({ ...o })), annualBonus: profile.annualBonus ? { ...profile.annualBonus } : profile.annualBonus };
  if (p.bonusPct !== undefined && next.annualBonus) next.annualBonus.amountCents = Math.round((next.annualBonus.amountCents * p.bonusPct) / 100);
  if (p.bonusPct !== undefined || p.bonusShiftMonths) {
    next.oneOffs = next.oneOffs.map((o) =>
      /bonus/i.test(o.label) && !/signing/i.test(o.label)
        ? { ...o, grossCents: Math.round((o.grossCents * (p.bonusPct ?? 100)) / 100), date: p.bonusShiftMonths ? addMonths(o.date, p.bonusShiftMonths) : o.date }
        : o,
    );
  }
  if (p.moveDate !== undefined) next.moveDate = p.moveDate === "none" ? null : p.moveDate;
  if (p.otherIncome !== undefined) next.otherIncomeAnnualCents = Math.round(p.otherIncome * 100);
  if (p.preTax !== undefined) next.preTaxAnnualCents = Math.round(p.preTax * 100);
  return next;
}

/** Extra planned items the levers add (rent change, moving costs, spending change, card payoff). */
export function scenarioItems(p: ScenarioParams, profile: TaxProfile, today: string): PlannedItem[] {
  const items: PlannedItem[] = [];
  const move = p.moveDate === "none" ? null : (p.moveDate ?? profile.moveDate);
  if (move && p.rentChange) {
    items.push({ id: "wi:rent", label: "What-if: rent change after the move", date: move, amountCents: -Math.round(p.rentChange * 100), certainty: "likely", repeat: { unit: "month", every: 1, count: 24 } });
  }
  if (move && p.movingCosts) items.push({ id: "wi:moving", label: "What-if: moving costs", date: move, amountCents: -Math.round(p.movingCosts * 100), certainty: "likely" });
  if (p.spendChange) {
    items.push({ id: "wi:spend", label: "What-if: everyday spending change", date: addDays(today, 30), amountCents: -Math.round(p.spendChange * 100), certainty: "likely", repeat: { unit: "month", every: 1, count: 24 } });
  }
  if (p.payoffCard && p.payoffAmount && p.payoffAmount > 0) {
    items.push({ id: "wi:payoff", label: "What-if: extra card payment", date: p.payoffDate && p.payoffDate > today ? p.payoffDate : addDays(today, 1), amountCents: -Math.round(p.payoffAmount * 100), certainty: "confirmed" });
  }
  return items;
}
export function scenarioCardPayments(p: ScenarioParams, today: string): { account_key: string; date: string; cents: number }[] {
  if (!p.payoffCard || !p.payoffAmount || p.payoffAmount <= 0) return [];
  return [{ account_key: p.payoffCard, date: p.payoffDate && p.payoffDate > today ? p.payoffDate : addDays(today, 1), cents: Math.round(p.payoffAmount * 100) }];
}
