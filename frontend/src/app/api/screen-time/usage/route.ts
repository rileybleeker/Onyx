import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { chunkRow, itemCountsBySegment, parseUploadRun, runStatusOf, segmentInWindow } from "@/lib/screen-time-upload";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/screen-time/usage
 *
 * Receives hourly Screen Time usage from the Onyx Screen Time iPhone app
 * (tools/screentime_ios), which reads Apple's iOS 26.4 export API
 * (DeviceActivityData.activityData). One segment = one hour on one device,
 * with the apps and web domains used in it.
 *
 * Body:
 *   device        optional, default "iphone"
 *   device_name   optional
 *   device_model  optional
 *   segments[]    { start, end, total_seconds, first_pickup?, pickups_without_app?,
 *                   longest_start?, longest_end?,
 *                   items[]: { kind: "app"|"web", identifier, name?, category?,
 *                              seconds, pickups?, notifications? } }
 *
 * Re-sending an hour overwrites it (the current hour keeps growing until it
 * ends), so the app can safely re-send the last few days on every run.
 *
 * Failure report (2026-11-11): the app POSTs `{ app_version?, failure: { stage,
 * message } }` (no segments) when a sync breaks before or while sending, with
 * stage one of FAILURE_STAGES. It becomes a failed screen_time|usage heartbeat,
 * so /status turns red at once instead of after the 36 h age-out. A rejected
 * upload (400) and a database error (500) log a failed heartbeat here too and
 * answer `logged: true`, which tells the app not to report the same failure
 * again. A missing or refused token never reaches this route (middleware 401),
 * so those failures still surface only through the age-out.
 *
 * Completeness (PIPE-11, 2026-11-16, sql/phone_usage_completeness.sql): app
 * builds from 2026-11-16 also send `run` (lib/screen-time-upload.ts) with every
 * chunk. The hours are written first, then the chunk is recorded in
 * pds.phone_usage_sync_chunks and pds.finalize_phone_usage_run marks the run's
 * hours verified once every chunk arrived and Apple's stream ended on its own;
 * the answer then carries `completeness` (the run's status). A watchdog stop, a
 * missing chunk or an app stopped halfway leaves the hours unverified. A body
 * without `run` (older builds) is stored exactly as before and stays
 * unverified: completeness unknown, never complete. A malformed `run` is a
 * rejected upload (400), like a malformed segment.
 *
 * Auth: a browser session, or the `x-onyx-ci-token` header (middleware
 * carve-out — the app stores the token in the iPhone Keychain).
 *
 * GET returns the newest 7 daily rows + the newest 24 hours (setup check).
 */

interface ItemInput {
  kind?: unknown;
  identifier?: unknown;
  name?: unknown;
  category?: unknown;
  seconds?: unknown;
  pickups?: unknown;
  notifications?: unknown;
}

interface SegmentInput {
  start?: unknown;
  end?: unknown;
  total_seconds?: unknown;
  first_pickup?: unknown;
  pickups_without_app?: unknown;
  longest_start?: unknown;
  longest_end?: unknown;
  items?: unknown;
}

const MAX_SEGMENTS = 800; // 33 days of hours
const MAX_ITEMS = 20_000;
const MAX_FUTURE_MS = 2 * 3_600_000;
const MAX_AGE_MS = 400 * 86_400_000;
const CHUNK = 1000;

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
}

