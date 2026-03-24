import { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export default function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className={`text-sm font-semibold text-zinc-300 ${subtitle ? "mb-1" : "mb-4"}`}>{title}</h3>
      {subtitle && <p className="text-xs text-zinc-500 mb-3">{subtitle}</p>}
      {children}
    </div>
  );
}
