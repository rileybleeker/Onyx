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
  return summaryFromAhead(renewalsAhead(load), load.state === "ok" ? load.today : "");
}

/**
 * The stored form of the Today summary (pds.finance_result_cache, key "renewals"): every alertable
 * renewal due today or later, as {merchant, date} only (no amounts), soonest first, plus the day it was
 * computed for. The summary for a LATER day is derived from it without re-reading the ledger
 * (summaryFromAhead): an estimate that is today or later belongs to an active subscription and does not
 * move with the date, so the derived summary equals a fresh computation until the ledger changes.
 */
export type RenewalsAhead =
  | { status: "empty" }
  | { status: "ready"; from: string; upcoming: { merchant: string; date: string }[] };

export function renewalsAhead(load: Exclude<DetectedLoad, { state: "error" }>): RenewalsAhead {
  if (load.state === "empty") return { status: "empty" };
  const upcoming = renewalRows(load.subs, load.today)
    .filter((r) => r.alertable && r.days >= 0)
    .map((r) => ({ merchant: r.merchant, date: r.date }));
  return { status: "ready", from: load.today, upcoming };
}

/** The Today summary on `today` (never earlier than the day the stored form was computed for). */
export function summaryFromAhead(ahead: RenewalsAhead, today: string): RenewalSummary {
  if (ahead.status === "empty") return { status: "empty" };
  const on = today > ahead.from ? today : ahead.from;
  // The stored order is soonest first, then merchant; every date shifts by the same number of days, so a
  // stable sort on days keeps it.
  const soon = ahead.upcoming
    .map((u) => ({ ...u, days: daysBetween(on, u.date) }))
    .filter((r) => r.days >= 0 && r.days <= RENEWAL_SOON_DAYS)
    .sort((a, b) => a.days - b.days);
  return {
    status: "ready",
    count: soon.length,
    soon: soon.slice(0, RENEWAL_SUMMARY_MAX).map((r) => ({ merchant: r.merchant, days: r.days, date: r.date, label: renewalPhrase(r.days) })),
    withinDays: RENEWAL_SOON_DAYS,
  };
}

/** A stored RenewalsAhead read back from the database, or null when it is not one. */
export function parseRenewalsAhead(body: unknown): RenewalsAhead | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.status === "empty") return { status: "empty" };
  const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (b.status !== "ready" || !isDay(b.from) || !Array.isArray(b.upcoming)) return null;
  const upcoming: { merchant: string; date: string }[] = [];
  for (const u of b.upcoming) {
    const r = u as Record<string, unknown> | null;
    if (!r || typeof r.merchant !== "string" || !isDay(r.date)) return null;
    upcoming.push({ merchant: r.merchant, date: r.date });
  }
  return { status: "ready", from: b.from, upcoming };
}
