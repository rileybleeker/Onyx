/**
 * /analytics/travel: types and the pure calculations behind the page. Import-free, so the server loader
 * (lib/travel-server.ts), the routed page and the continuous-scroll section (app/analytics/travel/FeedSection.tsx)
 * all use the same numbers.
 */

export interface Trip {
  trip_id: number;
  start_date: string;
  end_date: string;
  duration_days: number;
  iana_tz: string;
  offset_hours: number;
  n_cycles: number;
}

export interface HRVRow {
  calendar_date: string;
  whoop_hrv_rmssd: number | null;
  onyx_is_transition_day: boolean | null;
}

// Flight segments parsed from Delta's emails by flights_email_etl.py (receipt →
// trip details → check-in converge on one row per segment; latest email wins).
// Unlike pds.trips, this includes same-offset trips (ATL↔YYZ) and future bookings.
export interface Flight {
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

export interface TrajectoryPoint {
  day_offset: number;
  mean_hrv: number;
  n: number;
}

/** What the page draws. The HRV rows themselves stay on the server; only the two summaries are sent. */
export interface TravelPageData {
  trips: Trip[];
  flights: Flight[];
  /** ET calendar date the upcoming / past split is made against. */
  today: string;
  meanTrajectory: TrajectoryPoint[];
  direction: { outbound: number[]; return_home: number[] };
}

export function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Earliest calendar_date this page actually consumes: directionAsymmetry's
// 7-day pre-trip baseline (offset −7 from the earliest trip start) — wider
// than trajectoryAroundTrips' −3. No trips → trailing 365 days.
export function hrvSinceDate(trips: Trip[]): string {
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

function meanHRVByOffset(points: Array<{ day_offset: number; hrv: number }>): TrajectoryPoint[] {
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

/** The page's numbers from the three reads. */
export function buildTravelPageData(trips: Trip[], hrvData: HRVRow[], flights: Flight[], today: string): TravelPageData {
  return {
    trips,
    flights,
    today,
    meanTrajectory: meanHRVByOffset(trajectoryAroundTrips(hrvData, trips)),
    direction: directionAsymmetry(hrvData, trips),
  };
}

/** True when a value has the TravelPageData shape (a cached copy or a server answer). */
export function isTravelPageData(v: unknown): v is TravelPageData {
  const d = v as TravelPageData | null | undefined;
  return !!d
    && Array.isArray(d.trips)
    && Array.isArray(d.flights)
    && typeof d.today === "string"
    && Array.isArray(d.meanTrajectory)
    && !!d.direction
    && Array.isArray(d.direction.outbound)
    && Array.isArray(d.direction.return_home);
}
