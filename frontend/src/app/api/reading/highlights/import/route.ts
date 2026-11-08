import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { addHighlight, getBook, type Highlight, type HighlightSource } from "@/lib/reading";
import { parseKindleExport, type ParsedHighlight } from "@/lib/kindle-import";
import { mirrorHighlight } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

interface ImportBody {
  book?: string;
  text?: string;
  items?: Array<{ passage?: string; comment?: string | null; chapter?: number | null; location?: string | null }>;
  dry_run?: boolean;
  source?: string;
  /** Set by tools/kindle_harvest/harvest.mjs: write a pds.sync_log heartbeat (source='kindle'). */
  harvest?: boolean;
  /** Harvester-reported failure (e.g. Amazon session expired) → failed heartbeat, nothing imported. */
  error?: string;
}

/**
 * POST /api/reading/highlights/import
 *
 * Two input shapes:
 *   { text }   — paste of the Kindle app's "Export notebook" HTML, My Clippings.txt, or a plain
 *                blank-line list (parsed by lib/kindle-import.ts)
 *   { items }  — already-structured rows [{ passage, comment?, chapter?, location? }] from the
 *                local Kindle Notebook harvester (tools/kindle_harvest)
 *
 * Rows are upserted on (book, passage): re-importing the same export is a no-op apart from new
 * notes. Each NEW highlight is mirrored to Notion after the response. `dry_run` parses only.
 *
 * Auth: a browser session, or the `x-onyx-ci-token` header (middleware carve-out shared with
 * /api/habits) — the harvester has no session. When `harvest` is set the route also writes a
 * heartbeat to pds.sync_log (`kindle|highlights`) on success AND failure so /status can show the
 * Kindle card (every pipeline that writes to Supabase heartbeats, per CLAUDE.md).
 */
export async function POST(req: NextRequest) {
  const startedAt = new Date();
  const body = (await req.json().catch(() => ({}))) as ImportBody;

  if (body.harvest && body.error) {
    await heartbeat(startedAt, "failed", 0, String(body.error).slice(0, 500));
    return NextResponse.json({ heartbeat: "failed", error: body.error });
  }

  const text = String(body.text ?? "");
  if (text.length > 2_000_000) return NextResponse.json({ error: "text too large" }, { status: 413 });

  const book = await getBook(supabase, body.book || null);
  if (!book) {
    if (body.harvest) await heartbeat(startedAt, "failed", 0, `No Onyx book matches slug '${body.book ?? ""}'`);
    return NextResponse.json({ error: "No active book" }, { status: 404 });
  }

  let parsed: { format: string; items: ParsedHighlight[] };
  if (Array.isArray(body.items)) {
    parsed = {
      format: "structured",
      items: body.items
        .map((i) => ({
          passage: String(i.passage ?? "").trim(),
          comment: i.comment ? String(i.comment).trim() : null,
          chapter: i.chapter != null && Number.isFinite(Number(i.chapter)) ? Math.round(Number(i.chapter)) : null,
          location: i.location ? String(i.location).trim() : null,
        }))
        .filter((i) => i.passage.length >= 3),
    };
  } else {
    parsed = parseKindleExport(text);
  }

  if (body.dry_run) return NextResponse.json({ format: parsed.format, count: parsed.items.length, items: parsed.items.slice(0, 200) });

  const source: HighlightSource =
    body.source === "paper" || body.source === "manual" || body.source === "kindle" || body.source === "audible" || body.source === "photo"
      ? body.source
      : parsed.format === "plain"
        ? "manual"
        : "kindle";

  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  const toMirror: Highlight[] = [];
  for (const item of parsed.items) {
    const r = await addHighlight(supabase, {
      book_id: book.book_id,
      passage: item.passage,
      comment: item.comment,
      chapter: item.chapter,
      location: item.location,
      source,
    });
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

  if (body.harvest) {
    await heartbeat(
      startedAt,
      errors.length ? "partial" : "success",
      created,
      errors.length ? `${errors.length} rows failed: ${errors[0]}` : null,
    );
  }

  return NextResponse.json({ format: parsed.format, parsed: parsed.items.length, created, updated, errors: errors.slice(0, 10) });
}

async function heartbeat(startedAt: Date, status: "success" | "partial" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: "kindle",
    data_type: "highlights",
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    status,
    records_synced: records,
    error_message: error,
    duration_seconds: (end.getTime() - startedAt.getTime()) / 1000,
  });
  if (e) console.error("kindle heartbeat failed:", e.message);
}
