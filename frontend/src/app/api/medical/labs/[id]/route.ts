import { NextRequest } from "next/server";
import { LAB_COLUMNS, MAX_LAB_BODY_BYTES, labColumns, parseId, parseLabPatch, rowToLab } from "@/lib/medical-records";
import { linkableDocumentIds, medicalDb } from "@/lib/medical-records-server";
import { careJson as json, readCareBody as readBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/medical/labs/[id]: change or remove one lab result. Owner session only (middleware; not
// in the CI-token carve-out). Same-origin, JSON, small body.
//   PATCH  body = one or more fields of a result; {removed: false} brings back a removed result
//          (Undo).                                                                   -> {result}
//   DELETE marks the result removed (removed_at); the row stays, so Undo can restore it. -> {id}
// 404 for an id that does not exist (or is removed, unless the PATCH restores it).

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid result id" }, 400);
  const read = await readBody(req, req.nextUrl.origin, MAX_LAB_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseLabPatch(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { patch } = parsed;

  if (patch.documentId) {
    const linkable = await linkableDocumentIds([patch.documentId]);
    if (!linkable) return json({ error: "could not save" }, 500);
    if (!linkable.has(patch.documentId)) return json({ error: "the linked document was not found" }, 400);
  }

  let query = medicalDb().from("lab_results")
    .update({ ...labColumns(patch), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (patch.removed !== false) query = query.is("removed_at", null);
  const { data, error } = await query.select(LAB_COLUMNS);
  if (error) {
    // 23514: the change breaks a rule that spans fields (no value left, or low end above high end).
    if (error.code === "23514") return json({ error: "a result needs a value, and the range's low end must not be above its high end" }, 400);
    console.error("lab result update failed:", error.code || "unknown");
    return json({ error: "could not save" }, 500);
  }
  if (!data?.length) return json({ error: "result not found" }, 404);
  const result = rowToLab(data[0]);
  if (!result) return json({ error: "could not save" }, 500);
  return json({ result });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid result id" }, 400);
  const read = await readBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;

  const now = new Date().toISOString();
  const { data, error } = await medicalDb().from("lab_results")
    .update({ removed_at: now, updated_at: now })
    .eq("id", id)
    .is("removed_at", null)
    .select("id");
  if (error) {
    console.error("lab result remove failed:", error.code || "unknown");
    return json({ error: "could not save" }, 500);
  }
  if (!data?.length) return json({ error: "result not found" }, 404);
  return json({ id });
}
