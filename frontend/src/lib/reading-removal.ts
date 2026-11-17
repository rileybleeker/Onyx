import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BOOK_COLS,
  getOverview,
  markRemovalMirrored,
  reopenRemovalCleanup,
  SESSION_COLS,
  type Book,
  type ReadingOverview,
  type ReadingSession,
  type RemovalCleanup,
  type SessionRemoval,
} from "./reading";
import {
  findSessionBlocksByMarker,
  mirrorProgress,
  mirrorSession,
  notionMirrorEnabled,
  refreshMirroredSession,
  removeMirroredBlock,
  sessionMirrorDiffers,
  updateMirroredSession,
} from "./reading-notion";

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
 * only when EVERY step that is owed succeeded (Codex review of PR 376, round 2): a failed trash, or a progress line
 * that is neither checked nor owed durably (rewriteProgressNow), leaves the row open, so the sweep or the next retry
 * of the same removal tries again. Steps that are not owed count as done: no Notion entry, a book that no longer
 * exists, a book without a Notion page. A create's own after() still writing the entry when the session went trashes
 * it once it sees the row gone (app/api/reading/sessions/route.ts).
 * The progress line is written from the book as it is when the write happens, never from the overview the response
 * was built with (Codex review of PR 376, round 4), and its obligation is the writer's own row in
 * pds.reading_progress_owed, not this cleanup row (round 5): a line that may be stale stays owed even when another
 * worker closes this row.
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
  // Something is still owed and another worker may have closed the row meanwhile: it is opened again for the sweep.
  else if (sessionId !== null) await reopenRemovalCleanup(supabase, sessionId);
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

/** sql/reading_session_discards.sql (which creates the two tables below) is not applied yet. */
function relationMissing(error: { code?: string } | null | undefined): boolean {
  return !!error && ["42P01", "PGRST205", "PGRST204", "42703"].includes(String(error.code));
}

/**
 * Retry timing of claims and progress obligations (Codex review of PR 376, round 6). A row is first due 15 minutes
 * after it is written: longer than any server function runs, so the writer that stored it is done or gone before the
 * sweep looks at it, and a sweep never takes (or clears) the row of a writer still in flight. A sweep that could not
 * settle a row puts it back with a doubling delay, at most six hours: nothing is ever given up for its age, and a row
 * that keeps failing (a page Onyx can no longer write) is tried a few times a day without holding back newer rows,
 * which are taken first by their due time.
 */
const FIRST_TRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
/** After this many failed tries a row is logged on every further try (a count only), so a stuck one is visible. */
const LONG_OPEN_ATTEMPTS = 6;

/** Delay before the next try of a row that has failed `attempts` times (0 = a new row). Exported for the tests. */
export function retryDelayMs(attempts: number): number {
  return attempts <= 0 ? FIRST_TRY_MS : Math.min(FIRST_TRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
}

function dueAt(attempts: number, nowMs = Date.now()): string {
  return new Date(nowMs + retryDelayMs(attempts)).toISOString();
}

/**
 * A writer's own obligation for a book's progress line (pds.reading_progress_owed), stored BEFORE it writes. "missing"
 * = the table is not there yet (the writer then works as before the file); null = it could not be stored.
 * `attempts` > 0 = a sweep's own row that carries the obligations it found, due after their retry delay.
 */
async function addProgressOwed(supabase: Supa, bookId: number, attempts = 0): Promise<string | "missing" | null> {
  const owedId = randomUUID();
  const { error } = await supabase
    .from("reading_progress_owed")
    .insert({ owed_id: owedId, book_id: bookId, attempts, next_try_at: dueAt(attempts) });
  if (!error) return owedId;
  if (relationMissing(error)) return "missing";
  console.error("reading: progress obligation not stored:", error.code ?? "unknown");
  return null;
}

async function dropProgressOwed(supabase: Supa, owedIds: string[]): Promise<boolean> {
  if (!owedIds.length) return true;
  const { error } = await supabase.from("reading_progress_owed").delete().in("owed_id", owedIds);
  // Left behind, a row only makes the sweep write a checked line once more.
  if (error) console.error("reading: progress obligation not cleared:", error.code ?? "unknown");
  return !error;
}

async function deferProgressOwed(supabase: Supa, owedIds: string[], attempts: number): Promise<void> {
  if (!owedIds.length) return;
  const { error } = await supabase
    .from("reading_progress_owed")
    .update({ attempts, next_try_at: dueAt(attempts) })
    .in("owed_id", owedIds);
  if (error) console.error("reading: progress obligation not deferred:", error.code ?? "unknown");
}

/**
 * Writes the book page's progress line from the database as it is NOW and checks it: the book is read again after
 * the write, and the line counts as written only when the state it was written from is still the state (Codex review
 * of PR 376, rounds 4 and 5). Notion keeps the last write and serverless instances share no lock, so two writers of
 * one book can land in either order; a writer whose state changed while it wrote may have landed last with an older
 * line, so it writes once more from the state then, and otherwise keeps its obligation for the sweep.
 * `verified` = written and checked, or not owed (the book is gone or has no Notion page); `failed` = neither.
 */
async function writeProgressChecked(supabase: Supa, bookId: number): Promise<"verified" | "failed"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await progressState(supabase, bookId);
    if (before.kind === "failed") return "failed";
    if (before.kind === "none") return "verified";
    const wrote = await mirrorProgress(before.book, before.chaptersDone, before.lastSessionDate);
    if (!wrote) return "failed";
    const after = await progressState(supabase, bookId);
    if (after.kind === "none") return "verified";
    if (after.kind === "failed") return "failed";
    if (after.fingerprint === before.fingerprint) return "verified";
  }
  return "failed";
}