function text(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

// Where a sync can break on the phone (tools/screentime_ios SyncService.swift SyncStage).
const FAILURE_STAGES = ["access", "read", "encode", "network", "http"] as const;

/** The heartbeat text for an app failure report. Never echoes usage data. */
function failureMessage(failure: unknown, appVersion: unknown): string {
  const f = failure && typeof failure === "object" ? (failure as { stage?: unknown; message?: unknown }) : {};
  const stage = (FAILURE_STAGES as readonly unknown[]).includes(f.stage) ? (f.stage as string) : "unknown";
  const version = text(appVersion, 40);
  return `iPhone app sync failed (${stage}): ${text(f.message, 300) ?? "no detail"}${version ? ` [app ${version}]` : ""}`;
}

async function heartbeat(startedAt: Date, status: "success" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: "screen_time",
    data_type: "usage",
    status,
    records_synced: records,
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    duration_seconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    error_message: error,
  });
  if (e) console.error("screen_time heartbeat failed:", e.message);
}

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  // A rejected upload is a failed sync: log it, so /status goes red now. The
  // heartbeat gets a generic reason (sync_log is owner-readable, the usage
  // tables are service-role only); the detailed error goes back to the app.
  const reject = async (error: string, reason: string) => {
    await heartbeat(startedAt, "failed", 0, `Rejected upload: ${reason}`);
    return NextResponse.json({ error, logged: true }, { status: 400 });
  };

  let body: {
    device?: unknown; device_name?: unknown; device_model?: unknown; segments?: unknown;
    app_version?: unknown; failure?: unknown; run?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return reject("Body must be JSON", "body was not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reject("Body must be a JSON object", "body was not a JSON object");
  }

  if (body.failure !== undefined && body.failure !== null) {
    if (Array.isArray(body.segments) && body.segments.length > 0) {
      return reject("Send a failure report without segments", "failure report carried segments");
    }
    await heartbeat(startedAt, "failed", 0, failureMessage(body.failure, body.app_version));
    return NextResponse.json({ ok: true, recorded: "failed" });
  }

  const inputs = Array.isArray(body.segments) ? (body.segments as SegmentInput[]) : null;
  if (!inputs || inputs.length > MAX_SEGMENTS) {
    return reject(
      `Send segments[] with 0-${MAX_SEGMENTS} entries`,
      inputs ? `${inputs.length} segments (limit ${MAX_SEGMENTS})` : "no segments[] array",
    );
  }

  const device = text(body.device, 60) ?? "iphone";
  const deviceName = text(body.device_name, 120);
  const deviceModel = text(body.device_model, 60);
  const now = Date.now();

  // Completeness metadata: absent = an older app build (hours stay unverified).
  const parsedRun = parseUploadRun(body.run, now, { maxFutureMs: MAX_FUTURE_MS, maxAgeMs: MAX_AGE_MS });
  if (parsedRun.kind === "bad") {
    return reject(`Bad run metadata: ${parsedRun.reason}`, `completeness metadata invalid (${parsedRun.reason})`);
  }
  const run = parsedRun.kind === "ok" ? parsedRun.run : null;
  if (run && inputs.length === 0) {
    return reject("A run chunk needs at least one segment", "a run chunk carried no segments");
  }

  // Key by hour start so a duplicate in one payload cannot hit the same row
  // twice in a single upsert statement (Postgres rejects that).
  const segments = new Map<string, Record<string, unknown>>();
  const items = new Map<string, Record<string, unknown>>();

  for (const raw of inputs) {
    const start = iso(raw.start);
    const end = iso(raw.end);
    const total = num(raw.total_seconds);
    if (!start || !end || total === null || total < 0) {
      return reject(`Bad segment ${JSON.stringify(raw).slice(0, 200)}`, "a segment lacks a valid start, end or total_seconds");
    }
    const startMs = new Date(start).getTime();
    if (new Date(end).getTime() <= startMs || startMs > now + MAX_FUTURE_MS || startMs < now - MAX_AGE_MS) {
      return reject(`Segment out of range: ${start} → ${end}`, "a segment is outside the accepted time range");
    }
    if (run && !segmentInWindow(startMs, new Date(end).getTime(), run)) {
      return reject(`Segment outside the run window: ${start} → ${end}`, "a segment is outside its run's window");
    }
    segments.set(start, {
      device,
      segment_start: start,
      segment_end: end,
      total_seconds: Math.round(total * 10) / 10,
      first_pickup: iso(raw.first_pickup),
      pickups_without_app: int(raw.pickups_without_app),
      longest_activity_start: iso(raw.longest_start),
      longest_activity_end: iso(raw.longest_end),
      device_name: deviceName,
      device_model: deviceModel,
      synced_at: new Date(now).toISOString(),
      // Provenance, always sent so an older build's upload clears a run's claim on the hour.
      last_run_id: run?.runId ?? null,
      last_run_item_count: null as number | null,
      last_export_at: run?.windowEnd ?? null,
    });

    for (const it of Array.isArray(raw.items) ? (raw.items as ItemInput[]) : []) {
      const kind = it.kind === "web" ? "web" : it.kind === "app" ? "app" : null;
      const identifier = text(it.identifier, 200);
      const seconds = num(it.seconds);
      if (!kind || !identifier || seconds === null || seconds < 0) continue;
      const key = `${start}|${kind}|${identifier}`;
      const prev = items.get(key);
      items.set(key, {
        device,
        segment_start: start,
        kind,
        identifier,
        name: text(it.name, 200) ?? (prev?.name as string | null) ?? null,
        category: text(it.category, 120) ?? (prev?.category as string | null) ?? null,
        seconds: Math.round((seconds + ((prev?.seconds as number) ?? 0)) * 10) / 10,
        pickups: kind === "app" ? (int(it.pickups) ?? 0) + ((prev?.pickups as number) ?? 0) : null,
        notifications: kind === "app" ? (int(it.notifications) ?? 0) + ((prev?.notifications as number) ?? 0) : null,
        last_run_id: run?.runId ?? null,
      });
    }
  }

  if (items.size > MAX_ITEMS) {
    return reject(`Too many items (${items.size}); send fewer days per request`, `${items.size} items (limit ${MAX_ITEMS})`);
  }
  if (run) {
    if (segments.size > run.segmentCount) {
      return reject("The chunk has more hours than its run", "a run chunk has more hours than its run");
    }
    // The run's claim per hour: the finalization verifies an hour only while all of these are still its own.
    const counts = itemCountsBySegment(items.values());
    for (const [start, row] of segments) row.last_run_item_count = counts.get(start) ?? 0;
  }

  try {
    const segRows = [...segments.values()];
    for (let i = 0; i < segRows.length; i += CHUNK) {
      const { error } = await supabase
        .from("phone_usage_segments")
        .upsert(segRows.slice(i, i + CHUNK), { onConflict: "device,segment_start" });
      if (error) throw new Error(`segments: ${error.message}`);
    }
    const itemRows = [...items.values()];
    for (let i = 0; i < itemRows.length; i += CHUNK) {
      const { error } = await supabase
        .from("phone_usage_items")
        .upsert(itemRows.slice(i, i + CHUNK), { onConflict: "device,segment_start,kind,identifier" });
      if (error) throw new Error(`items: ${error.message}`);
    }
    if (!run) {
      await heartbeat(startedAt, "success", segRows.length, null);
      return NextResponse.json({ ok: true, segments: segRows.length, items: itemRows.length });
    }
    // Acknowledge the chunk only now that its hours and items are stored, then let the database decide.
    const ack = chunkRow(device, run, segRows as Array<{ segment_start: string; segment_end: string }>, text(body.app_version, 40));
    const { error: chunkError } = await supabase
      .from("phone_usage_sync_chunks")
      .upsert(ack, { onConflict: "device,run_id,chunk_index" });
    if (chunkError) throw new Error(`chunk: ${chunkError.message}`);
    const { data: finalized, error: finalizeError } = await supabase.rpc("finalize_phone_usage_run", {
      p_device: device,
      p_run_id: run.runId,
    });
    if (finalizeError) throw new Error(`finalize: ${finalizeError.message}`);
    const completeness = runStatusOf(finalized);
    const verified = Number((finalized as { hours_verified?: unknown } | null)?.hours_verified ?? 0);
    await heartbeat(startedAt, "success", segRows.length, null);
    return NextResponse.json({
      ok: true,
      segments: segRows.length,
      items: itemRows.length,
      completeness,
      hours_verified: Number.isFinite(verified) ? verified : 0,
      chunk: { index: run.chunkIndex, count: run.chunkCount },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("screen-time usage write failed:", message);
    await heartbeat(startedAt, "failed", 0, message);
    return NextResponse.json({ error: message, logged: true }, { status: 500 });
  }
}

// The setup check shows whole daily rows, so this is every column of
// pds.phone_usage_daily (checked against information_schema 2026-11-14), listed
// instead of a star select so a new column does not appear here unnoticed.
const SETUP_CHECK_DAILY_COLUMNS =
  "behavioral_date,hours_reported,total_minutes,late_night_minutes,after_midnight_minutes,pickups,notifications," +
  "apps_used,first_pickup,last_active_hour_end,sleep_start,minutes_last_hour_before_sleep_est,minutes_during_sleep_est," +
  "minutes_by_app,minutes_by_category,synced_at," +
  // appended by sql/phone_usage_completeness.sql (PIPE-11)
  "hours_verified,export_complete,completeness,pre_sleep_complete,during_sleep_complete";

export async function GET() {
  const [daily, hours] = await Promise.all([
    supabase.from("phone_usage_daily").select(SETUP_CHECK_DAILY_COLUMNS).order("behavioral_date", { ascending: false }).limit(7),
    supabase
      .from("phone_usage_segments")
      .select("device, segment_start, segment_end, total_seconds, first_pickup, onyx_behavioral_date, synced_at, verified_at")
      .order("segment_start", { ascending: false })
      .limit(24),
  ]);
  if (daily.error || hours.error) {
    return NextResponse.json({ error: (daily.error ?? hours.error)!.message }, { status: 500 });
  }
  return NextResponse.json({ daily: daily.data, hours: hours.data });
}
