import { NextRequest } from "next/server";
import { calendarStatus, disconnectCalendar } from "@/lib/care-google-server";
import { careJson, readCareBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// POST /api/care/google/disconnect: "Disconnect" on /health. Owner session only (middleware),
// same origin, no body. Revokes Onyx's access at Google (best effort) and blanks the stored
// refresh token. The "Onyx care" calendar and its events stay in Google Calendar; Riley can
// remove that calendar there. Answers the new status.
export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;
  const done = await disconnectCalendar();
  if (!done.ok) return careJson({ error: "could not disconnect" }, 500);
  return careJson(await calendarStatus());
}
