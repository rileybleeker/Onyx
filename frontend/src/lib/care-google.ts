// Google Calendar sync for /health care items: the pure part. No I/O, no Supabase, no fetch:
// the sign-in URL, the event a care item becomes, and the sync itself written against a small
// CalendarApi interface, so the tests run it against a fake Google (tests/care-google.test.cjs).
//
// Design, in one place:
//  - ONE scope: calendar.app.created. Google lets an app with this scope create secondary
//    calendars and manage events on the calendars IT created, and nothing else: no access to
//    Riley's own calendars, to other people's events, or to anything in Gmail.
//  - Onyx creates one calendar ("Onyx care") and writes there. One way only: Onyx -> Google.
//    Onyx never reads events back into the planner.
//  - Every event Onyx writes carries a private extended property naming its care item. Before
//    Onyx changes or removes an event it reads it and checks that tag; an event without the
//    matching tag is never touched.
//  - Only the label, the date / time and the booked state go to Google. Notes stay in Onyx.
//  - Repeats are not sent as recurring events: a repeat counts from the day the item is
//    completed, so only the current due date is a real date.
import { addDays, addMinutesWall, type CareItem } from "@/lib/care-planner";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_NAME = "Onyx care";
export const CALLBACK_PATH = "/api/care/google/callback";
export const OAUTH_COOKIE = "onyx_care_gcal";
export const OAUTH_COOKIE_SECONDS = 600;
/** The private extended property that marks an event as Onyx's, holding the care item's id. */
export const OWNER_TAG = "onyxCareItem";
export const TIMED_EVENT_MINUTES = 60;
const MAX_ATTEMPTS = 4;

// ---- what the page is told about the connection ------------------------------------------

export type CalendarSyncSummary = {
  at: string;
  ok: boolean;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  /** A short code such as google_auth, calendar_missing, google_500; never event text. */
  error: string | null;
};

export type CalendarStatus = {
  /** The two Google credentials exist in the server environment. */
  configured: boolean;
  /** Riley has pressed Connect and approved, and Onyx holds a refresh token. */
  connected: boolean;
  calendarName: string;
  connectedAt: string | null;
  lastSync: CalendarSyncSummary | null;
};

/** The default, and what every failure degrades to: nothing is connected. */
export const NOT_CONNECTED: CalendarStatus = { configured: false, connected: false, calendarName: CALENDAR_NAME, connectedAt: null, lastSync: null };

// ---- sign-in (OAuth authorization code + PKCE) --------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random URL-safe string: the `state` value and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline", // a refresh token, so sync works when Riley is not on the page
    prompt: "consent", // Google only returns a refresh token on a consent screen
    include_granted_scopes: "false",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** The short-lived cookie that ties the callback to the Connect press: "<state>.<verifier>". */
export function oauthCookieValue(state: string, verifier: string): string {
  return `${state}.${verifier}`;
}

export function parseOauthCookie(value: string | undefined | null): { state: string; verifier: string } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !TOKEN_RE.test(parts[0]) || !TOKEN_RE.test(parts[1])) return null;
  return { state: parts[0], verifier: parts[1] };
}

/** Constant-time comparison of two short strings. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Google must have granted the one scope Onyx asked for, and nothing more. */
export function scopeIsExactly(granted: unknown): boolean {
  if (typeof granted !== "string") return false;
  const scopes = granted.split(/\s+/).filter(Boolean);
  return scopes.length === 1 && scopes[0] === GOOGLE_SCOPE;
}

// ---- a care item as a calendar event ------------------------------------------------------

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  transparency: "opaque" | "transparent";
  extendedProperties: { private: Record<string, string> };
};

/**
 * The event id Onyx picks for an item. Google allows only a-v and 0-9, so: "care" + the item's
 * UUID without dashes + "g" + a generation number. The generation goes up when Google will not
 * let the id be used again (the event was removed in Google, or the id belongs to something
 * Onyx did not create).
 */
