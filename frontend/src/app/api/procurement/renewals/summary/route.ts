import { NextResponse } from "next/server";
import { cachedRenewalsAhead } from "@/lib/finance-result-cache-server";
import { summaryFromAhead } from "@/lib/procurement-renewals";
import { etDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/procurement/renewals/summary: what the Today "Renewals" panel shows (owner session only,
// via middleware; this path is NOT in the CI carve-out). Read-only and never cached by the browser or CDN:
// {status: "ready", count, soon: [{merchant, days, date}], withinDays} for subscriptions detected in
// the finance ledger whose next charge is estimated within the next 3 days (high / medium
// confidence only, no amounts); {status: "empty"} when the ledger has no rows yet; HTTP 500 when
// the ledger could not be read (never an empty list). Nothing in the ledger or the renewal prompts is
// written or marked by this call.
// The detection is stored server-side (pds.finance_result_cache) until the ledger changes; the days and
// labels are worked out for today on every call (lib/procurement-renewals.ts summaryFromAhead).
export async function GET() {
  const now = new Date();
  const ahead = await cachedRenewalsAhead(now);
  if (!ahead) return NextResponse.json({ error: "renewals unavailable" }, { status: 500, headers: NO_STORE });
  return NextResponse.json(summaryFromAhead(ahead, etDate(now.toISOString())), { headers: NO_STORE });
}
