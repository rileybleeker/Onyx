/**
 * GET /api/chat/operations?request_id=<uuid> (SEC-04): what one Onyx Chat request saved, read back by its id alone.
 *
 * The /chat page remembers the id of a send whose answer never arrived (lib/chat-contract.ts PENDING_SEND_KEY). After
 * a reload the conversation is gone, so the same message sent again would be a NEW request; instead the page asks
 * here and shows the receipts the first try stored (lib/chat-operations.ts requestOutcome), so nothing is logged
 * twice by mistake. Read-only: nothing is written, marked or run.
 *
 * POST /api/chat/operations {request_id, action: "abandon"}: Riley dismissed "this message never reached Onyx". An id
 * missing from the ledger is not proof that it will stay missing (the request may still be on its way), so before the
 * page forgets the id it is recorded as abandoned (lib/chat-operations.ts abandonRequest): the request itself is then
 * refused if it arrives late. When it reached the ledger first, nothing is recorded and its account is returned (as
 * GET answers). Writes only that one ledger row, nothing else; same-origin JSON, 256-byte cap.
 *
 * Owner session only (the middleware admits the owner; never a CI route), scoped to the signed-in owner's own
 * requests, no-store. Errors carry a code only.
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { REQUEST_ID_RE, parseRequestId } from "@/lib/chat-contract";
import { buildWriteReceipt } from "@/lib/chat-receipts";
import { abandonRequest, requestOutcome, supabaseLedgerStore } from "@/lib/chat-operations";
import { checkPortionRequest } from "@/lib/delivery-portion";
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

/** {"request_id":"<uuid>","action":"abandon"} is about 70 bytes. */
const MAX_ABANDON_BODY_BYTES = 256;

export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_ABANDON_BODY_BYTES);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!fields || Object.keys(fields).some((k) => k !== "request_id" && k !== "action") || fields.action !== "abandon") {
    return Response.json({ error: 'Send {"request_id", "action": "abandon"} only.' }, { status: 400, headers: NO_STORE });
  }
  const requestId = parseRequestId(fields.request_id);
  if (!requestId) return Response.json({ error: "request_id must be a UUID." }, { status: 400, headers: NO_STORE });
  const ownerId = await sessionOwnerId();
  if (!ownerId) return Response.json({ status: "failed", code: "no_owner", receipts: [] }, { status: 503, headers: NO_STORE });
  const outcome = await abandonRequest(supabaseLedgerStore(supabase), ownerId, requestId, buildWriteReceipt);
  if (outcome.status === "failed" || outcome.status === "unavailable") console.error("Chat ledger", { stage: "abandon", code: outcome.code });
  return Response.json(outcome, { status: outcome.status === "failed" ? 503 : 200, headers: NO_STORE });
}
