"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import { formatCents } from "@/lib/format";

export interface TrendDatum {
  month: string;
  label: string;
  outCents: number;
}

/** Money out per month for the trailing year; the selected month is highlighted. */
export default function SpendingTrendChart({ data, selectedMonth }: { data: TrendDatum[]; selectedMonth: string }) {
  const rows = data.map((d) => ({ ...d, out: d.outCents / 100 }));
  return (
    <div>
      <p className="sr-only">
        Monthly money out, last {data.length} months:{" "}
        {data.map((d) => `${d.label} ${formatCents(d.outCents)}`).join(", ")}.
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid {...gridStyle} vertical={false} />
          <XAxis dataKey="label" tick={axisTick} interval="preserveStartEnd" />
          <YAxis
            tick={axisTick}
            width={52}
            tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`)}
          />
          <Tooltip
            {...chartTooltip}
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
            formatter={(value) => [formatCents(Math.round(Number(value) * 100)), "Money out"]}
          />
          <Bar dataKey="out" name="Money out" radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {rows.map((d) => (
              <Cell key={d.month} fill={d.month === selectedMonth ? C.accent : C.categorical[0]} fillOpacity={d.month === selectedMonth ? 1 : 0.55} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
