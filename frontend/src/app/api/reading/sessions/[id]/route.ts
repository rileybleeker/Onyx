import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { deleteSession, getOverview, parseSessionUpdate, updateSession, type Book, type ReadingOverview } from "@/lib/reading";
import { mirrorProgress, mirrorSession, removeMirroredBlock, updateMirroredSession } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * PATCH  /api/reading/sessions/[id]  Body: { chapter_through, chapter_from?, minutes?, medium?, recall?, question?,
 *                                            date?, book? }   (date / book absent or null = keep the session's own)
 * DELETE /api/reading/sessions/[id]
 *
 * The autosaving session forms (/log Reading, /reading "Log a session") create a session with POST
 * /api/reading/sessions, then send every later edit of the same form here (lib/reading.ts updateSession: the same
 * rules as logSession; Kindle sessions are refused with 409), and "Remove this session" deletes it (deleteSession).
 * The Notion quote block follows best-effort after the response (updated in place, moved to the other book's page,
 * or trashed), and the progress callout is rewritten.
 * Auth: owner session only (middleware; NOT in isCiRoute), plus a same-origin check, JSON only and a size cap.
 * Answers: 200 { success, session, xp_gained, finished, overview } / { success, removed, unfinished, overview },
 * 400 with the reason, 404 for a session that no longer exists, 409 for a Kindle session.
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

function newestDate(o: ReadingOverview | null, fallback: string | null): string | null {
  return o?.sessions?.[0]?.session_date ?? fallback;
}

async function refreshProgress(book: Book, fallbackDate: string | null): Promise<void> {
  const o = await getOverview(supabase, book.slug).catch(() => null);
  await mirrorProgress(book, o?.chaptersDone ?? 0, newestDate(o, fallbackDate));
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
    if (r.book.book_id !== r.previousBook.book_id) {
      // Moved to another book: its entry belongs on that book's page.
      await removeMirroredBlock(r.previous.notion_block_id);
      const blockId = await mirrorSession(r.book, r.session);
      await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", id);
      await refreshProgress(r.previousBook, null);
    } else if (r.session.notion_block_id) {
      await updateMirroredSession(r.session);
    }
    await mirrorProgress(r.book, overview?.chaptersDone ?? r.session.chapter_through ?? 0, newestDate(overview, r.session.session_date));
  });

  return NextResponse.json({ success: true, session: r.session, xp_gained: r.xpGained, finished: r.finished, habit_marked: r.habitMarked, overview });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const refused = originRefused(req);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  const id = sessionIdOf((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const r = await deleteSession(supabase, id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const overview = await getOverview(supabase, r.book.slug).catch(() => null);

  after(async () => {
    await removeMirroredBlock(r.session.notion_block_id);
    await mirrorProgress(r.book, overview?.chaptersDone ?? 0, newestDate(overview, null));
  });

  return NextResponse.json({ success: true, removed: r.session.session_id, unfinished: r.unfinished, overview });
}
