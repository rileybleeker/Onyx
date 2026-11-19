import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SCREEN_TIME_COLUMNS, shapeScreenRows, windowStart, type ScreenDay } from "@/lib/screen-time";
import { AI_USAGE_COLUMNS, aiIncompleteHint, fetchAllAiRows, summarizeAi, type AiSection, type AiSync } from "@/lib/ai-usage";
import { PC_VIEW_COLUMNS, summarizePc, type PcSection } from "@/lib/pc-activity-view";

/**
 * Server-side read of pds.phone_usage_daily for /screen-time. SERVICE ROLE ONLY: the phone_usage_*
 * tables and this view have RLS on and no grants to anon / authenticated (they hold every app used,
 * hour by hour), so the browser can never query them and this module must never be imported from a
 * client component ("server-only" enforces that at build time). The caller (app/screen-time/page.tsx)
 * sits behind the owner-only middleware and renders per request - no ISR, no shared cache.
 *
 * The query lists its columns. Nothing here logs row contents: a failure logs an error code only.
 *
 * The same Promise.all reads pds.ai_tool_usage_daily (owner read + service role) for the "AI tools" section and
 * reduces it to aggregates right here (lib/ai-usage.ts). That section has its own states: an AI query failure
 * or an empty AI window never changes the page's kind, which phone_usage_daily alone decides.
 *
 * Likewise pds.pc_activity_daily (service role only) for the "PC" section, reduced by lib/pc-activity-view.ts,
 * with its own empty and error states.
 */

const HEARTBEAT_COLS = "status,sync_start";
/** One row per day, so the largest window (180 days) fits well inside this. */
const MAX_ROWS = 400;

export type ScreenSync = AiSync;

export type ScreenTimeLoad =
  | { kind: "error"; hint: string }
  | { kind: "empty"; windowDays: number; sync: ScreenSync | null; ai: AiSection; pc: PcSection }
  | { kind: "ok"; windowDays: number; days: ScreenDay[]; skippedRows: number; sync: ScreenSync | null; ai: AiSection; pc: PcSection };

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

function aiFail(code: string | null): AiSection {
  // Only the error code is logged - never a row, a project name or a number of minutes.
  console.error("[/screen-time] ai usage query failed", code ?? "unexpected");
  const missing = code === "42P01" || code === "PGRST205" || code === "42501";
  return {
    kind: "error",
    hint: missing
      ? `The AI tool usage table is missing or not readable by the server (code ${code}).`
      : code
        ? `The AI tool usage query failed (code ${code}). Try again in a moment.`
        : "An unexpected error occurred reading AI tool usage. Try again in a moment.",
  };
}

function pcFail(code: string | null): PcSection {
  // Only the error code is logged - never a row, a program name or a number of minutes.
  console.error("[/screen-time] pc activity query failed", code ?? "unexpected");
  const missing = code === "42P01" || code === "PGRST205" || code === "42501";
  return {
    kind: "error",
    hint: missing
      ? `The PC activity view is missing or not readable by the server (code ${code}).`
      : code
        ? `The PC activity query failed (code ${code}). Try again in a moment.`
        : "An unexpected error occurred reading PC activity. Try again in a moment.",
  };
}

/** The newest heartbeat row, or null; a failed heartbeat read just omits the freshness line. */
function syncFrom(beat: { error: unknown; data: unknown[] | null }): ScreenSync | null {
  const row = beat.error ? null : ((beat.data?.[0] as { status?: unknown; sync_start?: unknown } | undefined) ?? null);
  return row
    ? {
        status: typeof row.status === "string" ? row.status : null,
        at: typeof row.sync_start === "string" ? row.sync_start : null,
      }
    : null;
}

export async function loadScreenTime(windowDays: number, now: Date = new Date()): Promise<ScreenTimeLoad> {
  const client = db();
  if (!client) return fail("not-configured");
  try {
    const start = windowStart(now, windowDays);
    const [usage, beat, aiUsage, aiBeat, pcUsage, pcBeat] = await Promise.all([
      client
        .from("phone_usage_daily")
        .select(SCREEN_TIME_COLUMNS)
        .gte("behavioral_date", start)
        .order("behavioral_date", { ascending: true })
        .limit(MAX_ROWS),
      client
        .from("sync_log")
        .select(HEARTBEAT_COLS)
        .eq("source", "screen_time")
        .eq("data_type", "usage")
        .order("sync_start", { ascending: false })
        .limit(1),
      // Every row of the window, paged over the table's unique key and checked against the exact count
      // (a single capped select dropped the newest rows once a window outgrew it: Codex AI814-1).
      fetchAllAiRows((from, to) =>
        client
          .from("ai_tool_usage_daily")
          .select(AI_USAGE_COLUMNS, { count: "exact" })
          .gte("behavioral_date", start)
          .order("behavioral_date", { ascending: true })
          .order("device", { ascending: true })
          .order("tool", { ascending: true })
          .order("project", { ascending: true })
          .range(from, to)
          .then((r) => ({
            data: (r.data ?? null) as unknown[] | null,
            error: r.error ? { code: r.error.code ?? null } : null,
            count: r.count ?? null,
          })),
      ),
      client
        .from("sync_log")
        .select(HEARTBEAT_COLS)
        .eq("source", "ai_usage")
        .eq("data_type", "sessions")
        .order("sync_start", { ascending: false })
        .limit(1),
      // One row per behavioral day, so MAX_ROWS covers the largest window.
      client
        .from("pc_activity_daily")
        .select(PC_VIEW_COLUMNS)
        .gte("behavioral_date", start)
        .order("behavioral_date", { ascending: true })
        .limit(MAX_ROWS),
      client
        .from("sync_log")
        .select(HEARTBEAT_COLS)
        .eq("source", "pc_activity")
        .eq("data_type", "usage")
        .order("sync_start", { ascending: false })
        .limit(1),
    ]);
    if (usage.error) return fail(usage.error.code ?? "unknown");
    // The freshness line is context, not the data: a failed heartbeat read just omits it.
    const sync = syncFrom({ error: beat.error, data: (beat.data ?? null) as unknown[] | null });
    const aiSync = syncFrom({ error: aiBeat.error, data: (aiBeat.data ?? null) as unknown[] | null });
    let ai: AiSection;
    if (aiUsage.kind === "error") {
      ai = aiFail(aiUsage.code);
    } else if (aiUsage.kind === "incomplete") {
      // Counts only in the log, never a row.
      console.error("[/screen-time] ai usage read incomplete", aiUsage.reason, aiUsage.fetched, aiUsage.total);
      ai = { kind: "error", hint: aiIncompleteHint(aiUsage) };
    } else {
      const summary = summarizeAi(aiUsage.rows);
      ai = summary.kind === "ok" ? { ...summary, sync: aiSync } : { kind: "empty", sync: aiSync };
    }
    let pc: PcSection;
    if (pcUsage.error) {
      pc = pcFail(pcUsage.error.code ?? null);
    } else {
      const pcSync = syncFrom({ error: pcBeat.error, data: (pcBeat.data ?? null) as unknown[] | null });
      const summary = summarizePc((pcUsage.data ?? []) as unknown[]);
      pc = summary.kind === "ok" ? { ...summary, sync: pcSync } : { kind: "empty", sync: pcSync };
    }
    const raw = (usage.data ?? []) as unknown[];
    const days = shapeScreenRows(raw);
    if (days.length === 0) return { kind: "empty", windowDays, sync, ai, pc };
    return { kind: "ok", windowDays, days, skippedRows: raw.length - days.length, sync, ai, pc };
  } catch {
    return fail(null);
  }
}
