import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { isCategoryName } from "@/lib/finance-categories";
import { saveCategoryFix } from "@/lib/finance-budgets-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PUT /api/finance/categories  body {merchantKey, category | null}  (always file this merchant under a category)
//                           or {txnKey, category | null}       (just this transaction)
// Category fixes are applied when the ledger is read; no stored transaction changes. Owner session only,
// same-origin JSON, at most 1 KB.
export async function PUT(req: NextRequest) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin, 1024);
  if (refused) return answer({ error: refused.error }, refused.status);
  const text = await req.text().catch(() => null);
  if (text === null || text.length > 1024) return answer({ error: "bad body" }, 400);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  if (!b || typeof b !== "object") return answer({ error: "body must be an object" }, 400);
  const keys = Object.keys(b).sort().join(",");
  const kind = keys === "category,merchantKey" ? "rule" : keys === "category,txnKey" ? "txn" : null;
  if (!kind) return answer({ error: "send {merchantKey, category} or {txnKey, category}" }, 400);
  const key = String(kind === "rule" ? b.merchantKey : b.txnKey);
  if (!key || key.length > (kind === "rule" ? 200 : 64) || /[\u0000-\u001f]/.test(key)) return answer({ error: "bad key" }, 400);
  const category = b.category === null ? null : typeof b.category === "string" ? b.category.trim() : "";
  if (category !== null && !isCategoryName(category)) return answer({ error: "bad category" }, 400);
  try {
    return (await saveCategoryFix(kind, key, category)) ? answer({ ok: true }) : answer({ error: "could not save" }, 500);
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
}
