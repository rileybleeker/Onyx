import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBankOverview, parseBookQuery } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reading/bank?book=<slug>
 *
 * The question bank's chapter map for the active book (or `book`): pds.reading_bank_overview (the spoiler gate is
 * applied in SQL: a locked chapter carries no counts, and a narrative book's locked titles are left out) plus the
 * estimate for finishing the book from here and the cap a "Turn on" / "Allow $N more" tap approves
 * (lib/reading-bank-server.ts bookEstimate; PUT /api/reading/bank/approval recomputes it). Writes nothing and starts
 * nothing.
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * Errors are short codes: 400 bad_book, 404 book_not_found, 503 bank_unavailable (sql/reading_question_bank.sql not
 * applied).
 */
export async function GET(req: NextRequest) {
  const q = parseBookQuery(req.nextUrl.searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400, headers: NO_STORE });
  const r = await getBankOverview(supabase, q.slug);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
