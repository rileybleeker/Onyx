import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { parseQuestionOp, QUESTIONS_MAX_BODY_BYTES } from "@/lib/reading-questions";
import { applyQuestionOp, exportQuestions } from "@/lib/reading-questions-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * GET  /api/reading/questions?book=<slug>   Inspect / export one book's learning questions: every version with its
 *                                           source kind, reference, hash and whether that source is the same,
 *                                           changed or removed now, plus every attempt (raw answers included).
 * POST /api/reading/questions               One operation (lib/reading-questions.ts parseQuestionOp):
 *   { op: "answer",  op_key, book?, question_key, prompt, rubric?, source_kind, source_ref, answer, quiz_key? }
 *   { op: "grade",   attempt_key, correct, grader: "model"|"self", feedback? }
 *   { op: "correct", op_key, question_key, expected_version, prompt, rubric?, source_kind, source_ref, reason }
 *
 * Storage and rules: sql/reading_learning_questions.sql (pds.reading_question_apply / pds.reading_questions_export).
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). POST: same-origin, JSON
 * only, 16 KB cap, unknown fields refused. Everything is no-store, and the client cache keeps this key in memory
 * only. Errors are short codes (no question or answer text): 400 bad_*, 404 not_found / book_not_found, 409
 * key_reused / already_graded / invalidated / question_changed / source_not_permitted / quiz_closed / changed,
 * 503 practice_unavailable (SQL not applied; nothing is written).
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("book") || null;
  if (slug != null && !/^[a-z0-9-]{1,80}$/.test(slug)) return NextResponse.json({ error: "bad_book" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const r = await exportQuestions(supabase, slug);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, QUESTIONS_MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ error: "bad_request" }, { status: refused.status });
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > QUESTIONS_MAX_BODY_BYTES) return NextResponse.json({ error: "bad_request" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseQuestionOp(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await applyQuestionOp(supabase, parsed.op);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
