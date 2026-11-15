import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { serviceClient } from "@/lib/finance-ledger-server";
import { etDate } from "@/lib/format";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PUT /api/finance/subscriptions  body {subId: "<16 hex>", cancelling: boolean}
// Marks (or unmarks) a detected subscription as cancelled by Riley on the merchant's site, so the Budgets page
// can check that the charges stop. Onyx never cancels anything. Owner session only, same-origin JSON, 256 bytes.
export async function PUT(req: NextRequest) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin, 256);
  if (refused) return answer({ error: refused.error }, refused.status);
  const text = await req.text().catch(() => null);
  if (text === null || text.length > 256) return answer({ error: "bad body" }, 400);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  if (!b || typeof b !== "object" || Object.keys(b).sort().join(",") !== "cancelling,subId") return answer({ error: "send {subId, cancelling}" }, 400);
  if (typeof b.subId !== "string" || !/^[0-9a-f]{16}$/.test(b.subId) || typeof b.cancelling !== "boolean") return answer({ error: "bad subId or cancelling" }, 400);
  let db;
  try {
    db = serviceClient();
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
  const res = b.cancelling
    ? await db.from("finance_cancel_marks").upsert({ sub_id: b.subId, marked_on: etDate(new Date().toISOString()) })
    : await db.from("finance_cancel_marks").delete().eq("sub_id", b.subId);
  if (res.error) {
    console.error(`cancel mark save failed: ${res.error.code ?? "unknown"}`);
    return answer({ error: "could not save" }, 500);
  }
  return answer({ ok: true });
}
