import { NextRequest } from "next/server";
import { DOC_COLUMNS, MAX_DOC_BODY_BYTES, documentColumns, parseDocumentPatch, parseId, rowToDocument } from "@/lib/medical-records";
import { medicalDb } from "@/lib/medical-records-server";
import { careJson as json, readCareBody as readBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/medical/documents/[id]: change or remove one document's details. Owner session only
// (middleware; not in the CI-token carve-out). Same-origin, JSON, small body.
//   PATCH  body = one or more of {title, kind, date, provider, notes}; {removed: false} brings
//          back a removed document (Undo).                                         -> {document}
//   DELETE marks the document removed (removed_at). The row and the file stay, so Undo can
//          restore it; the file is no longer listed or served.                     -> {id}
// Only documents whose file is confirmed ("ready") can be changed. 404 for anything else.

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid document id" }, 400);
  const read = await readBody(req, req.nextUrl.origin, MAX_DOC_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseDocumentPatch(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  let query = medicalDb().from("medical_documents")
    .update({ ...documentColumns(parsed.patch), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "ready");
  if (parsed.patch.removed !== false) query = query.is("removed_at", null);
  const { data, error } = await query.select(DOC_COLUMNS);
  if (error) {
    console.error("document update failed:", error.code || "unknown");
    return json({ error: "could not save" }, 500);
  }
  if (!data?.length) return json({ error: "document not found" }, 404);
  const document = rowToDocument(data[0]);
  if (!document) return json({ error: "could not save" }, 500);
  return json({ document });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid document id" }, 400);
  const read = await readBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;

  const now = new Date().toISOString();
  const { data, error } = await medicalDb().from("medical_documents")
    .update({ removed_at: now, updated_at: now })
    .eq("id", id)
    .eq("status", "ready")
    .is("removed_at", null)
    .select("id");
  if (error) {
    console.error("document remove failed:", error.code || "unknown");
    return json({ error: "could not save" }, 500);
  }
  if (!data?.length) return json({ error: "document not found" }, 404);
  return json({ id });
}
