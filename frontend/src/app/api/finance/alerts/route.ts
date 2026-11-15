import { NextResponse } from "next/server";
import { cachedMoneyAlerts } from "@/lib/finance-result-cache-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/finance/alerts -> {status: "ready", alerts: MoneyAlert[]} | {status: "unavailable"}
// Owner session only (middleware; not in the CI carve-out). Read-only: the alerts Riley can act on, from the
// forecast and budgets. The result is stored (pds.finance_result_cache) and answered from there; it is
// recomputed after the answer once the ledger or the plan changed (lib/finance-result-cache-server.ts). Logs
// carry codes only.
export async function GET() {
  const body = await cachedMoneyAlerts(new Date());
  if (!body) return NextResponse.json({ status: "unavailable" }, { status: 500, headers: NO_STORE });
  return NextResponse.json(body, { headers: NO_STORE });
}
