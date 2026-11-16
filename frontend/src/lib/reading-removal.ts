import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOK_COLS, getOverview, markRemovalMirrored, type Book, type ReadingOverview, type RemovalCleanup, type SessionRemoval } from "./reading";
import { mirrorProgress, removeMirroredBlock } from "./reading-notion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/** What a removal's routes answer with, and what its Notion cleanup needs. */
export interface RemovalAnswer {
  /** The session's book; null when it no longer exists, or when it could not be read (`bookUnread`). */
  book: Book | null;
  /** The book could not be read (a failed query, not a missing book): its progress line cannot be rewritten now. */
  bookUnread: boolean;
  /** The book's overview after the removal; null when there is no book or it could not be computed. */
  overview: ReadingOverview | null;
  removedId: number | null;
  owed: boolean;
}

/**
 * What the two DELETE routes answer and run after a removal (PROD-T01): the book and its overview for the response,
 * and whether the Notion cleanup is owed. A fresh removal owes it; a retry that found the session already removed
 * owes it only while the cleanup row says it was not done (an earlier removal whose answer was lost, Codex review of
 * PR 376). The database part of a removal is never repeated here: it committed with the removal itself.
 */
export async function removalAnswer(supabase: Supa, r: Extract<SessionRemoval, { ok: true }>): Promise<RemovalAnswer> {
  let book: Book | null = r.removed ? r.book : null;
  let bookUnread = false;
  if (!book && r.cleanup) {
    const { data, error } = await supabase.from("books").select(BOOK_COLS).eq("book_id", r.cleanup.bookId).maybeSingle();
    if (error) bookUnread = true;
    else book = (data as Book | null) ?? null;
  }
  const overview = book ? await getOverview(supabase, book.slug).catch(() => null) : null;
  return {
    book,
    bookUnread,
    overview,
    removedId: r.removed ? r.removed.session_id : (r.cleanup?.sessionId ?? null),
    owed: r.removed !== null || (!!r.cleanup && !r.cleanup.done),
  };
}

/**
 * The cleanup a removal owes outside the database, run in after(): trash the session's Notion entry, rewrite the
 * book page's progress line, then mark the cleanup row done so a later retry replays nothing. The row is marked done
 * only when EVERY step that is owed succeeded (Codex review of PR 376, round 2): a failed trash, a book that could not
 * be read, an overview that could not be computed (the progress line would read chapter 0) or a failed progress
 * rewrite leaves the row open, so the next retry of the same removal tries again. Steps that are not owed count as
 * done: no Notion entry, a book that no longer exists, a book without a Notion page. A create's own after() still
 * writing the entry when the session went trashes it once it sees the row gone (app/api/reading/sessions/route.ts).
 */
export async function runRemovalCleanup(supabase: Supa, r: Extract<SessionRemoval, { ok: true }>, answer: RemovalAnswer): Promise<void> {
  const { book, bookUnread, overview } = answer;
  const blockId = r.cleanup?.notionBlockId ?? r.removed?.notion_block_id ?? null;
  const trashed = !blockId || (await removeMirroredBlock(blockId));
  let progressDone: boolean;
  if (bookUnread) progressDone = false;
  else if (!book || !book.notion_page_id) progressDone = true;
  else if (!overview) progressDone = false;
  else progressDone = await mirrorProgress(book, overview.chaptersDone ?? 0, overview.sessions?.[0]?.session_date ?? null);
  const sessionId = r.cleanup?.sessionId ?? null;
  if (trashed && progressDone && sessionId !== null) await markRemovalMirrored(supabase, sessionId);
}

/**
 * A create's own Notion callback wrote an entry for a session that a removal had already taken out (review of PR 376,
 * round 3). The block id goes into the removal's cleanup row FIRST, with the cleanup reopened, so it is owed and
 * found by the sweep below even if the trash call or this process fails; then it is trashed and the row closed.
 * Returns true when the entry is gone.
 */
export async function trashLateBlock(supabase: Supa, sessionId: number, blockId: string): Promise<boolean> {
  const { error } = await supabase
    .from("reading_session_removals")
    .update({ notion_block_id: blockId, mirror_done_at: null })
    .eq("session_id", sessionId);
  if (error) console.error("reading: late block record failed:", error.code ?? "unknown");
  const trashed = await removeMirroredBlock(blockId);
  // The book's progress line is rewritten by the create callback's last step from the database as it is then.
  if (trashed && !error) await markRemovalMirrored(supabase, sessionId);
  return trashed;
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;
const SWEEP_MIN_AGE_MS = 2 * 60_000;
const SWEEP_LIMIT = 5;

/**
 * Durable retry of Notion cleanup a removal still owes (review of PR 376, round 3): a removal answers before its
 * cleanup runs, and a cleanup that failed (or a process that ended first) used to wait for the client to repeat the
 * DELETE, which it never does once the entry is gone from the screen. Every reading route that already runs after()
 * calls this: it takes the removals whose cleanup row is still open and older than two minutes (so one still running
 * is left alone), at most five, at most once a minute per server instance, and runs the same cleanup for each.
 * Trashing a block twice is harmless, so two sweeps meeting do no damage. Never throws.
 */
export async function sweepPendingRemovals(supabase: Supa): Promise<number> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
  try {
    const { data, error } = await supabase
      .from("reading_session_removals")
      .select("session_id,book_id,session_date,notion_block_id,unfinished,mirror_done_at")
      .is("mirror_done_at", null)
      .lt("removed_at", new Date(now - SWEEP_MIN_AGE_MS).toISOString())
      .order("removed_at", { ascending: true })
      .limit(SWEEP_LIMIT);
    if (error || !data?.length) return 0;
    let done = 0;
    for (const row of data as Record<string, unknown>[]) {
      const cleanup: RemovalCleanup = {
        sessionId: Number(row.session_id),
        bookId: Number(row.book_id),
        sessionDate: typeof row.session_date === "string" ? row.session_date : null,
        notionBlockId: typeof row.notion_block_id === "string" && row.notion_block_id ? row.notion_block_id : null,
        unfinished: row.unfinished === true,
        done: false,
      };
      const r: Extract<SessionRemoval, { ok: true }> = { ok: true, removed: null, unfinished: cleanup.unfinished, cleanup };
      const answer = await removalAnswer(supabase, r);
      await runRemovalCleanup(supabase, r, answer);
      done++;
    }
    return done;
  } catch (e) {
    console.error("reading: removal sweep failed:", e instanceof Error ? e.name : "unknown");
    return 0;
  }
}
