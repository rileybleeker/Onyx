import type { MiniChart } from "@/lib/overview-views";

/**
 * The overview cards' one small chart: seven bars or a line, hand-drawn SVG (no chart library, no animation,
 * a few dozen nodes), theme colors through currentColor. A missing day leaves a gap; a still-growing last
 * value ("so far today") is drawn dimmed. The caption is the accessible name.
 */
export default function Spark({ chart }: { chart: MiniChart }) {
  const { values, labels } = chart;
  const n = values.length;
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const max = nums.length ? Math.max(...nums) : 0;
  const min = nums.length ? Math.min(...nums) : 0;
  const W = 100;
  const H = 36;
  const slot = W / Math.max(n, 1);
  return (
    <figure className="m-0">
      <figcaption className="truncate text-[10px] text-text-tertiary">{chart.caption}</figcaption>
      <svg role="img" aria-label={chart.caption} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 block h-9 w-full text-accent">
        {chart.kind === "bars" ? values.map((v, i) => {
          if (v === null || !Number.isFinite(v) || max <= 0) return <rect key={i} x={i * slot + slot * 0.2} y={H - 1} width={slot * 0.6} height={1} className="fill-current" opacity={0.2} />;
          const h = Math.max(1.5, (v / max) * (H - 2));
          return <rect key={i} x={i * slot + slot * 0.2} y={H - h} width={slot * 0.6} height={h} rx={0.8} className="fill-current" opacity={chart.partialLast && i === n - 1 ? 0.4 : 0.85} />;
        }) : (() => {
          const span = max - min || 1;
          const pts = values.map((v, i) => (v === null || !Number.isFinite(v) ? null : `${(i + 0.5) * slot},${H - 3 - ((v - min) / span) * (H - 6)}`));
          // One polyline per run of known values, so a missing night is a gap rather than a made-up slope.
          const runs: string[][] = [];
          let run: string[] = [];
          for (const p of pts) { if (p) run.push(p); else if (run.length) { runs.push(run); run = []; } }
          if (run.length) runs.push(run);
          return runs.map((r, i) => <polyline key={i} points={r.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />);
        })()}
      </svg>
      <div aria-hidden="true" className="mt-0.5 flex text-[9px] leading-3 text-text-tertiary">
        {labels.map((l, i) => <span key={i} className="flex-1 text-center">{l}</span>)}
      </div>
    </figure>
  );
}
