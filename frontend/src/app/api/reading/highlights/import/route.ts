import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { addHighlight, getBook, type Book, type Highlight, type HighlightSource } from "@/lib/reading";
import {
  chapterAt,
  loadChapters,
  syncKindleSessions,
  updateReadingPosition,
  upsertChapters,
  type ChapterInput,
  type KindleSyncResult,
} from "@/lib/reading-kindle";
import { parseKindleExport, type ParsedHighlight } from "@/lib/kindle-import";
import { mirrorHighlight, mirrorProgress, mirrorSession, updateMirroredSession } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

interface ImportItem {
  passage?: string;
  comment?: string | null;
  chapter?: number | null;
  location?: string | null;
  /** Kindle position span + print page + timestamps (harvester only). */
  position?: number | null;
  position_end?: number | null;
  page?: number | null;
  highlighted_at?: string | null;
  note_at?: string | null;
}

interface ImportBody {
  book?: string;
  text?: string;
  items?: ImportItem[];
  dry_run?: boolean;
  source?: string;
  /** Set by tools/kindle_harvest/harvest.mjs: write a pds.sync_log heartbeat (source='kindle'). */
  harvest?: boolean;
  /** Harvester-reported failure (e.g. Amazon session expired) → failed heartbeat, nothing imported. */
  error?: string;
  /** Harvester-only book facts: Kindle ASIN, Whispersync position, book length, chapter → position map. */
  asin?: string | null;
  last_position?: number | null;
  total_positions?: number | null;
  chapters?: ChapterInput[];
}

type Row = ParsedHighlight & Pick<ImportItem, "position" | "position_end" | "page" | "highlighted_at" | "note_at">;

const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * POST /api/reading/highlights/import
 *
 * Input shapes:
 *   { text }   — paste of the Kindle app's "Export notebook" HTML, My Clippings.txt, or a plain
 *                blank-line list (parsed by lib/kindle-import.ts)
 *   { items }  — structured rows [{ passage, comment?, chapter?, location?, position?, … }] from
 *                the local Kindle harvester (tools/kindle_harvest), plus optional book facts
 *                (`chapters`, `last_position`, `total_positions`, `asin`).
 *
 * Rows are upserted on (book, passage): re-importing is a no-op apart from new notes/positions.
 * When positions are present (harvester runs) the route then recomputes the book's Kindle-derived
 * sessions (lib/reading-kindle.ts:syncKindleSessions): a highlight on a chapter's last page
 * completes the chapter, any new note makes a session for that day with the notes as recall.
 * New highlights and new/changed sessions are mirrored to Notion after the response.
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

  let book: Book | null = await getBook(supabase, body.book || null);
  if (!book) {
    if (body.harvest) await heartbeat(startedAt, "failed", 0, `No Onyx book matches slug '${body.book ?? ""}'`);
    return NextResponse.json({ error: "No active book" }, { status: 404 });
  }

  let parsed: { format: string; items: Row[] };
  if (Array.isArray(body.items)) {
    parsed = {
      format: "structured",
      items: body.items
        .map((i) => ({
          passage: String(i.passage ?? "").trim(),
          comment: i.comment ? String(i.comment).trim() : null,
          chapter: i.chapter != null && Number.isFinite(Number(i.chapter)) ? Math.round(Number(i.chapter)) : null,
          location: i.location ? String(i.location).trim() : null,
          position: num(i.position),
          position_end: num(i.position_end),
          page: num(i.page),
          highlighted_at: iso(i.highlighted_at),
          note_at: iso(i.note_at),
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

  const errors: string[] = [];

  // Book facts first (chapter map + position), so highlights can be tagged with their chapter.
  let chaptersUpserted = 0;
  if (Array.isArray(body.chapters) && body.chapters.length) {
    try {
      chaptersUpserted = await upsertChapters(supabase, book, body.chapters);
    } catch (e) {
      errors.push(`chapters: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let positionAdvanced = false;
  if (body.asin != null || body.last_position != null || body.total_positions != null) {
    try {
      const r = await updateReadingPosition(supabase, book, {
        asin: body.asin ?? null,
        last_position: num(body.last_position),
        total_positions: num(body.total_positions),
      });
      book = r.book;
      positionAdvanced = r.advanced;
    } catch (e) {
      errors.push(`position: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const hasPositions = parsed.items.some((i) => i.position != null);
  const chapters = hasPositions || positionAdvanced ? await loadChapters(supabase, book.book_id).catch(() => []) : [];

  let created = 0;
  let updated = 0;
  const toMirror: Highlight[] = [];
  for (const item of parsed.items) {
    const r = await addHighlight(supabase, {
      book_id: book.book_id,
      passage: item.passage,
      comment: item.comment,
      chapter: item.chapter ?? chapterAt(chapters, item.position)?.chapter ?? null,
      location: item.location,
      source,
      position: item.position,
      position_end: item.position_end,
      page: item.page,
      highlighted_at: item.highlighted_at,
      note_at: item.note_at,
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

  // Kindle-derived sessions (only when the import carried Kindle evidence).
  let sync: KindleSyncResult | null = null;
  if (hasPositions || positionAdvanced || chaptersUpserted) {
    try {
      sync = await syncKindleSessions(supabase, book);
    } catch (e) {
      errors.push(`sessions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (toMirror.length || sync?.created.length || sync?.updated.length) {
    const b = book;
    const s = sync;
    after(async () => {
      for (const h of toMirror) {
        const blockId = await mirrorHighlight(b, h);
        if (blockId) await supabase.from("book_highlights").update({ notion_block_id: blockId }).eq("highlight_id", h.highlight_id);
      }
      if (s) {
        for (const sess of s.created) {
          const blockId = await mirrorSession(b, sess);
          if (blockId) await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", sess.session_id);
        }
        for (const sess of s.updated) {
          if (sess.notion_block_id) await updateMirroredSession(sess);
          else {
            const blockId = await mirrorSession(b, sess);
            if (blockId) await supabase.from("reading_sessions").update({ notion_block_id: blockId }).eq("session_id", sess.session_id);
          }
        }
        if (s.created.length || s.updated.length) {
          const last = [...s.created, ...s.updated].map((x) => x.session_date).sort().pop() ?? null;
          await mirrorProgress(b, s.chaptersDone, last);
        }
      }
    });
  }

  if (body.harvest) {
    await heartbeat(
      startedAt,
      errors.length ? "partial" : "success",
      created + (sync?.created.length ?? 0),
      errors.length ? `${errors.length} problem(s): ${errors[0]}` : null,
    );
  }

  return NextResponse.json({
    format: parsed.format,
    parsed: parsed.items.length,
    created,
    updated,
    chapters_upserted: chaptersUpserted,
    position: { last_position: book.last_position, advanced: positionAdvanced },
    sessions: sync
      ? { created: sync.created.length, updated: sync.updated.length, unchanged: sync.unchanged, chapters_done: sync.chaptersDone, finished: sync.finished, skipped: sync.skipped ?? null }
      : null,
    errors: errors.slice(0, 10),
  });
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
