import { calendarStatus } from "@/lib/care-google-server";
import { careJson } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// GET /api/care/google/status: what the calendar card on /health shows. Owner session only
// (middleware). {configured, connected, calendarName, connectedAt, lastSync}. Makes no call to
// Google, and no database call either until the Google credentials are set up.
export async function GET() {
  return careJson(await calendarStatus());
}