/**
 * The book page's progress line, rewritten from the database as it is now (what every reading session route uses).
 * Every writer stores its own obligation row first and deletes only that row once its line was checked
 * (writeProgressChecked). One row per writer, never a shared flag, so no writer can clear another's: a writer whose
 * older line may have landed after another writer's checked line, or whose process ends before it could check, still
 * owes the line, and the sweep writes it again from the state then (Codex review of PR 376, round 5: a closed cleanup
 * row used to leave such a line in Notion for good, and a create's or an edit's own write was owed nowhere).
 * True when the line is checked, not owed, or owed durably (the sweep finishes it); false only when it is none of
 * these (the obligation could not be stored and the line could not be checked), so a removal's cleanup row stays open.
 */
export async function rewriteProgressNow(supabase: Supa, bookId: number, storedOwedId: string | null = null): Promise<boolean> {
  // A write needs its obligation first (Codex review of PR 376): without a stored row, an older write landing last
  // followed by a failed check would stay stale for good and nobody would know. A row that cannot be stored after a
  // few tries means no write is made; false keeps a removal's cleanup row open, and the next write of the book
  // (or the sweep, for its own rows) writes the line from the state then. `storedOwedId` = the obligation an edit's
  // own transaction stored (pds.move_reading_session, Codex T01-R14): it is this writer's row, nothing more is added.
  let owed: string | "missing" | null = storedOwedId ?? (await addProgressOwed(supabase, bookId));
  for (let attempt = 1; owed === null && attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * attempt));
    owed = await addProgressOwed(supabase, bookId);
  }
  if (owed === null) return false;
  const held = owed !== "missing" ? owed : null;
  const result = await writeProgressChecked(supabase, bookId).catch(() => "failed" as const);
  if (result === "verified") {
    if (held) await dropProgressOwed(supabase, [held]);
    return true;
  }
  return held !== null;
}

/**
 * Writes the line for obligations the sweep found (one book; every row is due, so its writer is done or gone) and
 * clears them once checked. The sweep is a writer like any other (Codex review of PR 376, round 6): it stores its OWN
 * row before it writes, so another sweep that found the same rows and clears them after its own checked line cannot
 * leave this sweep's line, which may still land later and stale, owed nowhere; if this process ends mid-write, its
 * row is what a later sweep finds. That row starts with the found rows' next retry delay. When the write fails it
 * carries the obligation alone and the found rows are folded into it (deleted), so a book whose line keeps failing
 * holds one row, not one more per try. True when the line was checked.
 */
async function settleProgressOwed(supabase: Supa, bookId: number, owedIds: string[], attempts: number): Promise<boolean> {
  const next = attempts + 1;
  const own = await addProgressOwed(supabase, bookId, next);
  if (own === null) {
    // Nothing is written without its own obligation; the found rows wait for their next try.
    await deferProgressOwed(supabase, owedIds, next);
    return false;
  }
  const result = await writeProgressChecked(supabase, bookId).catch(() => "failed" as const);
  if (result === "verified") {
    await dropProgressOwed(supabase, own === "missing" ? owedIds : [own, ...owedIds]);
    return true;
  }
  if (next >= LONG_OPEN_ATTEMPTS) console.error("reading: progress line still owed after tries:", next);
  if (own === "missing") await deferProgressOwed(supabase, owedIds, next);
  else await dropProgressOwed(supabase, owedIds);
  return false;
}

/* ---------- Notion session entries whose block id may not be stored yet (pds.reading_mirror_claims) ---------- */

export interface MirrorClaim {
  claimId: string;
  sessionId: number;
  /** The book whose page the entry is (or is to be) on. */
  bookId: number;
  blockId: string | null;
  /** The session's entry this one replaces (a move to another book's page): trashed once this one is attached. */
  replaces: string | null;
  claimedAt: string;
  attempts: number;
  /**
   * The claim of a move to another book or of a keyed create, stored in the same transaction (pds.move_reading_session,
   * pds.create_reading_session; Codex T01-R14 and its round 2): it owes the session's entry on `bookId`'s page, so a
   * sweep that finds no entry for it writes one.
   */
  owesEntry?: boolean;
}

/**
 * Stored BEFORE an entry is written (Codex review of PR 376, rounds 5 and 6): the session, the book whose page the
 * entry goes on, the entry it replaces (a move) and a random id that the entry itself carries as an invisible marker
 * (reading-notion.ts sessionBlock), so the sweep can find exactly this entry before its block id is stored, never an
 * entry of another session with the same text. No entry is written without its claim: one that a removal or a
 * failure leaves behind is always found and settled (settleMirrorClaim), also after a restart. `blockId` given = a
 * claim on an entry that already exists (retireEntry). "missing" = the table is not there yet
 * (sql/reading_session_discards.sql not applied, so no removal can run: the entry is written as before); null = the
 * claim could not be stored.
 */
