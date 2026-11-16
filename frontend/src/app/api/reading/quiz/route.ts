import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { recordQuiz, XP } from "@/lib/reading";
import { parseQuizBody, PRACTICE_MAX_BODY_BYTES } from "@/lib/reading-practice";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/reading/quiz
 * Body: { book?: slug, checkpoint: 'ch12'|'ch26'|'ch40'|'review'|string, score, total, notes?, op_key?: uuid }
 *
 * Checkpoint quizzes are normally run by the chat ("quiz me on The Goal through chapter 12"), which records the
 * result through the same lib call. The result is stored with an operation receipt in ONE database call
 * (pds.reading_record_quiz): the same op_key and result answers that receipt again (`replayed: true`), so a retried
 * request never stores a second attempt or a second set of points; the same key with another result is 409
 * key_reused.
 *
 * Auth: owner session only (middleware; NOT in isCiRoute), plus same-origin, JSON only, 8 KB cap, unknown fields
 * refused. 503 practice_unavailable until sql/reading_practice_receipts.sql is applied (nothing is written).
 */
export async function POST(req: NextRequest) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, PRACTICE_MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ error: "bad_request" }, { status: refused.status });
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > PRACTICE_MAX_BODY_BYTES) return NextResponse.json({ error: "bad_request" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseQuizBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await recordQuiz(supabase, parsed.input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    {
      success: true,
      quiz: result.quiz,
      passed: result.passed,
      xp_gained: result.quiz.score * XP.perQuizPoint,
      op_key: result.op_key,
      replayed: result.replayed,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
