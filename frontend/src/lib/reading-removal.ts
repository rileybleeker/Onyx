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
 * The progress line is written from the book as it is when the write happens (rewriteProgressNow), never from the
 * overview the response was built with: two removals of one book whose cleanups ran out of order used to write the
 * older one's line last and close both rows (Codex review of PR 376, round 4).
 */
export async function runRemovalCleanup(supabase: Supa, r: Extract<SessionRemoval, { ok: true }>, answer: RemovalAnswer): Promise<void> {
  const { book, bookUnread } = answer;
  const blockId = r.cleanup?.notionBlockId ?? r.removed?.notion_block_id ?? null;
  const trashed = !blockId || (await removeMirroredBlock(blockId));
  let progressDone: boolean;
  if (bookUnread) progressDone = false;
  else if (!book || !book.notion_page_id) progressDone = true;
  else progressDone = await rewriteProgressNow(supabase, book.book_id);
  const sessionId = r.cleanup?.sessionId ?? null;
  // Closed only while the row still records the entry this run handled (Codex T01-R9): a late entry a create
  // callback recorded meanwhile stays owed.
  if (trashed && progressDone && sessionId !== null) await markRemovalMirrored(supabase, sessionId, blockId);
}

/** What the book page's progress line is written from, and a fingerprint of it (everything mirrorProgress reads). */
type ProgressState =
  | { kind: "failed" }
  | { kind: "none" } // the book no longer exists, or has no Notion page: nothing to write
  | { kind: "ok"; book: Book; chaptersDone: number; lastSessionDate: string | null; fingerprint: string };

async function progressState(supabase: Supa, bookId: number): Promise<ProgressState> {
  const { data, error } = await supabase.from("books").select(BOOK_COLS).eq("book_id", bookId).maybeSingle();
  if (error) return { kind: "failed" };
  const book = (data as Book | null) ?? null;
  if (!book || !book.notion_page_id) return { kind: "none" };
  const current = await getOverview(supabase, book.slug).catch(() => null);
  if (!current) return { kind: "failed" };
  const chaptersDone = current.chaptersDone ?? 0;
  const lastSessionDate = current.sessions?.[0]?.session_date ?? null;
  const fingerprint = JSON.stringify([
    book.notion_page_id,
    book.total_chapters ?? null,
    book.status ?? null,
    book.finished_on ?? null,
    book.target_date ?? null,
    chaptersDone,
    lastSessionDate,
  ]);
  return { kind: "ok", book, chaptersDone, lastSessionDate, fingerprint };
}

/**
 * The book page's progress line, rewritten from the database as it is NOW (review of PR 376, round 3). True when it
 * was rewritten or is not owed (the book no longer exists, or has no Notion page); false when the book could not be
 * read, its overview could not be computed, or the rewrite failed.
 * Also false when the book changed while the line was being written (Codex review of PR 376, round 4): Notion keeps
 * the last write, and serverless instances share no lock, so two writers of one book (two removals, or a removal and
 * a create's callback) can land in either order. Each writer therefore reads the book again after its write; a
 * writer whose line no longer matches the database may have landed last with an older line, so its cleanup stays
 * open and the sweep writes the line again later from the state then. The writer whose line matched closes its own
 * work; whichever write lands last, the one that may be stale is always left owed, so the line converges.
 */
export async function rewriteProgressNow(supabase: Supa, bookId: number): Promise<boolean> {
  const before = await progressState(supabase, bookId);
  if (before.kind === "failed") return false;
  if (before.kind === "none") return true;
  const wrote = await mirrorProgress(before.book, before.chaptersDone, before.lastSessionDate);
  if (!wrote) return false;
  const after = await progressState(supabase, bookId);
  if (after.kind === "none") return true;
  return after.kind === "ok" && after.fingerprint === before.fingerprint;
}

/**
 * A create's own Notion callback wrote an entry for a session that a removal had already taken out (review of PR 376,
 * round 3). The block id goes into the removal's cleanup row FIRST, with the cleanup reopened, so it is owed and
 * found by the sweep below even if the trash call or this process fails; then it is trashed and the book's progress
 * line rewritten (`rewriteProgress`, the callback's last step). The row is closed only when ALL of that succeeded
 * (Codex T01-R9): a failed record, trash or progress rewrite leaves it open for the sweep, and the close is
 * conditional on the row still recording this entry. A removal cleanup that started earlier with no entry closes
 * nothing of this work (markRemovalMirrored). Returns what happened (`complete` = every step succeeded and the close was sent), for the caller and the tests.
 */
export async function trashLateBlock(
  supabase: Supa,
  sessionId: number,
  blockId: string,
  rewriteProgress: () => Promise<boolean>,
): Promise<{ recorded: boolean; trashed: boolean; progressDone: boolean; complete: boolean }> {
  const { error } = await supabase
    .from("reading_session_removals")
    .update({ notion_block_id: blockId, mirror_done_at: null })
    .eq("session_id", sessionId);
  if (error) console.error("reading: late block record failed:", error.code ?? "unknown");
  const recorded = !error;
  const trashed = await removeMirroredBlock(blockId);
  const progressDone = await rewriteProgress().catch(() => false);
  const complete = recorded && trashed && progressDone;
  if (complete) await markRemovalMirrored(supabase, sessionId, blockId);
  return { recorded, trashed, progressDone, complete };
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
