import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { flagQuestion, parseFlagBody, readBankBody, SMALL_MAX_BODY_BYTES } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/reading/practice/flag
 * Body: { flag_key, question_id, kind: wrong|unclear|not_in_chapter|not_read_yet }   or   { flag_key, restore: true }
 *
 * A flag on a question through pds.reading_bank_flag, replay safe by flag_key (the same key with another request is
 * 409 key_reused): Wrong retires the idea and its questions and voids their answers (kept, with the reason);
 * Unclear retires that question and voids its answers; Not in this chapter moves the idea to the end of the book;
 * Not read yet holds the chapter (the spoiler gate drops below it at once). Restore undoes a flag (answers it voided
 * stay voided). The ideas whose answers changed are then replayed (pds.reading_bank_write_states). The client holds a
 * flag 8 s for Undo before sending it. Answers 200 {success, kind, invalidated, restored, replayed, repaired}.
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). Same-origin, JSON only, 1 KB cap, unknown
 * fields refused. Errors are short codes: 400 bad_request, 404 not_found, 409 key_reused / locked /
 * question_changed / superseded, 503 bank_unavailable.
 */
export async function POST(req: NextRequest) {
  const read = await readBankBody(req, SMALL_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseFlagBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await flagQuestion(supabase, parsed.input);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
