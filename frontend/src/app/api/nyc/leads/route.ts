import { NextResponse } from "next/server";
import { getNycLeads } from "@/lib/nyc";

/**
 * GET /api/nyc/leads — every lead from the Notion "NYC Leads" database,
 * uncached. Used by /nyc's silent mount revalidation (the ISR snapshot can be
 * up to an hour old; the scout writes once a day, Riley's edits any time).
 * Session-protected by middleware like every /api route.
 */
export async function GET() {
  try {
    const leads = await getNycLeads({ fresh: true });
    return NextResponse.json({ leads });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
