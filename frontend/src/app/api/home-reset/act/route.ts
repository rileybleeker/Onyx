import { NextRequest } from "next/server";
import { careDb, careJson, readCareBody } from "@/lib/care-items-server";
import { HOME_COLUMNS, MAX_HOME_BODY_BYTES, parseAct, rowToHomeItem } from "@/lib/home-reset";

export const dynamic = "force-dynamic";

// POST /api/home-reset/act -> {result, item}: one tap on the card: done | partly | snooze.
// body {receipt_id, item_id, action, remaining?, snooze_until?}. The receipt id is picked by the browser per tap and
// pds.home_reset_act() applies it once, atomically: a retried tap answers result "replayed" and changes nothing, so
// there is never a second completion. Owner session only; same-origin JSON; logs a database code only.
export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, MAX_HOME_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseAct(read.body, new Date());
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);
  const a = parsed.act;

  const db = careDb();
  const { data, error } = await db.rpc("home_reset_act", {
    p_receipt: a.receiptId, p_item: a.itemId, p_action: a.action, p_remaining: a.remaining, p_snooze_until: a.snoozeUntil,
  });
  if (error) {
    console.error("home reset act failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  if (data === "missing") return careJson({ error: "not found" }, 404);
  const { data: rows } = await db.from("home_reset_items").select(HOME_COLUMNS).eq("id", a.itemId).is("removed_at", null).limit(1);
  return careJson({ result: data === "replayed" ? "replayed" : "applied", item: rowToHomeItem(rows?.[0]) });
}
