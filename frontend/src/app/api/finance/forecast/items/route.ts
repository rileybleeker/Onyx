import { NextRequest, NextResponse } from "next/server";
import { MAX_FORECAST_BODY_BYTES, checkJsonRequest, parseItemBody } from "@/lib/cash-forecast-store";
import { insertPlanItem } from "@/lib/cash-forecast-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// POST /api/finance/forecast/items  body {label, date, amountCents (money in +, out -), certainty?, repeatUnit?, repeatEvery?, repeatCount?, note?}
// Adds one planned item to the cash forecast. Owner session only (middleware; NOT in the CI carve-out),
// same-origin JSON, at most 2 KB. Writes one row of pds.finance_plan_items; nothing moves money.
export async function POST(req: NextRequest) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);
  const text = await req.text().catch(() => null);
  if (text === null) return answer({ error: "could not read body" }, 400);
  if (text.length > MAX_FORECAST_BODY_BYTES) return answer({ error: "body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  const parsed = parseItemBody(body);
  if (!parsed.ok) return answer({ error: parsed.error }, 400);
  try {
    const saved = await insertPlanItem(parsed.item);
    return saved.ok ? answer({ ok: true, id: saved.id }) : answer({ error: "could not save" }, saved.status);
  } catch {
    return answer({ error: "Saving is not available right now. Nothing was changed." }, 503);
  }
}
