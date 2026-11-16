import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUrgentEmail } from "@/lib/urgent-email-query";

export const dynamic = "force-dynamic";
// Edge runtime, in the region of the database (Supabase us-east-1) and the Node functions (PERF-01, 2026-11-16).
// What was checked: the three queries are not the slow part. EXPLAIN (no ANALYZE, read-only) shows an index scan or a
// scan of a table of a few pages for each, and they already run in parallel (getUrgentEmail). What the perf-timing run
// showed is a call that was slow only on the cold first visit and ordinary on every warm view, which points at the
// start of a new function instance. An edge isolate starts in milliseconds. This is NOT yet measured on production:
// the next perf-timing runs after the deploy decide it, and if the cold first visit does not improve this export goes
// back to Node. Everything here runs on the edge runtime: supabase-js over fetch (the middleware already bundles it on
// the edge), Web Crypto for the clear-mark hashes (lib/today-clear.ts), Intl for the Eastern day; no Node API. Same
// middleware (owner session), same answer.
export const runtime = "edge";
export const preferredRegion = "iad1";

/**
 * GET /api/urgent-email
 * Read-only. The top few urgent unread emails from the last week, each linked to its
 * Gmail message, or `{ status: "not_connected" }` while no email source exists. Behind
 * the owner-session check in middleware.ts like every other /api route. Reads only
 * metadata already stored in pds.inbox_emails; it never contacts Gmail.
 */
export async function GET() {
  try {
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      db: { schema: "pds" },
      auth: { persistSession: false },
    });
    const body = await getUrgentEmail(client);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // Generic message: the detail stays in server logs, not in the response.
    console.error("urgent-email failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "Urgent email is unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
