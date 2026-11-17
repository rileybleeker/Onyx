import { NextRequest } from "next/server";
import { careDb, careJson, readCareBody } from "@/lib/care-items-server";
import { HOME_COLUMNS, MAX_HOME_BODY_BYTES, MAX_HOME_ITEMS, parseNewItem, rowToHomeItem } from "@/lib/home-reset";

export const dynamic = "force-dynamic";

// POST /api/home-reset/items -> {item}: add one cleanup action. The browser picks the UUID, so a retried POST of the
// same item answers with the stored row instead of adding a second one. Owner session only; same-origin JSON.
export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, MAX_HOME_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseNewItem(read.body);
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);

  const db = careDb();
  const { count, error: countErr } = await db.from("home_reset_items").select("id", { count: "exact", head: true }).is("removed_at", null);
  if (countErr || count === null) {
    console.error("home reset count failed:", countErr?.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  if (count >= MAX_HOME_ITEMS) return careJson({ error: `limit of ${MAX_HOME_ITEMS} actions reached` }, 409);
  const { data, error } = await db.from("home_reset_items").insert(parsed.item).select(HOME_COLUMNS).single();
  if (!error) {
    const item = rowToHomeItem(data);
    return item ? careJson({ item }, 201) : careJson({ error: "could not save" }, 500);
  }
  if (error.code !== "23505") {
    console.error("home reset insert failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  const { data: rows, error: readErr } = await db.from("home_reset_items").select(HOME_COLUMNS).eq("id", parsed.item.id).is("removed_at", null).limit(1);
  const existing = readErr ? null : rowToHomeItem(rows?.[0]);
  return existing ? careJson({ item: existing }) : careJson({ error: "could not save" }, 500);
}
