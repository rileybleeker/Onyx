import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  AIR_QUALITY_COLUMNS,
  AIR_QUALITY_WINDOW_DAYS,
  parseAirRow,
  shapeAirRows,
  type AirDay,
  type AirLocation,
} from "@/lib/air-quality";

/**
 * Server-side read of pds.air_quality_daily. SERVICE ROLE ONLY: the table has RLS on and no
 * grants to anon / authenticated; "server-only" keeps this out of client bundles. The caller
 * (/api/air-quality) sits behind the owner-only middleware. Errors log a code only.
 */

function airDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AirQualityLoad =
  | { state: "ready"; rows: AirDay[]; location: AirLocation | null }
  | { state: "not_connected" }
  | { state: "error" };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

function etDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export async function loadAirQuality(now: Date = new Date()): Promise<AirQualityLoad> {
  const since = etDate(new Date(now.getTime() - (AIR_QUALITY_WINDOW_DAYS - 1) * 86_400_000));
  const res = await airDb().from("air_quality_daily").select(AIR_QUALITY_COLUMNS)
    .gte("calendar_date", since)
    .order("calendar_date", { ascending: true })
    .limit(200);
  if (res.error) {
    const code = res.error.code ?? "";
    if (MISSING_TABLE.has(code)) return { state: "not_connected" };
    console.error("air quality read failed:", code || "unknown");
    return { state: "error" };
  }
  const data = (res.data ?? []) as unknown[];
  let location: AirLocation | null = null;
  for (const raw of data) {
    const p = parseAirRow(raw);
    if (p && p.lat !== null && p.lon !== null) location = { lat: p.lat, lon: p.lon };
  }
  return { state: "ready", rows: shapeAirRows(data), location };
}
