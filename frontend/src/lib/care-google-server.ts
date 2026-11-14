import "server-only";
import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";
import {
  CALENDAR_NAME,
  GOOGLE_API,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  NOT_CONNECTED,
  runSync,
  scopeIsExactly,
  type CalendarApi,
  type CalendarEvent,
  type CalendarLink,
  type CalendarStatus,
  type CalendarSyncSummary,
  type GoogleResult,
  type RemoteEvent,
} from "@/lib/care-google";
import { CARE_COLUMNS, MAX_CARE_ITEMS, rowToItem } from "@/lib/care-items";
import { DEFAULT_TZ, type CareItem } from "@/lib/care-planner";

/**
 * Google Calendar sync for /health: the server part (credentials, the stored refresh token,
 * the calls to Google, the sync run). SERVICE ROLE ONLY, behind the owner-session routes under
 * /api/care/google/*.
 *
 * NOTHING HERE CALLS GOOGLE unless both are true:
 *   1. GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET exist in the environment, and
 *   2. Riley pressed Connect and approved, so a refresh token is stored (or is completing that
 *      sign-in right now: exchangeCode is only reached from the callback with a valid state).
 * Without the credentials no function below makes a network call or a database call.
 *
 * Where things are kept:
 *   pds.ci_tokens (service = 'google_calendar')  the refresh token, like the other integrations
 *   pds.care_calendar_sync (one row)             calendar id, connected-at, last sync result
 *   pds.care_calendar_links                      item -> event id + digest of what was written
 * Access tokens live in memory for one run and are never stored. Logs and stored errors carry
 * short codes only: no token, no event text.
 */

const TOKEN_SERVICE = "google_calendar";
const GOOGLE_TIMEOUT_MS = 10_000;

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type GoogleConfig = { clientId: string; clientSecret: string };

/** The two credentials, or null when either is missing (the default: not set up). */
export function googleConfig(): GoogleConfig | null {
  const clientId = (process.env.GOOGLE_CALENDAR_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// ---- stored state -------------------------------------------------------------------------

type TokenBlob = { refresh_token: string; scope: string; obtained_at: string };

async function readRefreshToken(): Promise<string | null> {
  const { data, error } = await db().from("ci_tokens").select("token_data").eq("service", TOKEN_SERVICE).limit(1);
  if (error) throw new Error(`token_read_${error.code || "unknown"}`);
  const raw = data?.[0]?.token_data;
  if (typeof raw !== "string") return null;
  try {
    const blob = JSON.parse(raw) as Partial<TokenBlob>;
    return typeof blob.refresh_token === "string" && blob.refresh_token ? blob.refresh_token : null;
  } catch {
    return null;
  }
}

/** Store the refresh token, or (null) forget it. The row stays; an empty object means "not connected". */
async function writeRefreshToken(blob: TokenBlob | null): Promise<void> {
  const { error } = await db().from("ci_tokens").upsert(
    { service: TOKEN_SERVICE, token_data: JSON.stringify(blob ?? {}), updated_at: new Date().toISOString() },
    { onConflict: "service" },
  );
  if (error) throw new Error(`token_write_${error.code || "unknown"}`);
}

type SyncRow = {
  calendar_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_sync_ok: boolean | null;
  last_sync_counts: Record<string, number> | null;
  last_error: string | null;
};
const SYNC_COLUMNS = "calendar_id,connected_at,last_sync_at,last_sync_ok,last_sync_counts,last_error";

async function readSyncRow(): Promise<SyncRow | null> {
  const { data, error } = await db().from("care_calendar_sync").select(SYNC_COLUMNS).eq("id", 1).limit(1);
  if (error) throw new Error(`sync_read_${error.code || "unknown"}`);
  return (data?.[0] as SyncRow | undefined) ?? null;
}

async function writeSyncRow(fields: Partial<SyncRow>): Promise<void> {
  const { error } = await db().from("care_calendar_sync").upsert({ id: 1, ...fields, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(`sync_write_${error.code || "unknown"}`);
}

function summaryOf(row: SyncRow | null): CalendarSyncSummary | null {
  if (!row?.last_sync_at) return null;
  const n = (key: string) => (typeof row.last_sync_counts?.[key] === "number" ? row.last_sync_counts[key] : 0);
  return {
    at: row.last_sync_at, ok: row.last_sync_ok === true, created: n("created"), updated: n("updated"), removed: n("removed"),
    unchanged: n("unchanged"), failed: n("failed"), error: row.last_error,
  };
}

/** What /health shows. Never throws: anything unexpected reads as "not connected". */
export async function calendarStatus(): Promise<CalendarStatus> {
  if (!googleConfig()) return NOT_CONNECTED; // not set up: no database call either
  try {
    const [token, row] = await Promise.all([readRefreshToken(), readSyncRow()]);
    const connected = token !== null && !!row?.calendar_id && !!row.connected_at;
    return { configured: true, connected, calendarName: CALENDAR_NAME, connectedAt: connected ? row!.connected_at : null, lastSync: connected ? summaryOf(row) : null };
  } catch (e) {
    console.error("care calendar status failed:", e instanceof Error ? e.message : "unknown");
    return { ...NOT_CONNECTED, configured: true };
  }
}

// ---- Google over HTTPS --------------------------------------------------------------------

async function googleFetch(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS), cache: "no-store" });
  } catch {
    return null; // no answer (network, timeout)
  }
}

