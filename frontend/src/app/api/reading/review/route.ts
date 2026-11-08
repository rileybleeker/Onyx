import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { gradeHighlight, type Grade, XP } from "@/lib/reading";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/reading/review
 * Body: { highlight_id: number, grade: 'again'|'good'|'easy' }
 * Records the grade and reschedules the highlight (SM-2 lite). The first review
 * of a behavioral day earns the day's review XP.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { highlight_id?: number; grade?: Grade };
  const result = await gradeHighlight(supabase, Number(body.highlight_id), body.grade as Grade);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({
    success: true,
    highlight: result.highlight,
    xp_gained: result.firstReviewToday ? XP.perReviewDay : 0,
    next_review: result.highlight.next_review,
  });
}
