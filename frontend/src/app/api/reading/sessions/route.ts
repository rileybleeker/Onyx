import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BOOK_COLS, getOverview, logSession, SESSION_COLS, type Book, type Medium, type ReadingSession } from "@/lib/reading";
import { mirrorProgress, mirrorSession, removeMirroredBlock, sessionMirrorDiffers, updateMirroredSession } from "@/lib/reading-notion";
import { kickBank } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The question bank's kick (READ-QUIZ-01) runs after the response: up to 240 s of generation. */
export const maxDuration = 300;

/**
 * POST /api/reading/sessions
 * Body: { book?: slug, date?: YYYY-MM-DD, chapter_through: number, chapter_from?: number,
 *         minutes?: number, medium?: 'audio'|'kindle'|'paper'|'other', recall?: string, question?: string }
 *
 * Writes the session, stamps the book's habit (Yes) for that behavioral day,
 * flips the book to finished when the last chapter is reached, and returns the
 * XP gained plus the refreshed overview. The Notion mirror (session quote block
 * + progress callout) runs after the response via `after()` — best-effort.
 * The autosaving /log Reading form creates here, then edits the same session
 * through PATCH /api/reading/sessions/[id]. It sends `client_key` (a UUID per
 * new session): a create retried after a lost answer returns the stored
 * session (`replayed: true`) with no second XP, habit stamp or Notion entry.
 */
export async function POST(req: NextRequest) {
  const requestStartedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await logSession(supabase, {
    slug: (body.book as string) || null,
    date: (body.date as string) || null,
    chapter_through: Number(body.chapter_through),
    chapter_from: body.chapter_from != null && body.chapter_from !== "" ? Number(body.chapter_from) : null,
    minutes: body.minutes != null && body.minutes !== "" ? Number(body.minutes) : null,
    medium: (body.medium as Medium) || null,
    recall: (body.recall as string) || null,
    question: (body.question as string) || null,
    client_key: typeof body.client_key === "string" ? body.client_key : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const overview = await getOverview(supabase, result.book.slug).catch(() => null);

  // A retried create (same client_key): the first request made the session and its Notion entry.
  if (!result.replayed) after(async () => {
    const id = result.session.session_id;
    const blockId = await mirrorSession(result.book, result.session);
    if (blockId) {
      await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", id);
      // The autosaving forms may edit or remove the session while its entry is being written: an edit that ran
      // before the block id was stored could not update the entry, so compare with the row as it is now.
      const { data: fresh } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", id).maybeSingle();
      const now = fresh as ReadingSession | null;
      if (!now) await removeMirroredBlock(blockId);
      else if (now.book_id !== result.session.book_id) {
        await removeMirroredBlock(blockId);
        const { data: other } = await supabase.from("books").select(BOOK_COLS).eq("book_id", now.book_id).maybeSingle();
        const moved = other ? await mirrorSession(other as Book, now) : null;
        await supabase.from("reading_sessions").update({ notion_block_id: moved }).eq("session_id", id);
      } else if (sessionMirrorDiffers(result.session, now)) await updateMirroredSession({ ...now, notion_block_id: blockId });
    }
    await mirrorProgress(
      { ...result.book, finished_on: result.finished ? result.session.session_date : result.book.finished_on },
      overview?.chaptersDone ?? result.session.chapter_through ?? 0,
      result.session.session_date,
    );
  });

  // The question bank (READ-QUIZ-01): a chapter Riley logged through may now be quizzable; plan and build after the
  // response (a replayed create changed nothing).
  if (!result.replayed) {
    const bookId = result.book.book_id;
    after(async () => {
      await kickBank(supabase, { bookId, reason: "session", requestStartedAt });
    });
  }

  return NextResponse.json({
    success: true,
    session: result.session,
    xp_gained: result.xpGained,
    finished: result.finished,
    habit_marked: result.habitMarked,
    // The day of the habit row this create made (null = none, or unknown): the form sends it back with its edits.
    habit_created_on: result.habitCreated ? result.session.session_date : null,
    replayed: result.replayed,
    overview,
  });
}
