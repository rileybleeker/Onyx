import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOverview, logSession, type Medium } from "@/lib/reading";
import { mirrorProgress, mirrorSession } from "@/lib/reading-notion";

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
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const overview = await getOverview(supabase, result.book.slug).catch(() => null);

  after(async () => {
    const blockId = await mirrorSession(result.book, result.session);
    if (blockId) await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", result.session.session_id);
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
    overview,
  });
}
