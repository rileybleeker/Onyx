import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUrgentEmail } from "@/lib/urgent-email-query";

export const dynamic = "force-dynamic";

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
