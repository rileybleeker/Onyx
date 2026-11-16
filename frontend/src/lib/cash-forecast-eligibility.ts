/**
 * The safe-to-move gate of the cash forecast, read the same way everywhere: the forecast page's tile, the what-if
 * comparison and Today (lib/finance-alerts.ts cashForecastCheck). The engine (lib/cash-forecast.ts) decides
 * `result.eligibility`; this module only READS it, so a client view can use it without bundling the engine.
 *
 * An actionable amount ("safe to move to savings / investing") is shown only when every input it rests on was read,
 * complete and fresh. Otherwise the forecast is still drawn, as an estimate, and the amount is replaced by its
 * reasons, inside the same tile (so Personalize can never hide the reason and keep the number).
 *
 * A stored result (pds.finance_result_cache) can be served after it was computed: given a clock, the readers treat
 * a result past `eligibility.validUntil` (a counted balance has turned 48 hours old since) as not eligible.
 *
 * PURE: no I/O, no clock of its own. Type imports only from the engine.
 */
import type { EligibilityCode, EligibilityReason, ForecastEligibility, ForecastResult, LeftOutAccount } from "./cash-forecast";

/** A result whose eligibility is missing or malformed (stored by older code): never eligible. */
export const UNVERIFIED: ForecastEligibility = {
  eligible: false,
  reasons: [{ code: "unverified", text: "This forecast was computed before its inputs were checked. Reload the page." }],
};
/** The reason added when a stored result is read after its check stopped holding (no account: a reload re-checks). */
export const EXPIRED_REASON: EligibilityReason = { code: "stale-balance", text: "A cash balance has gone stale since this forecast was computed." };
// A Record, not a Set, so tsc fails here when the engine adds a code this list does not know.
const CODES: Record<EligibilityCode, true> = {
  "no-pool": true,
  "no-balance": true,
  "missing-balance": true,
  "invalid-balance": true,
  "stale-balance": true,
  "freshness-unknown": true,
  "short-history": true,
  "history-truncated": true,
  "plan-unavailable": true,
  "plan-invalid": true,
  "categories-unavailable": true,
  "invalid-input": true,
  unverified: true,
};
const isCode = (c: unknown): c is EligibilityCode => typeof c === "string" && Object.prototype.hasOwnProperty.call(CODES, c);
const unverified = (): ForecastEligibility => ({ eligible: false, reasons: UNVERIFIED.reasons.map((r) => ({ ...r })) });
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function parseReason(x: unknown): EligibilityReason | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { code?: unknown; text?: unknown; account?: unknown };
  if (!isCode(r.code) || typeof r.text !== "string") return null;
  if (r.account !== undefined && typeof r.account !== "string") return null;
  return typeof r.account === "string" ? { code: r.code, text: r.text, account: r.account } : { code: r.code, text: r.text };
}
function parseLeftOut(x: unknown): LeftOutAccount | null {
  if (!x || typeof x !== "object") return null;
  const l = x as { account?: unknown; label?: unknown; asOf?: unknown; why?: unknown };
  if (typeof l.account !== "string" || typeof l.label !== "string" || (l.why !== "small" && l.why !== "chosen")) return null;
  if (l.asOf !== null && typeof l.asOf !== "string") return null;
  return { account: l.account, label: l.label, asOf: l.asOf, why: l.why };
}

/**
 * The eligibility of a result, fresh or stored. Anything not well formed (a body stored before the check existed,
 * an unknown reason code) is never eligible, so an old safe-to-move amount is never shown as actionable. Given
 * `now`, a result read after its `validUntil` is not eligible either (EXPIRED_REASON).
 */
export function eligibilityOf(r: { eligibility?: unknown } | null | undefined, now?: Date | number): ForecastEligibility {
  const e = r?.eligibility as { eligible?: unknown; reasons?: unknown; validUntil?: unknown; leftOut?: unknown; cashAsOf?: unknown } | undefined;
  if (!e || typeof e.eligible !== "boolean" || !Array.isArray(e.reasons)) return unverified();
  const reasons = e.reasons.map(parseReason);
  if (reasons.some((x) => x === null)) return unverified();
  if (e.validUntil !== undefined && !isTime(e.validUntil)) return unverified();
  if (e.cashAsOf !== undefined && typeof e.cashAsOf !== "string") return unverified();
  if (e.leftOut !== undefined && !Array.isArray(e.leftOut)) return unverified();
  const leftOut = Array.isArray(e.leftOut) ? e.leftOut.map(parseLeftOut) : [];
  if (leftOut.some((x) => x === null)) return unverified();
  const out: ForecastEligibility = { eligible: e.eligible && reasons.length === 0, reasons: reasons as EligibilityReason[] };
  if (typeof e.validUntil === "string") out.validUntil = e.validUntil;
  if (Array.isArray(e.leftOut)) out.leftOut = leftOut as LeftOutAccount[];
  if (typeof e.cashAsOf === "string") out.cashAsOf = e.cashAsOf;
  const nowMs = now === undefined ? null : typeof now === "number" ? now : now.getTime();
  if (nowMs !== null && Number.isFinite(nowMs) && out.validUntil && Date.parse(out.validUntil) <= nowMs) {
    out.eligible = false;
    if (!out.reasons.some((x) => x.text === EXPIRED_REASON.text)) out.reasons.unshift({ ...EXPIRED_REASON });
  }
  return out;
}

