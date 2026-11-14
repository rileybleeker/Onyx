import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { serviceClient } from "@/lib/finance-ledger-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// POST /api/finance/goals  body {name, targetCents, targetDate, accountKey?}  (accountKey omitted = checking + savings)
// Adds a savings goal (tracking only; nothing moves money). Owner session only, same-origin JSON, at most 1 KB.
export async function POST(req: NextRequest) {
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
  if (!b || typeof b !== "object" || Object.keys(b).some((k) => !["name", "targetCents", "targetDate", "accountKey"].includes(k))) return answer({ error: "unknown field" }, 400);
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) return answer({ error: "name must be 1 to 80 characters" }, 400);
  if (!(typeof b.targetCents === "number" && Number.isInteger(b.targetCents) && b.targetCents > 0 && b.targetCents <= 100_000_000_000)) return answer({ error: "targetCents must be whole cents above 0" }, 400);
  if (typeof b.targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.targetDate)) return answer({ error: "targetDate must be YYYY-MM-DD" }, 400);
  const accountKey = b.accountKey === undefined || b.accountKey === null || b.accountKey === "" ? null : String(b.accountKey);
  let db;
  try {
    db = serviceClient();
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
  if (accountKey) {
    const { data } = await db.from("finance_accounts").select("account_key").eq("account_key", accountKey).limit(1);
    if (!data?.length) return answer({ error: "unknown account" }, 400);
  }
  const { error } = await db.from("finance_goals").insert({ name, target_cents: b.targetCents, target_date: b.targetDate, account_key: accountKey });
  if (error) {
    console.error(`goal insert failed: ${error.code ?? "unknown"}`);
    return answer({ error: "could not save" }, 500);
  }
  return answer({ ok: true });
}
