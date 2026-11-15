import "server-only";
import { supabase } from "@/lib/supabase";
import { buildTravelPageData, hrvSinceDate, todayET, type Flight, type HRVRow, type TravelPageData, type Trip } from "@/lib/travel";

// /analytics/travel reads. Shared by the ISR page and GET /api/travel/page-data (the continuous scroll), so
// both draw the same numbers. Server only: `supabase` is the service-role client here.

async function getTrips(): Promise<Trip[]> {
  const { data, error } = await supabase
    .from("trips")
    .select("trip_id, start_date, end_date, duration_days, iana_tz, offset_hours, n_cycles")
    .order("start_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Trip[];
}

async function getFlights(): Promise<Flight[]> {
  const { data, error } = await supabase
    .from("flights")
    .select("flight_id, confirmation_number, flight_number, dep_iata, arr_iata, dep_city, arr_city, dep_local, arr_local, dep_local_date, duration_min, seat, status, operated_by")
    .neq("status", "superseded")
    .order("dep_local", { ascending: false })
    .order("flight_id", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as Flight[];
}

async function getHRVData(sinceStr: string): Promise<HRVRow[]> {
  // 15-min matview, not the live view — this page is pure ETL history, so
  // staleness is invisible. Paged via .range() (getHealthMatrix pattern): the
  // matrix is at 850+ rows and an unpaged read would silently truncate at
  // PostgREST's 1000-row default cap as history grows.
  const PAGE = 1000;
  const rows: HRVRow[] = [];
  for (let fromIdx = 0; ; fromIdx += PAGE) {
    const { data, error } = await supabase
      .from("daily_health_matrix_behavioral_mat")
      .select("calendar_date, whoop_hrv_rmssd, onyx_is_transition_day")
      .gte("calendar_date", sinceStr)
      .order("calendar_date", { ascending: true })
      .range(fromIdx, fromIdx + PAGE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as HRVRow[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/** A database error code (or the error's name), never its text. */
function errorCode(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown } | null;
  if (err && typeof err.code === "string" && err.code) return err.code;
  if (err && typeof err.name === "string" && err.name) return err.name;
  return "error";
}

export async function loadTravelPageData(): Promise<TravelPageData> {
  // Per-fetch fail-open: each section renders from whatever succeeded, the
  // failed one renders empty, and the error is logged (code only). Trade-off,
  // chosen for simplicity on this low-traffic page: a transient failure can be
  // cached as an empty section for up to an hour — acceptable now that it's at
  // least observable. Trips first because the HRV window is derived from them;
  // flights in parallel with the HRV read.
  let trips: Trip[] = [];
  try {
    trips = await getTrips();
  } catch (e) {
    console.error("[/analytics/travel] trips fetch failed; rendering empty trip list", errorCode(e));
  }

  const [hrvData, flights] = await Promise.all([
    getHRVData(hrvSinceDate(trips)).catch((e) => {
      console.error("[/analytics/travel] HRV fetch failed; rendering empty trajectory", errorCode(e));
      return [] as HRVRow[];
    }),
    getFlights().catch((e) => {
      console.error("[/analytics/travel] flights fetch failed; rendering empty flight list", errorCode(e));
      return [] as Flight[];
    }),
  ]);

  return buildTravelPageData(trips, hrvData, flights, todayET());
}
