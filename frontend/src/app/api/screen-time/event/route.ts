import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * POST /api/screen-time/event
 *
 * Receives iPhone app open/close events from an iOS Shortcuts personal
 * automation ("App → Is Opened / Is Closed", every app ticked, Run
 * Immediately). Apple exposes no Screen Time data off-device and Opal has no
 * export, so this event stream is the only automatable screen-time signal.
 * Rows land in pds.phone_app_events; pds.phone_app_sessions pairs them and
 * pds.phone_screen_daily rolls them up per behavioral day.
 *
 * Body (one event, or { events: [...] }):
 *   event  "opened" | "closed"   (also accepts "open", "Is Opened", ...)
 *   app    optional app name — NULL when iOS doesn't pass the triggering app
 *   time   optional ISO-8601 phone timestamp (Shortcuts "Current Date",
 *          ISO 8601 format); falls back to server receive time
 *   device optional, default "iphone"
 *
 * Auth: a browser session, or the `x-onyx-ci-token` header (middleware
 * carve-out — the Shortcut on the phone sends the header).
 *
 * GET returns the latest 25 events + the newest 7 daily rows (setup check).
 */

interface EventInput {
  event?: unknown;
  app?: unknown;
  time?: unknown;
  device?: unknown;
}

const MAX_FUTURE_MS = 10 * 60_000;
const MAX_AGE_MS = 7 * 86_400_000;

function normalizeEvent(v: unknown): "opened" | "closed" | null {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("open")) return "opened";
  if (s.includes("clos")) return "closed";
  return null;
}

function normalizeApp(v: unknown): string | null {
  const s = String(v ?? "").trim();
  // Shortcuts sends "" for an empty variable; treat placeholders as unknown.
  if (!s || s.toLowerCase() === "shortcut input" || s.toLowerCase() === "null") return null;
  return s.slice(0, 120);
}

function resolveTime(v: unknown, now: number): { iso: string; source: "client" | "server" } {
  if (v) {
    const t = new Date(String(v)).getTime();
    if (Number.isFinite(t) && t <= now + MAX_FUTURE_MS && t >= now - MAX_AGE_MS) {
      return { iso: new Date(t).toISOString(), source: "client" };
    }
  }
  return { iso: new Date(now).toISOString(), source: "server" };
}

export async function POST(req: NextRequest) {
  let body: EventInput & { events?: EventInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const inputs = Array.isArray(body.events) ? body.events : [body];
  if (inputs.length === 0 || inputs.length > 500) {
    return NextResponse.json({ error: "Send 1-500 events" }, { status: 400 });
  }

  const now = Date.now();
  const rows = [];
  for (const raw of inputs) {
    const event = normalizeEvent(raw.event);
    if (!event) {
      return NextResponse.json({ error: `Unknown event ${JSON.stringify(raw.event)} (expected opened|closed)` }, { status: 400 });
    }
    const t = resolveTime(raw.time, now);
    rows.push({
      event_time: t.iso,
      time_source: t.source,
      event,
      app: normalizeApp(raw.app),
      device: normalizeApp(raw.device) ?? "iphone",
      raw_json: raw,
    });
  }

  const { error } = await supabase
    .from("phone_app_events")
    .upsert(rows, { onConflict: "device,event_time,event,app", ignoreDuplicates: true });
  if (error) {
    console.error("screen-time event insert failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, received: rows.length });
}

export async function GET() {
  const [events, daily] = await Promise.all([
    supabase
      .from("phone_app_events")
      .select("event_time, event, app, device, time_source, onyx_behavioral_date")
      .order("event_time", { ascending: false })
      .limit(25),
    supabase
      .from("phone_screen_daily")
      .select("*")
      .order("behavioral_date", { ascending: false })
      .limit(7),
  ]);
  if (events.error || daily.error) {
    return NextResponse.json({ error: (events.error ?? daily.error)!.message }, { status: 500 });
  }
  return NextResponse.json({ events: events.data, daily: daily.data });
}
