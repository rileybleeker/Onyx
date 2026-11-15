import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/finance-ledger-server";
import { loadDetectedSubscriptions } from "@/lib/procurement-recurring-server";
import { RenewalClaimError, runRenewalClaim } from "@/lib/procurement-renewal-claim";
import { parseClaimNow } from "@/lib/supplement-reminders";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * POST /api/procurement/renewals/claim
 * Body: { now?: ISO string }   (defaults to the server clock)
 *
 * Called by the sms-reminders Worker on its schedule (Riley's decision of 2026-11-13: a push card
 * in /agents a few days before a subscription renews, with the merchant name and no amount).
 * Atomically claims every detected subscription whose next charge is estimated within 3 days
 * (high or medium confidence) and has not been prompted for this billing cycle, and returns them
 * for the Worker to post as cards:
 *   { ok, today, within_days, claimed: [{ id, merchant, renewal_date, days }] }
 * Nothing else from the ledger is in the response: no amount, account, category or transaction.
 *
 * Auth: the x-onyx-ci-token header (exact-path carve-out in middleware.ts isCiRoute; the only
 * /api/procurement path there). The Worker holds no Supabase credentials. Errors answer with a
 * step and a database error code, never with row content.
 */
export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return answer({ ok: false, error: "Body must be JSON" }, 400);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return answer({ ok: false, error: "Body must be a JSON object" }, 400);

  const parsed = parseClaimNow((raw as { now?: unknown }).now, new Date());
  if (!parsed.ok) return answer({ ok: false, error: parsed.error }, 400);
  const now = parsed.now ?? new Date();

  let db;
  try {
    db = serviceClient();
  } catch {
    return answer({ ok: false, error: "not configured" }, 503);
  }
  try {
    return answer(await runRenewalClaim(db, () => loadDetectedSubscriptions(now)));
  } catch (e) {
    const detail = e instanceof RenewalClaimError ? `${e.step} failed (${e.code})` : "unexpected error";
    console.error("procurement renewal claim failed:", detail);
    return answer({ ok: false, error: detail }, 500);
  }
}
