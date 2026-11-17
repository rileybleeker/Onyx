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
  findSessionBlocksByDigest,
  mirrorProgress,
  notionMirrorEnabled,
  removeMirroredBlock,
  sessionBlockDigest,
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
 * A writer's own obligation for a book's progress line (pds.reading_progress_owed), stored BEFORE it writes. "missing"
 * = the table is not there yet (the writer then works as before the file); null = it could not be stored.
 */
async function addProgressOwed(supabase: Supa, bookId: number): Promise<string | "missing" | null> {
  const owedId = randomUUID();
  const { error } = await supabase.from("reading_progress_owed").insert({ owed_id: owedId, book_id: bookId });
  if (!error) return owedId;
  if (relationMissing(error)) return "missing";
  console.error("reading: progress obligation not stored:", error.code ?? "unknown");
  return null;
}

async function dropProgressOwed(supabase: Supa, owedIds: string[]): Promise<void> {
  if (!owedIds.length) return;
  const { error } = await supabase.from("reading_progress_owed").delete().in("owed_id", owedIds);
  // Left behind, a row only makes the sweep write a checked line once more.
  if (error) console.error("reading: progress obligation not cleared:", error.code ?? "unknown");
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
export async function rewriteProgressNow(supabase: Supa, bookId: number): Promise<boolean> {
  const owed = await addProgressOwed(supabase, bookId);
  const held = typeof owed === "string" && owed !== "missing" ? owed : null;
  const result = await writeProgressChecked(supabase, bookId).catch(() => "failed" as const);
  if (result === "verified") {
    if (held) await dropProgressOwed(supabase, [held]);
    return true;
  }
  return held !== null;
}

/** Writes the line for obligations the sweep found (one book, all stored before this write) and clears them once checked. */
async function settleProgressOwed(supabase: Supa, bookId: number, owedIds: string[]): Promise<boolean> {
  const result = await writeProgressChecked(supabase, bookId).catch(() => "failed" as const);
  if (result !== "verified") return false;
  await dropProgressOwed(supabase, owedIds);
  return true;
}

/* ---------- Notion session entries whose block id may not be stored yet (pds.reading_mirror_claims) ---------- */

export interface MirrorClaim {
  claimId: string;
  sessionId: number;
  bookId: number;
  digest: string;
  blockId: string | null;
  claimedAt: string;
}

/**
 * Stored BEFORE a create's callback writes the session's Notion entry (Codex review of PR 376, round 5): the session,
 * its book and a digest of the entry's text. The entry is created only once this claim is stored, so a removal that
 * lands while it is written is always followed by the entry's trash, even when recording the block id afterwards
 * fails or the process ends: the sweep finds the entry by the claim (settleMirrorClaim). "missing" = the table is not
 * there yet (sql/reading_session_discards.sql not applied, so no removal can run: the entry is written as before);
 * null = the claim could not be stored, and no entry is written.
 */
export async function claimMirror(supabase: Supa, session: ReadingSession): Promise<MirrorClaim | "missing" | null> {
  const row = { claim_id: randomUUID(), session_id: session.session_id, book_id: session.book_id, digest: sessionBlockDigest(session) };
  const { error } = await supabase.from("reading_mirror_claims").insert(row);
  if (relationMissing(error)) return "missing";
  if (error) {
    console.error("reading: mirror claim not stored:", error.code ?? "unknown");
    return null;
  }
  return { claimId: row.claim_id, sessionId: row.session_id, bookId: row.book_id, digest: row.digest, blockId: null, claimedAt: new Date().toISOString() };
}

/** The block id Notion answered, on the claim (which outlives the session). False when it could not be stored: the digest still finds the entry. */
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

/** A claim with no entry found this long after it was made belongs to an entry that was never created. */
const CLAIM_GIVE_UP_MS = 15 * 60_000;

/**
 * Settles a claim the sweep found (older than two minutes, so its create callback is done or gone). Its entry is the
 * block id on the claim, else the page's entry with the claim's digest created after the claim and not already the
 * entry of a session. Then: the session has this entry: nothing to do; the session exists with no entry (and on the
 * same book): the entry becomes its entry; the session has another entry, or is on another book now: this one is a
 * duplicate and is trashed; the session is gone: the entry is trashed and the book's progress line rewritten. No
 * entry found 15 minutes after the claim: none was created. True when settled (the claim row is deleted); false leaves
 * it for the next sweep. Exported for the tests.
 */
export async function settleMirrorClaim(supabase: Supa, claim: MirrorClaim, nowMs = Date.now()): Promise<boolean> {
  const { data: sessionRow, error: sessionError } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", claim.sessionId).maybeSingle();
  if (sessionError) return false;
  const session = (sessionRow as ReadingSession | null) ?? null;
  let blockId = claim.blockId;
  if (!blockId) {
    const { data: bookRow, error: bookError } = await supabase.from("books").select("book_id,notion_page_id").eq("book_id", claim.bookId).maybeSingle();
    if (bookError) return false;
    const pageId = (bookRow as { notion_page_id?: string | null } | null)?.notion_page_id ?? null;
    // No page: no entry can have been written.
    if (!pageId) return dropClaim(supabase, claim.claimId);
    const found = await findSessionBlocksByDigest(pageId, claim.digest, claim.claimedAt);
    if (found === null) return false;
    if (session?.notion_block_id && found.includes(session.notion_block_id)) return dropClaim(supabase, claim.claimId);
    let taken: string[] = [];
    if (found.length) {
      const { data: owners, error: ownersError } = await supabase.from("reading_sessions").select("notion_block_id").in("notion_block_id", found);
      if (ownersError) return false;
      taken = ((owners as Array<{ notion_block_id: string | null }> | null) ?? []).map((o) => o.notion_block_id ?? "");
    }
    blockId = found.find((id) => !taken.includes(id)) ?? null;
    if (!blockId) return nowMs - Date.parse(claim.claimedAt) > CLAIM_GIVE_UP_MS ? dropClaim(supabase, claim.claimId) : false;
  }
  if (session && session.notion_block_id === blockId) return dropClaim(supabase, claim.claimId);
  if (session && !session.notion_block_id && session.book_id === claim.bookId) {
    const { data: adopted, error } = await supabase
      .from("reading_sessions")
      .update({ notion_block_id: blockId })
      .eq("session_id", session.session_id)
      .is("notion_block_id", null)
      .select(SESSION_COLS)
      .maybeSingle();
    if (error || !adopted) return false;
    // The session may have been edited since its entry was written.
    await updateMirroredSession(adopted as ReadingSession);
    return dropClaim(supabase, claim.claimId);
  }
  if (!(await removeMirroredBlock(blockId))) return false;
  if (!session) await rewriteProgressNow(supabase, claim.bookId);
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

async function recordLateBlock(supabase: Supa, sessionId: number, blockId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase
      .from("reading_session_removals")
      .update({ notion_block_id: blockId, mirror_done_at: null })
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
const SWEEP_MIN_AGE_MS = 2 * 60_000;
const SWEEP_LIMIT = 5;
/** Claims and progress obligations still open a day later are given up (logged): a page Onyx can no longer read or
 * write (no access, no progress callout) must not keep the sweep busy, nor hold back newer work, for good. */
const GIVE_UP_MS = 24 * 60 * 60_000;

/**
 * Durable retry of the Notion work reading writes still owe (review of PR 376, rounds 3 and 5): a removal's cleanup
 * (pds.reading_session_removals), an entry whose block id may not be stored (pds.reading_mirror_claims) and a progress
 * line that may be stale (pds.reading_progress_owed). Each is written down before or with its work, so nothing
 * depends on the client repeating a request or on the process that started it surviving. Every reading route that
 * already runs after() calls this: it takes rows still open and older than two minutes (so work still running is
 * left alone), at most five of each kind (progress lines: five books), at most once a minute per server instance;
 * claims and obligations still open after a day are given up. Trashing a block twice and
 * writing a checked line twice are harmless, so two sweeps meeting do no damage. It writes only to Notion and to these
 * rows (and a found entry's block id onto its session); it never changes reading data. Never throws.
 */
export async function sweepPendingRemovals(supabase: Supa): Promise<number> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
  const cutoff = new Date(now - SWEEP_MIN_AGE_MS).toISOString();
  let done = 0;
  try {
    const { data, error } = await supabase
      .from("reading_session_removals")
      .select("session_id,book_id,session_date,notion_block_id,unfinished,mirror_done_at")
      .is("mirror_done_at", null)
      .lt("removed_at", cutoff)
      .order("removed_at", { ascending: true })
      .limit(SWEEP_LIMIT);
    for (const row of error ? [] : ((data ?? []) as Record<string, unknown>[])) {
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
        .select("claim_id,session_id,book_id,digest,block_id,claimed_at")
        .lt("claimed_at", cutoff)
        .order("claimed_at", { ascending: true })
        .limit(4 * SWEEP_LIMIT);
      let tried = 0;
      for (const c of claimsError ? [] : ((claims ?? []) as Record<string, unknown>[])) {
        if (now - Date.parse(String(c.claimed_at)) > GIVE_UP_MS) {
          console.error("reading: mirror claim given up after a day");
          await dropClaim(supabase, String(c.claim_id));
          continue;
        }
        if (tried++ >= SWEEP_LIMIT) break;
        const claim: MirrorClaim = {
          claimId: String(c.claim_id),
          sessionId: Number(c.session_id),
          bookId: Number(c.book_id),
          digest: String(c.digest),
          blockId: typeof c.block_id === "string" && c.block_id ? c.block_id : null,
          claimedAt: String(c.claimed_at),
        };
        if (await settleMirrorClaim(supabase, claim, now)) done++;
      }
    }

    const { data: owed, error: owedError } = await supabase
      .from("reading_progress_owed")
      .select("owed_id,book_id,owed_at")
      .lt("owed_at", cutoff)
      .order("owed_at", { ascending: true })
      .limit(50);
    const byBook = new Map<number, string[]>();
    const givenUp: string[] = [];
    for (const o of owedError ? [] : ((owed ?? []) as Record<string, unknown>[])) {
      if (now - Date.parse(String(o.owed_at)) > GIVE_UP_MS) {
        givenUp.push(String(o.owed_id));
        continue;
      }
      const bookId = Number(o.book_id);
      byBook.set(bookId, [...(byBook.get(bookId) ?? []), String(o.owed_id)]);
    }
    if (givenUp.length) {
      console.error("reading: progress obligations given up after a day:", givenUp.length);
      await dropProgressOwed(supabase, givenUp);
    }
    // One write per book covers all of its rows; at most five books per run.
    for (const [bookId, ids] of [...byBook].slice(0, SWEEP_LIMIT)) if (await settleProgressOwed(supabase, bookId, ids)) done++;
    return done;
  } catch (e) {
    console.error("reading: removal sweep failed:", e instanceof Error ? e.name : "unknown");
    return done;
  }
}
