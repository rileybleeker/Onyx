import { supabase } from "@/lib/supabase";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import TravelCharts from "./TravelCharts";

// ISR (perf pass 2026-06-11): was force-dynamic with a service-role client and
// an unbounded full-view scan on every visit. Now revalidated hourly to match
// the ETL cadence, reading via the shared anon client (RLS grants anon
// read-only; it already sets db.schema = "pds") and the 15-min matview.
export const revalidate = 3600;

interface Trip {
  trip_id: number;
  start_date: string;
  end_date: string;
  duration_days: number;
  iana_tz: string;
  offset_hours: number;
  n_cycles: number;
}

interface HRVRow {
  calendar_date: string;
  whoop_hrv_rmssd: number | null;
  onyx_is_transition_day: boolean | null;
}

async function getTrips(): Promise<Trip[]> {
  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .order("start_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Trip[];
}

// Flight segments parsed from Delta's emails by flights_email_etl.py (receipt →
// trip details → check-in converge on one row per segment; latest email wins).
// Unlike pds.trips, this includes same-offset trips (ATL↔YYZ) and future bookings.
interface Flight {
  flight_id: number;
  confirmation_number: string;
  flight_number: string;
  dep_iata: string | null;
  arr_iata: string | null;
  dep_city: string | null;
  arr_city: string | null;
  dep_local: string | null;      // naive local wall clock at the departure airport
  arr_local: string | null;
  dep_local_date: string;
  duration_min: number | null;
  seat: string | null;
  status: string;
  operated_by: string | null;
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

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-06T18:33:00" (naive local time) → "Fri, Nov 6" / "6:33 PM" without any
// timezone conversion — the string already IS the airport's local clock.
function fmtLocalDate(naive: string | null): string {
  if (!naive) return "—";
  const [y, m, d] = naive.slice(0, 10).split("-").map(Number);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow}, ${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}
function fmtLocalTime(naive: string | null): string {
  if (!naive || naive.length < 16) return "—";
  const h = Number(naive.slice(11, 13));
  const mi = naive.slice(14, 16);
  const ap = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${mi} ${ap}`;
}
function fmtDuration(min: number | null): string {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Earliest calendar_date this page actually consumes: directionAsymmetry's
// 7-day pre-trip baseline (offset −7 from the earliest trip start) — wider
// than trajectoryAroundTrips' −3. No trips → trailing 365 days.
function hrvSinceDate(trips: Trip[]): string {
  if (trips.length > 0) {
    const earliest = trips.reduce(
      (min, t) => (t.start_date < min ? t.start_date : min),
      trips[0].start_date
    );
    const d = new Date(earliest + "T00:00:00");
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date();
  d.setDate(d.getDate() - 365);
  return d.toISOString().slice(0, 10);
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

function classifyDirection(prevTrip: Trip | null, trip: Trip): "outbound" | "return" {
  // Outbound = NY → away. Return = away → NY.
  // We classify based on whether this trip's IANA is non-NY (always outbound
  // for non-NY trips since pds.trips only contains non-NY trips). The
  // "return" is the day AFTER end_date.
  return "outbound";
}

function trajectoryAroundTrips(hrvData: HRVRow[], trips: Trip[]): Array<{
  day_offset: number;
  hrv: number;
  trip_id: number;
}> {
  // For each trip, capture HRV from day -3 (pre-trip) to day +5 (post-return)
  // relative to trip start. Aggregates across trips for overlay viz.
  const map = new Map<string, number>();
  for (const r of hrvData) {
    if (r.whoop_hrv_rmssd != null) map.set(r.calendar_date, r.whoop_hrv_rmssd);
  }
  const points: Array<{ day_offset: number; hrv: number; trip_id: number }> = [];
  for (const trip of trips) {
    const start = new Date(trip.start_date + "T00:00:00");
    for (let off = -3; off <= 7; off++) {
      const d = new Date(start);
      d.setDate(d.getDate() + off);
      const key = d.toISOString().slice(0, 10);
      const hrv = map.get(key);
      if (hrv != null) {
        points.push({ day_offset: off, hrv, trip_id: trip.trip_id });
      }
    }
  }
  return points;
}

function meanHRVByOffset(points: Array<{ day_offset: number; hrv: number }>): Array<{
  day_offset: number;
  mean_hrv: number;
  n: number;
}> {
  const grouped = new Map<number, number[]>();
  for (const p of points) {
    if (!grouped.has(p.day_offset)) grouped.set(p.day_offset, []);
    grouped.get(p.day_offset)!.push(p.hrv);
  }
  return Array.from(grouped.entries())
    .map(([day_offset, vals]) => ({
      day_offset,
      mean_hrv: vals.reduce((a, b) => a + b, 0) / vals.length,
      n: vals.length,
    }))
    .sort((a, b) => a.day_offset - b.day_offset);
}

function directionAsymmetry(hrvData: HRVRow[], trips: Trip[]): {
  outbound: number[];
  return_home: number[];
} {
  const map = new Map<string, number>();
  for (const r of hrvData) {
    if (r.whoop_hrv_rmssd != null) map.set(r.calendar_date, r.whoop_hrv_rmssd);
  }
  const outbound: number[] = [];
  const return_home: number[] = [];
  for (const trip of trips) {
    const start = new Date(trip.start_date + "T00:00:00");
    const end = new Date(trip.end_date + "T00:00:00");
    // baseline = mean of 7 days pre-trip
    const baseline: number[] = [];
    for (let off = -7; off <= -1; off++) {
      const d = new Date(start);
      d.setDate(d.getDate() + off);
      const v = map.get(d.toISOString().slice(0, 10));
      if (v != null) baseline.push(v);
    }
    if (baseline.length < 3) continue;
    const baselineMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    // outbound day = start_date HRV
    const outboundHRV = map.get(trip.start_date);
    if (outboundHRV != null) outbound.push(outboundHRV - baselineMean);
    // return day = end_date + 1
    const returnDate = new Date(end);
    returnDate.setDate(returnDate.getDate() + 1);
    const returnHRV = map.get(returnDate.toISOString().slice(0, 10));
    if (returnHRV != null) return_home.push(returnHRV - baselineMean);
  }
  return { outbound, return_home };
}

function meanOrNaN(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export default async function TravelPage() {
  // Per-fetch fail-open: each section renders from whatever succeeded, the
  // failed one renders empty, and the error is logged (previously errors were
  // silently swallowed into `data ?? []`). Trade-off, chosen for simplicity on
  // this low-traffic page: a transient failure can be cached as an empty
  // section for up to an hour — acceptable now that it's at least observable.
  // Sequential (not Promise.all) because the HRV window is derived from trips.
  let trips: Trip[] = [];
  try {
    trips = await getTrips();
  } catch (e) {
    console.error("[/analytics/travel] trips fetch failed; rendering empty trip list", e);
  }

  let hrvData: HRVRow[] = [];
  try {
    hrvData = await getHRVData(hrvSinceDate(trips));
  } catch (e) {
    console.error("[/analytics/travel] HRV fetch failed; rendering empty trajectory", e);
  }

  let flights: Flight[] = [];
  try {
    flights = await getFlights();
  } catch (e) {
    console.error("[/analytics/travel] flights fetch failed; rendering empty flight list", e);
  }
  const today = todayET();
  const upcoming = flights.filter((f) => f.dep_local_date >= today && f.status !== "cancelled").reverse(); // soonest first
  const past = flights.filter((f) => f.dep_local_date < today || f.status === "cancelled");
  const pnrCount = new Set(flights.map((f) => f.confirmation_number)).size;

  // KPI calcs
  const totalTrips = trips.length;
  const totalDaysAbroad = trips.reduce((sum, t) => sum + t.duration_days, 0);
  const trajectoryPoints = trajectoryAroundTrips(hrvData, trips);
  const meanTrajectory = meanHRVByOffset(trajectoryPoints);
  const day0 = meanTrajectory.find((p) => p.day_offset === 0);
  const dayMinus1 = meanTrajectory.find((p) => p.day_offset === -1);
  const meanDay0Impact = day0 && dayMinus1 ? day0.mean_hrv - dayMinus1.mean_hrv : NaN;

  const direction = directionAsymmetry(hrvData, trips);
  const outboundMean = meanOrNaN(direction.outbound);
  const returnMean = meanOrNaN(direction.return_home);

  // Group trips by IANA for destination breakdown
  const byDest = new Map<string, { count: number; days: number }>();
  for (const t of trips) {
    const cur = byDest.get(t.iana_tz) ?? { count: 0, days: 0 };
    byDest.set(t.iana_tz, { count: cur.count + 1, days: cur.days + t.duration_days });
  }
  const destBreakdown = Array.from(byDest.entries())
    .map(([iana, v]) => ({ iana, ...v }))
    .sort((a, b) => b.days - a.days);

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[28px] font-medium text-text-primary">Travel Analysis</h2>
        <p className="text-sm text-text-tertiary mt-0.5">
          HRV impact and recovery patterns across {totalTrips} trips · {totalDaysAbroad} days abroad · {flights.length} flights on record
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Trips" value={String(totalTrips)} sublabel={`since ${trips[trips.length - 1]?.start_date ?? "—"}`} />
        <StatCard label="Days Abroad" value={String(totalDaysAbroad)} sublabel={`avg ${(totalDaysAbroad / Math.max(totalTrips, 1)).toFixed(1)}d/trip`} />
        <StatCard
          label="HRV Δ on outbound day"
          value={isNaN(outboundMean) ? "—" : `${outboundMean > 0 ? "+" : ""}${outboundMean.toFixed(1)} ms`}
          sublabel={`vs 7-day baseline (n=${direction.outbound.length})`}
        />
        <StatCard
          label="HRV Δ on return day"
          value={isNaN(returnMean) ? "—" : `${returnMean > 0 ? "+" : ""}${returnMean.toFixed(1)} ms`}
          sublabel={`vs 7-day baseline (n=${direction.return_home.length})`}
        />
      </div>

      {/* Flights (from Delta confirmation emails) */}
      <ChartCard
        title="Flights"
        subtitle={`${flights.length} segments across ${pnrCount} bookings, parsed from Delta emails · ${upcoming.length} upcoming`}
        source="DELTA EMAIL"
        className="mb-6"
      >
        {flights.length === 0 ? (
          <p className="text-sm text-text-tertiary py-6 text-center">No flights parsed yet — the Flights Email ETL runs every 3 hours.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-tertiary text-left border-b border-border-subtle">
                  <th className="py-2 px-3 font-medium">Date</th>
                  <th className="py-2 px-3 font-medium">Flight</th>
                  <th className="py-2 px-3 font-medium">Route</th>
                  <th className="py-2 px-3 font-medium">Departs</th>
                  <th className="py-2 px-3 font-medium">Arrives</th>
                  <th className="py-2 px-3 font-medium">Duration</th>
                  <th className="py-2 px-3 font-medium">Seat</th>
                  <th className="py-2 px-3 font-medium">Conf #</th>
                </tr>
              </thead>
              <tbody>
                {[...upcoming, ...past].map((f, i) => {
                  const isUpcoming = i < upcoming.length;
                  const overnight = f.arr_local && f.dep_local && f.arr_local.slice(0, 10) !== f.dep_local.slice(0, 10);
                  return (
                    <tr
                      key={f.flight_id}
                      className={`border-b border-border-subtle/50 ${isUpcoming ? "text-text-primary" : "text-text-secondary"} ${i === upcoming.length && upcoming.length > 0 ? "border-t-2 border-t-border-subtle" : ""}`}
                    >
                      <td className="py-2 px-3 font-mono whitespace-nowrap">
                        {fmtLocalDate(f.dep_local ?? f.dep_local_date)}
                        {isUpcoming && <span className="ml-2 text-[10px] uppercase tracking-wide text-indigo-400">upcoming</span>}
                      </td>
                      <td className="py-2 px-3 font-mono">
                        {f.flight_number}
                        {f.operated_by && !/Delta Air Lines/i.test(f.operated_by) && (
                          <span className="block text-[10px] text-text-tertiary">{f.operated_by.replace(/ DBA Delta Connection/i, "")}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className="font-mono">{f.dep_iata ?? "?"} → {f.arr_iata ?? "?"}</span>
                        <span className="block text-[11px] text-text-tertiary">{(f.dep_city ?? "").split(",")[0]} → {(f.arr_city ?? "").split(",")[0]}</span>
                      </td>
                      <td className="py-2 px-3 font-mono whitespace-nowrap">{fmtLocalTime(f.dep_local)}</td>
                      <td className="py-2 px-3 font-mono whitespace-nowrap">
                        {fmtLocalTime(f.arr_local)}
                        {overnight && <span className="ml-1 text-[10px] text-amber-400">+1</span>}
                      </td>
                      <td className="py-2 px-3 font-mono text-text-tertiary">{fmtDuration(f.duration_min)}</td>
                      <td className="py-2 px-3 font-mono text-text-tertiary">{f.seat ?? "—"}</td>
                      <td className="py-2 px-3 font-mono text-text-tertiary whitespace-nowrap">
                        {f.confirmation_number}
                        {f.status !== "confirmed" && (
                          <span className={`ml-2 text-[10px] uppercase tracking-wide ${f.status === "cancelled" ? "text-red-400" : "text-amber-400"}`}>{f.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>

      {/* Trip list */}
      <ChartCard title="All trips" subtitle="Auto-segmented from pds.trips">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-tertiary text-left border-b border-border-subtle">
                <th className="py-2 px-3 font-medium">ID</th>
                <th className="py-2 px-3 font-medium">Start</th>
                <th className="py-2 px-3 font-medium">End</th>
                <th className="py-2 px-3 font-medium">Days</th>
                <th className="py-2 px-3 font-medium">Destination</th>
                <th className="py-2 px-3 font-medium">Offset</th>
                <th className="py-2 px-3 font-medium">WHOOP cycles</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.trip_id} className="border-b border-border-subtle/50 text-text-secondary">
                  <td className="py-2 px-3 font-mono text-text-tertiary">#{t.trip_id}</td>
                  <td className="py-2 px-3 font-mono">{t.start_date}</td>
                  <td className="py-2 px-3 font-mono">{t.end_date}</td>
                  <td className="py-2 px-3">{t.duration_days}</td>
                  <td className="py-2 px-3">{t.iana_tz}</td>
                  <td className="py-2 px-3 font-mono">{t.offset_hours >= 0 ? "+" : ""}{t.offset_hours}h</td>
                  <td className="py-2 px-3 text-text-tertiary">{t.n_cycles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      {/* Trajectory + destination breakdown */}
      <div className="mt-6">
        <TravelCharts
          meanTrajectory={meanTrajectory}
          destBreakdown={destBreakdown}
        />
      </div>

      <p className="mt-6 text-xs text-text-tertiary leading-relaxed">
        Trip detection uses pds.trips (auto-segmented from whoop_cycles + user_tz_log). HRV Δ values
        compare day-of-event HRV to the 7-day pre-trip baseline. Mean trajectory averages HRV across
        all trips by day-offset from trip start. Limited statistical power: {totalTrips} trips total.
      </p>
    </>
  );
}
