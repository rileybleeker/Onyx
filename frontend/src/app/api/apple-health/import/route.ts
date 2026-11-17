import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  HEALTH_METRICS,
  healthFailureMessage,
  parseHourly,
  parseMind,
  parseWorkouts,
  text,
} from "@/lib/apple-health";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

export const dynamic = "force-dynamic";

/**
 * POST /api/apple-health/import
 *
 * Receives Apple Health data from the Onyx iPhone app (tools/screentime_ios, HealthKit),
 * which reads it only while the phone is unlocked (a Shortcuts "when Onyx is opened"
 * automation runs the "Sync Apple Health to Onyx" action). Tables: sql/apple_health_schema.sql.
 *
 * Body:
 *   device       optional, default "iphone"
 *   app_version  optional
 *   hourly[]     { metric, start, value, samples? }   metric in HEALTH_METRICS; one row per
 *                metric and hour: a SUM for steps / distance / flights / mindful seconds, an
 *                AVERAGE (with samples) for walking speed / steadiness / headphone level
 *   workouts[]   { uuid, type, start, end, duration_s, distance_m?, energy_kcal?, source? }
 *   mind[]       { uuid, at, kind, valence (-1..1), labels?, associations? }
 *   denied[]     metric names the phone has no Health permission for (-> a partial heartbeat)
 *   failure      { stage, message } instead of data: a failed heartbeat (stage in
 *                HEALTH_FAILURE_STAGES)
 *
 * Re-sending overwrites by key (hour / workout uuid / sample uuid), so the app can safely
 * re-send the last days on every run; the current hour keeps growing until it ends.
 * Never stored: raw samples, locations, routes, device names of samples.
 *
 * Auth: a browser session, or the `x-onyx-ci-token` header (middleware carve-out; exact path,
 * the app keeps the token in the iPhone Keychain). Heartbeat apple_health|samples on every
 * call. GET returns the newest 7 daily rows (setup check).
 */

const CHUNK = 1000;

async function heartbeat(startedAt: Date, status: "success" | "partial" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: "apple_health",
    data_type: "samples",
    status,
    records_synced: records,
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    duration_seconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    error_message: error,
  });
  if (e) console.error("apple_health heartbeat failed:", e.message);
}

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  // A rejected upload is a failed sync: log it so /status goes red now. The heartbeat gets a
  // generic reason (sync_log is owner-readable, the health tables are service-role only).
  const reject = async (error: string, reason: string) => {
    await heartbeat(startedAt, "failed", 0, `Rejected upload: ${reason}`);
    return NextResponse.json({ error, logged: true }, { status: 400 });
  };

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reject("Body must be a JSON object", "body was not a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return reject("Body must be JSON", "body was not JSON");
  }

  if (body.failure !== undefined && body.failure !== null) {
    await heartbeat(startedAt, "failed", 0, healthFailureMessage(body.failure, body.app_version));
    return NextResponse.json({ ok: true, recorded: "failed" });
  }

  const now = Date.now();
  const device = text(body.device, 60) ?? "iphone";
  const hourly = parseHourly(body.hourly, device, now);
  const workouts = parseWorkouts(body.workouts, device, now);
  const mind = parseMind(body.mind, device, now);
  for (const part of [hourly, workouts, mind]) {
    if (!part.ok) return reject(`Bad upload: ${part.reason}`, part.reason);
  }
  if (!hourly.ok || !workouts.ok || !mind.ok) return reject("Bad upload", "invalid parts");

  const denied = Array.isArray(body.denied)
    ? [...new Set((body.denied as unknown[]).filter((m): m is string => typeof m === "string" && m in HEALTH_METRICS))]
    : [];
  const syncedAt = new Date(now).toISOString();

  try {
    const writes: Array<[string, Record<string, unknown>[], string]> = [
      ["apple_health_hourly", hourly.rows.map((r) => ({ ...r, synced_at: syncedAt })), "device,metric,hour_start"],
      ["apple_health_workouts", workouts.rows.map((r) => ({ ...r, synced_at: syncedAt })), "workout_uuid"],
      ["apple_health_mind", mind.rows.map((r) => ({ ...r, synced_at: syncedAt })), "sample_uuid"],
    ];
    for (const [table, rows, onConflict] of writes) {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await supabase.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
        if (error) throw new Error(`${table}: ${error.message}`);
      }
    }
    const records = hourly.rows.length + workouts.rows.length + mind.rows.length;
    await heartbeat(
      startedAt,
      denied.length ? "partial" : "success",
      records,
      denied.length ? `No Health permission for: ${denied.join(", ")}. Allow it in Settings > Health > Data Access > the app.` : null,
    );
    return NextResponse.json({
      ok: true,
      hourly: hourly.rows.length,
      workouts: workouts.rows.length,
      mind: mind.rows.length,
      denied,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("apple-health import write failed:", message);
    await heartbeat(startedAt, "failed", 0, message);
    return NextResponse.json({ error: message, logged: true }, { status: 500 });
  }
}

// Every column of pds.apple_health_daily, listed so a new column does not appear here unnoticed.
const SETUP_CHECK_COLUMNS =
  "behavioral_date,steps,distance_m,flights_climbed,mindful_minutes,walking_speed_ms,walking_steadiness_pct," +
  "headphone_db_avg,headphone_db_hour_max,hours_reported,synced_at,workouts,workout_minutes,workout_kcal," +
  "mind_entries,mind_valence_avg,mind_valence_min";

export async function GET() {
  const { data, error } = await supabase
    .from("apple_health_daily")
    .select(SETUP_CHECK_COLUMNS)
    .order("behavioral_date", { ascending: false })
    .limit(7);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ daily: data });
}
