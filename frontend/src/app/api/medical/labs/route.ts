import { NextRequest } from "next/server";
import { LAB_COLUMNS, MAX_LAB_BATCH_BYTES, MAX_LAB_RESULTS, labColumns, parseLabBatch, rowToLab, type LabResult } from "@/lib/medical-records";
import { linkableDocumentIds, liveCount, loadLabs, medicalDb } from "@/lib/medical-records-server";
import { careJson as json, readCareBody as readBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// /api/medical/labs: lab results on /health/records (pds.lab_results, service-role only).
// Owner session only: middleware is the gate and this path is not in its CI-token carve-out.
//   GET   -> {results}   every result that was not removed
//   POST  -> {results}   body = {results: [...]}, one lab report's worth (MAX_LAB_BATCH). Saved
//                        in one statement, so either all of them are stored or none. The browser
//                        picks the ids, so a retried POST stores nothing twice and answers with
//                        the stored rows.
// A result may name a document (documentId) only when that document is listed (not pending,
// not removed). Errors never carry record text; logs carry a database code only.

export async function GET() {
  const data = await loadLabs();
  if (data.state === "error") return json({ error: "lab results unavailable" }, 500);
  return json({ results: data.items });
}

export async function POST(req: NextRequest) {
  const read = await readBody(req, req.nextUrl.origin, MAX_LAB_BATCH_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseLabBatch(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { results } = parsed;

  const docIds = [...new Set(results.map((r) => r.documentId).filter((d): d is string => d !== null))];
  const linkable = await linkableDocumentIds(docIds);
  if (!linkable) return json({ error: "could not save" }, 500);
  if (docIds.some((d) => !linkable.has(d))) return json({ error: "a linked document was not found" }, 400);

  const live = await liveCount("lab_results");
  if (live === null) return json({ error: "could not save" }, 500);
  if (live + results.length > MAX_LAB_RESULTS) return json({ error: `limit of ${MAX_LAB_RESULTS} results reached` }, 409);

  const db = medicalDb();
  const ids = results.map((r) => r.id);
  const { error } = await db.from("lab_results")
    .upsert(results.map((r) => ({ id: r.id, ...labColumns(r) })), { onConflict: "id", ignoreDuplicates: true });
  if (error) {
    console.error("lab results insert failed:", error.code || "unknown");
    return json({ error: error.code === "23514" ? "a result is out of range" : "could not save" }, error.code === "23514" ? 400 : 500);
  }
  // Answer with what is stored under those ids (a retry finds the rows the first try wrote).
  const { data, error: readErr } = await db.from("lab_results").select(LAB_COLUMNS).in("id", ids).is("removed_at", null);
  if (readErr) {
    console.error("lab results re-read failed:", readErr.code || "unknown");
    return json({ error: "saved, but could not read them back; reload the page" }, 500);
  }
  const stored = (data ?? []).map(rowToLab).filter((r): r is LabResult => r !== null);
  return json({ results: stored }, 201);
}