async function tokenRequest(config: GoogleConfig, params: Record<string, string>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: string }> {
  const res = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  if (!res) return { ok: false, code: "google_unreachable" };
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an error page instead of JSON */
  }
  if (!res.ok) {
    // invalid_grant = the refresh token was revoked or expired: Riley has to connect again.
    return { ok: false, code: body.error === "invalid_grant" ? "google_auth" : `google_token_${res.status}` };
  }
  return { ok: true, body };
}

async function call<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<GoogleResult<T>> {
  const res = await googleFetch(`${GOOGLE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res) return { ok: false, status: 0 };
  if (!res.ok) return { ok: false, status: res.status };
  if (res.status === 204) return { ok: true, value: null as T };
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch {
    return { ok: false, status: 502 };
  }
}

const enc = encodeURIComponent;

function calendarApi(accessToken: string): CalendarApi {
  return {
    getEvent: (cal, id) => call<RemoteEvent>(accessToken, "GET", `/calendars/${enc(cal)}/events/${enc(id)}`),
    insertEvent: (cal, event: CalendarEvent) => call<RemoteEvent>(accessToken, "POST", `/calendars/${enc(cal)}/events`, event),
    updateEvent: (cal, id, event: CalendarEvent) => call<RemoteEvent>(accessToken, "PUT", `/calendars/${enc(cal)}/events/${enc(id)}`, event),
    deleteEvent: (cal, id) => call<null>(accessToken, "DELETE", `/calendars/${enc(cal)}/events/${enc(id)}`),
  };
}

// ---- connect / disconnect -----------------------------------------------------------------

/**
 * Finish the sign-in: swap the code for tokens, insist on exactly the one scope, make (or
 * find again) the Onyx calendar, and store the refresh token. Returns a short code on failure.
 * Only called from the callback route after the state cookie matched.
 */
export async function completeConnection(p: { code: string; verifier: string; redirectUri: string }): Promise<{ ok: true } | { ok: false; code: string }> {
  const config = googleConfig();
  if (!config) return { ok: false, code: "not_configured" };
  const tokens = await tokenRequest(config, { grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
  if (!tokens.ok) return { ok: false, code: tokens.code };
  const { access_token: accessToken, refresh_token: refreshToken, scope } = tokens.body;
  if (typeof accessToken !== "string" || !accessToken) return { ok: false, code: "no_access_token" };
  const revoke = () => googleFetch(`${GOOGLE_REVOKE_URL}?token=${enc(accessToken)}`, { method: "POST" });
  if (!scopeIsExactly(scope)) {
    await revoke(); // more (or less) than the one scope was granted: keep nothing
    return { ok: false, code: "wrong_scope" };
  }
  if (typeof refreshToken !== "string" || !refreshToken) return { ok: false, code: "no_refresh_token" };

  try {
    const row = await readSyncRow();
    let calendarId = row?.calendar_id ?? null;
    if (calendarId) {
      // Connected before: use the same calendar if Google still has it.
      const existing = await call<{ id?: string }>(accessToken, "GET", `/calendars/${enc(calendarId)}`);
      if (!existing.ok) {
        // Only "it is gone" leads to a new calendar. Any other answer (Google down, rate limit)
        // stops here, so a hiccup can never leave a second "Onyx care" calendar behind.
        if (existing.status !== 404 && existing.status !== 410) {
          await revoke();
          return { ok: false, code: existing.status === 0 ? "google_unreachable" : `calendar_lookup_${existing.status}` };
        }
        calendarId = null;
      }
    }
    if (!calendarId) {
      const made = await call<{ id?: string }>(accessToken, "POST", "/calendars", {
        summary: CALENDAR_NAME,
        description: "Created by Onyx (Health & appointments). Onyx writes the events here; edit them in Onyx.",
        timeZone: DEFAULT_TZ,
      });
      if (!made.ok || typeof made.value?.id !== "string") {
        await revoke();
        return { ok: false, code: made.ok ? "calendar_create_failed" : `calendar_create_${made.status}` };
      }
      calendarId = made.value.id;
    }
    await writeRefreshToken({ refresh_token: refreshToken, scope: String(scope), obtained_at: new Date().toISOString() });
    await writeSyncRow({ calendar_id: calendarId, connected_at: new Date().toISOString(), last_sync_at: null, last_sync_ok: null, last_sync_counts: null, last_error: null });
    return { ok: true };
  } catch (e) {
    await revoke();
    return { ok: false, code: e instanceof Error ? e.message : "store_failed" };
  }
}

/**
 * Forget the connection: revoke the token at Google (best effort) and blank the stored one.
 * The calendar and its events stay in Google; connecting again reuses that calendar.
 */
export async function disconnectCalendar(): Promise<{ ok: boolean }> {
  const config = googleConfig();
  try {
    const refreshToken = config ? await readRefreshToken() : null;
    if (config && refreshToken) await googleFetch(`${GOOGLE_REVOKE_URL}?token=${enc(refreshToken)}`, { method: "POST" });
    if (!config) return { ok: true }; // never set up: nothing is stored
    await writeRefreshToken(null);
    await writeSyncRow({ connected_at: null });
    return { ok: true };
  } catch (e) {
    console.error("care calendar disconnect failed:", e instanceof Error ? e.message : "unknown");
    return { ok: false };
  }
}

// ---- the sync run -------------------------------------------------------------------------

async function loadLinks(): Promise<CalendarLink[]> {
  const { data, error } = await db().from("care_calendar_links").select("item_id,calendar_id,event_id,generation,fingerprint,state").limit(MAX_CARE_ITEMS * 4);
  if (error) throw new Error(`links_read_${error.code || "unknown"}`);
  return (data ?? []).map((r) => ({
    itemId: String(r.item_id), calendarId: String(r.calendar_id), eventId: String(r.event_id), generation: Number(r.generation) || 0,
    fingerprint: String(r.fingerprint), state: r.state === "present" ? "present" : "gone",
  }));
}

async function saveLinks(links: CalendarLink[]): Promise<void> {
  if (!links.length) return;
  const now = new Date().toISOString();
  const { error } = await db().from("care_calendar_links").upsert(
    links.map((l) => ({ item_id: l.itemId, calendar_id: l.calendarId, event_id: l.eventId, generation: l.generation, fingerprint: l.fingerprint, state: l.state, synced_at: now })),
    { onConflict: "item_id" },
  );
  if (error) throw new Error(`links_write_${error.code || "unknown"}`);
}

/** Items that are live (not removed); archived ones are included so their events get taken off. */
async function loadItems(): Promise<CareItem[]> {
  const { data, error } = await db().from("care_items").select(CARE_COLUMNS).is("removed_at", null).order("id", { ascending: true }).limit(MAX_CARE_ITEMS + 100);
  if (error) throw new Error(`items_read_${error.code || "unknown"}`);
  return (data ?? []).map(rowToItem).filter((item): item is CareItem => item !== null);
}

/**
 * Run one sync. Returns null when there is nothing to sync to (not set up, or not connected):
 * in that case Google is not called. Otherwise the result is also stored for the page.
 */
export async function syncCareCalendar(): Promise<CalendarSyncSummary | null> {
  const config = googleConfig();
  if (!config) return null;
  const at = new Date().toISOString();
  const failed = async (error: string): Promise<CalendarSyncSummary> => {
    const summary: CalendarSyncSummary = { at, ok: false, created: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, error };
    try {
      await writeSyncRow({ last_sync_at: at, last_sync_ok: false, last_sync_counts: {}, last_error: error });
    } catch {
      /* the page will show the previous result */
    }
    return summary;
  };
  try {
    const [refreshToken, row] = await Promise.all([readRefreshToken(), readSyncRow()]);
    if (!refreshToken || !row?.calendar_id || !row.connected_at) return null; // not connected
    const fresh = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
    if (!fresh.ok) return failed(fresh.code);
    const accessToken = fresh.body.access_token;
    if (typeof accessToken !== "string" || !accessToken) return failed("no_access_token");

    const [items, links] = await Promise.all([loadItems(), loadLinks()]);
    const result = await runSync(calendarApi(accessToken), row.calendar_id, items, links);
    await saveLinks(result.links);
    const summary: CalendarSyncSummary = {
      at, ok: result.ok, created: result.created, updated: result.updated, removed: result.removed, unchanged: result.unchanged,
      failed: result.failed, error: result.error,
    };
    await writeSyncRow({
      last_sync_at: at, last_sync_ok: result.ok, last_error: result.error,
      last_sync_counts: { created: result.created, updated: result.updated, removed: result.removed, unchanged: result.unchanged, failed: result.failed, foreign: result.foreign },
    });
    return summary;
  } catch (e) {
    const code = e instanceof Error && /^[a-z_]+_[A-Za-z0-9]+$/.test(e.message) ? e.message : "sync_failed";
    console.error("care calendar sync failed:", code);
    return failed(code);
  }
}

/**
 * After a care item was saved: sync in the background once the response has gone out. Does
 * nothing at all (no scheduled work, no calls) when the credentials are not set up.
 */
export function syncAfterWrite(): void {
  if (!googleConfig()) return;
  after(async () => {
    await syncCareCalendar();
  });
}
