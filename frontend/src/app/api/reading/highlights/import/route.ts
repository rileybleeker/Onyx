import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { addHighlight, getBook } from "@/lib/reading";
import { parseKindleExport } from "@/lib/kindle-import";
import { mirrorHighlight } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/reading/highlights/import
 * Body: { book?: slug, text: string, dry_run?: boolean, source?: 'kindle'|'paper'|'manual' }
 *
 * Paste the Kindle app's "Export notebook" HTML (or My Clippings.txt, or a
 * plain blank-line-separated list) and get the parsed highlights. dry_run
 * returns the parse only; otherwise rows are upserted on (book, passage) —
 * re-importing the same export is a no-op apart from new notes. Each NEW
 * highlight is mirrored to Notion after the response.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { book?: string; text?: string; dry_run?: boolean; source?: string };
  const text = String(body.text ?? "");
  if (text.length > 2_000_000) return NextResponse.json({ error: "text too large" }, { status: 413 });
  const book = await getBook(supabase, body.book || null);
  if (!book) return NextResponse.json({ error: "No active book" }, { status: 404 });

  const parsed = parseKindleExport(text);
  if (body.dry_run) return NextResponse.json({ format: parsed.format, count: parsed.items.length, items: parsed.items.slice(0, 200) });

  const source = body.source === "paper" || body.source === "manual" ? body.source : parsed.format === "plain" ? "manual" : "kindle";
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  const toMirror: Parameters<typeof mirrorHighlight>[1][] = [];
  for (const item of parsed.items) {
    const r = await addHighlight(supabase, { book_id: book.book_id, passage: item.passage, comment: item.comment, chapter: item.chapter, location: item.location, source });
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    if (r.created) {
      created += 1;
      toMirror.push(r.highlight);
    } else updated += 1;
  }

  if (toMirror.length) {
    after(async () => {
      for (const h of toMirror) {
        const blockId = await mirrorHighlight(book, h);
        if (blockId) await supabase.from("book_highlights").update({ notion_block_id: blockId }).eq("highlight_id", h.highlight_id);
      }
    });
  }

  return NextResponse.json({ format: parsed.format, parsed: parsed.items.length, created, updated, errors: errors.slice(0, 10) });
}
