import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRound, parseRoundQuery } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reading/practice/today?book=<slug>&kind=daily|extra|chapter&n=<extra round>&chapter=<n>
 *
 * The day's practice round for the active book (or `book`): ONE database read (pds.reading_bank_round, the spoiler
 * gate applied in SQL, so locked chapters never leave the server), then lib/reading-recall.ts buildRound. Writes
 * nothing and starts nothing: the same day gives the same round, so a reopened round resumes (answered cards are
 * marked done). Answers {today, quiz_through, enabled, round_key, kind, n, cards[], done, minutes, extra_available,
 * chapter_recall}; each card carries its question with the rubric, the idea, its sources and the preview of each
 * verdict. kind=extra&n=1.. is "One more round"; kind=chapter&chapter=N is the chapter sheet's "Practice 5".
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * Errors are short codes: 400 bad_book / bad_request, 404 book_not_found, 503 bank_unavailable (SQL not applied).
 */
export async function GET(req: NextRequest) {
  const parsed = parseRoundQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await getRound(supabase, parsed.query);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
