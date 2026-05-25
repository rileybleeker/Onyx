"use client";

import ChartCard from "@/components/ChartCard";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, BarChart, Bar, LabelList,
} from "recharts";

interface Props {
  meanTrajectory: Array<{ day_offset: number; mean_hrv: number; n: number }>;
  destBreakdown: Array<{ iana: string; count: number; days: number }>;
}

export default function TravelCharts({ meanTrajectory, destBreakdown }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <ChartCard
        title="Mean HRV trajectory around trip start"
        subtitle="Day 0 = trip start; averaged across all trips"
      >
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={meanTrajectory} margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="day_offset"
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 12 }}
              label={{ value: "Days from trip start", position: "insideBottom", offset: -5, fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 12 }}
              label={{ value: "Mean HRV (ms)", angle: -90, position: "insideLeft", fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)" }}
              formatter={(v, _name, p) => [
                `${typeof v === "number" ? v.toFixed(1) : v} ms (n=${(p as { payload?: { n?: number } }).payload?.n ?? "?"})`,
                "Mean HRV",
              ]}
            />
            <ReferenceLine x={0} stroke="rgba(255, 200, 0, 0.4)" strokeDasharray="3 3" label={{ value: "Trip start", position: "top", fill: "rgba(255,200,0,0.7)", fontSize: 10 }} />
            <Line type="monotone" dataKey="mean_hrv" stroke="#60a5fa" strokeWidth={2} dot={{ fill: "#60a5fa", r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Trips by destination" subtitle="Days abroad per IANA zone">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={destBreakdown} margin={{ top: 10, right: 30, bottom: 30, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="iana"
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }}
              angle={-15}
              textAnchor="end"
              height={50}
            />
            <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 12 }} />
            <Tooltip
              contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)" }}
              formatter={(v, _name, p) => [
                `${v} days (${(p as { payload?: { count?: number } }).payload?.count ?? "?"} trips)`,
                "Days abroad",
              ]}
            />
            <Bar dataKey="days" fill="#a78bfa">
              <LabelList dataKey="days" position="top" fill="rgba(255,255,255,0.6)" fontSize={10} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
