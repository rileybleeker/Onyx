import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Highlight } from "@/lib/reading";
import { updateMirroredHighlight } from "@/lib/reading-notion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/reading/highlights/:id — body: { comment?, concept?, chapter?, location?, archived? } */
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
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await supabase.from("book_highlights").update(patch).eq("highlight_id", highlight_id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const h = data as Highlight;
  if (h.notion_block_id && !("archived" in patch)) after(() => updateMirroredHighlight(h));
  return NextResponse.json({ success: true, highlight: h });
}

/** DELETE /api/reading/highlights/:id — soft delete (archived=true); the Notion block is left as history. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const highlight_id = Number(id);
  if (!Number.isFinite(highlight_id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const { error } = await supabase.from("book_highlights").update({ archived: true }).eq("highlight_id", highlight_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
