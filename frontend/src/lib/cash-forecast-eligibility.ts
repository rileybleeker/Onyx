/**
 * The safe-to-move gate of the cash forecast, read the same way everywhere: the forecast page's tile, the what-if
 * comparison and Today (lib/finance-alerts.ts cashForecastCheck). The engine (lib/cash-forecast.ts) decides
 * `result.eligibility`; this module only READS it, so a client view can use it without bundling the engine.
 *
 * An actionable amount ("safe to move to savings / investing") is shown only when every input it rests on was read,
 * complete and fresh. Otherwise the forecast is still drawn, as an estimate, and the amount is replaced by its
 * reasons, inside the same tile (so Personalize can never hide the reason and keep the number).
 *
 * PURE: no I/O, no clock. Type imports only from the engine.
 */
import type { EligibilityCode, EligibilityReason, ForecastEligibility, ForecastResult } from "./cash-forecast";

/** A result whose eligibility is missing or malformed (stored by older code): never eligible. */
export const UNVERIFIED: ForecastEligibility = {
  eligible: false,
  reasons: [{ code: "unverified", text: "This forecast was computed before its inputs were checked. Reload the page." }],
};
const CODES: ReadonlySet<string> = new Set<EligibilityCode>([
  "no-pool",
  "no-balance",
  "missing-balance",
  "invalid-balance",
  "stale-balance",
  "freshness-unknown",
  "short-history",
  "history-truncated",
  "plan-unavailable",
  "invalid-input",
  "unverified",
]);
const unverified = (): ForecastEligibility => ({ eligible: false, reasons: UNVERIFIED.reasons.map((r) => ({ ...r })) });

/**
 * The eligibility of a result, fresh or stored. Anything not well formed (a body stored before the check existed,
 * an unknown reason code) is never eligible, so an old safe-to-move amount is never shown as actionable.
 */
export function eligibilityOf(r: { eligibility?: unknown } | null | undefined): ForecastEligibility {
  const e = r?.eligibility as { eligible?: unknown; reasons?: unknown } | undefined;
  if (!e || typeof e.eligible !== "boolean" || !Array.isArray(e.reasons)) return unverified();
  const reasons = e.reasons.filter(
    (x): x is EligibilityReason => !!x && typeof x === "object" && CODES.has((x as EligibilityReason).code) && typeof (x as EligibilityReason).text === "string",
  );
  if (reasons.length !== e.reasons.length) return unverified();
  return { eligible: e.eligible && reasons.length === 0, reasons };
}

/** The actionable safe-to-move amount, or null when the inputs do not support one. */
export function safeToMoveOf(r: { eligibility?: unknown; headlines: { safeToMoveCents: number | null } }): number | null {
  const cents = r.headlines?.safeToMoveCents;
  return eligibilityOf(r).eligible && typeof cents === "number" && Number.isFinite(cents) ? cents : null;
}

/** "Nov 15, 3:00 PM ET" for a balance time (a date-only value reads "Nov 15"); null when it does not parse. */
export function cashAsOfLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return `${new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
}

/** What the "Safe to move" tile shows. */
export type SafeToMoveTile =
  | {
      kind: "amount";
      cents: number;
      /** About this much a week over the 13 weeks; null when the amount is 0. */
      perWeekCents: number | null;
      /** The buffer line the cautious path is kept above (Riley's setting; 0 when none is set). */
      bufferCents: number;
      bufferSet: boolean;
      /** The oldest cash balance the amount starts from, as a label ("Nov 15, 3:00 PM ET"). */
      asOf: string | null;
    }
  | {
      kind: "unavailable";
      /** Why the amount is withheld (at most 3 shown), and how many more there are. */
      reasons: string[];
      more: number;
      asOf: string | null;
    };

export function safeToMoveTile(result: Pick<ForecastResult, "headlines" | "opening"> & { eligibility?: unknown }, bufferCents: number): SafeToMoveTile {
  const asOf = cashAsOfLabel(result.opening?.asOf ?? null);
  const cents = safeToMoveOf(result);
  if (cents === null) {
    const e = eligibilityOf(result);
    // Eligible but no amount (should not happen): still never shown as an amount.
    const reasons = e.reasons.length ? e.reasons.map((r) => r.text) : ["The forecast inputs could not be checked."];
    return { kind: "unavailable", reasons: reasons.slice(0, 3), more: Math.max(0, reasons.length - 3), asOf };
  }
  const buffer = Number.isFinite(bufferCents) ? Math.max(0, bufferCents) : 0;
  return { kind: "amount", cents, perWeekCents: cents > 0 ? Math.floor(cents / 13) : null, bufferCents: buffer, bufferSet: buffer > 0, asOf };
}