export async function claimMirror(
  supabase: Supa,
  sessionId: number,
  bookId: number,
  replaces: string | null = null,
  blockId: string | null = null,
): Promise<MirrorClaim | "missing" | null> {
  const claimedAt = new Date().toISOString();
  const row = {
    claim_id: randomUUID(),
    session_id: sessionId,
    book_id: bookId,
    block_id: blockId,
    replaces_block_id: replaces,
    claimed_at: claimedAt,
    attempts: 0,
    next_try_at: dueAt(0),
  };
  // A failed insert is tried again a few times (Codex T01-R12): null means no claim, and then nothing is written. A
  // timed-out insert that committed after all leaves a second claim, which settles on its own (it finds no entry with
  // its marker and replaces nothing, or it holds the same block id).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.from("reading_mirror_claims").insert(row);
    if (relationMissing(error)) return "missing";
    if (!error) return { claimId: row.claim_id, sessionId, bookId, blockId, replaces, claimedAt, attempts: 0 };
    console.error("reading: mirror claim not stored:", error.code ?? "unknown");
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * (attempt + 1)));
  }
  return null;
}

/**
 * The claim a keyed create stored for the session's entry (pds.create_reading_session: owes the entry on `bookId`'s
 * page, nothing replaced, no block id yet), for a caller that knows the create committed but not its answer (Onyx
 * Chat's retry of its own insert). Null when there is none; "error" when it cannot be read (the caller then writes nothing).
 */
export async function createEntryClaimOf(supabase: Supa, sessionId: number, bookId: number): Promise<string | null | "error"> {
  const { data, error } = await supabase
    .from("reading_mirror_claims")
    .select("claim_id")
    .eq("session_id", sessionId)
    .eq("book_id", bookId)
    .eq("owes_entry", true)
    .is("replaces_block_id", null)
    .is("block_id", null)
    .order("claimed_at", { ascending: true })
    .limit(1);
  // A failed lookup is not "no claim": the caller must not write an entry no claim can find (Codex review of PR 376, round 3).
  if (error || !Array.isArray(data)) return "error";
  if (data.length === 0) return null;
  const id = (data[0] as { claim_id?: unknown }).claim_id;
  return typeof id === "string" ? id : null;
}

/** The block id Notion answered, on the claim (which outlives the session). False when it could not be stored: the marker still finds the entry. */
export async function recordClaimBlock(supabase: Supa, claimId: string, blockId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.from("reading_mirror_claims").update({ block_id: blockId }).eq("claim_id", claimId);
    if (!error) return true;
    console.error("reading: mirror claim block not stored:", error.code ?? "unknown");
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * (attempt + 1)));
  }
  return false;
}

/** The claim is settled: its entry is on its session, trashed, or was never created. */
export async function dropClaim(supabase: Supa, claimId: string): Promise<boolean> {
  const { error } = await supabase.from("reading_mirror_claims").delete().eq("claim_id", claimId);
  if (error) console.error("reading: mirror claim not cleared:", error.code ?? "unknown");
  return !error;
}

/**
 * A sweep takes a due claim for itself before it settles it (Codex review of PR 376, T01-R11 round 2): one conditional
 * update moves the claim's next try out by its doubling delay (at least 15 minutes, longer than any server function
 * runs) only while the claim still has the try count this sweep read. Exactly one of two sweeps that found the same
 * claim wins; the other leaves it alone, so no sweep can write an older entry after another sweep confirmed a newer one
 * and dropped the claim. The winner's claim is already deferred: a settlement that fails (or a process that ends) needs
 * nothing more, and the claim is tried again once the delay is over. Never given up for its age.
 */
async function leaseClaim(supabase: Supa, claim: MirrorClaim): Promise<boolean> {
  const next = claim.attempts + 1;
  if (next >= LONG_OPEN_ATTEMPTS) console.error("reading: mirror claim still open after tries:", next);
  const { data, error } = await supabase
    .from("reading_mirror_claims")
    .update({ attempts: next, next_try_at: dueAt(next) })
    .eq("claim_id", claim.claimId)
    .eq("attempts", claim.attempts)
    .select("claim_id");
  if (error) console.error("reading: mirror claim not taken:", error.code ?? "unknown");
  return !error && Array.isArray(data) && data.length === 1;
}

/** No entry with the claim's marker this long after the claim: none was created (Notion's listing caught up long before). */
const CLAIM_NOT_FOUND_MS = 60 * 60_000;

/** Where an entry written by placeEntry ended up. */
export type Placement =
  /** No entry was written (no page, the mirror is off, the claim could not be stored, or Notion gave no block id:
   * an entry Notion wrote anyway is found by its marker and settled by the sweep). */
  | { kind: "none" }
  /** The entry is the session's entry now; the one it replaced is trashed (or left to the claim). */
  | { kind: "attached"; blockId: string; row: ReadingSession }
  /** Not known whether it was attached (a database error): the claim stays and the sweep settles it. */
  | { kind: "unknown"; blockId: string }
  /** The session no longer exists: the caller trashes the entry (claimId = its claim, to drop once trashed). */
  | { kind: "gone"; blockId: string; claimId: string | null }
  /** The session is on another book or already has another entry: this entry was trashed (or left to its claim). */
  | { kind: "surplus"; row: ReadingSession };

