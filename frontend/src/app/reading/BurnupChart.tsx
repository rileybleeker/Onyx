"use client";

import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ReadingOverview } from "@/lib/reading";

/**
 * Burn-up: chapters read (solid, accent) against the linear pace line to the
 * target date (dashed). Loaded with ssr:false from ReadingClient. Every series
 * sets isAnimationActive={false} per the render conventions.
 */
export default function BurnupChart({ data, today, total }: { data: ReadingOverview["burnup"]; today: string; total: number }) {
  const fmt = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  return (
    <div className="h-[180px] w-full" data-testid="reading-burnup">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <XAxis dataKey="date" tickFormatter={fmt} tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={28} />
          <YAxis domain={[0, Math.max(1, total)]} tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border-default)", borderRadius: 4, fontSize: 12 }}
            labelFormatter={(d) => fmt(String(d))}
            formatter={(v, name) => [v == null ? "—" : `ch ${v}`, name === "target" ? "pace" : "read"]}
          />
          <Line type="stepAfter" dataKey="target" stroke="var(--color-text-tertiary)" strokeDasharray="4 4" dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
          <Area type="stepAfter" dataKey="actual" stroke="var(--color-accent)" fill="var(--color-accent-muted)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          <ReferenceLine x={today} stroke="var(--color-border-default)" strokeDasharray="2 2" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
