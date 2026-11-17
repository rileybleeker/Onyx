import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBankExport, parseBookQuery } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reading/bank/export?book=<slug>
 *
 * Inspection export of the book's question bank: its ideas (active and retired) at or below the spoiler gate and of
 * the current edition, with the ids of their evidence; the sources (web citations: URL, domain, title, the API's
 * snippet; highlight evidence: the highlight id only); and job counts by step and status (never the research
 * notes). Questions and answers stay on PROD-T07's export (GET /api/reading/questions?book=). Writes nothing. The
 * client cache keeps this key in memory only (lib/client-cache.ts).
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * Errors are short codes: 400 bad_book, 404 book_not_found, 503 bank_unavailable.
 */
export async function GET(req: NextRequest) {
  const q = parseBookQuery(req.nextUrl.searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400, headers: NO_STORE });
  const r = await getBankExport(supabase, q.slug);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