/**
 * Writes a session's entry on `book`'s page under a claim, and makes it the session's entry only while the session
 * is still on that book and its entry is still `replaces` (null = none): a conditional update, so two writers (a
 * create's callback and a move's, or two moves) never both attach, and the loser trashes its own entry. Every new
 * entry of the session routes goes through here: the create's, the create's catch-up after a move, the move's
 * (Codex review of PR 376, round 6). The entry it replaces is trashed once the new one is attached. A step that
 * cannot finish here leaves the claim, which the sweep settles.
 */
export async function placeEntry(
  supabase: Supa,
  book: Book,
  session: ReadingSession,
  replaces: string | null,
  storedClaimId: string | null = null,
): Promise<Placement> {
  if (!book.notion_page_id || !notionMirrorEnabled()) return { kind: "none" };
  // `storedClaimId` = the claim a move or a keyed create stored in its own transaction (Codex T01-R14 and its round
  // 2); otherwise one is stored now.
  const claim: MirrorClaim | "missing" | null = storedClaimId
    ? { claimId: storedClaimId, sessionId: session.session_id, bookId: book.book_id, blockId: null, replaces, claimedAt: new Date().toISOString(), attempts: 0, owesEntry: true }
    : await claimMirror(supabase, session.session_id, book.book_id, replaces);
  if (claim === null) return { kind: "none" };
  const own = claim === "missing" ? null : claim;
  const blockId = await mirrorSession(book, session, own?.claimId ?? null);
  if (!blockId) return { kind: "none" };
  const recorded = own ? await recordClaimBlock(supabase, own.claimId, blockId) : false;
  const base = supabase
    .from("reading_sessions")
    .update({ notion_block_id: blockId })
    .eq("session_id", session.session_id)
    .eq("book_id", book.book_id);
  const { data, error } = await (replaces ? base.eq("notion_block_id", replaces) : base.is("notion_block_id", null))
    .select(SESSION_COLS)
    .maybeSingle();
  if (error) return { kind: "unknown", blockId };
  const attached = async (row: ReadingSession): Promise<Placement> => {
    const oldGone = !replaces || replaces === blockId || (await trashWithRetry(replaces));
    // The autosaving forms may edit the session while its entry is written: an edit that ran before the block id was
    // stored could not update the entry, so the attached row is compared with what was written.
    const stale = sessionMirrorDiffers(session, row);
    if (!own) {
      // No claims table yet (the SQL file not applied): the catch-up is best effort, as before it.
      if (stale) await updateMirroredSession(row);
    } else if (recorded) {
      // The claim goes only once the catch-up rewrite is confirmed (Codex T01-R11, round 2): a failed or overtaken
      // rewrite keeps it, and the sweep (which then finds the session holding this entry) rewrites it again.
      const fresh = !stale || (await refreshClaimEntry(supabase, row));
      if (oldGone && fresh) await dropClaim(supabase, own.claimId);
    }
    // Block id not stored on the claim: the marker is the entry's only identity, and a rewrite now would drop it
    // (T01-R10). The claim stays; the sweep finds the entry by its marker, stores the id, then rewrites it.
    return { kind: "attached", blockId, row };
  };
  if (data) return attached(data as ReadingSession);
  const { data: cur, error: curError } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", session.session_id).maybeSingle();
  if (curError) return { kind: "unknown", blockId };
  const now = (cur as ReadingSession | null) ?? null;
  if (!now) return { kind: "gone", blockId, claimId: own?.claimId ?? null };
  // A sweep settled this claim first and put the entry on the session itself.
  if (now.notion_block_id === blockId) return attached(now);
  // An older claim's cleanup took the entry this one replaces off the session after the move committed (the session is
  // on this book with no entry): attach conditionally on that, rather than treating this entry as surplus and trashing
  // it, which would leave the session without any mirrored entry (Codex review of PR 376, round 3).
  if (replaces && now.book_id === book.book_id && now.notion_block_id === null) {
    const { data: again, error: againError } = await supabase
      .from("reading_sessions")
      .update({ notion_block_id: blockId })
      .eq("session_id", session.session_id)
      .eq("book_id", book.book_id)
      .is("notion_block_id", null)
      .select(SESSION_COLS)
      .maybeSingle();
    if (againError) return { kind: "unknown", blockId };
    if (again) return attached(again as ReadingSession);
    // Lost the race again: the session moved on; read it once more below for the surplus decision.
    const { data: latest, error: latestError } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", session.session_id).maybeSingle();
    if (latestError) return { kind: "unknown", blockId };
    const l = (latest as ReadingSession | null) ?? null;
    if (!l) return { kind: "gone", blockId, claimId: own?.claimId ?? null };
    if (l.notion_block_id === blockId) return attached(l);
    const trashedAgain = await trashWithRetry(blockId);
    if (trashedAgain && own && (await settleReplaced(supabase, own, l, blockId))) await dropClaim(supabase, own.claimId);
    return { kind: "surplus", row: l };
  }
  // Surplus: this entry is trashed, and the claim goes only once the entry it replaces (a move) is settled too
  // (settleReplaced: left alone while the session holds it on another book, where a later move's claim owns it), so a
  // claim never goes with its replaced entry still owed (Codex review of PR 376, round 2 of T01-R14).
  const trashed = await trashWithRetry(blockId);
  if (trashed && own && (await settleReplaced(supabase, own, now, blockId))) await dropClaim(supabase, own.claimId);
  return { kind: "surplus", row: now };
}

