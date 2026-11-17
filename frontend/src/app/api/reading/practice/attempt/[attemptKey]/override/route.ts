import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isUuid, overrideAttempt, parseOverrideBody, readBankBody, selfGrade, SMALL_MAX_BODY_BYTES } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

type Ctx = { params: Promise<{ attemptKey: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/reading/practice/attempt/:attemptKey/override
 * Body: { verdict: correct|partial|incorrect }      Disagree with a model grade (once; never a chapter recall grade,
 *                                                    never after its checkpoint quiz was recorded)
 *    or { self_grade: correct|partial|incorrect }   "Grade it yourself" for an answer whose model grade failed or
 *                                                    did not come within a minute
 * Either way the answer's schedule is replayed with the new verdict and written in the same call
 * (pds.reading_bank_override / pds.reading_bank_grade with grader 'self'). A repeat of the same request replays.
 * Answers the receipt: 200 {success, attempt_key, grading_status, verdict, score, attempt_date, next_review, ...}.
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). Same-origin, JSON only, 1 KB cap, unknown
 * fields refused. Errors are short codes: 400 bad_request, 404 not_found, 409 already_overridden / not_overridable /
 * quiz_closed / already_graded / invalidated / still_grading / raced, 503 bank_unavailable.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { attemptKey } = await ctx.params;
  if (!isUuid(attemptKey)) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  const read = await readBankBody(req, SMALL_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseOverrideBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const key = attemptKey.toLowerCase();
  const r = parsed.input.mode === "override" ? await overrideAttempt(supabase, key, parsed.input.verdict) : await selfGrade(supabase, key, parsed.input.verdict);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
