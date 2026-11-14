"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { axisTick, chartColors as C, chartTooltip, gridStyle, legendStyle } from "@/lib/chart-theme";
import { formatMinutes, type ScreenPoint } from "@/lib/screen-time";

const SOURCE = "IPHONE";
const HEIGHT = 240;
const MARGIN = { top: 8, right: 8, left: 4, bottom: 0 };
const CURSOR = { fill: "rgba(255,255,255,0.03)" };

/** Axis ticks in minutes: 45 -> "45m", 120 -> "2h", 150 -> "2h30". */
const hours = (v: number) => {
  const m = Math.round(v);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m / 60}h`;
};
const minutes = (value: unknown, name: unknown): [string, string] => [formatMinutes(Number(value)), String(name)];
const count = (value: unknown, name: unknown): [string, string] => [String(Math.round(Number(value))), String(name)];

/** The four time-series charts on /screen-time. Rows arrive as props from the server page. */
export default function ScreenTimeCharts({ points }: { points: ScreenPoint[] }) {
  const hasBedtime = points.some((p) => p.lastHour !== null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ChartCard title="Daily total" subtitle="Time on the phone per day; a day still syncing is dimmed" source={SOURCE}>
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <BarChart data={points} margin={MARGIN}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={axisTick} width={44} tickFormatter={hours} />
            <Tooltip {...chartTooltip} cursor={CURSOR} formatter={minutes} />
            <Bar dataKey="total" name="Total" stackId="t" fill={C.categorical[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="totalPartial" name="So far (still syncing)" stackId="t" fill={C.categorical[0]} fillOpacity={0.35} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Late night" subtitle="Minutes between 10 PM and 6 AM, split at midnight" source={SOURCE}>
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <BarChart data={points} margin={MARGIN}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={axisTick} width={44} tickFormatter={hours} />
            <Tooltip {...chartTooltip} cursor={CURSOR} formatter={minutes} />
            <Legend wrapperStyle={legendStyle} />
            <Bar dataKey="evening" name="10 PM to midnight" stackId="n" fill={C.categorical[3]} isAnimationActive={false} />
            <Bar dataKey="afterMidnight" name="Midnight to 6 AM" stackId="n" fill={C.categorical[1]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Pickups and notifications" subtitle="Counts per day" source={SOURCE}>
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <LineChart data={points} margin={MARGIN}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={axisTick} width={40} allowDecimals={false} />
            <Tooltip {...chartTooltip} formatter={count} />
            <Legend wrapperStyle={legendStyle} />
            <Line dataKey="pickups" name="Pickups" stroke={C.categorical[2]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            <Line dataKey="notifications" name="Notifications" stroke={C.categorical[4]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Around sleep onset"
        subtitle="Estimated minutes in the hour before WHOOP sleep onset, and after it"
        source={SOURCE}
      >
        {hasBedtime ? (
          <ResponsiveContainer width="100%" height={HEIGHT}>
            <ComposedChart data={points} margin={MARGIN}>
              <CartesianGrid {...gridStyle} vertical={false} />
              <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={axisTick} width={40} tickFormatter={(v: number) => `${v}m`} />
              <Tooltip {...chartTooltip} cursor={CURSOR} formatter={minutes} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="lastHour" name="Hour before sleep" fill={C.categorical[5]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Line dataKey="duringSleep" name="After sleep onset" stroke={C.categorical[7]} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-[13px] text-text-tertiary">
            No night in this window has both a finished sync and a scored WHOOP sleep yet.
          </p>
        )}
      </ChartCard>
    </div>
  );
}