/** Trashes an entry nothing should keep, and drops its claim once the trash is confirmed (else the sweep trashes it). */
export async function discardEntry(supabase: Supa, blockId: string, claimId: string | null): Promise<boolean> {
  const trashed = await trashWithRetry(blockId);
  if (trashed && claimId) await dropClaim(supabase, claimId);
  return trashed;
}

/**
 * Takes an existing entry off its session and trashes it (a move whose new page got no entry: the old book's page
 * must not keep it). A claim on the entry is stored first, so a trash that fails, or a process that ends, leaves it
 * to the sweep; when no claim can be stored the entry stays on its session, findable, rather than being detached
 * into an entry nothing knows.
 */
export async function retireEntry(supabase: Supa, sessionId: number, oldBookId: number, blockId: string): Promise<void> {
  const claim = await claimMirror(supabase, sessionId, oldBookId, null, blockId);
  if (claim === null) return;
  const { error } = await supabase
    .from("reading_sessions")
    .update({ notion_block_id: null })
    .eq("session_id", sessionId)
    .eq("notion_block_id", blockId);
  // Not known whether it was detached: the claim settles it (the session is on another book, so it is trashed).
  if (error) return;
  await discardEntry(supabase, blockId, claim === "missing" ? null : claim.claimId);
}

/**
 * Rewrites a session's entry after an edit, as durable work (Codex T01-R11, round 2): a claim on the entry is stored
 * BEFORE the rewrite, and it goes only once the rewrite is confirmed (refreshClaimEntry: the session read again still
 * holds this entry and renders the same entry). Each writer has its own claim, so when two edits' rewrites land in
 * the wrong order, the one whose older entry landed last cannot confirm it and its claim makes the sweep rewrite the
 * entry from the session as it is then. A failed rewrite is kept the same way. `storedClaimId` = the claim the edit's
 * own transaction stored (pds.move_reading_session), so the rewrite is owed even if this never runs. Without the
 * claims table (the SQL file not applied) the rewrite is made best effort, as before it. A claim that cannot be stored
 * (claimMirror already tried a few times) means NO rewrite (Codex T01-R12): an untracked rewrite that lands after a
 * newer, confirmed one would stay in Notion with nothing left to repair it.
 */
export async function refreshEntry(supabase: Supa, session: ReadingSession, storedClaimId: string | null = null): Promise<void> {
  const blockId = session.notion_block_id;
  if (!blockId || !notionMirrorEnabled()) return;
  const claim = storedClaimId ? { claimId: storedClaimId } : await claimMirror(supabase, session.session_id, session.book_id, null, blockId);
  if (claim === "missing") {
    await updateMirroredSession(session);
    return;
  }
  if (claim === null) {
    console.error("reading: entry refresh skipped, no claim could be stored");
    return;
  }
  if (await refreshClaimEntry(supabase, session)) await dropClaim(supabase, claim.claimId);
}

/**
 * A move to a book with no Notion page (Codex T01-R14): no new entry is owed, and the session's old entry comes off
 * the old book's page under the move's stored claim (settleMirrorClaim: no page, so the replaced entry is trashed and
 * taken off the session, then the claim goes). A trash that fails leaves the claim for the sweep.
 */
export async function retireUnderClaim(supabase: Supa, sessionId: number, bookId: number, replaces: string | null, claimId: string): Promise<boolean> {
  return settleMirrorClaim(supabase, {
    claimId,
    sessionId,
    bookId,
    blockId: null,
    replaces,
    claimedAt: new Date().toISOString(),
    attempts: 0,
    owesEntry: true,
  }).catch(() => false);
}

/**
 * Brings a claim's entry up to date with its session (Codex T01-R11) and confirms it: the entry is rewritten from the
 * session, then the session is read again, and the refresh counts only when the session still holds this entry and
 * would render the same entry. An entry archived in Notion by hand counts as settled (nothing left to refresh). False
 * = the claim stays, and its next try (the session then has this entry: the already-attached branch) refreshes again.
 */
async function refreshClaimEntry(supabase: Supa, session: ReadingSession): Promise<boolean> {
  const result = await refreshMirroredSession(session);
  if (result === "archived") return true;
  if (result === "failed") return false;
  const { data, error } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", session.session_id).maybeSingle();
  if (error) return false;
  const now = (data as ReadingSession | null) ?? null;
  // Gone or holding another entry since: the next try settles the claim against that.
  if (!now || now.notion_block_id !== session.notion_block_id) return false;
  // Edited while the rewrite ran: written from an older state, so it is done again.
  return !sessionMirrorDiffers(session, now);
}

