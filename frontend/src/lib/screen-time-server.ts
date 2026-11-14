import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SCREEN_TIME_COLUMNS, shapeScreenRows, windowStart, type ScreenDay } from "@/lib/screen-time";

/**
 * Server-side read of pds.phone_usage_daily for /screen-time. SERVICE ROLE ONLY: the phone_usage_*
 * tables and this view have RLS on and no grants to anon / authenticated (they hold every app used,
 * hour by hour), so the browser can never query them and this module must never be imported from a
 * client component ("server-only" enforces that at build time). The caller (app/screen-time/page.tsx)
 * sits behind the owner-only middleware and renders per request - no ISR, no shared cache.
 *
 * The query lists its columns. Nothing here logs row contents: a failure logs an error code only.
 */

const HEARTBEAT_COLS = "status,sync_start";
/** One row per day, so the largest window (180 days) fits well inside this. */
const MAX_ROWS = 400;

export interface ScreenSync {
  status: string | null;
  at: string | null;
}

export type ScreenTimeLoad =
  | { kind: "error"; hint: string }
  | { kind: "empty"; windowDays: number; sync: ScreenSync | null }
  | { kind: "ok"; windowDays: number; days: ScreenDay[]; skippedRows: number; sync: ScreenSync | null };

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(code: string | null): ScreenTimeLoad {
  // Only the error code is logged - never a row, an app name or a number of minutes.
  console.error("[/screen-time] usage query failed", code ?? "unexpected");
  const missing = code === "42P01" || code === "PGRST205" || code === "42501";
  return {
    kind: "error",
    hint: missing
      ? `The Screen Time view is missing or not readable by the server (code ${code}).`
      : code === "not-configured"
        ? "The server has no Supabase service credentials configured."
        : code
          ? `The database query failed (code ${code}). Try again in a moment.`
          : "An unexpected error occurred. Try again in a moment.",
  };
}

export async function loadScreenTime(windowDays: number, now: Date = new Date()): Promise<ScreenTimeLoad> {
  const client = db();
  if (!client) return fail("not-configured");
  try {
    const [usage, beat] = await Promise.all([
      client
        .from("phone_usage_daily")
        .select(SCREEN_TIME_COLUMNS)
        .gte("behavioral_date", windowStart(now, windowDays))
        .order("behavioral_date", { ascending: true })
        .limit(MAX_ROWS),
      client
        .from("sync_log")
        .select(HEARTBEAT_COLS)
        .eq("source", "screen_time")
        .eq("data_type", "usage")
        .order("sync_start", { ascending: false })
        .limit(1),
    ]);
    if (usage.error) return fail(usage.error.code ?? "unknown");
    // The freshness line is context, not the data: a failed heartbeat read just omits it.
    const row = beat.error ? null : ((beat.data?.[0] as { status?: unknown; sync_start?: unknown } | undefined) ?? null);
    const sync: ScreenSync | null = row
      ? {
          status: typeof row.status === "string" ? row.status : null,
          at: typeof row.sync_start === "string" ? row.sync_start : null,
        }
      : null;
    const raw = (usage.data ?? []) as unknown[];
    const days = shapeScreenRows(raw);
    if (days.length === 0) return { kind: "empty", windowDays, sync };
    return { kind: "ok", windowDays, days, skippedRows: raw.length - days.length, sync };
  } catch {
    return fail(null);
  }
}
