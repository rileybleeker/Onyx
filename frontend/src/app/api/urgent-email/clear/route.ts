import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MAX_CLEAR_BODY_BYTES, checkClearRequest, clearKeyHash, parseClearBody } from "@/lib/today-clear";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
// PostgREST / Postgres "table not there": sql/today_cleared_emails.sql not applied yet.
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

/**
 * POST /api/urgent-email/clear
 *   {items: [{key, receivedAt}]}          hide these labelled threads from Today's Urgent email
 *   {items: [{key}], undo: true}          show them again
 * Owner session only (middleware; NOT in the CI carve-out), same-origin JSON, at most 16 KB.
 * Writes only pds.today_cleared_emails (SHA-256 of the thread key + the newest message time Riley
 * cleared); a newer message in the thread shows it again. Nothing is sent to Gmail: no label,
 * read flag or archive changes. Agent Inbox cards are cleared through the Worker, not here.
 */
export async function POST(req: NextRequest) {
  const refused = checkClearRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);

  let text: string;
  try {
    text = await req.text();
  } catch {
    return answer({ error: "could not read body" }, 400);
  }
  if (text.length > MAX_CLEAR_BODY_BYTES) return answer({ error: "body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer({ error: "body must be JSON" }, 400);
  }
  const now = new Date();
  const parsed = parseClearBody(body, now);
  if (!parsed.ok) return answer({ error: parsed.error }, 400);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return answer({ error: "saving is not configured" }, 503);
  const db = createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });

  const request = parsed.request;
  const { error } = request.undo
    ? await db.from("today_cleared_emails").delete().in("key_hash", await Promise.all(request.keys.map(clearKeyHash)))
    : await db.from("today_cleared_emails").upsert(
        await Promise.all(request.items.map(async (i) => ({ key_hash: await clearKeyHash(i.key), cleared_through: i.through, cleared_at: now.toISOString() }))),
        { onConflict: "key_hash" },
      );
  if (error) {
    // Code only: the keys name a mailbox and a thread.
    console.error("urgent-email clear failed:", error.code || "unknown");
    if (MISSING_TABLE_CODES.has(error.code)) return answer({ error: "clearing is not set up yet", setupPending: true }, 503);
    return answer({ error: "could not save" }, 500);
  }
  return answer({ ok: true, undo: request.undo, count: request.undo ? request.keys.length : request.items.length });
}
