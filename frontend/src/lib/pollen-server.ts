import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  POLLEN_COLUMNS,
  POLLEN_ROW_LIMIT,
  POLLEN_WINDOW_DAYS,
  etDate,
  shapePollenRows,
  shiftDate,
  type PollenDay,
} from "@/lib/pollen";

/**
 * Server-side read of pds.pollen_daily. SERVICE ROLE ONLY: "server-only" keeps this out of
 * client bundles. The caller (/api/pollen) sits behind the owner-only middleware. Errors log a
 * code only. GET only: nothing is written.
 */

function pollenDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type PollenLoad =
  | { state: "ready"; rows: PollenDay[] }
  | { state: "not_connected" }
  | { state: "error" };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

export async function loadPollen(now: Date = new Date()): Promise<PollenLoad> {
  // Counts published in the last 730 ET days (count_date; the panel plots each on count_date - 1).
  const since = shiftDate(etDate(now), -(POLLEN_WINDOW_DAYS - 1));
  const res = await pollenDb().from("pollen_daily").select(POLLEN_COLUMNS)
    .gte("count_date", since)
    .order("count_date", { ascending: true })
    .limit(POLLEN_ROW_LIMIT);
  if (res.error) {
    const code = res.error.code ?? "";
    if (MISSING_TABLE.has(code)) return { state: "not_connected" };
    console.error("pollen read failed:", code || "unknown");
    return { state: "error" };
  }
  return { state: "ready", rows: shapePollenRows((res.data ?? []) as unknown[]) };
}
