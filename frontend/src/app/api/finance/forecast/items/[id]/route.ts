import { NextRequest, NextResponse } from "next/server";
import { checkJsonRequest, isUuid } from "@/lib/cash-forecast-store";
import { removePlanItem } from "@/lib/cash-forecast-server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// DELETE /api/finance/forecast/items/<uuid>  (send Content-Type: application/json, empty body allowed)
// Soft-removes one planned item (removed_at). Owner session only, same-origin.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const refused = checkJsonRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);
  const { id } = await ctx.params;
  if (!isUuid(id)) return answer({ error: "unknown item" }, 404);
  try {
    const res = await removePlanItem(id);
    return res.ok ? answer({ ok: true }) : answer({ error: res.status === 404 ? "unknown item" : "could not remove" }, res.status);
  } catch {
    return answer({ error: "Saving is not available right now. Nothing was changed." }, 503);
  }
}
