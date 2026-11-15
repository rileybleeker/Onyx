/**
 * How Today shows the money alerts (GET /api/finance/alerts) and how current they are. IMPORT-FREE at run time
 * (tests/today-regression.cjs bundles this file by name): type imports only.
 *
 * The route answers from a stored result (lib/finance-result-cache-server.ts). When the stored result is older
 * than the inputs (an ETL run, an edit, a new ET day, a new build) it is answered at once with `updating: true`
 * and recomputed after the response; Today then asks once more with ?fresh=1 (computed before answering when the
 * background refresh has not landed yet), so old alerts are never shown as current and a new alert shows within
 * seconds. `partial` = the forecast or the budgets could not be read, so an alert from that part may be missing.
 */
import type { MoneyAlert } from "./finance-alerts";

export const MONEY_URL = "/api/finance/alerts";
/** The follow-up read after an `updating` answer. */
export const MONEY_FRESH_URL = "/api/finance/alerts?fresh=1";
/** How long Today waits before the follow-up read (the background refresh takes about a second). */
export const MONEY_RECHECK_MS = 4_000;

export type MoneyPart = "forecast" | "budgets";
export interface MoneyView {
  alerts: MoneyAlert[];
  /** When the alerts were computed (ISO), null for an answer that does not say. */
  asOf: string | null;
  /** An older stored answer: a newer one is being computed. */
  updating: boolean;
  /** The part that could not be read, or null. */
  partial: MoneyPart | null;
  /** The newer answer could not be fetched: what is shown may be out of date. */
  refreshFailed: boolean;
}

/** Check a GET /api/finance/alerts answer (throws on anything else). */
export function parseMoneyAnswer(data: unknown): MoneyView {
  const v = data as { status?: unknown; alerts?: unknown; asOf?: unknown; updating?: unknown; partial?: unknown } | null;
  if (!v || v.status !== "ready" || !Array.isArray(v.alerts)) throw new Error("Invalid money alerts");
  return {
    alerts: v.alerts as MoneyAlert[],
    asOf: typeof v.asOf === "string" && Number.isFinite(Date.parse(v.asOf)) ? v.asOf : null,
    updating: v.updating === true,
    partial: v.partial === "forecast" || v.partial === "budgets" ? v.partial : null,
    refreshFailed: false,
  };
}

/** The panel is shown when there is something to act on, or when "nothing to act on" is not verified. */
export function showMoneyPanel(v: MoneyView | null): boolean {
  if (!v) return false;
  return v.alerts.length > 0 || v.partial !== null || (v.updating && v.refreshFailed);
}

function age(iso: string | null, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "an earlier check";
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (min < 2) return "the check just now";
  if (min < 60) return `the check ${min} min ago`;
  if (min < 48 * 60) return `the check ${Math.floor(min / 60)} h ago`;
  return `the check ${Math.floor(min / 1440)} d ago`;
}

/**
 * The line under the alerts that says how current they are; null when they are current and complete.
 * tone "warn" = it could not be brought up to date (or part is missing); "muted" = a newer answer is on its way.
 */
export function moneyNote(v: MoneyView, now: Date): { text: string; tone: "muted" | "warn" } | null {
  const parts: string[] = [];
  let tone: "muted" | "warn" = "muted";
  if (v.refreshFailed && v.alerts.length > 0) {
    tone = "warn";
    parts.push(`Couldn't refresh: these are from ${age(v.asOf, now)} and may have changed.`);
  } else if (v.refreshFailed && v.updating) {
    tone = "warn";
    parts.push(`No money alerts in ${age(v.asOf, now)}, but it couldn't be brought up to date.`);
  } else if (v.updating) parts.push(`From ${age(v.asOf, now)}. Updating...`);
  if (v.partial) {
    tone = "warn";
    parts.push(`Your ${v.partial} couldn't be read, so an alert from it may be missing.`);
  }
  return parts.length ? { text: parts.join(" "), tone } : null;
}
