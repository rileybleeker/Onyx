"use client";

import clsx from "clsx";
import Sparkline from "./Sparkline";
import MetadataRow, { type MetaItem } from "./MetadataRow";
import { directionalColor } from "@/lib/chart-theme";

interface KpiTileProps {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  /** Signed delta line, e.g. ↑ +2.1 vs today. */
  delta?: { value: number; favorable?: "up" | "down"; suffix?: string; digits?: number };
  /** Secondary line under the value (CI band, qualifier, etc.). */
  sub?: string;
  /** Inline sparkline values (60×20). */
  spark?: number[];
  sparkFavorable?: "up" | "down";
  sparkColor?: string;
  /** Override the value color (e.g. zone-keyed). Defaults to primary text. */
  valueColor?: string;
  /** Left-edge tick color (defaults to the cyan accent). */
  accent?: string;
  /** Footer metadata strip — model / source / data age. */
  meta?: Array<MetaItem | null | undefined | false>;
  testId?: string;
  className?: string;
}

/**
 * Direction A hero KPI tile — uppercase label, large JetBrains-Mono display
 * value, inline sparkline, optional CI/sub line, signed delta, and a mono
 * metadata footer. Min height 88px (iOS touch target / horizontal scroll-snap).
 */
export default function KpiTile({
  label,
  value,
  unit,
  delta,
  sub,
  spark,
  sparkFavorable = "up",
  sparkColor,
  valueColor,
  accent = "var(--color-accent)",
  meta,
  testId,
  className,
}: KpiTileProps) {
  const deltaColor = delta
    ? directionalColor(delta.value, { favorable: delta.favorable })
    : undefined;
  const deltaDigits = delta?.digits ?? 1;

  return (
    <div
      data-testid={testId}
      className={clsx(
        "relative min-h-[88px] bg-surface-card border border-border-subtle rounded-[4px] pl-4 pr-3 py-3 overflow-hidden transition-colors hover:border-border-hover",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ backgroundColor: accent }}
      />

      <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">{label}</p>

      <div className="flex items-end justify-between gap-2 mt-1.5">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span
            className="font-display text-[34px] sm:text-[40px] leading-none text-text-primary tabular-nums truncate"
            style={valueColor ? { color: valueColor } : undefined}
          >
            {value ?? "—"}
          </span>
          {unit && <span className="text-[12px] text-text-secondary font-mono">{unit}</span>}
        </div>
        {spark && spark.length >= 2 && (
          <Sparkline values={spark} favorable={sparkFavorable} color={sparkColor} width={64} height={22} />
        )}
      </div>

      {sub && <p className="text-[11px] text-text-tertiary font-mono mt-1.5 truncate">{sub}</p>}

      {delta && Number.isFinite(delta.value) && (
        <p className="text-[11px] font-mono font-medium mt-1 flex items-center gap-1" style={{ color: deltaColor }}>
          <span aria-hidden>{delta.value > 0 ? "↑" : delta.value < 0 ? "↓" : "→"}</span>
          <span>{Math.abs(delta.value).toFixed(deltaDigits)}</span>
          {delta.suffix && <span className="text-text-tertiary font-normal">{delta.suffix}</span>}
        </p>
      )}

      {meta && (
        <div className="mt-2 pt-2 border-t border-border-subtle">
          <MetadataRow items={meta} />
        </div>
      )}
    </div>
  );
}
