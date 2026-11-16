import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { gradeHighlight, XP } from "@/lib/reading";
import { parseReviewBody, PRACTICE_MAX_BODY_BYTES } from "@/lib/reading-practice";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/reading/review
 * Body: { highlight_id, grade: 'again'|'good'|'easy', op_key?: uuid, expected_review_count?: number }
 *
 * Records the grade and reschedules the highlight (SM-2 lite, lib/reading-practice.ts) in ONE database call
 * (pds.reading_grade_review): the review row, the schedule and an operation receipt commit together or not at all.
 * The review card sends one op_key per card until it hears a definite answer, so a retry after a lost answer gets
 * the same receipt (`replayed: true`) and stores nothing new. The first review of a behavioral day earns the day's
 * review XP (decided inside the same transaction); on a replay `xp_gained` is that original award, not earned again.
 *
 * Auth: owner session only (middleware; NOT in isCiRoute), plus same-origin, JSON only, 8 KB cap, unknown fields
 * refused. Answers: 200 { success, highlight, xp_gained, next_review, interval_days, review_date, op_key,
 * replayed }; 400 bad_*; 404 not_found; 409 changed (graded on another screen) / archived / key_reused (this key
 * already stored another grade); 503 practice_unavailable (sql/reading_practice_receipts.sql not applied; nothing
 * is written). Error bodies are short codes only.
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
  const parsed = parseReviewBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await gradeHighlight(supabase, parsed.input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    {
      success: true,
      highlight: result.highlight,
      xp_gained: result.firstReviewToday ? XP.perReviewDay : 0,
      next_review: result.receipt.next_review,
      interval_days: result.receipt.interval_days,
      review_date: result.receipt.review_date,
      op_key: result.receipt.op_key,
      replayed: result.replayed,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
