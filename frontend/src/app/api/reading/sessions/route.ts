import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BOOK_COLS, deleteSessionByClientKey, getOverview, logSession, SESSION_COLS, type Book, type Medium, type ReadingSession } from "@/lib/reading";
import { mirrorProgress, mirrorSession, removeMirroredBlock, sessionMirrorDiffers, updateMirroredSession } from "@/lib/reading-notion";
import { removalAnswer, runRemovalCleanup } from "@/lib/reading-removal";

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
 * A key whose entry was discarded (DELETE below) answers 409 `discarded`.
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
  // 409 discarded: this client_key's entry was discarded (sql/reading_session_discards.sql), so nothing is created
  // under it again; the /log form continues an entry edited since under a new key.
  // 503 (also `retryable`: a transport or infrastructure failure, where a create whose answer was lost may have
  // committed; only a confirmed refusal is 400): a keyed create needs pds.create_reading_session (one transaction); until it is there nothing is stored and the
  // form retries (never the create in separate requests, which a Discard could land between).
  if (!result.ok) {
    return result.discarded
      ? NextResponse.json({ error: result.error, discarded: true }, { status: 409 })
      : result.unavailable || result.retryable
        ? NextResponse.json({ error: result.error }, { status: 503 })
        : NextResponse.json({ error: result.error }, { status: 400 });
  }

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
 * (PROD-T01): the form knows no session id, only the create's client_key. The key is recorded as discarded first
 * (sql/reading_session_discards.sql), so a create of it still running on the server is either found or refused, then
 * the session that key made (if any) is removed here like DELETE /api/reading/sessions/[id] (lib/reading.ts
 * deleteSessionByClientKey: finish undone, and the habit change the create made taken back from the create's own
 * record in the database unless the habit was answered again since, Codex T01-R7). Nothing is
 * created: `removed: null` tells the form nothing of the entry is stored, and nothing can be stored under that key
 * any more. Repeating it is safe.
 * Auth: owner session only (middleware; NOT in isCiRoute), plus a same-origin check.
 * Answers: 200 { success, discarded: true, client_key, removed: id | null, unfinished, overview } (the form clears
 * the entry only on exactly this receipt for its own key, Codex T01-R8; a retry of a removal whose answer was lost
 * answers its id and replays its Notion cleanup), 400 for a key that is not a UUID, 503 while the
 * discard cannot be recorded (SQL not applied), 500 on a database failure (the form retries both).
 */
export async function DELETE(req: NextRequest) {
  const refused = originRefused(req);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  const clientKey = (req.nextUrl.searchParams.get("client_key") ?? "").toLowerCase();
  const r = await deleteSessionByClientKey(supabase, clientKey);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  // The receipt names the key whose discard is recorded (Codex T01-R8).
  const receipt = { success: true, discarded: true, client_key: clientKey };
  if (!r.removed && !r.cleanup) return NextResponse.json({ ...receipt, removed: null, unfinished: false, overview: null });
  // A fresh removal, or a retry of one whose answer was lost: the Notion cleanup it still owes runs after the
  // response (lib/reading-removal.ts). A create's own after() that was still writing the Notion entry trashes it
  // once it sees the row gone.
  const { book, overview, removedId, owed } = await removalAnswer(supabase, r);
  if (owed) after(() => runRemovalCleanup(supabase, r, book, overview));

  return NextResponse.json({ ...receipt, removed: removedId, unfinished: r.unfinished, overview });
}
