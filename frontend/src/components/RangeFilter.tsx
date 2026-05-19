"use client";

import type { Range } from "@/lib/queries";

export const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: "1d",   label: "1D" },
  { value: "7d",   label: "1W" },
  { value: "30d",  label: "30D" },
  { value: "60d",  label: "60D" },
  { value: "90d",  label: "90D" },
  { value: "365d", label: "1Y" },
  { value: "all",  label: "ALL" },
];

type RangeFilterProps = {
  value: Range;
  onChange: (value: Range) => void;
  accent?: string;
  ariaLabel?: string;
};

export default function RangeFilter({
  value,
  onChange,
  accent = "#3B82F6",
  ariaLabel = "Time range",
}: RangeFilterProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-[6px] border border-border-subtle bg-black/30 p-0.5 overflow-x-auto"
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={
              active
                ? { backgroundColor: `${accent}33`, borderColor: `${accent}66` }
                : undefined
            }
            className={`px-2.5 py-1 text-[10px] font-mono tracking-wide rounded-[4px] transition-colors ${
              active
                ? "text-text-primary border"
                : "text-text-tertiary hover:text-text-secondary border border-transparent"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
