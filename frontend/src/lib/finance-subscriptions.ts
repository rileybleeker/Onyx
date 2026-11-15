/**
 * Subscriptions on the Budgets page, with a cancel tracker: Riley cancels on the merchant's site, marks it here,
 * and the ledger then shows whether the charges actually stopped. PURE: no I/O. Onyx never cancels anything.
 */
import { addDays, type DetectedSubscription } from "./procurement-recurring";

export type CancelState = "active" | "waiting" | "stopped" | "still-charging";
export interface SubscriptionView {
  id: string;
  merchant: string;
  cadence: string;
  typicalCents: number;
  monthlyCents: number;
  lastCharge: string;
  nextExpected: string;
  markedOn: string | null;
  state: CancelState;
  stateText: string;
  /** A web search for the merchant's cancel page (opened only when Riley clicks it). */
  cancelSearchUrl: string;
}

export function subscriptionViews(subs: readonly DetectedSubscription[], marks: ReadonlyMap<string, string>, today: string): SubscriptionView[] {
  return subs
    // Interest charges repeat monthly but are the cost of a card balance, not a subscription (see the forecast's Cards).
    .filter((s) => !/\binterest\b/i.test(s.merchant))
    .filter((s) => s.status === "active" || marks.has(s.id))
    .map((s) => {
      const markedOn = marks.get(s.id) ?? null;
      let state: CancelState = "active";
      let stateText = "";
      if (markedOn) {
        if (s.lastCharge > markedOn) {
          state = "still-charging";
          stateText = `Still charging: charged on ${s.lastCharge}, after you marked it cancelled on ${markedOn}. Check that the cancellation went through.`;
        } else if (today > addDays(s.nextExpected, 7)) {
          state = "stopped";
          stateText = `Stopped: no charge since ${s.lastCharge}; the next one was due about ${s.nextExpected}.`;
        } else {
          state = "waiting";
          stateText = `Marked cancelled on ${markedOn}. Confirmed once ${s.nextExpected} passes with no charge.`;
        }
      }
      return {
        id: s.id,
        merchant: s.merchant,
        cadence: s.cadence,
        typicalCents: s.typicalCents,
        monthlyCents: s.monthlyCents,
        lastCharge: s.lastCharge,
        nextExpected: s.nextExpected,
        markedOn,
        state,
        stateText,
        cancelSearchUrl: `https://www.google.com/search?q=${encodeURIComponent(`how to cancel ${s.merchant} subscription`)}`,
      };
    })
    .sort((a, b) => (a.state === "still-charging" ? -1 : b.state === "still-charging" ? 1 : b.monthlyCents - a.monthlyCents));
}

/** Monthly cost of what is still active (stopped ones excluded). */
export const activeMonthly = (views: readonly SubscriptionView[]): number => views.filter((v) => v.state !== "stopped").reduce((s, v) => s + v.monthlyCents, 0);
