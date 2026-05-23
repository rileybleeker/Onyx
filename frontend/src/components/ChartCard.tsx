"use client";

import { ReactNode, useEffect, useState } from "react";
import clsx from "clsx";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  source?: string;
  info?: string;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  storageKey?: string;
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
}: ChartCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const key = storageKey ?? title;

  useEffect(() => {
    if (!collapsible) return;
    try {
      const stored = localStorage.getItem(`chartCard.collapsed.${key}`);
      if (stored === "true") setCollapsed(true);
    } catch {}
  }, [collapsible, key]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`chartCard.collapsed.${key}`, next ? "true" : "false");
      } catch {}
      return next;
    });
  };

  const headerInner = (
    <>
      <div>
        <h3 className={clsx("text-[13px] font-medium text-text-secondary", subtitle ? "mb-0.5" : "")}>
          {title}
        </h3>
        {subtitle && <p className="text-[11px] text-text-tertiary">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {source && (
          <span className="text-[9px] font-mono font-medium tracking-wider text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">
            {source}
          </span>
        )}
        {collapsible && (
          <svg
            className={`w-4 h-4 text-text-tertiary transition-transform ${collapsed ? "" : "rotate-180"}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </div>
    </>
  );

  return (
    <div
      className={clsx(
        "bg-surface-card border border-border-subtle rounded-[6px] p-5 shadow-card transition-colors hover:border-border-hover",
        className,
      )}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className={clsx(
            "w-full flex items-start justify-between text-left cursor-pointer",
            collapsed ? "" : "mb-3",
          )}
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex items-start justify-between mb-3">{headerInner}</div>
      )}
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
