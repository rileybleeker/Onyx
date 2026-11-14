/**
 * Renewal alerts over the detected subscriptions (lib/procurement-recurring.ts).
 *
 * PURE: no network, no clock (callers pass `today`), no Supabase. Read-only advice: nothing here
 * pays, cancels or changes a subscription.
 *
 * Which renewals are alerted on:
 * - only ACTIVE subscriptions (a lapsed one has no next charge to warn about);
 * - only estimates with high or medium confidence. A low-confidence date is still shown on
 *   /procurement, marked as rough, but never raises the Today panel;
 * - charges that repeat on no regular schedule have no date at all (IrregularCharge).
 */
import { daysBetween, type DetectedLoad, type DetectedSubscription, type RenewalConfidence } from "./procurement-recurring";

/** Today shows a renewal this many days ahead (0 = today). */
export const RENEWAL_SOON_DAYS = 3;
/** /procurement lists renewals this far ahead under "Renewing soon". */
export const RENEWAL_LIST_DAYS = 14;
/** At most this many renewals are named on Today; the rest are a count. */
export const RENEWAL_SUMMARY_MAX = 3;

export interface RenewalRow {
  id: string;
  merchant: string;
  cadence: DetectedSubscription["cadence"];
  typicalCents: number;
  /** Estimated next charge date, YYYY-MM-DD. */
  date: string;
  /** Days from today to that date; negative = expected already, not in the ledger yet. */
  days: number;
  confidence: RenewalConfidence;
  /** High / medium confidence, so it may raise an alert. */
  alertable: boolean;
}

/** One row per ACTIVE subscription, soonest first. */
export function renewalRows(subs: readonly DetectedSubscription[], today: string): RenewalRow[] {
  return subs
    .filter((s) => s.status === "active")
    .map((s) => ({
      id: s.id,
      merchant: s.merchant,
      cadence: s.cadence,
      typicalCents: s.typicalCents,
      date: s.nextExpected,
      days: daysBetween(today, s.nextExpected),
      confidence: s.confidence,
      alertable: s.confidence !== "low",
    }))
    .sort((a, b) => a.days - b.days || (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0));
}

/** Alertable renewals due from today through `withinDays` days ahead. */
export function renewalsWithin(subs: readonly DetectedSubscription[], today: string, withinDays: number): RenewalRow[] {
  return renewalRows(subs, today).filter((r) => r.alertable && r.days >= 0 && r.days <= withinDays);
}

/** "renews today" / "renews tomorrow" / "renews in 5 days"; a past estimate says the charge has not shown up yet. */
export function renewalPhrase(days: number): string {
  if (days === 0) return "renews today";
  if (days === 1) return "renews tomorrow";
  if (days > 1) return `renews in ${days} days`;
  return days === -1 ? "was expected yesterday (not in the ledger yet)" : `was expected ${-days} days ago (not in the ledger yet)`;
}

const CONFIDENCE_WORDS: Record<RenewalConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence, a rough date",
};

/** "Estimate: same day of the month as the recent charges. High confidence: the last 4 gaps fit within 1 day." */
export function estimateNote(sub: Pick<DetectedSubscription, "nextMethod" | "confidence" | "checkedGaps" | "maxMissDays">): string {
  const gaps = sub.checkedGaps === 1 ? "the one gap seen fits" : `the last ${sub.checkedGaps} gaps fit`;
  const miss = sub.maxMissDays === 0 ? "exactly" : `within ${sub.maxMissDays} day${sub.maxMissDays === 1 ? "" : "s"}`;
  return `Estimate: ${sub.nextMethod}. ${CONFIDENCE_WORDS[sub.confidence]}: ${gaps} ${miss}.`;
}

// ─── Today summary (GET /api/procurement/renewals/summary) ─────────────────────────────────────

export interface RenewalSummaryItem {
  merchant: string;
  days: number;
  date: string;
  /** "renews tomorrow": ready to show, so Today needs no code of its own for it. */
  label: string;
}
export type RenewalSummary =
  | { status: "ready"; count: number; soon: RenewalSummaryItem[]; withinDays: number }
  | { status: "empty" };

/**
 * What Today shows: the renewals due within RENEWAL_SOON_DAYS, soonest first, at most
 * RENEWAL_SUMMARY_MAX named. No amounts: Today is a glance screen, the amounts are on /procurement.
 * A failed ledger read is the route's business (HTTP 500), never an empty summary.
 */
export function renewalSummary(load: Exclude<DetectedLoad, { state: "error" }>): RenewalSummary {
  if (load.state === "empty") return { status: "empty" };
  const soon = renewalsWithin(load.subs, load.today, RENEWAL_SOON_DAYS);
  return {
    status: "ready",
    count: soon.length,
    soon: soon.slice(0, RENEWAL_SUMMARY_MAX).map((r) => ({ merchant: r.merchant, days: r.days, date: r.date, label: renewalPhrase(r.days) })),
    withinDays: RENEWAL_SOON_DAYS,
  };
}
