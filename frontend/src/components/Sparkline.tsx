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
 * unless an explicit `color` is given. The domain is pinned to
 * [dataMin, dataMax] so the trace fills the available height.
 *
 * Hand-rolled <svg><polyline> rather than a recharts LineChart: Sparkline sits
 * in StatCard's synchronous import chain, and recharts here dragged ~110 kB of
 * chart runtime into the First Load JS of every non-chart page that shows a
 * KPI tile (/status most importantly — it's the post-login landing page).
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

  // Mirror the old recharts margins: { top: 2, right: 1, bottom: 2, left: 1 }.
  const margin = { top: 2, right: 1, bottom: 2, left: 1 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const points = clean
    .map((v, i) => {
      const x = margin.left + (i / (clean.length - 1)) * innerW;
      // Flat series renders as a centered horizontal line.
      const y = span === 0 ? margin.top + innerH / 2 : margin.top + (1 - (v - min) / span) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
