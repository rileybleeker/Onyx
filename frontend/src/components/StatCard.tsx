import clsx from "clsx";

interface StatCardProps {
  label: string;
  value: string | number | null;
  unit?: string;
  sublabel?: string;
  trend?: { delta: number; favorable: "up" | "down" };
  source?: "GARMIN" | "WHOOP" | "8SLP" | "MFP" | "CRONOMETER";
  className?: string;
}

const sourceColors: Record<string, string> = {
  GARMIN: "text-source-garmin",
  WHOOP: "text-source-whoop",
  "8SLP": "text-source-eightsleep",
};

export default function StatCard({ label, value, unit, sublabel, trend, source, className }: StatCardProps) {
  const trendColor = trend
    ? (trend.delta > 0 && trend.favorable === "up") || (trend.delta < 0 && trend.favorable === "down")
      ? "text-green-400"
      : "text-red-400"
    : "";

  return (
    <div className={clsx(
      "bg-surface-card border border-border-subtle rounded-[6px] p-4 relative transition-colors hover:border-border-hover shadow-card",
      className
    )}>
      {source && (
        <span className={clsx("absolute top-3 right-3 text-[9px] font-mono font-medium tracking-wider", sourceColors[source] || "text-text-tertiary")}>
          {source}
        </span>
      )}
      <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">{label}</p>
      <div className="flex items-baseline gap-1.5 mt-1.5">
        <p className="text-[28px] leading-none font-medium text-text-primary font-mono tabular-nums">
          {value ?? "\u2014"}
        </p>
        {unit && <span className="text-xs font-normal text-text-secondary">{unit}</span>}
        {trend && (
          <span className={clsx("text-xs font-mono font-medium flex items-center gap-0.5 ml-1", trendColor)}>
            <span>{trend.delta > 0 ? "\u2191" : "\u2193"}</span>
            {Math.abs(trend.delta).toFixed(1)}
          </span>
        )}
      </div>
      {sublabel && <p className="text-[11px] text-text-tertiary mt-1.5">{sublabel}</p>}
    </div>
  );
}
