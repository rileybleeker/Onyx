import { NextRequest, NextResponse } from "next/server";
import { MAX_FORECAST_BODY_BYTES, checkJsonRequest, parseDriverBody } from "@/lib/cash-forecast-store";
import { knownAccountKeys, saveDriver } from "@/lib/cash-forecast-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PUT /api/finance/forecast/drivers  body {key: 'settings' | 'card:<account_key>' | 'growth:<account_key>', value: {...} | null}
// Saves one forecast driver (buffer line, a card's APR / promo end, an account's expected return). Owner
// session only, same-origin JSON, at most 2 KB. Writes one row of pds.finance_plan_drivers.
export async function PUT(req: NextRequest) {
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
  let known: Set<string>;
  try {
    known = await knownAccountKeys();
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
  const parsed = parseDriverBody(body, known);
  if (!parsed.ok) return answer({ error: parsed.error }, 400);
  const saved = await saveDriver(parsed.key, parsed.value);
  return saved.ok ? answer({ ok: true }) : answer({ error: "could not save" }, 500);
}
