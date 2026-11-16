import { NextResponse } from "next/server";
import { cachedRenewalsAheadWithAge } from "@/lib/finance-result-cache-server";
import { summaryFromAhead } from "@/lib/procurement-renewals";
import { etDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/procurement/renewals/summary[?fresh=1]: what the Today "Renewals" panel shows (owner session only,
// via middleware; this path is NOT in the CI carve-out). Read-only and never cached by the browser or CDN:
// {status: "ready", count, soon: [{merchant, days, date}], withinDays} for subscriptions detected in
// the finance ledger whose next charge is estimated within the next 3 days (high / medium
// confidence only, no amounts); {status: "empty"} when the ledger has no rows yet; HTTP 500 when
// the ledger could not be read (never an empty list). Nothing in the ledger or the renewal prompts is
// written or marked by this call.
// The detection is stored server-side (pds.finance_result_cache) until the ledger changes; the days and
// labels are worked out for today on every call (lib/procurement-renewals.ts summaryFromAhead). Like the money
// alerts, once the ledger changed (or a new ET day or build began) the older stored detection comes back at once
// with `updating: true` and `asOf` (when it was computed) and is recomputed after the answer; ?fresh=1 (Today's
// follow-up read) computes before answering unless the stored detection is current. A current answer carries
// neither field.
export async function GET(request: Request) {
  // request?.: the offline tests call GET() with no request (a plain read).
  const fresh = !!request?.url && new URL(request.url).searchParams.get("fresh") === "1";
  const now = new Date();
  const served = await cachedRenewalsAheadWithAge(now, fresh ? "fresh-only" : "stale-ok");
  if (!served) return NextResponse.json({ error: "renewals unavailable" }, { status: 500, headers: NO_STORE });
  const summary = summaryFromAhead(served.value, etDate(now.toISOString()));
  return NextResponse.json(served.stale ? { ...summary, asOf: served.computedAt, updating: true } : summary, { headers: NO_STORE });
}