export function eventId(itemId: string, generation: number): string {
  return `care${itemId.replace(/-/g, "")}g${generation}`;
}

/** Items that should be on the calendar: everything active. Archived items come off it. */
export const shouldHaveEvent = (item: Pick<CareItem, "archived">): boolean => !item.archived;

export function eventForItem(item: CareItem, generation: number): CalendarEvent {
  const timed = item.time !== null;
  let start: CalendarEvent["start"];
  let end: CalendarEvent["end"];
  if (item.time !== null) {
    // Wall clock + zone, exactly as stored: Google does the DST arithmetic for that zone.
    const stop = addMinutesWall(item.due, item.time, TIMED_EVENT_MINUTES);
    start = { dateTime: `${item.due}T${item.time}:00`, timeZone: item.tz };
    end = { dateTime: `${stop.date}T${stop.time}:00`, timeZone: item.tz };
  } else {
    start = { date: item.due };
    end = { date: addDays(item.due, 1) }; // all-day events end on the next day (exclusive)
  }
  const lines = [
    item.booked ? "Booked (you confirmed this appointment in Onyx)." : "Not booked yet: this is the date it is due.",
    item.months > 0 ? `Repeats ${item.months} month${item.months === 1 ? "" : "s"} after you mark it complete in Onyx.` : "",
    "Managed by Onyx (Health & appointments). Change it there: edits made in Google Calendar are overwritten.",
  ].filter(Boolean);
  return {
    id: eventId(item.id, generation),
    // A due date is not an appointment, so it must not read like one.
    summary: item.booked ? item.title : `Book: ${item.title}`,
    description: lines.join("\n"),
    start,
    end,
    // Only a booked appointment with a time blocks the calendar.
    transparency: item.booked && timed ? "opaque" : "transparent",
    extendedProperties: { private: { [OWNER_TAG]: item.id } },
  };
}

/** A short digest of an event, to tell "nothing changed" without asking Google. */
export async function fingerprint(event: CalendarEvent): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(event))));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the sync -----------------------------------------------------------------------------

/** What Onyx remembers about the event it made for an item (pds.care_calendar_links). */
export type CalendarLink = {
  itemId: string;
  calendarId: string;
  eventId: string;
  generation: number;
  fingerprint: string;
  state: "present" | "gone";
};

export type RemoteEvent = { id?: string; status?: string; extendedProperties?: { private?: Record<string, string> } };
/** status: the HTTP status Google answered with; 0 = the request did not get an answer. */
export type GoogleResult<T> = { ok: true; value: T } | { ok: false; status: number };

/** The four calls the sync makes. The real one is in care-google-server.ts; tests pass a fake. */
export interface CalendarApi {
  getEvent(calendarId: string, eventId: string): Promise<GoogleResult<RemoteEvent>>;
  insertEvent(calendarId: string, event: CalendarEvent): Promise<GoogleResult<RemoteEvent>>;
  updateEvent(calendarId: string, eventId: string, event: CalendarEvent): Promise<GoogleResult<RemoteEvent>>;
  deleteEvent(calendarId: string, eventId: string): Promise<GoogleResult<null>>;
}

export type SyncOutcome = {
  ok: boolean;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  /** Events found under an Onyx id that do not carry Onyx's tag for that item: left alone. */
  foreign: number;
  error: string | null;
  /** Links that changed and must be saved. */
  links: CalendarLink[];
};

const isOwned = (remote: RemoteEvent, itemId: string): boolean => remote.extendedProperties?.private?.[OWNER_TAG] === itemId;
const isMissing = (status: number): boolean => status === 404 || status === 410;

