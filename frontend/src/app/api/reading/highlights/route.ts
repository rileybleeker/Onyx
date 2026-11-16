import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { HIGHLIGHT_COLS, addHighlight, getBook, type Highlight, type HighlightSource } from "@/lib/reading";
import { highlightMirrorDiffers, mirrorHighlight, updateMirroredHighlight } from "@/lib/reading-notion";
import { HIGHLIGHT_EDIT_STEPS, kickBank } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The question bank's kick (READ-QUIZ-01) runs after the response: up to 240 s of generation. */
export const maxDuration = 300;

/** GET /api/reading/highlights?book=<slug>&include_archived=1 */
export async function GET(req: NextRequest) {
  const book = await getBook(supabase, req.nextUrl.searchParams.get("book"));
  if (!book) return NextResponse.json({ error: "No active book" }, { status: 404 });
  let q = supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("book_id", book.book_id).order("created_at", { ascending: false });
  if (!req.nextUrl.searchParams.get("include_archived")) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ book, highlights: data ?? [] });
}

/**
 * POST /api/reading/highlights
 * Body: { book?: slug, passage: string, comment?: string, chapter?: number, location?: string,
 *         concept?: string, source?: 'manual'|'kindle'|'audible'|'paper'|'photo' }
 * Idempotent on (book, passage). Mirrors to the Notion page after the response.
 */
export async function POST(req: NextRequest) {
  const requestStartedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await addHighlight(supabase, {
    slug: (body.book as string) || null,
    passage: String(body.passage ?? ""),
    comment: (body.comment as string) || null,
    chapter: body.chapter != null && body.chapter !== "" ? Number(body.chapter) : null,
    location: (body.location as string) || null,
    concept: (body.concept as string) || null,
    source: (body.source as HighlightSource) || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  if (result.created) {
    after(async () => {
      const id = result.highlight.highlight_id;
      const blockId = await mirrorHighlight(result.book, result.highlight);
      if (!blockId) return;
      await supabase.from("book_highlights").update({ notion_block_id: blockId }).eq("highlight_id", id);
      // The autosaving highlight form may have edited it before the block id was stored (that edit could not
      // update the entry): compare with the row as it is now.
      const { data: fresh } = await supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("highlight_id", id).maybeSingle();
      const now = fresh as Highlight | null;
      if (now && !now.archived && highlightMirrorDiffers(result.highlight, now)) await updateMirroredHighlight({ ...now, notion_block_id: blockId });
    });
  }
  // The question bank (READ-QUIZ-01): plan the book after the response. The highlights step itself waits for the
  // Kindle import kick or the hourly worker (HIGHLIGHT_EDIT_STEPS): this form autosaves while Riley types.
  if (result.created) {
    const bookId = result.book.book_id;
    after(async () => {
      await kickBank(supabase, { bookId, reason: "highlight", steps: HIGHLIGHT_EDIT_STEPS, requestStartedAt });
    });
  }
  return NextResponse.json({ success: true, created: result.created, highlight: result.highlight });
}
