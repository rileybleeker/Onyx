import { NextRequest } from "next/server";
import { syncCareCalendar } from "@/lib/care-google-server";
import { careJson, readCareBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// POST /api/care/google/sync: "Sync now" on /health. Owner session only (middleware), same
// origin, no body. Answers {sync: {at, ok, created, updated, removed, unchanged, failed, error}}
// (counts and a short code, never event text), or 409 not_connected, in which case Google was
// not called.
export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;
  const sync = await syncCareCalendar();
  if (!sync) return careJson({ error: "not_connected" }, 409);
  return careJson({ sync });
}
