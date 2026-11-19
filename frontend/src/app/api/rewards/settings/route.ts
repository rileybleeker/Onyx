import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { parseSettingsPatch } from "@/lib/rewards";
import { saveSettings } from "@/lib/rewards-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PUT /api/rewards/settings  body {key: "valuations" | "discover_quarter" | "apple_boosted" | "credits", value}
// Saves one of Riley's editable rewards values (cents per point, the Discover quarter's categories, Apple Card's
// 3% merchants, credit amounts). Owner session only (middleware; never in isCiRoute()), same-origin JSON, at most
// 2 KB, unknown fields refused, a valuations / credits save is merged into the stored row. Logs a code only.
export async function PUT(req: NextRequest) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin, 2048);
  if (refused) return answer({ error: refused.error }, refused.status);
  const text = await req.text().catch(() => null);
  if (text === null || text.length > 2048) return answer({ error: "bad body" }, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) return answer({ error: parsed.error }, 400);
  const res = await saveSettings(parsed.patch);
  if (!res.ok) {
    console.error("[rewards settings] save failed", res.code);
    return answer({ error: "Saving is not available right now. Nothing was changed." }, 503);
  }
  return answer({ ok: true });
}
