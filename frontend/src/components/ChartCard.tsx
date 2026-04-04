import { ReactNode } from "react";
import clsx from "clsx";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  source?: string;
  info?: string;
  children: ReactNode;
  className?: string;
}

export default function ChartCard({ title, subtitle, source, info, children, className }: ChartCardProps) {
  return (
    <div className={clsx(
      "bg-surface-card border border-border-subtle rounded-[6px] p-5 shadow-card transition-colors hover:border-border-hover",
      className
    )}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className={clsx("text-[13px] font-medium text-text-secondary", subtitle ? "mb-0.5" : "")}>
            {title}
          </h3>
          {subtitle && <p className="text-[11px] text-text-tertiary">{subtitle}</p>}
        </div>
        {source && (
          <span className="text-[9px] font-mono font-medium tracking-wider text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">
            {source}
          </span>
        )}
      </div>
      {info && (
        <p className="text-[11px] text-text-tertiary leading-relaxed mb-4 pb-3 border-b border-border-subtle">
          {info}
        </p>
      )}
      {children}
    </div>
  );
}
