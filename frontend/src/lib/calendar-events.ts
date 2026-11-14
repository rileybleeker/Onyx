/**
 * Pure helpers for the synced calendar events (pds.calendar_events, filled hourly by
 * google_calendar_etl.py from the calendar iCal feeds). Shared by the server reader, the
 * /api/calendar/events route, /health (Month + Agenda) and Today's Calendar panel.
 *
 * No I/O and NO runtime imports: tests/today-regression.cjs bundles this file on its own and
 * node --test loads it directly. Type-only imports are fine.
 *
 * Read-only by design: nothing here (or anywhere in Onyx) writes to a calendar.
 */

export const CALENDAR_EVENT_COLUMNS =
  "event_key,account,calendar,title,start_at,end_at,all_day,start_date,end_date,tz,location,status,recurring";
/** Longest from..to span one request may ask for (a month grid is at most 42 days). */
export const CALENDAR_MAX_RANGE_DAYS = 62;
export const CALENDAR_ROW_LIMIT = 1000;
/** The sync runs hourly. Older than this and the pages say newer changes may be missing. */
export const CALENDAR_SYNC_LATE_MS = 3 * 3_600_000;
/** Older than this (or a failed run) and the sync is treated as failing. Same as the /status card. */
export const CALENDAR_SYNC_FAILING_MS = 8 * 3_600_000;
export const CALENDAR_SOURCE_LABEL = "Google Calendar";

export interface CalendarEvent {
  key: string;
  title: string;
  allDay: boolean;
  /** ISO instant; null for an all-day event. */
  startAt: string | null;
  /** ISO instant (exclusive); null for an all-day event. */
  endAt: string | null;
  /** YYYY-MM-DD. All-day: the event's own first date. Timed: local date in the event's zone. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
  calendar: string;
  account: string;
  location: string | null;
  status: "confirmed" | "tentative";
  recurring: boolean;
}

export interface CalendarSync {
  at: string;
  status: string;
  error: string | null;
}

export interface CalendarCount {
  account: string;
  calendar: string;
  events: number;
}

export type CalendarEventsResponse =
  | { status: "not_connected"; lastSync: CalendarSync | null }
  | {
      status: "ready";
      events: CalendarEvent[];
      /** True when the row cap was hit, so the list may be incomplete. */
      truncated: boolean;
      lastSync: CalendarSync | null;
      /** Per-calendar totals over everything stored. Only sent when asked for (summary=1). */
      calendars?: CalendarCount[];
    };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** `date` moved by whole days (calendar arithmetic, no time zone involved). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** A usable request range: two real dates, in order, at most `maxDays` apart. */
export function validRange(from: unknown, to: unknown, maxDays: number = CALENDAR_MAX_RANGE_DAYS): boolean {
  if (!isDate(from) || !isDate(to) || from > to) return false;
  return spanDays(from, to) <= maxDays;
}

