import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BOOK_COLS, deleteSessionByClientKey, getOverview, logSession, SESSION_COLS, type Book, type Medium, type ReadingSession } from "@/lib/reading";
import { mirrorProgress, mirrorSession, removeMirroredBlock, sessionMirrorDiffers, updateMirroredSession } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

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

/** Same-origin check for a request without a body (DELETE): the Origin header must be this site. */
function originRefused(req: NextRequest): { status: number; error: string } | null {
  const origin = req.headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host"), req.nextUrl.host].filter(Boolean);
  return hosts.includes(o.host) ? null : { status: 403, error: "cross-origin request refused" };
}

/**
 * DELETE /api/reading/sessions?client_key=<uuid>
 *
 * Discard of an autosaving /log Reading entry whose create may have been stored although its answer never arrived
 * (PROD-T01): the form knows no session id, only the create's client_key, so the session that key made (if any) is
 * removed here like DELETE /api/reading/sessions/[id] (lib/reading.ts deleteSessionByClientKey: finish undone, habit
 * Yes left because whether the create made it is unknown). Nothing is created: a key no session has answers
 * `removed: null`, which tells the form nothing of the entry is stored. Repeating it is safe.
 * Auth: owner session only (middleware; NOT in isCiRoute), plus a same-origin check.
 * Answers: 200 { success, removed: id | null, unfinished, overview }, 400 for a key that is not a UUID.
 */
export async function DELETE(req: NextRequest) {
  const refused = originRefused(req);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  const r = await deleteSessionByClientKey(supabase, req.nextUrl.searchParams.get("client_key") ?? "");
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (!r.removed) return NextResponse.json({ success: true, removed: null, unfinished: false, overview: null });
  const { removed, book, unfinished } = r;
  const overview = await getOverview(supabase, book.slug).catch(() => null);

  // A create's own after() that was still writing the Notion entry trashes it once it sees the row gone.
  after(async () => {
    await removeMirroredBlock(removed.notion_block_id);
    await mirrorProgress(book, overview?.chaptersDone ?? 0, overview?.sessions?.[0]?.session_date ?? null);
  });

  return NextResponse.json({ success: true, removed: removed.session_id, unfinished, overview });
}
