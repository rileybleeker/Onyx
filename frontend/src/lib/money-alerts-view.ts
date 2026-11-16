/**
 * How Today shows the money alerts (GET /api/finance/alerts) and how current they are. IMPORT-FREE at run time
 * (tests/today-regression.cjs bundles this file by name): type imports only.
 *
 * The route answers from a stored result (lib/finance-result-cache-server.ts). When the stored result is older
 * than the inputs (an ETL run, an edit, a new ET day, a new build) it is answered at once with `updating: true`
 * and recomputed after the response; Today then asks once more with ?fresh=1 (computed before answering when the
 * background refresh has not landed yet), so old alerts are never shown as current and a new alert shows within
 * seconds. `partial` = the forecast or the budgets could not be read, so an alert from that part may be missing.
 * `cash` = the cash forecast's input check (the same gate that withholds safe to move on the forecast page): when it
 * is not eligible, "no low-cash alert" is not an all-clear, so the panel shows the reason.
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
  /** The cash forecast's input check; null when the answer does not say (no ledger, or an older answer). */
  cash: { eligible: boolean; reasons: string[] } | null;
}

function parseCash(raw: unknown): MoneyView["cash"] {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { eligible?: unknown; reasons?: unknown };
  if (typeof c.eligible !== "boolean") return null;
  const reasons = Array.isArray(c.reasons) ? c.reasons.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 3) : [];
  return { eligible: c.eligible && reasons.length === 0, reasons };
}

/** Check a GET /api/finance/alerts answer (throws on anything else). */
export function parseMoneyAnswer(data: unknown): MoneyView {
  const v = data as { status?: unknown; alerts?: unknown; asOf?: unknown; updating?: unknown; partial?: unknown; cash?: unknown } | null;
  if (!v || v.status !== "ready" || !Array.isArray(v.alerts)) throw new Error("Invalid money alerts");
  return {
    alerts: v.alerts as MoneyAlert[],
    asOf: typeof v.asOf === "string" && Number.isFinite(Date.parse(v.asOf)) ? v.asOf : null,
    updating: v.updating === true,
    partial: v.partial === "forecast" || v.partial === "budgets" ? v.partial : null,
    refreshFailed: false,
    cash: parseCash(v.cash),
  };
}

/** The panel is shown when there is something to act on, or when "nothing to act on" is not verified. */
export function showMoneyPanel(v: MoneyView | null): boolean {
  if (!v) return false;
  return v.alerts.length > 0 || v.partial !== null || (v.updating && v.refreshFailed) || (!!v.cash && !v.cash.eligible);
}

/**
 * Why this answer cannot confirm "nothing to act on" though it was read: a part that could not be read, or a cash
 * forecast whose input check failed (the gate behind safe to move). The quiet view's Money source is then partial
 * with this note, so it never says "Nothing needs you right now". null = the answer is complete.
 */
export function moneyIncomplete(v: MoneyView): string | null {
  const why: string[] = [];
  if (v.partial) why.push(`your ${v.partial} couldn't be read`);
  if (v.cash && !v.cash.eligible) why.push("the cash forecast's inputs are incomplete");
  return why.length ? `${why.join(" and ")}, so an alert may be missing` : null;
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
  if (v.cash && !v.cash.eligible) {
    tone = "warn";
    parts.push(["Cash forecast incomplete.", ...v.cash.reasons.slice(0, 2), "A low-cash alert may be off or missing."].join(" "));
  }
  return parts.length ? { text: parts.join(" "), tone } : null;
}