/**
 * The entry a move's claim replaces, once the claim's own entry is attached, surplus, or was never written (Codex
 * T01-R10: it is never dropped just because no new entry was found). It is trashed (confirmed) unless the session
 * still holds it. When the session holds it on the claim's book, nothing was attached over it on the new page (the
 * move's retire never ran), so it is trashed and taken off the session (conditionally); when the session holds it on
 * another book, a later move's claim owns it. True when nothing of the replaced entry is left owed.
 */
async function settleReplaced(supabase: Supa, claim: MirrorClaim, session: ReadingSession | null, ownBlock: string | null): Promise<boolean> {
  const old = claim.replaces;
  if (!old || old === ownBlock) return true;
  if (session && session.notion_block_id === old && session.book_id !== claim.bookId) return true;
  if (!(await removeMirroredBlock(old))) return false;
  if (session && session.notion_block_id === old) {
    const { error } = await supabase
      .from("reading_sessions")
      .update({ notion_block_id: null })
      .eq("session_id", session.session_id)
      .eq("book_id", claim.bookId)
      .eq("notion_block_id", old);
    if (error) return false;
  }
  return true;
}

/**
 * Settles a claim the sweep found (due, so its writer is done or gone). Its entry is the block id on the claim, else
 * the page's entry carrying the claim's marker; a block id found by the marker is stored on the claim FIRST (Codex
 * T01-R10), before anything rewrites or trashes the entry (either drops the marker), so a later try still knows it.
 * Then, with the session on the claim's book: the session has this entry: it is brought up to date (confirmed, Codex
 * T01-R11) and the entry it replaced (if any) is trashed; the session has no entry, or still the one this replaces:
 * this becomes its entry (conditionally), is brought up to date, and the replaced one is trashed. Otherwise (the
 * session is gone, on another book, or has another entry) this one is surplus: it is trashed and taken off the session
 * if it is still on it, the replaced entry is settled, and for a gone session the book's progress line is rewritten.
 * No entry found an hour after the claim: none was created. A move's or a keyed create's claim (owesEntry, stored in
 * the same transaction) then
 * writes the entry itself when the session still wants it (Codex T01-R14); otherwise the replaced entry of a move is
 * still settled before the claim goes. True when settled (the claim row is deleted); false leaves it for a later try. Exported for the tests.
 */
export async function settleMirrorClaim(supabase: Supa, claim: MirrorClaim, nowMs = Date.now()): Promise<boolean> {
  const { data: sessionRow, error: sessionError } = await supabase
    .from("reading_sessions")
    .select(SESSION_COLS)
    .eq("session_id", claim.sessionId)
    .maybeSingle();
  if (sessionError) return false;
  const session = (sessionRow as ReadingSession | null) ?? null;
  let blockId = claim.blockId;
  if (!blockId) {
    const { data: bookRow, error: bookError } = await supabase.from("books").select(BOOK_COLS).eq("book_id", claim.bookId).maybeSingle();
    if (bookError) return false;
    const book = (bookRow as Book | null) ?? null;
    const pageId = book?.notion_page_id ?? null;
    // No page: no entry can have been written; the entry a move replaced is still settled.
    if (!pageId) return (await settleReplaced(supabase, claim, session, null)) && dropClaim(supabase, claim.claimId);
    const found = await findSessionBlocksByMarker(pageId, claim.claimId);
    if (found === null) return false;
    // One entry per claim; should a retried append have made two, the one on the session wins and the rest go.
    blockId = (session?.notion_block_id && found.includes(session.notion_block_id) ? session.notion_block_id : found[0]) ?? null;
    for (const extra of found) if (extra !== blockId && !(await removeMirroredBlock(extra))) return false;
    if (!blockId) {
      if (nowMs - Date.parse(claim.claimedAt) <= CLAIM_NOT_FOUND_MS) return false;
      // A move's claim owes the session's entry on this page (Codex T01-R14): when the session still wants it (on
      // this book, with no entry or still the one this replaces), the entry is written here, under the claim's
      // marker, and settled like an entry found by it (its id stored first, then attached and refreshed, the
      // replaced one trashed). A failed write leaves the claim for a later try.
      const wanted =
        claim.owesEntry === true &&
        book !== null &&
        session !== null &&
        session.book_id === claim.bookId &&
        (session.notion_block_id === null || session.notion_block_id === claim.replaces);
      if (!wanted || !book || !session) return (await settleReplaced(supabase, claim, session, null)) && dropClaim(supabase, claim.claimId);
      blockId = await mirrorSession(book, session, claim.claimId);
      if (!blockId) return false;
    }
    // The marker is the entry's only identity until now: the id is kept before any step can drop the marker.
    if (!(await recordClaimBlock(supabase, claim.claimId, blockId))) return false;
  }
  if (session && session.book_id === claim.bookId) {
    if (session.notion_block_id === blockId) {
      // Attached earlier (by its writer or an earlier try) whose refresh may not have landed: finished here.
      if (!(await refreshClaimEntry(supabase, session))) return false;
      if (!(await settleReplaced(supabase, claim, session, blockId))) return false;
      return dropClaim(supabase, claim.claimId);
    }
    const current = session.notion_block_id;
    if (current === null || (claim.replaces !== null && current === claim.replaces)) {
      const base = supabase
        .from("reading_sessions")
        .update({ notion_block_id: blockId })
        .eq("session_id", session.session_id)
        .eq("book_id", claim.bookId);
      const { data: adopted, error } = await (current === null ? base.is("notion_block_id", null) : base.eq("notion_block_id", current))
        .select(SESSION_COLS)
        .maybeSingle();
      if (error || !adopted) return false;
      const row = adopted as ReadingSession;
      // The session may have been edited since its entry was written. A failed refresh keeps the claim: the next try
      // sees the session with this entry and refreshes again (Codex T01-R11).
      if (!(await refreshClaimEntry(supabase, row))) return false;
      // A failed trash of the replaced entry: the next try sees the session with this entry and trashes it then.
      if (!(await settleReplaced(supabase, claim, row, blockId))) return false;
      return dropClaim(supabase, claim.claimId);
    }
  }
  if (!(await removeMirroredBlock(blockId))) return false;
  if (session && session.notion_block_id === blockId) {
    const { error } = await supabase
      .from("reading_sessions")
      .update({ notion_block_id: null })
      .eq("session_id", session.session_id)
      .eq("notion_block_id", blockId);
    if (error) return false;
  }
  // The entry this one replaced (a move) is settled too before the claim goes: when its attach happened and the
  // trash of the old entry failed, the session may be gone now, and nothing else knows the old entry. It is left
  // alone while the session still holds it as its entry.
  if (claim.replaces && claim.replaces !== blockId && (!session || session.notion_block_id !== claim.replaces)) {
    if (!(await removeMirroredBlock(claim.replaces))) return false;
  }
  if (!session && !(await rewriteProgressNow(supabase, claim.bookId))) return false;
  return dropClaim(supabase, claim.claimId);
}

