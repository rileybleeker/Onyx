import { NextRequest } from "next/server";
import { DOC_COLUMNS, parseId, rowToDocument } from "@/lib/medical-records";
import { medicalDb, storedFile } from "@/lib/medical-records-server";
import { careJson as json, readCareBody as readBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// POST /api/medical/documents/[id]/complete: the browser finished uploading the file. The server
// checks that the file is really in the bucket with the size and type the document declared,
// then marks the row "ready" so it is listed and served. Owner session only, same origin, no
// body. Calling it again for a ready document answers with the document (idempotent).
//   200 {document} | 404 unknown or removed | 409 file missing or not what was declared

type Ctx = { params: Promise<{ id: string }> };
type Row = { status: string; size_bytes: number | string; mime_type: string; storage_path: string };

export async function POST(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid document id" }, 400);
  const read = await readBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;

  const db = medicalDb();
  const { data: rows, error } = await db.from("medical_documents")
    .select(`status,storage_path,${DOC_COLUMNS}`) // DOC_COLUMNS carries size_bytes and mime_type
    .eq("id", id).is("removed_at", null).limit(1);
  if (error) {
    console.error("document read failed:", error.code || "unknown");
    return json({ error: "could not finish the upload" }, 500);
  }
  const row = rows?.[0] as unknown as Row | undefined;
  if (!row) return json({ error: "document not found" }, 404);
  if (row.status === "ready") {
    const document = rowToDocument(row);
    return document ? json({ document }) : json({ error: "could not finish the upload" }, 500);
  }

  const file = await storedFile(row.storage_path);
  if (!file) return json({ error: "the file has not arrived yet" }, 409);
  if (file.size !== Number(row.size_bytes) || file.type.split(";")[0].trim().toLowerCase() !== row.mime_type) {
    return json({ error: "the uploaded file is not the one that was described" }, 409);
  }

  const now = new Date().toISOString();
  const { data, error: updErr } = await db.from("medical_documents")
    .update({ status: "ready", uploaded_at: now, updated_at: now })
    .eq("id", id).eq("status", "pending").is("removed_at", null)
    .select(DOC_COLUMNS);
  if (updErr) {
    console.error("document finish failed:", updErr.code || "unknown");
    return json({ error: "could not finish the upload" }, 500);
  }
  const document = rowToDocument(data?.[0]);
  return document ? json({ document }) : json({ error: "document not found" }, 404);
}
