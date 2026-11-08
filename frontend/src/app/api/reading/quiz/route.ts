import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { recordQuiz, XP } from "@/lib/reading";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/reading/quiz
 * Body: { book?: slug, checkpoint: 'ch12'|'ch26'|'ch40'|'review'|string, score: number, total: number, notes?: string }
 * Checkpoint quizzes are normally run by the chat ("quiz me on The Goal through
 * chapter 12"), which records the result through the same lib call.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await recordQuiz(supabase, {
    slug: (body.book as string) || null,
    checkpoint: String(body.checkpoint ?? ""),
    score: Number(body.score),
    total: Number(body.total),
    notes: (body.notes as string) || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ success: true, quiz: result.quiz, passed: result.passed, xp_gained: result.quiz.score * XP.perQuizPoint });
}
