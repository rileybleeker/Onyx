import { NextRequest } from "next/server";
import { careDb, careJson, readCareBody } from "@/lib/care-items-server";
import { HOME_COLUMNS, MAX_HOME_BODY_BYTES, applyPatch, isUuid, parsePatch, rowToHomeItem } from "@/lib/home-reset";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/home-reset/items/[id] -> {item}: answer the upkeep question or pause / resume it, or remove the action
// (soft: removed_at). {upkeep: "weekly" | "biweekly" | "none", upkeep_paused: boolean, removed: true}.
// Choosing an upkeep cadence reopens a finished item with its next day counted from the day it was done (never in
// the past, see applyPatch), so no past period is owed. Owner session only; same-origin JSON.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = (await params).id;
  if (!isUuid(id)) return careJson({ error: "invalid id" }, 400);
  const read = await readCareBody(req, req.nextUrl.origin, MAX_HOME_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parsePatch(read.body);
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);

  const db = careDb();
  const { data: rows, error: readErr } = await db.from("home_reset_items").select(HOME_COLUMNS).eq("id", id).is("removed_at", null).limit(1);
  if (readErr) {
    console.error("home reset read failed:", readErr.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  const cur = rowToHomeItem(rows?.[0]);
  if (!cur) return careJson({ error: "not found" }, 404);

  const now = new Date();
  const { patch } = parsed;
  const update: Record<string, unknown> = { updated_at: now.toISOString() };
  if (patch.removed) update.removed_at = now.toISOString();
  if (!patch.removed) {
    const next = applyPatch(cur, patch, now);
    update.upkeep = next.upkeep;
    update.upkeep_paused = next.upkeepPaused;
    update.status = next.status;
    update.next_due_on = next.nextDueOn;
  }
  const { data, error } = await db.from("home_reset_items").update(update).eq("id", id).is("removed_at", null).select(HOME_COLUMNS);
  if (error) {
    console.error("home reset update failed:", error.code || "unknown");
    return careJson({ error: "could not save" }, 500);
  }
  const item = rowToHomeItem(data?.[0]);
  return item ? careJson({ item }) : patch.removed ? careJson({ id }) : careJson({ error: "not found" }, 404);
}
