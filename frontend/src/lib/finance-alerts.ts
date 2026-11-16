/**
 * Money alerts (only things Riley can act on): cash heading below the low-balance line, a budget over or heading
 * over, a 0% promo ending soon, a tax payment due soon. PURE: no I/O. Shown on Today and on the finance pages.
 */
import type { ForecastResult } from "./cash-forecast";
import { EXPIRED_REASON, eligibilityOf, leftOutCentsOf } from "./cash-forecast-eligibility";
import type { BudgetsResult } from "./finance-budgets";

export interface MoneyAlert {
  kind: "low-cash" | "budget" | "promo" | "tax";
  severity: "high" | "medium";
  title: string;
  detail: string;
  href: string;
  /**
   * The alert's own date ("YYYY-MM-DD", ET): the first day cash drops below the line on the cautious path, the day
   * the 0% promo ends, or the day the tax payment is due. Absent for budgets (no single day) and in answers stored
   * before it existed. Today ranks by it and never lets a snooze outlast it (lib/today-attention.ts).
   */
  due?: string;
  /** Low cash only: the day cash is lowest (the day the title names), which can be later than `due`. */
  lowest?: string;
  /**
   * Low cash only: the first day the LIKELY path is below the line, when it is within the 30 days. It can come before
   * the cautious path's lowest day, so Today treats a likely breach today or tomorrow as urgent from this date.
   */
  likelyDue?: string;
}

/**
 * The cash forecast's input check, as Today shows it: the SAME gate that withholds the safe-to-move amount on the
 * forecast page and in the what-if (eligibilityOf). Not eligible = a stale, missing or unreadable input, so "no
 * low-cash alert" is not an all-clear. Reasons are short sentences (account labels, never amounts).
 */
export interface CashForecastCheck {
  eligible: boolean;
  reasons: string[];
  /** Stored copy only: when the check stops holding (ISO). cashCheckAt applies it when the answer is served. */
  validUntil?: string;
}
export function cashForecastCheck(forecast: ForecastResult | null): CashForecastCheck | null {
  if (!forecast) return null;
  const e = eligibilityOf(forecast);
  return { eligible: e.eligible, reasons: e.reasons.slice(0, 3).map((r) => r.text), ...(e.validUntil ? { validUntil: e.validUntil } : {}) };
}
/** True once the stored check's validUntil has passed (or does not parse): it no longer holds at `now`. */
export function cashCheckExpired(check: CashForecastCheck, now: Date): boolean {
  const until = check.validUntil === undefined ? null : Date.parse(check.validUntil);
  return until !== null && !(Number.isFinite(until) && until > now.getTime());
}
/**
 * A stored check as Today is told it at `now`: once a balance it counted has turned 48 hours old (validUntil, or a
 * validUntil that does not parse), it is not eligible. The answer never carries validUntil itself.
 */
export function cashCheckAt(check: CashForecastCheck, now: Date): CashForecastCheck {
  const expired = cashCheckExpired(check, now);
  const reasons = expired ? [EXPIRED_REASON.text, ...check.reasons.filter((t) => t !== EXPIRED_REASON.text)].slice(0, 3) : check.reasons;
  return { eligible: check.eligible && !expired && reasons.length === 0, reasons };
}

const usd = (cents: number) => `$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function moneyAlerts(forecast: ForecastResult | null, budgets: BudgetsResult | null, bufferCents: number, today: string): MoneyAlert[] {
  const out: MoneyAlert[] = [];
  if (forecast && forecast.state === "ok") {
    const line = Math.max(0, bufferCents);
    // The same cash the safe-to-move amount counts: the positive balance of the accounts Riley left out (a savings
    // account the feed no longer refreshes) is taken out of the projection, so a stale balance there can never hide a
    // low-cash alert on the accounts that are counted. The projection on the forecast page still includes it.
    const leftOut = leftOutCentsOf(forecast);
    const soon = forecast.days.slice(0, 30).map((d) => ({ date: d.date, low: d.low - leftOut, likely: d.likely - leftOut }));
    const low = soon.reduce<{ date: string; cents: number } | null>((m, d) => (!m || d.low < m.cents ? { date: d.date, cents: d.low } : m), null);
    // The day it first crosses the line is when Riley has to act, even when the lowest point is later.
    const firstBelow = soon.find((d) => d.low < line);
    // The likely path can drop below the line on a day other than the cautious low point (sooner, even): that day
    // makes the alert likely (high) and is Today's deadline when it is today or tomorrow.
    const firstLikely = soon.find((d) => d.likely < line);
    if (low && low.cents < line) {
      const likelyThen = soon.find((d) => d.date === low.date)?.likely ?? low.cents;
      const likelyElsewhere = firstLikely && likelyThen >= line ? `; likely below it around ${day(firstLikely.date)}` : "";
      out.push({
        kind: "low-cash",
        severity: likelyThen < line || firstLikely ? "high" : "medium",
        title: `Cash may drop to ${low.cents < 0 ? "-" : ""}${usd(low.cents)} around ${day(low.date)}`,
        detail: `${line > 0 ? `Below your ${usd(line)} line` : "Below $0"} on the cautious path (likely ${likelyThen < 0 ? "-" : ""}${usd(likelyThen)}${likelyElsewhere})${leftOut > 0 ? ", not counting the accounts you left out" : ""}. Move money or delay a payment.`,
        href: "/financials/forecast",
        due: firstBelow?.date ?? low.date,
        lowest: low.date,
        ...(firstLikely ? { likelyDue: firstLikely.date } : {}),
      });
    }
    for (const m of forecast.milestones) {
      if (m.ended || m.daysAway > 60 || m.owedAtEndCents <= 0) continue;
      out.push({
        kind: "promo",
        severity: m.daysAway <= 30 ? "high" : "medium",
        title: `${m.label}: 0% ends ${day(m.date)}`,
        detail: `About ${usd(m.owedAtEndCents)} would still be owed, costing about ${usd(m.interestPerMonthAfterCents)} a month after.`,
        href: "/financials/forecast",
        due: m.date,
      });
    }
    const horizon = addDays(today, 14);
    for (const l of forecast.lines) {
      if (!l.sourceId.startsWith("tax:") || l.amountCents >= 0 || l.date > horizon) continue;
      out.push({ kind: "tax", severity: "high", title: `${l.label.replace(/ \(calculated\)$/, "")}: ${usd(l.amountCents)} due ${day(l.date)}`, detail: "Your employer does not withhold it; pay it as an estimated payment.", href: "/financials/forecast", due: l.date });
    }
  }
  if (budgets) {
    const flagged = budgets.lines
      .filter((l) => l.budgetCents !== null && (l.status === "over" || (l.status === "at-risk" && l.projectedCents - (l.budgetCents ?? 0) >= Math.max(2_500, (l.budgetCents ?? 0) * 0.1))))
      .sort((a, b) => b.projectedCents - (b.budgetCents ?? 0) - (a.projectedCents - (a.budgetCents ?? 0)))
      .slice(0, 3);
    for (const l of flagged) {
      out.push({
        kind: "budget",
        severity: l.status === "over" ? "high" : "medium",
        title: l.status === "over" ? `${l.category}: ${usd(l.spentCents - (l.budgetCents ?? 0))} over budget` : `${l.category}: heading ${usd(l.projectedCents - (l.budgetCents ?? 0))} over budget`,
        detail: `${usd(l.spentCents)} spent of ${usd(l.budgetCents ?? 0)} with ${budgets.daysInMonth - budgets.dayOfMonth} days left.`,
        href: "/financials/budgets",
      });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}
