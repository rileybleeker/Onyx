/**
 * GET /api/chat/operations?request_id=<uuid> (SEC-04): what one Onyx Chat request saved, read back by its id alone.
 *
 * The /chat page remembers the id of a send whose answer never arrived (lib/chat-contract.ts PENDING_SEND_KEY). After
 * a reload the conversation is gone, so the same message sent again would be a NEW request; instead the page asks
 * here and shows the receipts the first try stored (lib/chat-operations.ts requestOutcome), so nothing is logged
 * twice by mistake. Read-only: nothing is written, marked or run.
 *
 * Owner session only (the middleware admits the owner; never a CI route), scoped to the signed-in owner's own
 * requests, no-store. Errors carry a code only.
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { REQUEST_ID_RE, parseRequestId } from "@/lib/chat-contract";
import { buildWriteReceipt } from "@/lib/chat-receipts";
import { requestOutcome, supabaseLedgerStore } from "@/lib/chat-operations";
import { createSupabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "pds" } });

const NO_STORE = { "Cache-Control": "private, no-store" };

/** The signed-in owner's user id from the session (same check as POST /api/chat). */
async function sessionOwnerId(): Promise<string | null> {
  try {
    const client = await createSupabaseServer();
    const { data } = await client.auth.getClaims();
    const sub = data?.claims?.sub;
    return typeof sub === "string" && REQUEST_ID_RE.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const requestId = parseRequestId(req.nextUrl.searchParams.get("request_id") ?? undefined);
  if (!requestId) return Response.json({ error: "request_id must be a UUID." }, { status: 400, headers: NO_STORE });
  const ownerId = await sessionOwnerId();
  if (!ownerId) return Response.json({ status: "failed", code: "no_owner", receipts: [] }, { status: 503, headers: NO_STORE });
  const outcome = await requestOutcome(supabaseLedgerStore(supabase), ownerId, requestId, buildWriteReceipt);
  if (outcome.status === "failed" || outcome.status === "unavailable") console.error("Chat ledger", { stage: "outcome", code: outcome.code });
  return Response.json(outcome, { status: outcome.status === "failed" ? 503 : 200, headers: NO_STORE });
}