/** The actionable safe-to-move amount, or null when the inputs do not support one (now: see eligibilityOf). */
export function safeToMoveOf(r: { eligibility?: unknown; headlines: { safeToMoveCents: number | null } }, now?: Date | number): number | null {
  const cents = r.headlines?.safeToMoveCents;
  return eligibilityOf(r, now).eligible && typeof cents === "number" && Number.isFinite(cents) ? cents : null;
}

/**
 * A stored result as of `now`: when its check no longer holds, its eligibility says so and the amount is withheld
 * (headlines.safeToMoveCents null), so every view that reads it agrees. Returns the same object when nothing changes.
 */
export function asOfNow<T extends { eligibility?: unknown; headlines: { safeToMoveCents: number | null } }>(r: T, now: Date | number): T {
  const before = eligibilityOf(r);
  const after = eligibilityOf(r, now);
  if (after.eligible === before.eligible && after.reasons.length === before.reasons.length) return r;
  return { ...r, eligibility: after, headlines: { ...r.headlines, safeToMoveCents: null } };
}

/**
 * The earliest `validUntil` among `results` that is still ahead of `nowMs` (ms), or null when none is: when a view
 * left open must look again (a forecast page or a scroll section open past the check's expiry flips to withheld).
 */
export function nextExpiry(results: readonly ({ eligibility?: unknown } | null | undefined)[], nowMs: number): number | null {
  let next: number | null = null;
  for (const r of results) {
    const until = eligibilityOf(r).validUntil;
    const t = until ? Date.parse(until) : NaN;
    if (Number.isFinite(t) && t > nowMs && (next === null || t < next)) next = t;
  }
  return next;
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

/** A reason shown in the tile; `account` = a pool account Riley can leave out of the amount to clear it. */
export interface TileReason {
  text: string;
  account?: string;
}
/** A pool account the amount does not count, as the tile names it; `chosen` = Riley left it out (can count it again). */
export interface TileLeftOut {
  account: string;
  text: string;
  chosen: boolean;
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
      /** The oldest cash balance the amount counts, as a label ("Nov 15, 3:00 PM ET"). */
      asOf: string | null;
      /** Pool accounts the amount does not count, each named. */
      leftOut: TileLeftOut[];
    }
  | {
      kind: "unavailable";
      /** Why the amount is withheld: the first three, and the rest (shown folded, never dropped). */
      reasons: TileReason[];
      more: TileReason[];
      asOf: string | null;
      leftOut: TileLeftOut[];
    };

function leftOutText(l: LeftOutAccount): string {
  const when = cashAsOfLabel(l.asOf);
  if (l.why === "chosen") return `${l.label} is not counted: you left it out${when ? ` (last balance ${when})` : ""}.`;
  return `${l.label} is not counted: a small balance last updated ${when ?? "a while ago"}.`;
}

/**
 * The time of the oldest balance the amount COUNTS, as a label: left-out accounts are named separately with their own
 * date (an old small or chosen one never dates the tile); a backtest opening has no checked balance and keeps its own.
 */
function countedAsOf(e: ForecastEligibility, result: Pick<ForecastResult, "opening">): string | null {
  return cashAsOfLabel(e.cashAsOf ?? (e.leftOut?.length ? null : (result.opening?.asOf ?? null)));
}

export function safeToMoveTile(result: Pick<ForecastResult, "headlines" | "opening"> & { eligibility?: unknown }, bufferCents: number, now?: Date | number): SafeToMoveTile {
  const e = eligibilityOf(result, now);
  const leftOut: TileLeftOut[] = (e.leftOut ?? []).map((l) => ({ account: l.account, text: leftOutText(l), chosen: l.why === "chosen" }));
  const cents = safeToMoveOf(result, now);
  if (cents === null) {
    // Eligible but no amount (should not happen): still never shown as an amount.
    const reasons: TileReason[] = e.reasons.length
      ? e.reasons.map((r) => (r.account ? { text: r.text, account: r.account } : { text: r.text }))
      : [{ text: "The forecast inputs could not be checked." }];
    return { kind: "unavailable", reasons: reasons.slice(0, 3), more: reasons.slice(3), asOf: countedAsOf(e, result), leftOut };
  }
  const buffer = Number.isFinite(bufferCents) ? Math.max(0, bufferCents) : 0;
  const asOf = countedAsOf(e, result);
  return { kind: "amount", cents, perWeekCents: cents > 0 ? Math.floor(cents / 13) : null, bufferCents: buffer, bufferSet: buffer > 0, asOf, leftOut };
}
