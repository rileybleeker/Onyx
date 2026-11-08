import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { listBooks } from "@/lib/reading";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** GET /api/reading/books */
export async function GET() {
  try {
    return NextResponse.json({ books: await listBooks(supabase) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

/**
 * POST /api/reading/books
 * Body: { title, author?, total_chapters?, start_date?, target_date?, slug?, habit_name?, notion_page_id? }
 * Creates a book in 'reading' status. Any other 'reading' book is left as-is;
 * /reading shows the most recently created one by default.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const slug =
    String(body.slug ?? "").trim() ||
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const row = {
    slug,
    title,
    author: (body.author as string)?.trim() || null,
    total_chapters: body.total_chapters ? Math.round(Number(body.total_chapters)) : null,
    start_date: (body.start_date as string) || null,
    target_date: (body.target_date as string) || null,
    habit_name: (body.habit_name as string)?.trim() || null,
    notion_page_id: (body.notion_page_id as string)?.trim() || null,
    status: "reading",
  };
  const { data, error } = await supabase.from("books").insert(row).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, book: data });
}
