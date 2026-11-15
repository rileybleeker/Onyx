import type { SupabaseClient } from "@supabase/supabase-js";
import { stableId, type DetectedLoad } from "./procurement-recurring";
import { RENEWAL_SOON_DAYS, renewalsWithin } from "./procurement-renewals";

/**
 * Renewal cards for /agents (Onyx side), decided by Riley on 2026-11-13.
 *
 * The sms-reminders Worker polls POST /api/procurement/renewals/claim and posts one push card per
 * claimed renewal ("<merchant> renews in 2 days"). This is the ONE place where something derived
 * from the finance ledger leaves Onyx without a login, so what leaves is fixed here and nowhere
 * else: per renewal an opaque id, the merchant display name, the estimated date and the days until
 * it. NEVER an amount, an account, a category, a transaction id or a charge date (CLAIM_FIELDS;
 * tests/procurement-renewal-claim.test.cjs fails if anything else appears).
 *
 * A renewal is claimed when a subscription detected in the ledger is active, its next charge is
 * estimated with high or medium confidence, and that date is today through 3 days ahead - the same
 * rule as the Today panel (lib/procurement-renewals.ts).
 *
 * Prompted once: the claim is an atomic INSERT ... ON CONFLICT DO NOTHING RETURNING into
 * pds.procurement_renewal_prompt, keyed (subscription id, date of its last charge) = one billing
 * cycle. Two polls at once, or an estimate that moves by a day, cannot prompt the same cycle
 * twice; the next cycle starts when the next charge posts. Everything that can fail (the ledger
 * read, the lookup of cycles already prompted, building the card text) happens BEFORE that insert, so a claimed row always reaches the
 * caller.
 *
 * Nothing here logs or stores a merchant name: the ledger table holds hashes and dates, the
 * heartbeat and every error carry a database error code at most.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const HEARTBEAT_SOURCE = "procurement_renewals";
export const HEARTBEAT_TYPE = "prompt";
/** Quiet "nothing due" heartbeats are written at most this often. */
export const HEARTBEAT_MIN_GAP_MS = 50 * 60 * 1000;
/** At most this many cards from one poll (a first run could otherwise post a pile). */
export const MAX_CLAIMS_PER_CALL = 10;
export const MAX_MERCHANT_CHARS = 80;
/** Exactly what one claimed renewal carries out of Onyx. */
export const CLAIM_FIELDS = ["id", "merchant", "renewal_date", "days"] as const;

export interface ClaimedRenewal {
  /** Opaque and stable for one billing cycle of one subscription (16 hex). */
  id: string;
  merchant: string;
  /** Estimated next charge date, YYYY-MM-DD. */
  renewal_date: string;
  /** Days from today to that date (0 = today). */
  days: number;
}

export interface RenewalClaimResult {
  ok: true;
  today: string;
  within_days: number;
  claimed: ClaimedRenewal[];
}

/** An error that carries a code only, so nothing from a row can ride along in a message. */
export class RenewalClaimError extends Error {
  constructor(readonly step: string, readonly code: string) {
    super(`${step} (${code})`);
  }
}

/** One line of display text: control characters out, spaces collapsed, capped. */
export function displayName(raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_MERCHANT_CHARS ? `${text.slice(0, MAX_MERCHANT_CHARS - 1).trimEnd()}…` : text;
}

/** The id of one billing cycle: a hash of the subscription id and the date of its last charge. */
export const cycleId = (subId: string, lastCharge: string): string => stableId(`renewal|${subId}|${lastCharge}`);