/**
 * A create's own Notion callback wrote an entry for a session that a removal had already taken out (review of PR 376,
 * round 3). The block id goes into the removal's cleanup row FIRST, with the cleanup reopened, so a retried removal
 * finds it; then it is trashed and the book's progress line rewritten (`rewriteProgress`, the callback's last step).
 * The row is closed only when ALL of that succeeded (Codex T01-R9): a failed record, trash or progress rewrite leaves
 * it open for the sweep, and the close is conditional on the row still recording this entry. A removal cleanup that
 * started earlier with no entry closes nothing of this work (markRemovalMirrored). The entry's claim
 * (pds.reading_mirror_claims) is the caller's to drop, and only once the trash is confirmed, so an entry that could be
 * neither recorded nor trashed is still found by the sweep, also after a restart (Codex review of PR 376, round 5).
 * Returns what happened (`complete` = every step succeeded and the close was sent), for the caller and the tests.
 */
export async function trashLateBlock(
  supabase: Supa,
  sessionId: number,
  blockId: string,
  rewriteProgress: () => Promise<boolean>,
): Promise<{ recorded: boolean; trashed: boolean; progressDone: boolean; complete: boolean }> {
  const recorded = await recordLateBlock(supabase, sessionId, blockId);
  const trashed = await trashWithRetry(blockId);
  const progressDone = await rewriteProgress().catch(() => false);
  const complete = recorded && trashed && progressDone;
  if (complete) await markRemovalMirrored(supabase, sessionId, blockId);
  // Recorded, but the progress line is neither checked nor owed anywhere: another worker may have closed the row
  // since, so it is opened again for the sweep.
  else if (recorded && !progressDone) await reopenRemovalCleanup(supabase, sessionId);
  return { recorded, trashed, progressDone, complete };
}

const RETRY_PAUSE_MS = 250;
/** A removal row a late entry was recorded on is due this soon (the same two minutes as a new removal row). */
const LATE_BLOCK_DUE_MS = 2 * 60_000;

async function recordLateBlock(supabase: Supa, sessionId: number, blockId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase
      .from("reading_session_removals")
      // New work for the row: due again soon even when a sweep had put it back by hours (Codex T01-R13).
      .update({ notion_block_id: blockId, mirror_done_at: null, next_try_at: new Date(Date.now() + LATE_BLOCK_DUE_MS).toISOString() })
      .eq("session_id", sessionId);
    if (!error) return true;
    console.error("reading: late block record failed:", error.code ?? "unknown");
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * (attempt + 1)));
  }
  return false;
}

async function trashWithRetry(blockId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await removeMirroredBlock(blockId)) return true;
    if (attempt < 2) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * (attempt + 1)));
  }
  return false;
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;
const SWEEP_LIMIT = 5;

/**
 * A sweep takes an open removal row for itself before it runs its cleanup (Codex T01-R13), like a claim (leaseClaim):
 * one conditional update moves the row's next try out by its doubling delay while it still has the try count this
 * sweep read and is still open. A cleanup that fails (an entry Notion keeps refusing, a page Onyx can no longer write)
 * therefore waits longer each time instead of being taken first by every sweep, and the rows behind it are reached.
 * The row stays open (mirror_done_at NULL) until its cleanup succeeds: nothing is given up for its age.
 */
