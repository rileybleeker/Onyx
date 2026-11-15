// The /status card for the Google Calendar WRITE side: care items copied out to the "Onyx care"
// calendar (lib/care-google.ts, lib/care-google-server.ts). Pure: no I/O, no imports, so
// /api/status and the tests use it as is.
//
// What it reads: the one row of pds.care_calendar_sync (calendar id, connected-at, the last sync
// result as counts + a short code). Never pds.ci_tokens and never a care item: /api/status is
// CDN-cacheable, so only timestamps, counts and short codes leave it. The sync writes no
// pds.sync_log rows, so last_sync_at is the heartbeat. It moves on every sync: after each change
// on /health, on Sync now, and on the scheduled catch-up (POST /api/jobs/care-calendar-catch-up,
// every 6 hours), which is what makes an idle week still read as healthy.

export type CareCalendarSyncRow = {
  calendar_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_sync_ok: boolean | null;
  last_sync_counts: Record<string, unknown> | null;
  last_error: string | null;
};

/** The columns the card needs (no token, no item text: the table holds neither). */
export const CARE_CALENDAR_SYNC_COLUMNS = "calendar_id,connected_at,last_sync_at,last_sync_ok,last_sync_counts,last_error";

/** The catch-up runs every 6 hours: two missed runs = degraded, four = red (as SimpleFIN). */
export const CARE_CALENDAR_DEGRADED_HOURS = 14;
export const CARE_CALENDAR_FAILED_HOURS = 30;

export type CareCalendarCard = {
  label: string;
  lastSync: string | null;
  status: "success" | "partial" | "failed" | "unknown";
  latestDataDate: string | null;
  daysLag: number;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
};

const LABEL = "Care Calendar";
const DOC = "docs/health-google-calendar.md";
const CATCH_UP = "the Care Calendar Catch-up workflow";

/** The same test as googleConfig() in care-google-server.ts: both Google credentials are present. */
export function careCalendarConfigured(env: Record<string, string | undefined>): boolean {
  return !!(env.GOOGLE_CALENDAR_CLIENT_ID || "").trim() && !!(env.GOOGLE_CALENDAR_CLIENT_SECRET || "").trim();
}

/** A stored code is shown only if it looks like one (google_auth, google_500, token_read_42P01). */
function code(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : "unknown";
}

const count = (counts: Record<string, unknown> | null, key: string): number => {
  const n = counts?.[key];
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
};

function failureMessage(error: string, failed: number): string {
  if (error === "google_auth") return "Google access was lost (google_auth): on /health press Disconnect, then Connect Google Calendar.";
  if (error === "calendar_missing") return "The Onyx care calendar is gone from Google (calendar_missing): on /health press Disconnect, then Connect again.";
  const items = failed > 0 ? `, ${failed} item${failed === 1 ? "" : "s"} not written` : "";
  return `Last sync failed (${error})${items}. It is retried at the next change, by Sync now and by the catch-up run.`;
}

function hoursBetween(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 3_600_000) : Infinity;
}

/**
 * The card. Not set up or not connected reads "unknown" with the next step, never red: nothing is
 * broken, it is simply not turned on. Once connected, the age of the last sync and its result
 * decide: a failed sync is red with what to do; a good one ages to degraded after 14 h and red
 * after 30 h (the catch-up is not running).
 */
export function careCalendarCard(p: {
  configured: boolean;
  row: CareCalendarSyncRow | null;
  readError: { code?: string | null; message?: string | null } | null;
  nowMs: number;
}): CareCalendarCard {
  const base: CareCalendarCard = {
    label: LABEL, lastSync: null, status: "unknown", latestDataDate: null, daysLag: 999, recordsSynced: 0, durationSeconds: null, errorMessage: null,
  };
  if (!p.configured) {
    return { ...base, label: `${LABEL} (not set up)`, errorMessage: `Not set up: a Google OAuth client and two Vercel variables (${DOC}), then Connect on /health.` };
  }
  if (p.readError) {
    const c = code(p.readError.code);
    if (c === "PGRST205" || c === "42P01") return { ...base, errorMessage: "Sync table missing: apply sql/care_calendar_sync_schema.sql." };
    return { ...base, status: "failed", errorMessage: `Could not read the sync state (${c}).` };
  }
  const row = p.row;
  if (!row?.calendar_id || !row.connected_at) {
    return { ...base, label: `${LABEL} (not connected)`, errorMessage: "Not connected: press Connect Google Calendar on /health." };
  }

  if (!row.last_sync_at) {
    const sinceConnect = hoursBetween(row.connected_at, p.nowMs);
    const status = sinceConnect > CARE_CALENDAR_FAILED_HOURS ? "failed" : sinceConnect > CARE_CALENDAR_DEGRADED_HOURS ? "partial" : "unknown";
    return {
      ...base,
      status,
      errorMessage: status === "unknown"
        ? "Connected; no sync has run yet."
        : `No sync since connecting ${Math.floor(sinceConnect)}h ago: check ${CATCH_UP}.`,
    };
  }

  const ageH = hoursBetween(row.last_sync_at, p.nowMs);
  const counts = row.last_sync_counts;
  const card: CareCalendarCard = {
    ...base,
    lastSync: row.last_sync_at,
    latestDataDate: row.last_sync_at.slice(0, 10),
    daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
    recordsSynced: count(counts, "created") + count(counts, "updated") + count(counts, "removed"),
  };
  if (row.last_sync_ok !== true) {
    return { ...card, status: "failed", errorMessage: failureMessage(code(row.last_error), count(counts, "failed")) };
  }
  if (ageH > CARE_CALENDAR_FAILED_HOURS) return { ...card, status: "failed", errorMessage: `No sync for ${Math.floor(ageH)}h: check ${CATCH_UP}.` };
  if (ageH > CARE_CALENDAR_DEGRADED_HOURS) return { ...card, status: "partial", errorMessage: `No sync for ${Math.floor(ageH)}h: check ${CATCH_UP}.` };
  return { ...card, status: "success" };
}
