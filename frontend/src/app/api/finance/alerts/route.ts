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
// Rewards alerts (lib/rewards.ts rewardsAlerts) are appended to `alerts`. `partial` = the forecast or the budgets could not be read; `cash` = {eligible, reasons} of the cash forecast's
// inputs (the gate that withholds safe to move; not eligible = "no low-cash alert" is not an all-clear). Logs carry codes only.
export async function GET(request: Request) {
  // request?.: the offline tests call GET() with no request (a plain read).
  const fresh = !!request?.url && new URL(request.url).searchParams.get("fresh") === "1";
  const body = await cachedMoneyAlerts(new Date(), fresh ? "fresh-only" : "stale-ok");
  if (!body) return NextResponse.json({ status: "unavailable" }, { status: 500, headers: NO_STORE });
  // Rewards (points expiring, an Amex credit with value left): read live and appended, never stored with the money
  // alerts. A lean, time-limited read that fails open to "none" (the /rewards page itself shows failures); the module
  // loads only here, so a stored-answer-only request path stays as light as before (PERF-02).
  const rewards = await import("@/lib/rewards-server").then((m) => m.loadRewardsAlerts(new Date())).catch(() => []);
  return NextResponse.json(rewards.length ? { ...body, alerts: [...body.alerts, ...rewards] } : body, { headers: NO_STORE });
}
