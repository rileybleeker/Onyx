import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOK_COLS, getOverview, markRemovalMirrored, type Book, type ReadingOverview, type SessionRemoval } from "./reading";
import { mirrorProgress, removeMirroredBlock } from "./reading-notion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/**
 * What the two DELETE routes answer and run after a removal (PROD-T01): the book and its overview for the response,
 * and whether the Notion cleanup is owed. A fresh removal owes it; a retry that found the session already removed
 * owes it only while the cleanup row says it was not done (an earlier removal whose answer was lost, Codex review of
 * PR 376). The database part of a removal is never repeated here: it committed with the removal itself.
 */
export async function removalAnswer(
  supabase: Supa,
  r: Extract<SessionRemoval, { ok: true }>,
): Promise<{ book: Book | null; overview: ReadingOverview | null; removedId: number | null; owed: boolean }> {
  let book: Book | null = r.removed ? r.book : null;
  if (!book && r.cleanup) {
    const { data } = await supabase.from("books").select(BOOK_COLS).eq("book_id", r.cleanup.bookId).maybeSingle();
    book = (data as Book | null) ?? null;
  }
  const overview = book ? await getOverview(supabase, book.slug).catch(() => null) : null;
  return {
    book,
    overview,
    removedId: r.removed ? r.removed.session_id : (r.cleanup?.sessionId ?? null),
    owed: r.removed !== null || (!!r.cleanup && !r.cleanup.done),
  };
}

/**
 * The cleanup a removal owes outside the database, run in after(): trash the session's Notion entry, rewrite the
 * book page's progress line, then mark the cleanup row done so a later retry replays nothing. A failed trash leaves
 * the row open, so the next retry of the same removal tries again. A create's own after() still writing the entry
 * when the session went trashes it once it sees the row gone (app/api/reading/sessions/route.ts).
 */
export async function runRemovalCleanup(
  supabase: Supa,
  r: Extract<SessionRemoval, { ok: true }>,
  book: Book | null,
  overview: ReadingOverview | null,
): Promise<void> {
  const blockId = r.cleanup?.notionBlockId ?? r.removed?.notion_block_id ?? null;
  const trashed = !blockId || (await removeMirroredBlock(blockId));
  if (book) await mirrorProgress(book, overview?.chaptersDone ?? 0, overview?.sessions?.[0]?.session_date ?? null);
  const sessionId = r.cleanup?.sessionId ?? null;
  if (trashed && sessionId !== null) await markRemovalMirrored(supabase, sessionId);
}