/** The calendar date of an instant in `timeZone` (the browser's zone when omitted). */
export function localDate(instant: Date, timeZone?: string): string {
  if (!timeZone) {
    return `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One table row -> an event, or null when the row is unusable or cancelled. */
export function parseEventRow(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = text(r.event_key, 80);
  const startDate = typeof r.start_date === "string" ? r.start_date.slice(0, 10) : "";
  const endDate = typeof r.end_date === "string" ? r.end_date.slice(0, 10) : "";
  if (!key || !isDate(startDate) || !isDate(endDate) || endDate < startDate) return null;
  if (r.status !== "confirmed" && r.status !== "tentative") return null; // cancelled or unknown
  const allDay = r.all_day === true;
  const startAt = instant(r.start_at);
  let endAt = instant(r.end_at);
  if (!allDay && !startAt) return null;
  if (!allDay && (!endAt || endAt < startAt!)) endAt = startAt;
  return {
    key,
    title: text(r.title, 300),
    allDay,
    startAt: allDay ? null : startAt,
    endAt: allDay ? null : endAt,
    startDate,
    endDate,
    calendar: text(r.calendar, 60),
    account: text(r.account, 60),
    location: text(r.location, 300) || null,
    status: r.status,
    recurring: r.recurring === true,
  };
}

/** Deterministic order: by start day is the caller's job; within a day all-day first, then by
 *  start instant, then title, then the unique key. */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return (a.startAt ?? a.startDate).localeCompare(b.startAt ?? b.startDate)
    || a.title.localeCompare(b.title)
    || a.key.localeCompare(b.key);
}

/**
 * The days (YYYY-MM-DD, inside start..end) an event is shown on.
 *  - All-day: every date from startDate to endDate (the dates are the event's own, no zone).
 *  - Timed: the local date it starts on (`timeZone`, default the browser's). Only an event that
 *    lasts 24 hours or more is also shown on the later days it covers, so a late-evening event
 *    that runs past midnight is not listed twice.
 */
export function eventDays(event: CalendarEvent, start: string, end: string, timeZone?: string): string[] {
  let first: string;
  let last: string;
  if (event.allDay || !event.startAt) {
    first = event.startDate;
    last = event.endDate;
  } else {
    const s = new Date(event.startAt);
    const e = new Date(event.endAt ?? event.startAt);
    first = localDate(s, timeZone);
    last = e.getTime() - s.getTime() >= 86_400_000 ? localDate(new Date(e.getTime() - 1), timeZone) : first;
  }
  const out: string[] = [];
  let day = first < start ? start : first;
  const stop = last > end ? end : last;
  while (day <= stop && out.length < 400) {
    out.push(day);
    day = shiftDate(day, 1);
  }
  return out;
}

/** Events grouped by the days they are shown on, each day sorted (all-day first). */
export function eventsByDay(events: CalendarEvent[], start: string, end: string, timeZone?: string): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    for (const day of eventDays(event, start, end, timeZone)) {
      const list = map.get(day);
      if (list) list.push(event);
      else map.set(day, [event]);
    }
  }
  for (const list of map.values()) list.sort(compareEvents);
  return map;
}

function clock(instantIso: string, timeZone?: string, locale?: string): string {
  // Some ICU versions put a narrow no-break space before AM / PM; keep the label plain.
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(instantIso)).replace(/[\u202f\u00a0]/g, " ");
}

/** "All day", "9:00 AM - 10:00 AM", "9:00 AM" (no length), or "Continues" on a later day of a long event. */
export function timeLabel(event: CalendarEvent, day: string, timeZone?: string, locale?: string): string {
  if (event.allDay || !event.startAt) return "All day";
  const startDay = localDate(new Date(event.startAt), timeZone);
  const end = event.endAt && event.endAt > event.startAt ? event.endAt : null;
  if (startDay !== day) {
    const endsToday = end && localDate(new Date(new Date(end).getTime() - 1), timeZone) === day;
    return endsToday ? `Until ${clock(end, timeZone, locale)}` : "Continues";
  }
  const from = clock(event.startAt, timeZone, locale);
  return end ? `${from} - ${clock(end, timeZone, locale)}` : from;
}

export const eventTitle = (event: Pick<CalendarEvent, "title">): string => event.title || "(No title)";

/** A calendar event as one entry per shown day, in the shape the /health calendar draws. */
export interface ExternalEntry {
  key: string;
  itemId: "";
  title: string;
  date: string;
  /** Care items use `time` for their own HH:MM; a calendar entry's display text is `when`. */
  time: null;
  status: "external";
  sample: false;
  months: 0;
  when: string;
  calendar: string;
  location: string | null;
  tentative: boolean;
}

/** Entries for start..end, sorted by day and then all-day first / start time. Never a care item:
 *  these are display-only copies and carry no item id. */
export function externalEntries(events: CalendarEvent[], start: string, end: string, timeZone?: string, locale?: string): ExternalEntry[] {
  const out: ExternalEntry[] = [];
  const byDay = eventsByDay(events, start, end, timeZone);
  for (const day of [...byDay.keys()].sort()) {
    for (const event of byDay.get(day)!) {
      out.push({
        key: `calendar:${event.key}:${day}`,
        itemId: "",
        title: eventTitle(event),
        date: day,
        time: null,
        status: "external",
        sample: false,
        months: 0,
        when: timeLabel(event, day, timeZone, locale),
        calendar: event.calendar,
        location: event.location,
        tentative: event.status === "tentative",
      });
    }
  }
  return out;
}

/** Care entries and calendar entries for one view, by day: care items first, then the calendar's
 *  events in their own order. Both lists must already be sorted. */
export function mergeByDate<C extends { date: string }, E extends { date: string }>(care: C[], external: E[]): Map<string, (C | E)[]> {
  const map = new Map<string, (C | E)[]>();
  for (const entry of care) map.set(entry.date, [...(map.get(entry.date) ?? []), entry]);
  for (const entry of external) map.set(entry.date, [...(map.get(entry.date) ?? []), entry]);
  return map;
}

export type CalendarSyncHealth = "ok" | "late" | "failing" | "never";

/** How the last sync run looks at `nowMs`: never ran, failing (failed run or older than 8 h),
 *  late (partial run or older than 3 h), or ok. */
export function syncHealth(lastSync: CalendarSync | null | undefined, nowMs: number): CalendarSyncHealth {
  if (!lastSync) return "never";
  const at = Date.parse(lastSync.at);
  const age = Number.isFinite(at) ? nowMs - at : Infinity;
  if (lastSync.status === "failed" || lastSync.status === "error" || age > CALENDAR_SYNC_FAILING_MS) return "failing";
  if (lastSync.status !== "success" || age > CALENDAR_SYNC_LATE_MS) return "late";
  return "ok";
}

export type CalendarLoadState = "loading" | "ready" | "not_connected" | "error";
export type CalendarReadStatus = "checking" | "synced" | "late" | "failing" | "not-synced" | "unavailable";
export interface CalendarReadConnection {
  status: CalendarReadStatus;
  statusLabel: string;
  detail: string;
  readOnly: true;
  writesToCalendar: false;
}

/**
 * What the /health "Your calendar events" card says, from what GET /api/calendar/events answered.
 * checking: no answer yet. unavailable: Onyx could not read its own copy. not-synced: the table
 * or the first sync run does not exist. late: last run partial or older than 3 h. failing: last
 * run failed or older than 8 h. Whatever the state, this sync only reads.
 */
export function readConnection(load: CalendarLoadState, lastSync: CalendarSync | null, nowMs: number): CalendarReadConnection {
  const base = { readOnly: true, writesToCalendar: false } as const;
  if (load === "loading") return { ...base, status: "checking", statusLabel: "Checking", detail: "Checking the calendar events sync." };
  if (load === "error") {
    return { ...base, status: "unavailable", statusLabel: "Couldn't be checked", detail: "Onyx couldn't read its copy of your calendar events just now. Your care items are not affected." };
  }
  const health = syncHealth(lastSync, nowMs);
  const failedRun = !!lastSync && (lastSync.status === "failed" || lastSync.status === "error");
  if (load === "not_connected" || health === "never") {
    return { ...base, status: "not-synced", statusLabel: "Not synced yet", detail: failedRun
      ? "The calendar sync ran but its table is not set up yet, so no calendar events are shown."
      : "The hourly calendar sync has not run yet, so no calendar events are shown." };
  }
  if (health === "failing") {
    return { ...base, status: "failing", statusLabel: "Sync failing", detail: failedRun
      ? "The last sync run failed. The events shown are from the last run that worked and may be out of date."
      : "The sync has not run for more than 8 hours. The events shown may be out of date." };
  }
  if (health === "late") {
    return { ...base, status: "late", statusLabel: "Synced (read-only)", detail: lastSync && lastSync.status !== "success"
      ? "The last sync run was incomplete, so some events may be missing or out of date."
      : "The sync is running late, so the newest changes may be missing." };
  }
  return { ...base, status: "synced", statusLabel: "Synced (read-only)", detail: "Events from your Google Calendar are copied into Onyx about once an hour and shown below, read-only." };
}

/** Shape check for a fetched /api/calendar/events body (throws on anything else). */
export function readCalendarResponse(data: unknown): CalendarEventsResponse {
  const d = data as { status?: unknown; events?: unknown } | null;
  if (d && d.status === "not_connected") return data as CalendarEventsResponse;
  if (d && d.status === "ready" && Array.isArray(d.events)) return data as CalendarEventsResponse;
  throw new Error("Invalid calendar response");
}
