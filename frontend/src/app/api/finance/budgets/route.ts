import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { isCategoryName } from "@/lib/finance-categories";
import { TOTAL_KEY } from "@/lib/finance-budgets";
import { saveBudget } from "@/lib/finance-budgets-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PUT /api/finance/budgets  body {category: "<name>" | "__total__", monthlyCents: number | null}
// Sets (or, with null, removes) one monthly budget. Owner session only (middleware; not in the CI carve-out),
// same-origin JSON, at most 512 bytes. Writes one row of pds.finance_budgets.
export async function PUT(req: NextRequest) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin, 512);
  if (refused) return answer({ error: refused.error }, refused.status);
  const text = await req.text().catch(() => null);
  if (text === null || text.length > 512) return answer({ error: "bad body" }, 400);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  if (!b || typeof b !== "object" || Object.keys(b).some((k) => k !== "category" && k !== "monthlyCents")) return answer({ error: "unknown field" }, 400);
  const category = typeof b.category === "string" ? b.category.trim() : "";
  if (category !== TOTAL_KEY && !isCategoryName(category)) return answer({ error: "bad category" }, 400);
  const cents = b.monthlyCents;
  if (cents !== null && !(typeof cents === "number" && Number.isInteger(cents) && cents > 0 && cents <= 100_000_000_000)) return answer({ error: "monthlyCents must be whole cents above 0, or null" }, 400);
  try {
    return (await saveBudget(category, cents as number | null)) ? answer({ ok: true }) : answer({ error: "could not save" }, 500);
  } catch {
    return answer({ error: "Saving is not available right now. Nothing was changed." }, 503);
  }
}
