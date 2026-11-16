import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { kickBank, parseRunBody, requestRun } from "@/lib/reading-bank-server";
import { readBankBody, SMALL_MAX_BODY_BYTES } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The queued steps run after the response (kickBank: up to 240 s). */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/reading/bank/run
 * Body: { book?: slug, chapter?: integer, rebuild?: boolean }
 *
 * "Build now" (plan + enqueue the book's missing chapters) and "Rebuild chapter" (rebuild: true): the chapter's
 * rebuild counter goes up first, which makes new job hashes, so a fresh research + build is queued; the stored
 * ideas stay served until the rebuilt batch replaces them. chapter 0 or none with rebuild = the book level (the
 * source map, and the whole-book build). Answers 202 at once {success, book_id, queued, enqueued, rebuilds}; the
 * work runs in after() (kickBank), never awaited.
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). Same-origin, JSON only, 1 KB cap, unknown
 * fields refused. Errors are short codes: 400 bad_request / bad_book / bad_chapter, 404 book_not_found, 409
 * bank_off (the book is not turned on), 503 bank_unavailable.
 */
export async function POST(req: NextRequest) {
  const requestStartedAt = Date.now();
  const read = await readBankBody(req, SMALL_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseRunBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await requestRun(supabase, parsed.input);
  const bookId = r.kickBookId;
  if (bookId) after(async () => {
    await kickBank(supabase, { bookId, reason: "run", plan: false, requestStartedAt });
  });
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
