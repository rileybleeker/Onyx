import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getLinkedIdeaTitles } from "@/lib/reading";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/**
 * GET /api/reading/idea-titles?book=<slug>
 *
 * The titles of the question-bank ideas the book's highlights are linked to: the extra concept tags the highlight form
 * offers next to the book's own (pds.books.theme). Answered by pds.reading_bank_linked_idea_titles, which applies the
 * spoiler gate, the edition check and the valid-evidence rule (a title of a chapter not yet quizzable never leaves the
 * database) and answers [] while the book's questions are off. Fails open: while the SQL is missing or on any read
 * error the answer is { titles: [] }. Writes nothing and starts nothing.
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * 400 bad_book for a slug that is not a slug.
 */
export async function GET(req: NextRequest) {
  const book = req.nextUrl.searchParams.get("book") || null;
  if (book !== null && !SLUG_RE.test(book)) return NextResponse.json({ error: "bad_book" }, { status: 400, headers: NO_STORE });
  const titles = await getLinkedIdeaTitles(supabase, book);
  return NextResponse.json({ titles }, { headers: NO_STORE });
}
