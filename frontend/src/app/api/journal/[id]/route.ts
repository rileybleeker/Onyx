import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

/**
 * GET /api/journal/[id]
 * Returns the full entry (including content_md) for a single notion_page_id.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { data, error } = await supabase
    .from("journal_entries")
    .select(
      "notion_page_id, entry_date, title, mood, source, confidence, topics, content_md, word_count, notion_created_at, notion_edited_at"
    )
    .eq("notion_page_id", id)
    .eq("archived", false)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ entry: data });
}
