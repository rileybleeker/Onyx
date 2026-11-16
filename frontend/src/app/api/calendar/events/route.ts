import { NextResponse } from "next/server";
import { CALENDAR_MAX_RANGE_DAYS, validRange, type CalendarEventsResponse } from "@/lib/calendar-events";
import { loadCalendarEvents } from "@/lib/calendar-events-server";

export const dynamic = "force-dynamic";
// Edge runtime, next to the database (PERF-01, 2026-11-16), for the same reason as /api/urgent-email: its queries are
// small (EXPLAIN, read-only: a table of a few dozen rows and an index scan) and it was slow only on the cold first
// visit, which points at the start of a new Node function instance. Not yet measured on production: the next
// perf-timing runs after the deploy decide it, and without a gain on the cold first visit this goes back to Node.
// lib/calendar-events-server.ts uses supabase-js over fetch and no Node API. Same middleware, same answer.
export const runtime = "edge";
export const preferredRegion = "iad1";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD[&summary=1]: the synced calendar events
// that overlap the range (owner session only, via middleware; deliberately NOT in isCiRoute).
// Read-only copies from pds.calendar_events; Onyx never writes to a calendar.
//   {status: "ready", events, truncated, lastSync, calendars?} | {status: "not_connected", lastSync}
// summary=1 adds the per-calendar totals the /health connection card shows.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!validRange(from, to)) {
    return NextResponse.json(
      { error: `from and to must be YYYY-MM-DD dates, in order, at most ${CALENDAR_MAX_RANGE_DAYS} days apart` },
      { status: 400, headers: NO_STORE },
    );
  }
  const data = await loadCalendarEvents(from as string, to as string, { summary: params.get("summary") === "1" });
  if (data.state === "error") return NextResponse.json({ error: "calendar unavailable" }, { status: 500, headers: NO_STORE });
  const body: CalendarEventsResponse = data.state === "not_connected"
    ? { status: "not_connected", lastSync: data.lastSync }
    : { status: "ready", events: data.events, truncated: data.truncated, lastSync: data.lastSync, ...(data.calendars ? { calendars: data.calendars } : {}) };
  return NextResponse.json(body, { headers: NO_STORE });
}
