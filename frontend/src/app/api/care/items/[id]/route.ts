import { NextRequest } from "next/server";
import { CARE_COLUMNS, MAX_ITEM_BODY_BYTES, parseCarePatch, parseItemId, rowToItem, toColumns } from "@/lib/care-items";
import { careDb, careJson, readCareBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/care/items/[id]: change or remove one care item. Owner session only (middleware; not in
// the CI-token carve-out). Same-origin, JSON, small body.
//   PATCH  body = one or more of {title, kind, due, time, tz, months, booked, notes, archived,
//          completedOn}; {removed: false} brings back a removed item (Undo).           -> {item}
//   DELETE marks the item removed (removed_at); the row stays, so Undo can restore it.  -> {id}
// 404 for an id that does not exist (or is removed, unless the PATCH restores it).

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = parseItemId((await params).id);
  if (!id) return careJson({ error: "invalid item id" }, 400);
  const read = await readCareBody(req, req.nextUrl.origin, MAX_ITEM_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseCarePatch(read.body);
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);

  let query = careDb().from("care_items")
    .update({ ...toColumns(parsed.patch), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (parsed.patch.removed !== false) query = query.is("removed_at", null);
  const { data, error } = await query.select(CARE_COLUMNS);
  if (error) {
    console.error("care item update failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  if (!data?.length) return careJson({ error: "item not found" }, 404);
  const item = rowToItem(data[0]);
  return item ? careJson({ item }) : careJson({ error: "could not save" }, 500);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const id = parseItemId((await params).id);
  if (!id) return careJson({ error: "invalid item id" }, 400);
  const read = await readCareBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;

  const now = new Date().toISOString();
  const { data, error } = await careDb().from("care_items")
    .update({ removed_at: now, updated_at: now })
    .eq("id", id)
    .is("removed_at", null)
    .select("id");
  if (error) {
    console.error("care item remove failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  if (!data?.length) return careJson({ error: "item not found" }, 404);
  return careJson({ id });
}
