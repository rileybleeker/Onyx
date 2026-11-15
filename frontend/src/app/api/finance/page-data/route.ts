import { NextResponse } from "next/server";
import { loadLedger } from "@/lib/finance-ledger-server";
import { parseLedgerQuery } from "@/lib/finance-ledger";
import { cachedBudgets, cachedForecast } from "@/lib/finance-result-cache-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const PAGES = ["financials", "forecast", "budgets"] as const;
type FinancePage = (typeof PAGES)[number];
const isPage = (v: string | null): v is FinancePage => (PAGES as readonly string[]).includes(v ?? "");
const codeOf = (e: unknown): string => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unexpected");

// GET /api/finance/page-data?page=financials|forecast|budgets -> {now, load}
// What each finance page.tsx passes to its view, for that page's section in the continuous scroll
// (app/financials/**/FeedSection.tsx): the same server functions, for the page's default view (no ledger
// filters, no what-if levers; those open the routed page). `now` = the server time the load was computed for.
// Owner session only (middleware; never in isCiRoute()), same-origin GET, never cached by a browser or a CDN;
// the client keeps it in memory only (isSensitiveKey). A failed read answers 500 with the page's own error
// state, so the client never caches it. Logs carry a code only, never a row, a name or an amount.
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  const page = new URL(request.url).searchParams.get("page");
  if (!isPage(page)) return NextResponse.json({ error: "unknown_page" }, { status: 400, headers: NO_STORE });
  const now = new Date();
  try {
    const load =
      page === "financials" ? await loadLedger(parseLedgerQuery({}), now) : page === "forecast" ? await cachedForecast(now) : await cachedBudgets(now);
    return NextResponse.json({ now: now.toISOString(), load }, { status: load.kind === "error" ? 500 : 200, headers: NO_STORE });
  } catch (e) {
    console.error("[finance page-data] failed", page, codeOf(e));
    const load =
      page === "financials"
        ? { kind: "error", message: "Couldn't load the ledger.", hint: "An unexpected error occurred. Try again in a moment." }
        : { kind: "error", code: "unexpected" };
    return NextResponse.json({ now: now.toISOString(), load }, { status: 500, headers: NO_STORE });
  }
}
