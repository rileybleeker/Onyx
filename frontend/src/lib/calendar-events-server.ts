import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  CALENDAR_EVENT_COLUMNS,
  CALENDAR_ROW_LIMIT,
  parseEventRow,
  shiftDate,
  type CalendarCount,
  type CalendarEvent,
  type CalendarSync,
} from "@/lib/calendar-events";

/**
 * Server-side read of pds.calendar_events (filled hourly by google_calendar_etl.py). SERVICE ROLE
 * ONLY: the table has RLS on, no policies and no grants to anon / authenticated, so the browser
 * never queries it, and "server-only" keeps this module out of client bundles. The one caller
 * (/api/calendar/events) sits behind the owner-only middleware. Errors log a code only, never a
 * row. Read-only: nothing here, or anywhere in Onyx, writes to a calendar.
 */

function calendarDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type CalendarLoad =
  | { state: "ready"; events: CalendarEvent[]; truncated: boolean; lastSync: CalendarSync | null; calendars?: CalendarCount[] }
  | { state: "not_connected"; lastSync: CalendarSync | null }
  | { state: "error" };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const SUMMARY_PAGE = 1000;
const SUMMARY_MAX_PAGES = 20;

type Db = ReturnType<typeof calendarDb>;

/** Events per calendar over everything stored (cancelled left out). Null when a page fails. */
async function loadCounts(db: Db): Promise<CalendarCount[] | null> {
  const tally = new Map<string, CalendarCount>();
  for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
    const res = await db.from("calendar_events").select("account,calendar")
      .neq("status", "cancelled")
      .order("event_key", { ascending: true })
      .range(page * SUMMARY_PAGE, (page + 1) * SUMMARY_PAGE - 1);
    if (res.error) return null;
    const rows = (res.data ?? []) as { account?: unknown; calendar?: unknown }[];
    for (const row of rows) {
      const account = typeof row.account === "string" ? row.account : "";
      const calendar = typeof row.calendar === "string" ? row.calendar : "";
      const key = `${account}\u001f${calendar}`;
      const entry = tally.get(key);
      if (entry) entry.events += 1;
      else tally.set(key, { account, calendar, events: 1 });
    }
    if (rows.length < SUMMARY_PAGE) break;
  }
  return [...tally.values()].sort((a, b) => a.account.localeCompare(b.account) || a.calendar.localeCompare(b.calendar));
}

/**
 * Events that overlap from..to (YYYY-MM-DD, already validated by the route). The query is padded
 * by a day on each side: stored dates are in the event's zone and the pages bucket by the
 * browser's, so an event near midnight must not fall out of the answer.
 */
export async function loadCalendarEvents(from: string, to: string, options: { summary?: boolean } = {}): Promise<CalendarLoad> {
  const db = calendarDb();
  const [eventsRes, syncRes, counts] = await Promise.all([
    db.from("calendar_events").select(CALENDAR_EVENT_COLUMNS)
      .lte("start_date", shiftDate(to, 1))
      .gte("end_date", shiftDate(from, -1))
      .neq("status", "cancelled")
      .order("start_date", { ascending: true })
      .order("start_at", { ascending: true, nullsFirst: true })
      .order("event_key", { ascending: true })
      .limit(CALENDAR_ROW_LIMIT),
    db.from("sync_log").select("sync_start,status,error_message")
      .eq("source", "google_calendar").eq("data_type", "events")
      .order("sync_start", { ascending: false }).limit(1),
    options.summary ? loadCounts(db) : Promise.resolve(undefined),
  ]);
  const sync = syncRes.error ? null : syncRes.data?.[0];
  const lastSync: CalendarSync | null = sync?.sync_start
    ? { at: String(sync.sync_start), status: String(sync.status ?? "unknown"), error: (sync.error_message as string | null) ?? null }
    : null;
  if (eventsRes.error) {
    const code = eventsRes.error.code ?? "";
    if (MISSING_TABLE.has(code)) return { state: "not_connected", lastSync };
    console.error("calendar events read failed:", code || "unknown");
    return { state: "error" };
  }
  const rows = (eventsRes.data ?? []) as unknown[];
  const events = rows.map(parseEventRow).filter((e): e is CalendarEvent => e !== null);
  return {
    state: "ready",
    events,
    truncated: rows.length >= CALENDAR_ROW_LIMIT,
    lastSync,
    ...(counts ? { calendars: counts } : {}),
  };
}
