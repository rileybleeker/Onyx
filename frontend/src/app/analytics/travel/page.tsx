import { createClient } from "@supabase/supabase-js";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import TravelCharts from "./TravelCharts";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

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
  const { data } = await supabase
    .from("trips")
    .select("*")
    .order("start_date", { ascending: false });
  return (data ?? []) as Trip[];
}

async function getHRVData(): Promise<HRVRow[]> {
  const { data } = await supabase
    .from("daily_health_matrix_behavioral")
    .select("calendar_date, whoop_hrv_rmssd, onyx_is_transition_day")
    .order("calendar_date", { ascending: true });
  return (data ?? []) as HRVRow[];
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
  const [trips, hrvData] = await Promise.all([getTrips(), getHRVData()]);

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
          HRV impact and recovery patterns across {totalTrips} trips · {totalDaysAbroad} days abroad
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
