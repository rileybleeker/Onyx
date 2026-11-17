import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isFlagOn, PHONE_MESSAGES_FLAG } from "@/lib/phone-messages";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const NO_STORE = { "Cache-Control": "no-store" };

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
  });
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * GET /api/phone-messages/messages?days=14&limit=100&sender=<text>
 * The texts the phone pushed (see /api/phone-messages/ingest), newest first.
 * Owner session only (not a CI route). Off with the flag. Only what was pushed,
 * never the whole inbox. No page uses it yet; it is the read side.
 */
export async function GET(req: NextRequest) {
  if (!isFlagOn(process.env, PHONE_MESSAGES_FLAG)) {
    return NextResponse.json({ error: "disabled" }, { status: 503, headers: NO_STORE });
  }
  const p = req.nextUrl.searchParams;
  const days = Math.min(90, Math.max(1, Math.trunc(Number(p.get("days") ?? 14)) || 14));
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(p.get("limit") ?? 100)) || 100));
  const sender = (p.get("sender") ?? "").trim().slice(0, 200);
  let q = db()
    .from("phone_messages")
    .select("sender,body,received_at")
    .gte("received_at", new Date(Date.now() - days * DAY_MS).toISOString())
    .order("received_at", { ascending: false })
    .order("message_key", { ascending: true })
    .limit(limit);
  if (sender) q = q.ilike("sender", `%${sender.replace(/[%_\\]/g, "\\$&")}%`);
  const { data, error } = await q;
  if (error) {
    console.error("phone_messages read failed:", error.code ?? "error");
    return NextResponse.json({ error: "Could not read the texts" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json(
    { messages: (data ?? []).map((r) => ({ sender: r.sender, text: r.body, received_at: r.received_at })) },
    { headers: NO_STORE },
  );
}

/**
 * DELETE /api/phone-messages/messages  {"all": true}
 * Removes every stored text (revocation). Owner session, same-origin JSON. Works
 * with the flag off too, so switching it off never traps data in the table.
 */
export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req) || !(req.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || (body as { all?: unknown }).all !== true) {
    return NextResponse.json({ error: 'Send {"all": true}' }, { status: 400, headers: NO_STORE });
  }
  const { count, error } = await db()
    .from("phone_messages")
    .delete({ count: "exact" })
    .gte("received_at", "1970-01-01T00:00:00Z");
  if (error) {
    console.error("phone_messages delete failed:", error.code ?? "error");
    return NextResponse.json({ error: "Could not delete" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ deleted: count ?? 0 }, { headers: NO_STORE });
}
