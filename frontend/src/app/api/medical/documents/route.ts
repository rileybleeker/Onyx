import { NextRequest } from "next/server";
import { MAX_DOCUMENTS, MAX_DOC_BODY_BYTES, documentColumns, parseNewDocument, storagePathFor } from "@/lib/medical-records";
import { liveCount, loadDocuments, medicalDb, signedUpload } from "@/lib/medical-records-server";
import { careJson as json, readCareBody as readBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/medical/documents: files on /health/records (pds.medical_documents + the private bucket
// "medical-records", both service-role only). Owner session only: middleware is the gate and
// this path is not in its CI-token carve-out.
//   GET   -> {documents}   every document whose file is confirmed and that was not removed
//   POST  -> {document, upload: {path, token}}   body = the new document's details (no file).
//            The row starts "pending"; the browser uploads the file with the one-time token,
//            then calls POST /api/medical/documents/[id]/complete. A retried POST of the same
//            pending id hands out a fresh token instead of adding a second row.
// Errors never carry record text; logs carry a database / storage code only.

export async function GET() {
  const data = await loadDocuments();
  if (data.state === "error") return json({ error: "documents unavailable" }, 500);
  return json({ documents: data.items });
}

export async function POST(req: NextRequest) {
  const read = await readBody(req, req.nextUrl.origin, MAX_DOC_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseNewDocument(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { doc } = parsed;
  const path = storagePathFor(doc.id);

  const live = await liveCount("medical_documents");
  if (live === null) return json({ error: "could not save" }, 500);
  if (live >= MAX_DOCUMENTS) return json({ error: `limit of ${MAX_DOCUMENTS} documents reached` }, 409);

  const db = medicalDb();
  const { error } = await db.from("medical_documents")
    .insert({ id: doc.id, ...documentColumns(doc), storage_path: path, status: "pending" });
  if (error) {
    if (error.code !== "23505") {
      console.error("document insert failed:", error.code || "unknown");
      return json({ error: "could not save" }, 500);
    }
    // Same id again (a retry after a lost answer): only a pending, live row gets a new token.
    const { data: rows, error: readErr } = await db.from("medical_documents").select("status,removed_at").eq("id", doc.id).limit(1);
    if (readErr) {
      console.error("document re-read failed:", readErr.code || "unknown");
      return json({ error: "could not save" }, 500);
    }
    const row = rows?.[0] as { status?: string; removed_at?: string | null } | undefined;
    if (!row || row.removed_at || row.status !== "pending") return json({ error: "a document with this id already exists" }, 409);
  }

  const upload = await signedUpload(path);
  if (!upload) return json({ error: "could not start the upload" }, 500);
  return json({ document: { ...doc, uploadedAt: null }, upload }, error ? 200 : 201);
}
