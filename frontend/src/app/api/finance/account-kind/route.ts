import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest } from "@/lib/cash-forecast-store";
import { saveAccountKind } from "@/lib/finance-budgets-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const ACCOUNT_KEY_RE = /^[0-9a-fA-F]{1,64}$/;

// PUT /api/finance/account-kind   body {account_id, kind: "asset" | "liability" | null}
// Riley labels an unclassified balance as an asset or a liability (kind null = clear the override,
// so the source's own label applies again). Writes one row of pds.finance_account_kind_overrides;
// no ledger row, balance or account is touched. Owner session only (middleware; this path is NOT
// in the CI carve-out), same-origin JSON, at most 1 KB.
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
  if (keys !== "account_id,kind") return answer({ error: "send {account_id, kind}" }, 400);
  const accountId = typeof b.account_id === "string" ? b.account_id.toLowerCase() : "";
  if (!ACCOUNT_KEY_RE.test(accountId)) return answer({ error: "bad account_id" }, 400);
  const kind = b.kind === null ? null : b.kind;
  if (kind !== null && kind !== "asset" && kind !== "liability") return answer({ error: "kind must be asset, liability or null" }, 400);
  try {
    return (await saveAccountKind(accountId, kind)) ? answer({ ok: true }) : answer({ error: "could not save" }, 500);
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
}
