import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCheckpointRound, parseCheckpointQuery } from "@/lib/reading-checkpoint-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reading/practice/checkpoint?book=<slug>&chapter=<the checkpoint's chapter>
 *
 * The checkpoint quiz's round (READ-QUIZ-01 S5): up to 10 questions, one per idea, from chapters 1..N, built in code
 * from the ideas that may be asked (the spoiler gate applied in SQL, so locked chapters never leave the server). Writes
 * nothing and starts nothing: the same day gives the same quiz, so a reopened quiz resumes. The runner answers each
 * card through POST /api/reading/practice/attempt with round_kind "checkpoint" and the quiz_key this answer carries, and
 * records the result through POST /api/reading/quiz with op_key = quiz_key. Answers the round's shape (see
 * /api/reading/practice/today) plus {checkpoint, chapter, quiz_key, quiz, eligible, size, ready}.
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * Errors are short codes: 400 bad_book / bad_request / bad_checkpoint, 404 book_not_found, 409 bank_off / locked,
 * 503 bank_unavailable (SQL not applied).
 */
export async function GET(req: NextRequest) {
  const parsed = parseCheckpointQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await getCheckpointRound(supabase, parsed.query);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
