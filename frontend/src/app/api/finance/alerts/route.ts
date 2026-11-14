import { NextResponse } from "next/server";
import { loadForecast } from "@/lib/cash-forecast-server";
import { loadBudgets } from "@/lib/finance-budgets-server";
import { moneyAlerts } from "@/lib/finance-alerts";
import { etDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/finance/alerts -> {status: "ready", alerts: MoneyAlert[]} | {status: "unavailable"}
// Owner session only (middleware; not in the CI carve-out). Read-only: computes the forecast and budgets and
// returns only the alerts Riley can act on. Logs carry codes only.
export async function GET() {
  const now = new Date();
  const [f, b] = await Promise.all([loadForecast(now), loadBudgets(now)]);
  if (f.kind === "error" && b.kind === "error") return NextResponse.json({ status: "unavailable" }, { status: 500, headers: NO_STORE });
  const buffer = f.kind === "ok" ? Number((f.drivers.find((d) => d.key === "settings")?.value as { bufferCents?: number } | undefined)?.bufferCents ?? 0) : 0;
  const alerts = moneyAlerts(f.kind === "ok" ? f.result : null, b.kind === "ok" ? b.result : null, buffer, etDate(now.toISOString()));
  return NextResponse.json({ status: "ready", alerts }, { headers: NO_STORE });
}
