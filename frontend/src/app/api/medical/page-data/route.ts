import { NextRequest } from "next/server";
import { loadDocuments, loadLabs, type Section } from "@/lib/medical-records-server";
import type { LabResult, MedicalDocument } from "@/lib/medical-records";
import { careJson as json } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// GET /api/medical/page-data: exactly what app/health/records/page.tsx hands to RecordsClient,
// for the /health/records section of the continuous scroll (app/health/records/FeedSection.tsx).
// {documents: Section<MedicalDocument>, labs: Section<LabResult>}; a failed read is
// {state: "error"} for that section only, like on the page.
// Owner session only: middleware is the gate and this path is not in its CI-token carve-out.
// GET only, same-origin, no-store. /api/medical is a memory-only key in the client cache
// (isSensitiveKey), so the answer never reaches the device's disk. Never read by a model.
// Logs carry a database code only (inside the loaders), never record text.
export async function GET(req: NextRequest) {
  // A same-origin GET carries no Origin header; Sec-Fetch-Site says which site caused it.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "cross_origin" }, 403);
  const [documents, labs] = await Promise.all([
    loadDocuments().catch((): Section<MedicalDocument> => ({ state: "error" })),
    loadLabs().catch((): Section<LabResult> => ({ state: "error" })),
  ]);
  return json({ documents, labs });
}
