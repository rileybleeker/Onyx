/**
 * Savings goals (an NYC move fund, an emergency fund): progress from real balances and, for goals on the cash
 * pool, whether the cash forecast reaches the target by its date. PURE: no I/O. Tracking only: Onyx never moves
 * money toward a goal.
 */
import type { DayPoint } from "./cash-forecast";

export interface GoalRow {
  id: string;
  name: string;
  target_cents: number;
  target_date: string;
  account_key: string | null; // null = the cash pool (checking + savings)
}
export interface GoalView {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string;
  accountLabel: string;
  currentCents: number;
  pct: number;
  monthsLeft: number;
  perMonthNeededCents: number;
  /** Cash-pool goals: the forecast's likely balance on the target date (null past the horizon or for one account). */
  projectedCents: number | null;
  onTrack: boolean | null;
}

const monthsBetween = (from: string, to: string) =>
  Math.max(0, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + (Number(to.slice(8, 10)) >= Number(from.slice(8, 10)) ? 0 : -1));

export function computeGoals(
  goals: readonly GoalRow[],
  balances: ReadonlyMap<string, number>,
  labels: ReadonlyMap<string, string>,
  poolCents: number,
  days: readonly DayPoint[],
  today: string,
): GoalView[] {
  return goals.map((g) => {
    const current = g.account_key ? (balances.get(g.account_key) ?? 0) : poolCents;
    const monthsLeft = monthsBetween(today, g.target_date);
    const gap = Math.max(0, g.target_cents - current);
    const projected = g.account_key ? null : (days.find((d) => d.date >= g.target_date)?.likely ?? null);
    return {
      id: g.id,
      name: g.name,
      targetCents: g.target_cents,
      targetDate: g.target_date,
      accountLabel: g.account_key ? (labels.get(g.account_key) ?? "account") : "Cash (checking + savings)",
      currentCents: current,
      pct: g.target_cents > 0 ? Math.max(0, Math.min(100, Math.round((current / g.target_cents) * 100))) : 0,
      monthsLeft,
      perMonthNeededCents: gap === 0 ? 0 : Math.ceil(gap / Math.max(1, monthsLeft)),
      projectedCents: projected,
      onTrack: projected === null ? (gap === 0 ? true : null) : projected >= g.target_cents,
    };
  });
}
