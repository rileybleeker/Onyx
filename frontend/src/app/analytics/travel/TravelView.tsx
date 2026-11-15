import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import type { TravelPageData } from "@/lib/travel";
import TravelCharts from "./TravelCharts";

// The /analytics/travel screen. Drawn by the ISR page (page.tsx, server) and by the continuous scroll
// (FeedSection.tsx, client) from the same TravelPageData, so the two never differ. No hooks: it renders on
// either side.

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

function meanOrNaN(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export default function TravelView({ data, headingTestId }: { data: TravelPageData; headingTestId?: string }) {
  const { trips, flights, today, meanTrajectory, direction } = data;
  const upcoming = flights.filter((f) => f.dep_local_date >= today && f.status !== "cancelled").reverse(); // soonest first
  const past = flights.filter((f) => f.dep_local_date < today || f.status === "cancelled");
  const pnrCount = new Set(flights.map((f) => f.confirmation_number)).size;

  // KPI calcs
  const totalTrips = trips.length;
  const totalDaysAbroad = trips.reduce((sum, t) => sum + t.duration_days, 0);
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
        <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Travel Analysis</h2>
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
