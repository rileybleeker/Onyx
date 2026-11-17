import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { deleteSession, getOverview, parseSessionUpdate, updateSession, ymdOrNull } from "@/lib/reading";
import {
  discardEntry,
  placeEntry,
  refreshEntry,
  removalAnswer,
  retireEntry,
  retireUnderClaim,
  rewriteProgressNow,
  runRemovalCleanup,
  sweepPendingRemovals,
} from "@/lib/reading-removal";
import { notionMirrorEnabled } from "@/lib/reading-notion";
import { SESSION_GONE_CODE } from "@/lib/reading-removal-receipt";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * PATCH  /api/reading/sessions/[id]  Body: { chapter_through, chapter_from?, minutes?, medium?, recall?, question?,
 *                                            date?, book?, habit_created_on? }   (date / book absent or null = keep)
 * DELETE /api/reading/sessions/[id]?habit_created_on=YYYY-MM-DD
 *
 * The autosaving session forms (/log Reading, /reading "Log a session") create a session with POST
 * /api/reading/sessions, then send every later edit of the same form here (lib/reading.ts updateSession: the same
 * rules as logSession; Kindle sessions are refused with 409), and "Remove this session" deletes it (deleteSession).
 * An edit or removal undoes what the session's earlier values did: a finish it caused goes back to reading when no
 * other session reaches the last chapter, and the habit Yes reading made is taken back from a day it leaves when no
 * other session is on that day (the habit row's own record in the database, else `habit_created_on`, reported by the
 * create and by every edit and sent back by the form, for a session stamped before that record existed).
 * The Notion quote block follows best-effort after the response (updated in place, moved to the other book's page,
 * or trashed), and the progress callout is rewritten.
 * Auth: owner session only (middleware; NOT in isCiRoute), plus a same-origin check, JSON only and a size cap.
 * Answers: 200 { success, session, xp_gained, finished, overview } / { success, removed: id, unfinished, overview },
 * 400 with the reason, 404 { error, code: "session_gone" } for a session that no longer exists (and no removal of it
 * on record; the form takes a removal as done only on that 200 for its id or this 404, Codex T01-R8), 409 for a Kindle
 * session, 503 while sql/reading_session_discards.sql is not applied (a removal, or an edit that moves the session to
 * another day or book: nothing changed; the form retries).
 */

const MAX_BYTES = 48 * 1024;
type Ctx = { params: Promise<{ id: string }> };

function sessionIdOf(raw: string): number | null {
  if (!/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
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

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, MAX_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  const id = sessionIdOf((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseSessionUpdate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const r = await updateSession(supabase, id, parsed.input);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const overview = await getOverview(supabase, r.book.slug).catch(() => null);

  after(async () => {
    const movedBook = r.book.book_id !== r.previousBook.book_id;
    const old = r.previous.notion_block_id ?? null;
    if (r.mirrorStored) {
      // The Notion work this edit owes was stored in the edit's own transaction (pds.move_reading_session; Codex
      // T01-R12, T01-R14): the claim and the progress obligations below are already durable, so a step that fails
      // here, or this callback never running (the RPC's answer lost), leaves them to the sweep.
      if (movedBook && r.mirrorClaimId) {
        // Moved to another book: the new entry is written under the move's claim and attached only while the session
        // is still on that book with its old entry (or none), then the old entry is trashed (placeEntry). An edit
        // that ran while the entry was written is caught up under the same claim, which goes only once that rewrite
        // is confirmed (Codex T01-R11, round 2). A failed write keeps the claim: the sweep writes the entry.
        const placed = await placeEntry(supabase, r.book, r.session, old, r.mirrorClaimId);
        // Removed meanwhile: its removal's cleanup row holds the old entry; the new one is trashed here (or by its claim).
        if (placed.kind === "gone") await discardEntry(supabase, placed.blockId, placed.claimId);
        // The new book has no page: no entry is owed there, and the old one comes off the old book's page.
        else if (placed.kind === "none" && !r.book.notion_page_id && notionMirrorEnabled()) {
          await retireUnderClaim(supabase, id, r.book.book_id, old, r.mirrorClaimId);
        }
      } else if (!movedBook && r.mirrorClaimId && r.session.notion_block_id) {
        // Under the claim the edit stored until the rewrite is confirmed (refreshEntry; Codex T01-R11, round 2).
        await refreshEntry(supabase, r.session, r.mirrorClaimId);
      }
      // r.entryPending: a move's claim still owes the session's entry (the replay of a move whose answer was lost):
      // that claim writes it from the session as it is then, so the old book's entry is not rewritten here.
      // Each line from the database as it is at write time and checked, under the obligation the edit stored.
      for (const o of r.progressOwed) await rewriteProgressNow(supabase, o.bookId, o.owedId);
    } else {
      // sql/reading_session_discards.sql not applied (an edit that keeps the day and the book only): as before it.
      if (movedBook) {
        const placed = await placeEntry(supabase, r.book, r.session, old);
        if (placed.kind === "gone") await discardEntry(supabase, placed.blockId, placed.claimId);
        else if (placed.kind === "none" && old) await retireEntry(supabase, id, r.previousBook.book_id, old);
        await rewriteProgressNow(supabase, r.previousBook.book_id);
      } else if (r.session.notion_block_id) {
        await refreshEntry(supabase, r.session);
      }
      // Written from the database as it is at write time and checked, with its own obligation until then (Codex
      // review of PR 376, round 5): a line from the overview this request saw could land after a newer, checked one.
      await rewriteProgressNow(supabase, r.book.book_id);
    }
    await sweepPendingRemovals(supabase);
  });

  return NextResponse.json({
    success: true,
    session: r.session,
    xp_gained: r.xpGained,
    finished: r.finished,
    unfinished: r.unfinished,
    habit_marked: r.habitMarked,
    habit_created_on: r.habitCreatedOn,
    overview,
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const refused = originRefused(req);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  const id = sessionIdOf((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const habitCreatedOn = ymdOrNull(req.nextUrl.searchParams.get("habit_created_on"));
  if (habitCreatedOn === undefined) return NextResponse.json({ error: "habit_created_on must be YYYY-MM-DD" }, { status: 400 });

  // One transaction (lib/reading.ts deleteSession): the delete, the finish and habit Yes taken back, and the Notion
  // cleanup still owed. A retry of a removal whose answer was lost finds the session gone and gets that cleanup back,
  // so the entry is still trashed (Codex review of PR 376); the database part is never repeated.
  const r = await deleteSession(supabase, id, habitCreatedOn);
  // Only the database's own "no such session, none of it on record" carries the code, so the form can tell it from
  // any other 404 (a missing book, where the session is still stored, or another page), which never counts as a
  // removal (Codex T01-R8).
  if (!r.ok) return NextResponse.json(r.gone ? { error: r.error, code: SESSION_GONE_CODE } : { error: r.error }, { status: r.status });
  const answer = await removalAnswer(supabase, r);
  const { overview, removedId } = answer;
  after(async () => {
    if (answer.owed) await runRemovalCleanup(supabase, r, answer);
    await sweepPendingRemovals(supabase);
  });

  return NextResponse.json({
    success: true,
    removed: removedId,
    unfinished: r.unfinished,
    habit_removed: r.removed ? r.habitRemoved : false,
    overview,
  });
}
