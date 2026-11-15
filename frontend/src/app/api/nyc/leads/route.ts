import { NextResponse } from "next/server";
import { getNycLeads } from "@/lib/nyc";

// How old the cached leads may be before Notion is asked again (in the background: the cached copy is answered
// at once). The scout writes once a day and Riley's own edits drop the entry (revalidateTag in the PATCH route).
const MAX_AGE_SEC = 300;

/**
 * GET /api/nyc/leads — every lead from the Notion "NYC Leads" database, for /nyc's silent mount revalidation
 * (the ISR snapshot can be up to an hour old) and the NYC overview card. Session-protected by middleware like
 * every /api route.
 *
 * Speed (2026-11-15): served from the Next data cache (tag NYC_LEADS_TAG, at most 5 minutes old) instead of a
 * live Notion query on every call, which took 0.7-1.3 s and broke the speed budget on every page whose scroll or
 * overview card reads it (perf-timing run 43668835523).
 */
export async function GET() {
  try {
    const leads = await getNycLeads({ maxAgeSec: MAX_AGE_SEC });
    return NextResponse.json({ leads });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
