import { NextResponse } from "next/server";
import { cachedMoneyAlerts } from "@/lib/finance-result-cache-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/finance/alerts[?fresh=1] -> {status: "ready", alerts: MoneyAlert[], cash?, asOf, updating?, partial?} | {status: "unavailable"}
// Owner session only (middleware; not in the CI carve-out). Read-only: the alerts Riley can act on, from the
// forecast and budgets. The result is stored (pds.finance_result_cache) and answered from there; once the ledger
// or the plan changed (or a new ET day began) the older stored answer comes back at once marked `updating: true`
// and is recomputed after the answer (lib/finance-result-cache-server.ts). ?fresh=1 (Today's follow-up read)
// computes before answering unless the stored answer is current. `asOf` = when the alerts were computed;
// `partial` = the forecast or the budgets could not be read; `cash` = {eligible, reasons} of the cash forecast's
// inputs (the gate that withholds safe to move; not eligible = "no low-cash alert" is not an all-clear). Logs carry codes only.
export async function GET(request: Request) {
  // request?.: the offline tests call GET() with no request (a plain read).
  const fresh = !!request?.url && new URL(request.url).searchParams.get("fresh") === "1";
  const body = await cachedMoneyAlerts(new Date(), fresh ? "fresh-only" : "stale-ok");
  if (!body) return NextResponse.json({ status: "unavailable" }, { status: 500, headers: NO_STORE });
  return NextResponse.json(body, { headers: NO_STORE });
}