async function leaseRemoval(supabase: Supa, sessionId: number, attempts: number): Promise<boolean> {
  const next = attempts + 1;
  if (next >= LONG_OPEN_ATTEMPTS) console.error("reading: removal cleanup still open after tries:", next);
  const { data, error } = await supabase
    .from("reading_session_removals")
    .update({ attempts: next, next_try_at: dueAt(next) })
    .eq("session_id", sessionId)
    .eq("attempts", attempts)
    .is("mirror_done_at", null)
    .select("session_id");
  if (error) console.error("reading: removal cleanup not taken:", error.code ?? "unknown");
  return !error && Array.isArray(data) && data.length === 1;
}

/**
 * Durable retry of the Notion work reading writes still owe (review of PR 376, rounds 3, 5 and 6): a removal's cleanup
 * (pds.reading_session_removals), an entry whose block id may not be stored (pds.reading_mirror_claims) and a progress
 * line that may be stale (pds.reading_progress_owed). Each is written down before or with its work, so nothing
 * depends on the client repeating a request or on the process that started it surviving. Every reading route that
 * already runs after() calls this: removal rows two minutes after they were written, claims and obligations once due
 * (retryDelayMs: never while their writer may still run), then each with a doubling delay and taken by due time, so a
 * row that keeps failing never holds back the others (Codex T01-R13); nothing is given up; at most five of each kind
 * (progress lines: five books), at most once a minute per server instance. Trashing a block twice and writing a
 * checked line twice are harmless, attaches are conditional, a claim or a removal row is handled only by the sweep that
 * took it (leaseClaim, leaseRemoval), and a sweep that writes a progress line holds its own obligation while it does, so two sweeps meeting
 * do no damage. It writes only to Notion and to these rows (and an
 * entry's block id onto its session); it never changes reading data. Never throws.
 */
export async function sweepPendingRemovals(supabase: Supa): Promise<number> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
  const nowIso = new Date(now).toISOString();
  let done = 0;
  try {
    // Open rows by their due time, never by their age (Codex T01-R13): five rows that keep failing used to be the five
    // oldest on every sweep and held back every newer removal.
    const { data, error } = await supabase
      .from("reading_session_removals")
      .select("session_id,book_id,session_date,notion_block_id,unfinished,mirror_done_at,attempts")
      .is("mirror_done_at", null)
      .lt("next_try_at", nowIso)
      .order("next_try_at", { ascending: true })
      .limit(SWEEP_LIMIT);
    for (const row of error ? [] : ((data ?? []) as Record<string, unknown>[])) {
      // Taken by another sweep that found it too: that one runs it.
      if (!(await leaseRemoval(supabase, Number(row.session_id), Number(row.attempts) || 0))) continue;
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

    if (notionMirrorEnabled()) {
      const { data: claims, error: claimsError } = await supabase
        .from("reading_mirror_claims")
        .select("claim_id,session_id,book_id,block_id,replaces_block_id,claimed_at,attempts,owes_entry")
        .lt("next_try_at", nowIso)
        .order("next_try_at", { ascending: true })
        .limit(SWEEP_LIMIT);
      for (const c of claimsError ? [] : ((claims ?? []) as Record<string, unknown>[])) {
        const claim: MirrorClaim = {
          claimId: String(c.claim_id),
          sessionId: Number(c.session_id),
          bookId: Number(c.book_id),
          blockId: typeof c.block_id === "string" && c.block_id ? c.block_id : null,
          replaces: typeof c.replaces_block_id === "string" && c.replaces_block_id ? c.replaces_block_id : null,
          claimedAt: String(c.claimed_at),
          attempts: Number(c.attempts) || 0,
          owesEntry: c.owes_entry === true,
        };
        // Taken by another sweep that found it too: that one settles it.
        if (!(await leaseClaim(supabase, claim))) continue;
        if (await settleMirrorClaim(supabase, claim, now).catch(() => false)) done++;
      }
    }

    const { data: owed, error: owedError } = await supabase
      .from("reading_progress_owed")
      .select("owed_id,book_id,attempts")
      .lt("next_try_at", nowIso)
      .order("next_try_at", { ascending: true })
      .limit(50);
    const byBook = new Map<number, { ids: string[]; attempts: number }>();
    for (const o of owedError ? [] : ((owed ?? []) as Record<string, unknown>[])) {
      const bookId = Number(o.book_id);
      const entry = byBook.get(bookId) ?? { ids: [], attempts: 0 };
      entry.ids.push(String(o.owed_id));
      entry.attempts = Math.max(entry.attempts, Number(o.attempts) || 0);
      byBook.set(bookId, entry);
    }
    // One write per book covers all of its rows; at most five books per run.
    for (const [bookId, { ids, attempts }] of [...byBook].slice(0, SWEEP_LIMIT)) {
      if (await settleProgressOwed(supabase, bookId, ids, attempts)) done++;
    }
    return done;
  } catch (e) {
    console.error("reading: removal sweep failed:", e instanceof Error ? e.name : "unknown");
    return done;
  }
}
