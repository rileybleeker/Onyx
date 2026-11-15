import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest, isUuid } from "@/lib/cash-forecast-store";
import { serviceClient } from "@/lib/finance-ledger-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// DELETE /api/finance/goals/<uuid>: soft-removes a goal. Owner session only, same-origin.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);
  const { id } = await ctx.params;
  if (!isUuid(id)) return answer({ error: "unknown goal" }, 404);
  let db;
  try {
    db = serviceClient();
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
  const { data, error } = await db.from("finance_goals").update({ removed_at: new Date().toISOString() }).eq("id", id).is("removed_at", null).select("id");
  if (error) {
    console.error(`goal remove failed: ${error.code ?? "unknown"}`);
    return answer({ error: "could not remove" }, 500);
  }
  return data?.length ? answer({ ok: true }) : answer({ error: "unknown goal" }, 404);
}
