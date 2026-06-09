"use client";

import { ReactNode, useEffect, useState } from "react";
import clsx from "clsx";
import MetadataRow, { type MetaItem } from "./MetadataRow";

type Variant = "primary" | "secondary" | "compact";
type TickKey = "forecast" | "descriptive" | "causal" | "calibration";

const TICK_VARS: Record<TickKey, string> = {
  forecast: "var(--color-tick-forecast)",
  descriptive: "var(--color-tick-descriptive)",
  causal: "var(--color-tick-causal)",
  calibration: "var(--color-tick-calibration)",
};

const PADDING: Record<Variant, string> = {
  primary: "p-5",
  secondary: "p-4",
  compact: "p-3",
};

interface ChartCardProps {
  title: string;
  subtitle?: string;
  source?: string;
  info?: string;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  storageKey?: string;
  // ── Stage 2 (Direction A) additions — all optional / additive ─────────────
  variant?: Variant;
  /** Renders a relative "Xh ago" in the metadata strip (client-computed). */
  freshness?: { lastUpdate: Date | string | number };
  /** Right-aligned header slot (overflow menu, export, link-to-section). */
  actions?: ReactNode;
  /** Sample size + FDR-survival badge in the metadata strip. */
  confidence?: { n?: number; fdrPasses?: boolean };
  /** Color-keyed left-edge tick (forecast/descriptive/causal/calibration or raw color). */
  tick?: TickKey | string;
  id?: string;
}

function formatAge(d: Date): string | null {
  const ms = Date.now() - d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ChartCard({
  title,
  subtitle,
  source,
  info,
  children,
  className,
  collapsible,
  storageKey,
  variant = "secondary",
  freshness,
  actions,
  confidence,
  tick,
  id,
}: ChartCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [ageStr, setAgeStr] = useState<string | null>(null);
  const key = storageKey ?? title;

  useEffect(() => {
    if (!collapsible) return;
    try {
      const stored = localStorage.getItem(`chartCard.collapsed.${key}`);
      if (stored === "true") setCollapsed(true);
    } catch {}
  }, [collapsible, key]);

  // Compute relative freshness client-side only (avoids hydration mismatch).
  useEffect(() => {
    if (!freshness) return setAgeStr(null);
    const { lastUpdate } = freshness;
    if (typeof lastUpdate === "string" && Number.isNaN(Date.parse(lastUpdate))) {
      return setAgeStr(lastUpdate); // already a pre-formatted label
    }
    setAgeStr(formatAge(new Date(lastUpdate)));
  }, [freshness]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`chartCard.collapsed.${key}`, next ? "true" : "false");
      } catch {}
      return next;
    });
  };

  const metaItems: Array<MetaItem | null | undefined | false> = [
    ageStr ? { text: ageStr, tone: "tertiary" } : undefined,
    source ? { text: source, tone: "secondary" } : undefined,
    confidence?.n != null ? { text: `n=${confidence.n}`, tone: "tertiary" } : undefined,
    confidence?.fdrPasses ? { text: "FDR✓", tone: "up" } : undefined,
  ];
  const hasMeta = metaItems.some(Boolean);
  const tickColor = tick ? TICK_VARS[tick as TickKey] ?? tick : undefined;

  const titleBlock = (
    <div className="min-w-0">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary">
        {title}
      </h3>
      {subtitle && <p className="text-[11px] text-text-tertiary mt-0.5 normal-case tracking-normal">{subtitle}</p>}
      {hasMeta && <MetadataRow items={metaItems} className="mt-1" />}
    </div>
  );

  const chevron = collapsible && (
    <svg
      className={`w-4 h-4 text-text-tertiary transition-transform shrink-0 ${collapsed ? "" : "rotate-180"}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );

  return (
    <div
      id={id}
      className={clsx(
        "relative bg-surface-card border border-border-subtle rounded-[4px] transition-colors hover:border-border-hover",
        PADDING[variant],
        id && "scroll-mt-24",
        className,
      )}
    >
      {tickColor && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[4px]"
          style={{ backgroundColor: tickColor }}
        />
      )}
      <div className={clsx("flex items-start justify-between gap-2", collapsed ? "" : "mb-3")}>
        {collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="flex-1 min-w-0 flex items-start justify-between gap-2 text-left cursor-pointer"
          >
            {titleBlock}
            {chevron}
          </button>
        ) : (
          titleBlock
        )}
        {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
      </div>
      {!collapsed && (
        <>
          {info && (
            <p className="text-[11px] text-text-tertiary leading-relaxed mb-4 pb-3 border-b border-border-subtle">
              {info}
            </p>
          )}
          {children}
        </>
      )}
    </div>
  );
}
