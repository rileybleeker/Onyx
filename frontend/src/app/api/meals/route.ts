import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

const ALLOWED_KINDS = new Set(["last_meal", "first_meal", "snack", "other"]);

/**
 * GET /api/meals?days=N
 *
 * Returns the last N days of meal events (default 14), newest first.
 * Also returns the meal_timing_daily view rows for the same window so
 * the UI can render last_meal_hour and eating_window in one fetch.
 */
export async function GET(req: NextRequest) {
  const daysParam = req.nextUrl.searchParams.get("days");
  const days = Math.min(Math.max(parseInt(daysParam ?? "14", 10) || 14, 1), 365);

  // ET today as YYYY-MM-DD. Compute the cutoff date in JS so we don't
  // have to round-trip through Postgres for a simple subtraction.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const cutoff = new Date(today + "T00:00:00");
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const [eventsRes, timingRes] = await Promise.all([
    supabase
      .from("meal_events")
      .select("event_id,event_date,event_time,kind,notes")
      .gte("event_date", cutoffStr)
      .order("event_time", { ascending: false }),
    supabase
      .from("meal_timing_daily")
      .select("calendar_date,last_meal_time,first_meal_time,last_meal_hour,first_meal_hour,eating_window_hours,meal_event_count,last_meal_kind,last_meal_to_bedtime_minutes")
      .gte("calendar_date", cutoffStr)
      .order("calendar_date", { ascending: false }),
  ]);

  if (eventsRes.error) return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });
  if (timingRes.error) return NextResponse.json({ error: timingRes.error.message }, { status: 500 });

  return NextResponse.json({
    days,
    events: eventsRes.data ?? [],
    timing: timingRes.data ?? [],
  });
}

/**
 * POST /api/meals
 * Body: { event_date?, event_time?, kind?, notes? }
 *
 * event_date defaults to ET today; event_time defaults to "now" if omitted.
 * Both can be overridden so the user can log a past meal retroactively or
 * attribute a pre-bed late meal to the previous behavioral day.
 *
 * kind defaults to "last_meal" — the only kind we expose in the UI today.
 * Other kinds are allowed (first_meal, snack, other) for future use.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    event_date?: string;
    event_time?: string;
    kind?: string;
    notes?: string;
  };

  const kind = body.kind ?? "last_meal";
  if (!ALLOWED_KINDS.has(kind)) {
    return NextResponse.json({ error: `kind must be one of ${[...ALLOWED_KINDS].join(", ")}` }, { status: 400 });
  }

  const event_time = body.event_time ?? new Date().toISOString();
  // Validate the timestamp parses — Postgres will reject malformed input
  // but a 400 here is a better DX than a 500.
  if (Number.isNaN(new Date(event_time).getTime())) {
    return NextResponse.json({ error: "event_time must be a valid ISO timestamp" }, { status: 400 });
  }

  // Default to Riley's current behavioral day via pds.behavioral_today_now()
  // — TZ-aware (handles travel) + awake-tail-aware (-6h rule). The previous
  // ET-clock-today default broke for westbound trips and for awake-tail
  // post-midnight ET meals (which the /nutrition page partially compensated
  // for with a 00:00-04:00 ET special-case, now subsumed by the -6h rule).
  let event_date = body.event_date;
  if (!event_date) {
    try {
      const { data: bday } = await supabase.rpc("behavioral_today_now");
      event_date = bday || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch {
      event_date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
  }

  const row = {
    event_date,
    event_time,
    kind,
    notes: body.notes?.trim() ? body.notes.trim() : null,
  };

  const { data, error } = await supabase
    .from("meal_events")
    .insert(row)
    .select("event_id,event_date,event_time,kind,notes")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * PATCH /api/meals
 * Body: { event_id, event_date?, event_time?, kind?, notes? }
 *
 * Only fields explicitly present in the body are updated. Pass notes as
 * "" to clear it.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    event_id?: number;
    event_date?: string;
    event_time?: string;
    kind?: string;
    notes?: string | null;
  };

  if (!body.event_id || !Number.isFinite(body.event_id)) {
    return NextResponse.json({ error: "event_id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.event_date !== undefined) patch.event_date = body.event_date;
  if (body.event_time !== undefined) {
    if (Number.isNaN(new Date(body.event_time).getTime())) {
      return NextResponse.json({ error: "event_time must be a valid ISO timestamp" }, { status: 400 });
    }
    patch.event_time = body.event_time;
  }
  if (body.kind !== undefined) {
    if (!ALLOWED_KINDS.has(body.kind)) {
      return NextResponse.json({ error: `kind must be one of ${[...ALLOWED_KINDS].join(", ")}` }, { status: 400 });
    }
    patch.kind = body.kind;
  }
  if (body.notes !== undefined) {
    patch.notes = body.notes === null || body.notes.trim() === "" ? null : body.notes.trim();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("meal_events")
    .update(patch)
    .eq("event_id", body.event_id)
    .select("event_id,event_date,event_time,kind,notes")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/meals?event_id=N
 */
export async function DELETE(req: NextRequest) {
  const event_id = req.nextUrl.searchParams.get("event_id");
  if (!event_id) {
    return NextResponse.json({ error: "event_id is required" }, { status: 400 });
  }
  const { error } = await supabase
    .from("meal_events")
    .delete()
    .eq("event_id", event_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
