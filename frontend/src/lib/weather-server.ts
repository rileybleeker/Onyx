import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  WEATHER_COLUMNS,
  WEATHER_WINDOW_DAYS,
  parseWeatherRow,
  shapeWeatherRows,
  type WeatherDay,
  type WeatherLocation,
} from "@/lib/weather";

/**
 * Server-side read of pds.weather_daily. SERVICE ROLE ONLY: the table has RLS on and no
 * grants to anon / authenticated; "server-only" keeps this out of client bundles. The caller
 * (/api/weather) sits behind the owner-only middleware. Errors log a code only.
 */

function weatherDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type WeatherLoad =
  | { state: "ready"; rows: WeatherDay[]; location: WeatherLocation | null }
  | { state: "not_connected" }
  | { state: "error" };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

function etDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export async function loadWeather(now: Date = new Date()): Promise<WeatherLoad> {
  const since = etDate(new Date(now.getTime() - (WEATHER_WINDOW_DAYS - 1) * 86_400_000));
  const res = await weatherDb().from("weather_daily").select(WEATHER_COLUMNS)
    .gte("calendar_date", since)
    .order("calendar_date", { ascending: true })
    .limit(200);
  if (res.error) {
    const code = res.error.code ?? "";
    if (MISSING_TABLE.has(code)) return { state: "not_connected" };
    console.error("weather read failed:", code || "unknown");
    return { state: "error" };
  }
  const data = (res.data ?? []) as unknown[];
  let location: WeatherLocation | null = null;
  for (const raw of data) {
    const p = parseWeatherRow(raw);
    if (p && p.lat !== null && p.lon !== null) location = { lat: p.lat, lon: p.lon };
  }
  return { state: "ready", rows: shapeWeatherRows(data), location };
}
