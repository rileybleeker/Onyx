import clsx from "clsx";
import type { ReactNode } from "react";

type TickKey = "forecast" | "descriptive" | "causal" | "calibration";

const TICK_VARS: Record<TickKey, string> = {
  forecast: "var(--color-tick-forecast)",
  descriptive: "var(--color-tick-descriptive)",
  causal: "var(--color-tick-causal)",
  calibration: "var(--color-tick-calibration)",
};

interface SectionHeaderProps {
  title: string;
  /** Color-keyed left-edge tick (Bloomberg-style section keying). Pass a known
   * key or any raw CSS color. Omit for a neutral hairline. */
  tick?: TickKey | string;
  /** One-line description / kicker under the title. */
  kicker?: string;
  /** Right-aligned controls (RangeFilter, toggles, links). */
  actions?: ReactNode;
  /** Anchor id for the in-page TOC. */
  id?: string;
  className?: string;
}

/**
 * Direction A section header — a 1px divider with a 12px-wide colored tick at
 * the left edge keyed to section function (forecast=cyan, descriptive=neutral,
 * causal=amber, calibration=green), an 18px Geist Sans title, an optional
 * kicker, and a right-aligned actions slot.
 */
export default function SectionHeader({
  title,
  tick,
  kicker,
  actions,
  id,
  className,
}: SectionHeaderProps) {
  const tickColor = tick
    ? TICK_VARS[tick as TickKey] ?? tick
    : "var(--color-border-default)";

  return (
    <div
      id={id}
      className={clsx(
        "flex items-end justify-between gap-3 border-t border-border-subtle pt-3 mb-3",
        id && "scroll-mt-24",
        className,
      )}
      style={{ borderTopColor: "transparent" }}
    >
      <div className="min-w-0 flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-1 h-4 w-[3px] shrink-0 rounded-full"
          style={{ backgroundColor: tickColor }}
        />
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-text-primary leading-tight truncate">
            {title}
          </h2>
          {kicker && <p className="text-[12px] text-text-tertiary mt-0.5">{kicker}</p>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
