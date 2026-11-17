import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BOOK_COLS, deleteSessionByClientKey, getOverview, logSession, type Book, type Medium } from "@/lib/reading";
import { discardEntry, dropClaim, placeEntry, removalAnswer, rewriteProgressNow, runRemovalCleanup, sweepPendingRemovals, trashLateBlock } from "@/lib/reading-removal";

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
 * A key whose entry was discarded (DELETE below) answers 409 `discarded`.
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

  // A retried create (same client_key): the first request made the session, and its transaction stored the Notion
  // work it owes (pds.create_reading_session: the entry's claim and the progress obligation; Codex review of PR 376,
  // round 2 of T01-R14). When that request's answer was lost before its own Notion step ran, the sweep finishes it:
  // the claim's entry once no entry with its marker exists an hour on, the line once its obligation is due. The replay
  // writes nothing itself, so it never races the first request's callback.
  if (!result.replayed) after(async () => {
    const id = result.session.session_id;
    // Under the obligation the create stored (keyed creates); a keyless create stores its own first.
    const rewriteProgress = () => rewriteProgressNow(supabase, result.book.book_id, result.progressOwedId);
    // Set when a removal ran meanwhile: trashLateBlock then owns the progress rewrite too, and closes the removal's
    // cleanup row only once the trash AND the rewrite succeeded (Codex T01-R9).
    let progressHandled = false;
    // The entry is written under a claim stored BEFORE it is created (Codex review of PR 376, rounds 5 and 6), and
    // attached only while the session is still on this book with no entry (lib/reading-removal.ts placeEntry): an
    // entry whose block id cannot be recorded afterwards (a removal landed, then the database or this process failed)
    // is still found by its marker and settled by the sweep. No claim stored, no entry.
    // An edit that ran while the entry was written is caught up inside placeEntry, under the entry's claim (the claim
    // goes only once that rewrite is confirmed, Codex T01-R11 round 2).
    // A keyed create's entry is written under the claim its transaction stored (result.mirrorClaimId).
    const placed = await placeEntry(supabase, result.book, result.session, null, result.mirrorClaimId);
    if (placed.kind === "gone") {
      // A removal that ran meanwhile found no block id in its cleanup row: record this one there first (so a retried
      // removal owes it), then trash it and rewrite the progress line. The claim goes only once the entry is trashed.
      const late = await trashLateBlock(supabase, id, placed.blockId, rewriteProgress);
      progressHandled = true;
      if (placed.claimId && late.trashed) await dropClaim(supabase, placed.claimId);
    } else if (placed.kind === "surplus" && placed.row.book_id !== result.book.book_id && !placed.row.notion_block_id) {
      // Moved to another book while the entry was written (this one, on the old page, is trashed) and that move left
      // no entry: the session gets one on its new book's page, through the same claim and conditional attach (a move
      // still writing its own entry and this one never both attach).
      const { data: other } = await supabase.from("books").select(BOOK_COLS).eq("book_id", placed.row.book_id).maybeSingle();
      if (other) {
        const moved = await placeEntry(supabase, other as Book, placed.row, null);
        if (moved.kind === "gone") await discardEntry(supabase, moved.blockId, moved.claimId);
      }
    }
    // "none" with a claim: either no entry was written (the sweep drops the claim once no entry with its marker shows
    // up) or Notion wrote one and its answer was lost (the sweep finds it by the marker). "unknown": the claim stays.
    // The progress line is written from the database as it is NOW, not from the values this request saw: a removal
    // or an edit that ran during the mirroring above has changed them (review of PR 376, round 3).
    if (!progressHandled) await rewriteProgress();
    await sweepPendingRemovals(supabase);
  });

  // The question bank (READ-QUIZ-01): a chapter Riley logged through may now be quizzable; plan and build after the
  // response (a replayed create changed nothing).
  if (!result.replayed) {
    const bookId = result.book.book_id;
    after(async () => {
      const { kickBank } = await import("@/lib/reading-bank-server"); // inside after(): keeps the SDK graph out of the cold start
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
  const answer = await removalAnswer(supabase, r);
  const { overview, removedId } = answer;
  after(async () => {
    if (answer.owed) await runRemovalCleanup(supabase, r, answer);
    await sweepPendingRemovals(supabase);
  });

  return NextResponse.json({ ...receipt, removed: removedId, unfinished: r.unfinished, overview });
}
