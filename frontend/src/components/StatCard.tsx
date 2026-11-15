import clsx from "clsx";
import Sparkline from "./Sparkline";

interface StatCardProps {
  label: string;
  value: string | number | null;
  unit?: string;
  sublabel?: string;
  trend?: { delta: number; favorable: "up" | "down" };
  source?: "GARMIN" | "WHOOP" | "8SLP" | "MFP" | "CRONOMETER" | "SPOTIFY" | "TANITA" | "UBER EATS EST." | "PHOTO EST." | "UBER EATS + PHOTO EST.";
  className?: string;
  // ── Stage 2 (Direction A) additions — optional / additive ─────────────────
  sparkline?: { values: number[]; color?: string; favorable?: "up" | "down" };
  band?: { low: number; high: number; unit?: string };
}

export default function StatCard({
  label,
  value,
  unit,
  sublabel,
  trend,
  source,
  className,
  sparkline,
  band,
}: StatCardProps) {
  const trendGood = trend
    ? (trend.delta > 0 && trend.favorable === "up") || (trend.delta < 0 && trend.favorable === "down")
    : false;

  return (
    <div className={clsx(
      "bg-surface-card border border-border-subtle rounded-card shadow-card p-4 relative transition-colors hover:border-border-hover",
      className
    )}>
      {source && (
        <span className="absolute top-3.5 right-4 text-[9px] font-mono font-medium tracking-[0.12em] text-text-tertiary">
          {source}
        </span>
      )}
      <p className="text-[10px] text-text-secondary font-mono uppercase tracking-[0.14em]">{label}</p>
      <div className="flex items-end justify-between gap-2 mt-1.5">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <p className="text-[28px] leading-none font-display font-medium text-text-primary tabular-nums truncate">
            {value ?? "—"}
          </p>
          {unit && <span className="text-xs font-normal text-text-secondary">{unit}</span>}
          {trend && (
            <span className={clsx("text-xs font-mono font-medium flex items-center gap-0.5 ml-1", trendGood ? "text-up" : "text-down")}>
              <span>{trend.delta > 0 ? "↑" : "↓"}</span>
              {Math.abs(trend.delta).toFixed(1)}
            </span>
          )}
        </div>
        {sparkline && sparkline.values.length >= 2 && (
          <Sparkline
            values={sparkline.values}
            color={sparkline.color}
            favorable={sparkline.favorable}
            width={56}
            height={20}
          />
        )}
      </div>
      {sublabel && <p className="text-[11px] text-text-tertiary mt-1.5">{sublabel}</p>}
      {band && (
        <p className="text-[10px] text-text-tertiary font-mono mt-1 tabular-nums">
          {band.low}–{band.high}{band.unit ? ` ${band.unit}` : ""}
        </p>
      )}
    </div>
  );
}
