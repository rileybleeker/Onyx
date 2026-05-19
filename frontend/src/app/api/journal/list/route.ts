import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SNIPPET_LEN = 400;

/**
 * GET /api/journal/list
 * Query params:
 *   - from   ISO date (inclusive)
 *   - to     ISO date (inclusive)
 *   - mood   low | neutral | good | great
 *   - topic  exact topic name (matches if entry's topics JSONB array contains it)
 *   - limit  default 100, max 500
 *
 * Returns entries sorted by entry_date DESC with content truncated to SNIPPET_LEN.
 * Excludes archived rows.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const mood = params.get("mood");
  const topic = params.get("topic");
  const limit = Math.min(Number(params.get("limit") ?? "100"), 500);

  let q = supabase
    .from("journal_entries")
    .select(
      "notion_page_id, entry_date, title, mood, source, confidence, topics, content_md, word_count, notion_edited_at"
    )
    .eq("archived", false)
    .order("entry_date", { ascending: false })
    .limit(limit);

  if (from) q = q.gte("entry_date", from);
  if (to) q = q.lte("entry_date", to);
  if (mood) q = q.eq("mood", mood);
  if (topic) q = q.contains("topics", JSON.stringify([topic]));

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const entries = (data || []).map((row) => ({
    ...row,
    content_md: undefined,
    snippet: (row.content_md ?? "").slice(0, SNIPPET_LEN),
    truncated: (row.content_md ?? "").length > SNIPPET_LEN,
  }));

  return NextResponse.json({ entries });
}
