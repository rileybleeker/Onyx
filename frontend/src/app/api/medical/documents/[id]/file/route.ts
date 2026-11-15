import { NextRequest, NextResponse } from "next/server";
import { DOC_COLUMNS, downloadName, parseId, rowToDocument } from "@/lib/medical-records";
import { medicalDb, signedView } from "@/lib/medical-records-server";
import { careJson as json } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// GET /api/medical/documents/[id]/file[?download=1]: open (or save) one document's file. Owner
// session only (middleware; not in the CI-token carve-out). Answers with a redirect to a signed
// Storage link that stops working after VIEW_URL_SECONDS; the link is never cached or stored.
// Only documents whose file is confirmed and that were not removed are served. Read-only.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return json({ error: "invalid document id" }, 400);

  const { data: rows, error } = await medicalDb().from("medical_documents")
    .select(`storage_path,${DOC_COLUMNS}`)
    .eq("id", id).eq("status", "ready").is("removed_at", null).limit(1);
  if (error) {
    console.error("document read failed:", error.code || "unknown");
    return json({ error: "file unavailable" }, 500);
  }
  const row = rows?.[0] as { storage_path?: string } | undefined;
  const doc = rowToDocument(row);
  if (!row?.storage_path || !doc) return json({ error: "document not found" }, 404);

  const download = req.nextUrl.searchParams.get("download") === "1" ? downloadName(doc) : null;
  const url = await signedView(row.storage_path, download);
  if (!url) return json({ error: "file unavailable" }, 502);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
