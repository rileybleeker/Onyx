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
 * Instrument dial — the signature recovery/strain gauge. A 270° track open at
 * the bottom, a progress arc that fills clockwise from the lower left, and tick
 * marks every 10% (longer at 0 / 50 / 100%). Colored by recovery zone
 * (green/yellow/red), strain blue, or an explicit color; the centered value
 * adopts the zone color for recovery-style dials.
 */
const START_DEG = 135;
const SWEEP_DEG = 270;

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
  const c = size / 2;
  const r = (size - thickness) / 2 - 1;
  const circ = 2 * Math.PI * r;
  const arc = (circ * SWEEP_DEG) / 360;
  const rotate = `rotate(${START_DEG} ${c} ${c})`;
  const valueColor = zone ? ringColor : undefined;
  const tickOuter = r - thickness / 2 - 3;
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const a = ((START_DEG + (SWEEP_DEG * i) / 10) * Math.PI) / 180;
    const len = i % 5 === 0 ? 6 : 3;
    // Rounded so the server and browser render identical attributes (no hydration mismatch).
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      x1: r2(c + tickOuter * Math.cos(a)),
      y1: r2(c + tickOuter * Math.sin(a)),
      x2: r2(c + (tickOuter - len) * Math.cos(a)),
      y2: r2(c + (tickOuter - len) * Math.sin(a)),
    };
  });

  return (
    <div className={clsx("flex flex-col items-center", className)} data-testid={testId}>
      {label && (
        <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-secondary mb-2">{label}</p>
      )}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden>
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            style={{ stroke: "var(--color-surface-hover)" }}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${circ}`}
            transform={rotate}
          />
          {pct > 0 && (
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={ringColor}
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={`${arc * pct} ${circ}`}
              transform={rotate}
              style={{ transition: "stroke-dasharray 600ms ease-out" }}
            />
          )}
          <g style={{ stroke: "var(--color-text-tertiary)" }} strokeWidth={1.2} strokeLinecap="round" opacity={0.7}>
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
          <span
            className="font-display font-medium leading-none tabular-nums text-text-primary"
            style={{ fontSize: size * 0.26, color: valueColor }}
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
