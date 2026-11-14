import { NextRequest } from "next/server";
import { CARE_COLUMNS, MAX_CARE_ITEMS, MAX_ITEM_BODY_BYTES, parseCareItem, rowToItem, toColumns } from "@/lib/care-items";
import { careDb, careJson, liveCareCount, loadCareItems, readCareBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/care/items: the care items shown on /health (pds.care_items, service-role only).
// Owner session only: middleware is the gate and this path is not in its CI-token carve-out.
//   GET   -> {items}                      every item that has not been removed
//   POST  -> {item}   body = a whole item (the browser picks the UUID, so a retried POST of the
//                     same item answers with the stored row instead of adding a second one)
// Errors never carry item text; logs carry a database error code only.

export async function GET() {
  const data = await loadCareItems();
  if (data.state === "error") return careJson({ error: "care items unavailable" }, 500);
  return careJson({ items: data.items });
}

export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, MAX_ITEM_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseCareItem(read.body);
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);

  const live = await liveCareCount();
  if (live === null) return careJson({ error: "could not save" }, 500);
  if (live >= MAX_CARE_ITEMS) return careJson({ error: `limit of ${MAX_CARE_ITEMS} items reached` }, 409);

  const db = careDb();
  const { data, error } = await db.from("care_items")
    .insert({ id: parsed.item.id, ...toColumns(parsed.item) })
    .select(CARE_COLUMNS)
    .single();
  if (!error) {
    const item = rowToItem(data);
    return item ? careJson({ item }, 201) : careJson({ error: "could not save" }, 500);
  }
  if (error.code !== "23505") {
    console.error("care item insert failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  // Same id sent again (a retry after a lost answer): hand back what is stored, unless it was removed since.
  const { data: rows, error: readErr } = await db.from("care_items").select(CARE_COLUMNS)
    .eq("id", parsed.item.id).is("removed_at", null).limit(1);
  if (readErr) {
    console.error("care item re-read failed:", readErr.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  const existing = rowToItem(rows?.[0]);
  return existing ? careJson({ item: existing }) : careJson({ error: "an item with this id was removed" }, 409);
}
