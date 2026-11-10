import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
  let body: { device?: unknown; device_name?: unknown; device_model?: unknown; segments?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const inputs = Array.isArray(body.segments) ? (body.segments as SegmentInput[]) : null;
  if (!inputs || inputs.length > MAX_SEGMENTS) {
    return NextResponse.json({ error: `Send segments[] with 0-${MAX_SEGMENTS} entries` }, { status: 400 });
  }

  const device = text(body.device, 60) ?? "iphone";
  const deviceName = text(body.device_name, 120);
  const deviceModel = text(body.device_model, 60);
  const now = Date.now();

  // Key by hour start so a duplicate in one payload cannot hit the same row
  // twice in a single upsert statement (Postgres rejects that).
  const segments = new Map<string, Record<string, unknown>>();
  const items = new Map<string, Record<string, unknown>>();

  for (const raw of inputs) {
    const start = iso(raw.start);
    const end = iso(raw.end);
    const total = num(raw.total_seconds);
    if (!start || !end || total === null || total < 0) {
      return NextResponse.json({ error: `Bad segment ${JSON.stringify(raw).slice(0, 200)}` }, { status: 400 });
    }
    const startMs = new Date(start).getTime();
    if (new Date(end).getTime() <= startMs || startMs > now + MAX_FUTURE_MS || startMs < now - MAX_AGE_MS) {
      return NextResponse.json({ error: `Segment out of range: ${start} → ${end}` }, { status: 400 });
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
      });
    }
  }

  if (items.size > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items (${items.size}); send fewer days per request` }, { status: 400 });
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
    await heartbeat(startedAt, "success", segRows.length, null);
    return NextResponse.json({ ok: true, segments: segRows.length, items: itemRows.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("screen-time usage write failed:", message);
    await heartbeat(startedAt, "failed", 0, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const [daily, hours] = await Promise.all([
    supabase.from("phone_usage_daily").select("*").order("behavioral_date", { ascending: false }).limit(7),
    supabase
      .from("phone_usage_segments")
      .select("device, segment_start, segment_end, total_seconds, first_pickup, onyx_behavioral_date, synced_at")
      .order("segment_start", { ascending: false })
      .limit(24),
  ]);
  if (daily.error || hours.error) {
    return NextResponse.json({ error: (daily.error ?? hours.error)!.message }, { status: 500 });
  }
  return NextResponse.json({ daily: daily.data, hours: hours.data });
}
