import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { chapterParam, getChapterSheet, parseBookQuery } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ n: string }> };

/**
 * GET /api/reading/bank/chapter/<n>?book=<slug>
 *
 * One chapter's sheet (pds.reading_bank_chapter): title, status, built date and prompt version, the ideas with their
 * stage (a statement only once the idea has been asked), how many sources support each, the open flags (for
 * Restore), and what a rebuild would cost (`rebuild_cents`). A chapter above the spoiler gate is 404 `locked`: its
 * ideas never leave the server. Writes nothing.
 *
 * Auth: owner session only (middleware covers /api/reading/*; NEVER add this to isCiRoute). no-store at the CDN.
 * Errors are short codes: 400 bad_book / bad_chapter, 404 book_not_found / locked, 503 bank_unavailable.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const chapter = chapterParam((await ctx.params).n);
  if (chapter === null) return NextResponse.json({ error: "bad_chapter" }, { status: 400, headers: NO_STORE });
  const q = parseBookQuery(req.nextUrl.searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400, headers: NO_STORE });
  const r = await getChapterSheet(supabase, q.slug, chapter);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