/** Claim every renewal that is due and not prompted yet for its billing cycle. */
export async function claimDueRenewals(db: Db, load: DetectedLoad): Promise<RenewalClaimResult> {
  if (load.state === "error") throw new RenewalClaimError("ledger read", load.code);
  if (load.state === "empty") return { ok: true, today: "", within_days: RENEWAL_SOON_DAYS, claimed: [] };

  const lastCharge = new Map(load.subs.map((s) => [s.id, s.lastCharge]));
  // Everything a card needs, built before anything is claimed.
  const due = renewalsWithin(load.subs, load.today, RENEWAL_SOON_DAYS)
    .map((r) => ({ subId: r.id, last: lastCharge.get(r.id) ?? "", card: { merchant: displayName(r.merchant), renewal_date: r.date, days: r.days } }))
    .filter((c) => c.last !== "" && c.card.merchant !== "");
  const result: RenewalClaimResult = { ok: true, today: load.today, within_days: RENEWAL_SOON_DAYS, claimed: [] };
  if (due.length === 0) return result;

  // Cycles already prompted are set aside first, so the per-call cap never starves a later one.
  const { data: seen, error: seenError } = await db
    .from("procurement_renewal_prompt")
    .select("sub_id,last_charge")
    .in("sub_id", due.map((c) => c.subId));
  if (seenError) throw new RenewalClaimError("prompt lookup", seenError.code ?? "unknown");
  const prompted = new Set((seen ?? []).map((r) => `${r.sub_id}|${String(r.last_charge).slice(0, 10)}`));
  const candidates = due.filter((c) => !prompted.has(`${c.subId}|${c.last}`)).slice(0, MAX_CLAIMS_PER_CALL);
  if (candidates.length === 0) return result;

  // Atomic claim: INSERT ... ON CONFLICT DO NOTHING RETURNING. A concurrent call, or a cycle
  // already prompted, simply gets no row back.
  const { data: won, error } = await db
    .from("procurement_renewal_prompt")
    .upsert(
      candidates.map((c) => ({ sub_id: c.subId, last_charge: c.last, renewal_date: c.card.renewal_date })),
      { onConflict: "sub_id,last_charge", ignoreDuplicates: true },
    )
    .select("sub_id,last_charge");
  if (error) throw new RenewalClaimError("renewal claim", error.code ?? "unknown");

  const wonKeys = new Set((won ?? []).map((r) => `${r.sub_id}|${String(r.last_charge).slice(0, 10)}`));
  result.claimed = candidates
    .filter((c) => wonKeys.has(`${c.subId}|${c.last}`))
    .map((c) => ({ id: cycleId(c.subId, c.last), merchant: c.card.merchant, renewal_date: c.card.renewal_date, days: c.card.days }));
  return result;
}

/**
 * Write the procurement_renewals|prompt heartbeat. Never throws: a sync_log hiccup must not turn a
 * successful claim into an error response (the claimed renewals would then never reach the
 * Worker). Quiet polls (nothing claimed) repeat the previous heartbeat at most once per 50
 * minutes; a claim, a status change and the first heartbeat always land. The message is an error
 * code or null - never a merchant.
 */
async function writeHeartbeat(db: Db, startedAt: Date, endedAt: Date, status: "success" | "failed", records: number, code: string | null): Promise<void> {
  try {
    if (records === 0) {
      const { data: last } = await db
        .from("sync_log")
        .select("status,sync_start")
        .eq("source", HEARTBEAT_SOURCE)
        .eq("data_type", HEARTBEAT_TYPE)
        .order("sync_start", { ascending: false })
        .limit(1);
      const prev = last?.[0];
      if (prev && prev.status === status && endedAt.getTime() - new Date(prev.sync_start as string).getTime() < HEARTBEAT_MIN_GAP_MS) return;
    }
    const { error } = await db.from("sync_log").insert({
      source: HEARTBEAT_SOURCE,
      data_type: HEARTBEAT_TYPE,
      status,
      records_synced: records,
      sync_start: startedAt.toISOString(),
      sync_end: endedAt.toISOString(),
      duration_seconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      error_message: code,
    });
    if (error) console.error("procurement_renewals heartbeat failed:", error.code ?? "unknown");
  } catch {
    console.error("procurement_renewals heartbeat failed: unexpected");
  }
}

/** claimDueRenewals plus the heartbeat; rethrows after recording a failed one. */
export async function runRenewalClaim(
  db: Db,
  loadSubscriptions: () => Promise<DetectedLoad>,
  clock: () => Date = () => new Date(),
): Promise<RenewalClaimResult> {
  const startedAt = clock();
  try {
    const result = await claimDueRenewals(db, await loadSubscriptions());
    await writeHeartbeat(db, startedAt, clock(), "success", result.claimed.length, null);
    return result;
  } catch (e) {
    const code = e instanceof RenewalClaimError ? `${e.step} failed (${e.code})` : "unexpected error";
    await writeHeartbeat(db, startedAt, clock(), "failed", 0, code);
    throw e instanceof RenewalClaimError ? e : new RenewalClaimError("unexpected", "unexpected");
  }
}
