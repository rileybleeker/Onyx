import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/finance-ledger-server";
import { checkMarkRequest } from "@/lib/online-orders";
import { MAX_FLAG_BODY_BYTES, parseFlagBody } from "@/lib/procurement-flags";
import { saveFlagMark } from "@/lib/procurement-flags-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// PATCH /api/procurement/flags   body {sub: "<16 hex>", flag: "<kind>:<16 hex>", dismissed: boolean}
// Riley dismisses (or restores) one waste flag on /procurement. Owner session only (middleware;
// this path is NOT in the CI carve-out), same-origin JSON, at most 256 bytes. It writes one row of
// pds.procurement_flag_dismissals (two opaque hashes and a boolean) and nothing else: no ledger
// row, no subscription and no merchant is touched, and nothing is cancelled anywhere.
export async function PATCH(req: NextRequest) {
  const refused = checkMarkRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);

  let text: string;
  try {
    text = await req.text();
  } catch {
    return answer({ error: "could not read body" }, 400);
  }
  if (text.length > MAX_FLAG_BODY_BYTES) return answer({ error: "body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  const parsed = parseFlagBody(body);
  if (!parsed.ok) return answer({ error: parsed.error }, 400);

  let db;
  try {
    db = serviceClient();
  } catch {
    return answer({ error: "saving is not configured" }, 503);
  }
  const saved = await saveFlagMark(db, parsed.mark, new Date().toISOString());
  if (!saved.ok) return answer({ error: "could not save", setupPending: saved.setupPending }, saved.status);
  return answer({ ok: true, sub: parsed.mark.sub, flag: parsed.mark.flag, dismissed: parsed.mark.dismissed });
}
