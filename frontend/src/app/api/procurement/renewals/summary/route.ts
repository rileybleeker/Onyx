import { NextResponse } from "next/server";
import { loadDetectedSubscriptions } from "@/lib/procurement-recurring-server";
import { renewalSummary } from "@/lib/procurement-renewals";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/procurement/renewals/summary: what the Today "Renewals" panel shows (owner session only,
// via middleware; this path is NOT in the CI carve-out). Read-only and never cached:
// {status: "ready", count, soon: [{merchant, days, date}], withinDays} for subscriptions detected in
// the Rocket Money ledger whose next charge is estimated within the next 3 days (high / medium
// confidence only, no amounts); {status: "empty"} when the ledger has no rows yet; HTTP 500 when
// the ledger could not be read (never an empty list). Nothing is written or marked by this call.
export async function GET() {
  const load = await loadDetectedSubscriptions();
  if (load.state === "error") return NextResponse.json({ error: "renewals unavailable" }, { status: 500, headers: NO_STORE });
  return NextResponse.json(renewalSummary(load), { headers: NO_STORE });
}
