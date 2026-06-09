"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { zoneColor, chartColors } from "@/lib/chart-theme";

interface MetricRingProps {
  /** Current value (in the same unit as `max`). */
  value: number;
  /** Full-ring value. Default 100 (percent). */
  max?: number;
  size?: number;
  thickness?: number;
  /** Explicit ring color — overrides `zone` / `strain`. */
  color?: string;
  /** Color the ring (and value) by WHOOP recovery zone: ≥67 green / ≥34 yellow / red. */
  zone?: boolean;
  /** Render in WHOOP strain blue. */
  strain?: boolean;
  /** Eyebrow label above the ring. */
  label?: string;
  /** Big centered value. Defaults to the rounded `value`. */
  centerValue?: ReactNode;
  centerUnit?: string;
  /** Small line under the centered value. */
  sublabel?: string;
  className?: string;
  testId?: string;
}

/**
 * WHOOP-style circular gauge — the signature recovery/strain ring. A subtle
 * track plus a progress arc that starts at 12 o'clock and fills clockwise,
 * colored by recovery zone (green/yellow/red), strain blue, or an explicit
 * color. The centered value adopts the zone color for recovery-style rings.
 */
export default function MetricRing({
  value,
  max = 100,
  size = 132,
  thickness = 10,
  color,
  zone,
  strain,
  label,
  centerValue,
  centerUnit,
  sublabel,
  className,
  testId,
}: MetricRingProps) {
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  const ringColor =
    color ?? (strain ? chartColors.strainBright : zone ? zoneColor(value, max) : chartColors.accent);
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);
  const valueColor = zone ? ringColor : undefined;

  return (
    <div className={clsx("flex flex-col items-center", className)} data-testid={testId}>
      {label && (
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary mb-2">{label}</p>
      )}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={thickness}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={ringColor}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 600ms ease-out" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
          <span
            className="font-display leading-none tabular-nums text-text-primary"
            style={{ fontSize: size * 0.3, color: valueColor }}
          >
            {centerValue ?? (Number.isFinite(value) ? Math.round(value) : "—")}
          </span>
          {centerUnit && <span className="text-[11px] text-text-secondary font-mono mt-1">{centerUnit}</span>}
          {sublabel && <span className="text-[10px] text-text-tertiary mt-0.5">{sublabel}</span>}
        </div>
      </div>
    </div>
  );
}
