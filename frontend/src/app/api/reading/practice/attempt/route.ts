import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ATTEMPT_MAX_BODY_BYTES, claimAndRunGrade, parseAttemptBody, readBankBody, recordAttempt } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The grade job of a model-graded answer runs after the response (one 30 s step). */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/reading/practice/attempt
 * Body: { attempt_key, question_id, version, round_key, round_date, round_kind: daily|extra|chapter|checkpoint,
 *         answer, hinted?, response_ms?, quiz_key? (checkpoint only) }
 *
 * One answer to a bank question (lib/reading-recall-server.ts recordAttempt): the question, the day and the idea's
 * history are read in one snapshot (pds.reading_bank_attempt_context; the version must be current), graded in code when it can be (a short answer, a choice after "Show choices", an order, "I don't
 * know"; the same gradeLocal the browser ran, and the server's verdict wins) and stored with the replayed schedule in
 * ONE call of pds.reading_bank_attempt (two database requests per answer); anything else is stored pending and its grade job runs in after(), never
 * awaited. The same attempt_key with the same request answers the first receipt (`replayed: true`), also after the
 * question was re-versioned or retired since (the function looks the key up before it refuses a changed question);
 * another request under that key is 409 key_reused. Answers: 200 {success, attempt_key, grading_status, verdict, score,
 * attempt_date, next_review, hinted, overridden, replayed}.
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). Same-origin, JSON only, 16 KB cap, unknown
 * fields refused. Errors are short codes: 400 bad_request / bad_answer / states_missing, 404 not_found, 409
 * key_reused / question_changed / retired / locked / chapter_changed / raced / quiz_closed / already_answered /
 * quiz_other_book / source_not_permitted / bank_off (the book's questions were turned off: no new answer, a retry of a
 * stored one still gets its receipt), 503 bank_unavailable / schema_checks. No answer text is ever logged.
 */
export async function POST(req: NextRequest) {
  const read = await readBankBody(req, ATTEMPT_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseAttemptBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await recordAttempt(supabase, parsed.input);
  const pending = r.pendingKey;
  if (pending) after(async () => {
    await claimAndRunGrade(supabase, pending);
  });
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
