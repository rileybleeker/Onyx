"use client";

import { Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisTick, chartColors as C, chartTooltip } from "@/lib/chart-theme";
import { formatNumber, type LabSeries } from "@/lib/medical-records";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * One test's numeric results over time, spaced by real dates (not evenly), with the newest
 * result's reference range shaded (or drawn as a line when it has one end only). Qualitative
 * results ("Negative") are not drawn.
 */
export default function LabTrendChart({ series }: { series: LabSeries }) {
  const points = series.results
    .filter((r) => r.value !== null)
    .map((r) => ({ t: Date.parse(`${r.collectedOn}T12:00:00Z`), value: r.value as number }));
  const { refLow, refHigh } = series.latest;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, ...(refLow !== null ? [refLow] : []));
  const hi = Math.max(...values, ...(refHigh !== null ? [refHigh] : []));
  const pad = hi === lo ? Math.abs(hi) * 0.1 || 1 : (hi - lo) * 0.15;
  return (
    <ResponsiveContainer width="100%" height={110}>
      <LineChart data={points} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
          tick={axisTick} tickFormatter={(t: number) => MONTH.format(new Date(t))} tickCount={3} minTickGap={24}
        />
        <YAxis tick={axisTick} width={40} domain={[lo - pad, hi + pad]} tickFormatter={(v: number) => formatNumber(Number(v.toPrecision(3)))} />
        {refLow !== null && refHigh !== null && (
          <ReferenceArea y1={refLow} y2={refHigh} fill={C.up} fillOpacity={0.08} stroke="none" ifOverflow="extendDomain" />
        )}
        {refLow !== null && refHigh === null && <ReferenceLine y={refLow} stroke={C.up} strokeOpacity={0.5} strokeDasharray="3 3" />}
        {refHigh !== null && refLow === null && <ReferenceLine y={refHigh} stroke={C.up} strokeOpacity={0.5} strokeDasharray="3 3" />}
        <Tooltip
          {...chartTooltip}
          labelFormatter={(t) => DAY.format(new Date(Number(t)))}
          formatter={(v) => [`${formatNumber(Number(v))}${series.unit ? ` ${series.unit}` : ""}`, series.test]}
        />
        <Line dataKey="value" stroke={C.categorical[0]} strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