/**
 * Bring the Onyx calendar in line with the care items.
 *  - an active item with no event gets one; an event whose content changed is rewritten;
 *  - an item that was archived or removed has its event taken off the calendar;
 *  - an item whose event is already right costs no Google call at all.
 * Before any rewrite or removal the event is read and must carry this item's tag. An event
 * that does not is never changed: the item moves to a fresh id instead.
 * One item failing does not stop the others. Losing access (401) or the calendar itself
 * (404 on a new event) stops the run, because nothing after it can work.
 */
export async function runSync(api: CalendarApi, calendarId: string, items: CareItem[], links: CalendarLink[]): Promise<SyncOutcome> {
  const out: SyncOutcome = { ok: true, created: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, foreign: 0, error: null, links: [] };
  const here = new Map(links.filter((l) => l.calendarId === calendarId).map((l) => [l.itemId, l]));
  const wanted = items.filter(shouldHaveEvent);
  const wantedIds = new Set(wanted.map((item) => item.id));
  let stop: string | null = null;
  const itemFailed = (status: number) => {
    out.failed++;
    out.error ??= status === 0 ? "google_unreachable" : `google_${status}`;
  };

  for (const item of wanted) {
    if (stop) break;
    const link = here.get(item.id);
    let generation = link?.generation ?? 0;
    if (link?.state === "present" && link.fingerprint === (await fingerprint(eventForItem(item, generation)))) {
      out.unchanged++;
      continue;
    }
    let mode: "update" | "insert" = link?.state === "present" ? "update" : "insert";
    let done = false;
    const failedBefore = out.failed;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done && !stop; attempt++) {
      const event = eventForItem(item, generation);
      const save = async () => {
        out.links.push({ itemId: item.id, calendarId, eventId: event.id, generation, fingerprint: await fingerprint(event), state: "present" });
        done = true;
      };
      if (mode === "update") {
        const got = await api.getEvent(calendarId, event.id);
        if (!got.ok) {
          if (isMissing(got.status)) { mode = "insert"; continue; }
          if (got.status === 401) { stop = "google_auth"; break; }
          itemFailed(got.status);
          break;
        }
        if (!isOwned(got.value, item.id)) { out.foreign++; generation++; mode = "insert"; continue; } // not ours: never touch it
        if (got.value.status === "cancelled") { generation++; mode = "insert"; continue; }             // removed in Google: make a new one
        const put = await api.updateEvent(calendarId, event.id, event);
        if (put.ok) { out.updated++; await save(); break; }
        if (put.status === 401) { stop = "google_auth"; break; }
        itemFailed(put.status);
        break;
      }
      const made = await api.insertEvent(calendarId, event);
      if (made.ok) { out.created++; await save(); break; }
      if (made.status === 409) { mode = "update"; continue; } // the id exists: look at it before deciding
      if (made.status === 401) { stop = "google_auth"; break; }
      if (made.status === 404) { stop = "calendar_missing"; break; }
      itemFailed(made.status);
      break;
    }
    if (!done && !stop && out.failed === failedBefore) itemFailed(409); // ran out of attempts without an answer that settles it
  }

  for (const link of here.values()) {
    if (stop) break;
    if (link.state !== "present" || wantedIds.has(link.itemId)) continue;
    const gone = () => out.links.push({ ...link, state: "gone" });
    const got = await api.getEvent(calendarId, link.eventId);
    if (!got.ok) {
      if (isMissing(got.status)) { gone(); continue; }
      if (got.status === 401) { stop = "google_auth"; break; }
      itemFailed(got.status);
      continue;
    }
    if (!isOwned(got.value, link.itemId)) { out.foreign++; gone(); continue; } // not ours: forget it, leave it
    if (got.value.status === "cancelled") { gone(); continue; }
    const del = await api.deleteEvent(calendarId, link.eventId);
    if (del.ok || isMissing(del.status)) { out.removed++; gone(); continue; }
    if (del.status === 401) { stop = "google_auth"; break; }
    itemFailed(del.status);
  }

  if (stop) out.error = stop;
  out.ok = !stop && out.failed === 0;
  return out;
}
