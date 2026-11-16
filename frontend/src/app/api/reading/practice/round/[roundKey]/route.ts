import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRoundAttempts, isUuid } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

type Ctx = { params: Promise<{ roundKey: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/reading/practice/round/:roundKey
 *
 * The attempts of one round, for the runner's poll while a model grade is pending and for the summary: verdict,
 * score, grading status, grader feedback, the rubric marks (ids only), override state and whether Disagree or
 * "Grade it yourself" applies. Never the answer text; an attempt whose question version is not open now
 * (pds.reading_bank_question_open: above the spoiler gate, another edition, or a chapter recall listing an idea
 * that moved above the gate) is left out, feedback included. Read only. The client cache keeps this key in memory
 * only (feedback is about Riley's answers).
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). no-store. Errors: 400 bad_request,
 * 503 bank_unavailable.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { roundKey } = await ctx.params;
  if (!isUuid(roundKey)) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  const r = await getRoundAttempts(supabase, roundKey.toLowerCase());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
