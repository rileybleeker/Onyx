/**
 * Life-event plans that feed the cash forecast (configurable on /financials/forecast): the NYC move (rent change,
 * moving costs, deposit, deposit refund, cost-of-living change). PURE: no I/O. Stored as driver "move".
 * The move date is also the tax plan's residency change (one source of truth).
 */
import { addDays, addMonths } from "./procurement-recurring";
import type { PlannedItem } from "./cash-forecast";

export interface MovePlan {
  date: string;
  /** Rent today and after the move, per month (paid however; the change is what the forecast adds). */
  currentRentCents: number;
  newRentCents: number;
  movingCostsCents: number;
  /** Security deposit paid about two weeks before the move; the old deposit refunded about a month after. */
  depositCents: number;
  depositRefundCents: number;
  /** Change in everyday spending per month after the move (+ more, - less). */
  livingCostChangeCents: number;
  /** Months the rent and living-cost changes are projected for. */
  months: number;
  note?: string;
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const cents = (v: unknown, min = 0) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= 10_000_000_00 ? v : null);

export function parseMovePlan(raw: unknown): MovePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isDay(r.date)) return null;
  const req = ["currentRentCents", "newRentCents", "movingCostsCents", "depositCents", "depositRefundCents"].map((k) => cents(r[k] ?? 0));
  const col = cents(r.livingCostChangeCents ?? 0, -10_000_000_00);
  if (req.some((x) => x === null) || col === null) return null;
  const months = typeof r.months === "number" && Number.isInteger(r.months) && r.months >= 1 && r.months <= 60 ? r.months : 24;
  return {
    date: r.date,
    currentRentCents: req[0]!,
    newRentCents: req[1]!,
    movingCostsCents: req[2]!,
    depositCents: req[3]!,
    depositRefundCents: req[4]!,
    livingCostChangeCents: col,
    months,
    note: typeof r.note === "string" ? r.note.slice(0, 200) : undefined,
  };
}

/** Planned cash lines for a move (dateOverride: a what-if move date). */
export function moveItems(m: MovePlan, dateOverride?: string | null): PlannedItem[] {
  const date = dateOverride ?? m.date;
  const items: PlannedItem[] = [];
  const firstRent = date.slice(8, 10) === "01" ? date : addMonths(`${date.slice(0, 7)}-01`, 1);
  const change = m.newRentCents - m.currentRentCents;
  if (change !== 0) items.push({ id: "move:rent", label: `NYC rent change (${change > 0 ? "+" : ""}$${Math.round(change / 100)}/mo)`, date: firstRent, amountCents: -change, certainty: "likely", repeat: { unit: "month", every: 1, count: m.months } });
  if (m.movingCostsCents > 0) items.push({ id: "move:costs", label: "Moving costs", date, amountCents: -m.movingCostsCents, certainty: "likely" });
  if (m.depositCents > 0) items.push({ id: "move:deposit", label: "NYC security deposit", date: addDays(date, -14), amountCents: -m.depositCents, certainty: "likely" });
  if (m.depositRefundCents > 0) items.push({ id: "move:refund", label: "Old deposit refunded", date: addDays(date, 30), amountCents: m.depositRefundCents, certainty: "possible" });
  if (m.livingCostChangeCents !== 0)
    items.push({ id: "move:col", label: "NYC cost-of-living change", date: addDays(date, 30), amountCents: -m.livingCostChangeCents, certainty: "likely", repeat: { unit: "month", every: 1, count: m.months } });
  return items;
}
