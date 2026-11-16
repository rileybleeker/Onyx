import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { kickBank, parseApprovalBody, setApproval } from "@/lib/reading-bank-server";
import { readBankBody, SMALL_MAX_BODY_BYTES } from "@/lib/reading-recall-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The first build steps run after the response (kickBank: up to 240 s). */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/reading/bank/approval
 * Body: { book?: slug, on: boolean, cap_cents: integer (required when on) }
 *
 * Riley's one tap per book is the spending approval for its question bank. The cap is recomputed on the server
 * (what is spent + the remaining estimate x 1.25, rounded up to whole dollars, at most $25) and must equal the cap
 * the card showed: otherwise 409 estimate_changed with the new `cap_cents`, and nothing is written. Turning off
 * keeps every stored row (questions, answers, flags). Turning on queues the source map and the first chapters and
 * starts them in after() (lib/reading-bank-server.ts kickBank).
 *
 * Auth: owner session only (middleware; NEVER add this to isCiRoute). Same-origin, JSON only, 1 KB cap, unknown
 * fields refused. Answers 200 {success, book_id, on, cap_cents}; errors are short codes: 400 bad_request / bad_book /
 * bad_cap, 404 book_not_found, 409 estimate_changed, 503 bank_unavailable.
 */
export async function PUT(req: NextRequest) {
  const read = await readBankBody(req, SMALL_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseApprovalBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const r = await setApproval(supabase, parsed.input);
  const bookId = r.kickBookId;
  if (bookId) after(async () => {
    await kickBank(supabase, { bookId, reason: "approval" });
  });
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
