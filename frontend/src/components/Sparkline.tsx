"use client";

import { LineChart, Line, XAxis, YAxis } from "recharts";
import { directionalColor } from "@/lib/chart-theme";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Explicit stroke. When omitted, color is derived from last-vs-mean trend. */
  color?: string;
  /** Which direction counts as "good" for the auto-derived color. */
  favorable?: "up" | "down";
  className?: string;
}

/**
 * 60×20 inline sparkline (Direction A "Terminal" KPI widget). No axes, no grid,
 * 1px stroke. Color is keyed up/down by the latest value vs the series mean
 * unless an explicit `color` is given. Hidden axes pin the domain to
 * [dataMin, dataMax] so the trace fills the available height.
 */
export default function Sparkline({
  values,
  width = 60,
  height = 20,
  color,
  favorable = "up",
  className,
}: SparklineProps) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length < 2) {
    return <div style={{ width, height }} className={className} aria-hidden />;
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const stroke = color ?? directionalColor(clean[clean.length - 1] - mean, { favorable });
  const data = clean.map((v, i) => ({ i, v }));

  return (
    <LineChart
      width={width}
      height={height}
      data={data}
      margin={{ top: 2, right: 1, bottom: 2, left: 1 }}
      className={className}
      aria-hidden
    >
      <XAxis dataKey="i" hide />
      <YAxis hide domain={["dataMin", "dataMax"]} />
      <Line type="monotone" dataKey="v" stroke={stroke} strokeWidth={1} dot={false} isAnimationActive={false} />
    </LineChart>
  );
}
