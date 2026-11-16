import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { HIGHLIGHT_COLS, type Highlight } from "@/lib/reading";
import { updateMirroredHighlight } from "@/lib/reading-notion";
import { HIGHLIGHT_EDIT_STEPS, kickBank } from "@/lib/reading-bank-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/** The question bank's kick (READ-QUIZ-01) runs after the response: up to 240 s of generation. */
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const SOURCES = ["manual", "kindle", "audible", "paper", "photo"];

/** PATCH /api/reading/highlights/:id — body: { passage?, comment?, concept?, chapter?, location?, source?, archived? } */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const highlight_id = Number(id);
  if (!Number.isFinite(highlight_id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if ("comment" in body) patch.comment = String(body.comment ?? "").trim() || null;
  if ("concept" in body) patch.concept = String(body.concept ?? "").trim() || null;
  if ("location" in body) patch.location = String(body.location ?? "").trim() || null;
  if ("chapter" in body) patch.chapter = body.chapter === null || body.chapter === "" ? null : Math.round(Number(body.chapter));
  if ("archived" in body) patch.archived = Boolean(body.archived);
  // The autosaving highlight form (/reading) edits the passage and source of the highlight it just created.
  if ("passage" in body) {
    const passage = typeof body.passage === "string" ? body.passage.trim() : "";
    if (!passage) return NextResponse.json({ error: "passage is required" }, { status: 400 });
    patch.passage = passage;
  }
  if ("source" in body) {
    if (typeof body.source !== "string" || !SOURCES.includes(body.source)) return NextResponse.json({ error: "bad source" }, { status: 400 });
    patch.source = body.source;
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await supabase.from("book_highlights").update(patch).eq("highlight_id", highlight_id).select(HIGHLIGHT_COLS).single();
  if (error) {
    // (book_id, passage) is unique: the same passage is already saved for this book.
    if (error.code === "23505") return NextResponse.json({ error: "That passage is already saved for this book." }, { status: 409 });
    if (error.code === "PGRST116") return NextResponse.json({ error: "That highlight no longer exists." }, { status: 404 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const h = data as Highlight;
  if (h.notion_block_id && !("archived" in patch)) after(() => updateMirroredHighlight(h));
  // The question bank (READ-QUIZ-01): an edited, moved or archived highlight changes what its ideas rest on.
  if ("passage" in patch || "chapter" in patch || "archived" in patch) kickAfter(h.book_id);
  return NextResponse.json({ success: true, highlight: h });
}

/** DELETE /api/reading/highlights/:id — soft delete (archived=true); the Notion block is left as history. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const highlight_id = Number(id);
  if (!Number.isFinite(highlight_id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const { data, error } = await supabase.from("book_highlights").update({ archived: true }).eq("highlight_id", highlight_id).select("book_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const bookId = Number((data as { book_id?: unknown }[] | null)?.[0]?.book_id);
  if (Number.isInteger(bookId) && bookId > 0) kickAfter(bookId);
  return NextResponse.json({ success: true });
}

/**
 * Plan the book's question bank after the response (lib/reading-bank-server.ts kickBank), without the highlights
 * step: the highlight form autosaves while Riley types, so that step waits for the Kindle import kick or the hourly
 * worker. Quiet while the book's bank is off or the SQL is not applied.
 */
function kickAfter(bookId: number) {
  after(async () => {
    await kickBank(supabase, { bookId, reason: "highlight", steps: HIGHLIGHT_EDIT_STEPS });
  });
}
