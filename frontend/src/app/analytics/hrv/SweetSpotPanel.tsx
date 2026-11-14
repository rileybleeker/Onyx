"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Bar, CartesianGrid, Cell, ComposedChart, ErrorBar, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { axisLabel, axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import {
  SWEET_SPOT_DEFAULT_X, SWEET_SPOT_DEFAULT_Y, SWEET_SPOT_MIN_CURVATURE_T,
  SWEET_SPOT_MIN_NIGHTS_CHART, SWEET_SPOT_MIN_NIGHTS_FIT, SWEET_SPOT_X, SWEET_SPOT_X_KEYS,
  SWEET_SPOT_Y, SWEET_SPOT_Y_KEYS, bucketSweetSpot, fitQuadratic, predictQuadratic,
  sweetSpotPoints, type SweetSpotRow, type SweetSpotXKey, type SweetSpotYKey,
} from "@/lib/sweet-spot";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Environment Sweet Spot: nights grouped by the level of one input, mean of one outcome of the
// SAME night per bucket (±1 SEM), plus a least-squares parabola fitted to the nightly points.
// Descriptive only (association across nights, nothing adjusted for). All logic lives in
// lib/sweet-spot.ts; `rows` comes from getEnvDoseResponseData via the page's ISR prefetch and
// silent revalidation, and both axis toggles derive locally (no refetch).

const pillBase = "px-2 py-0.5 rounded-[3px] border";
const pillOff = "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover";

export default function SweetSpotPanel({ rows }: { rows: SweetSpotRow[] }) {
  const [xKey, setXKey] = useState<SweetSpotXKey>(SWEET_SPOT_DEFAULT_X);
  const [yKey, setYKey] = useState<SweetSpotYKey>(SWEET_SPOT_DEFAULT_Y);
  const xMeta = SWEET_SPOT_X[xKey];
  const yMeta = SWEET_SPOT_Y[yKey];
  const xName = xMeta.noun;
  const yName = yMeta.noun;
  const isTemp = xMeta.unit === "°F";

  // Nights available per input for the selected outcome, shown on the selector.
  const nightsByX = useMemo(() => {
    const out = {} as Record<SweetSpotXKey, number>;
    for (const k of SWEET_SPOT_X_KEYS) out[k] = sweetSpotPoints(rows, k, yKey).length;
    return out;
  }, [rows, yKey]);

  const points = useMemo(() => sweetSpotPoints(rows, xKey, yKey), [rows, xKey, yKey]);
  const n = points.length;
  const enough = n >= SWEET_SPOT_MIN_NIGHTS_CHART;

  const chart = useMemo(() => {
    if (!enough) return null;
    const { size, buckets } = bucketSweetSpot(points, xMeta.bucketSize);
    const fit = fitQuadratic(points);
    const fmtEdge = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const data = buckets.map((b) => ({
      bucket: `${fmtEdge(b.start)}–${fmtEdge(b.end)}${isTemp ? "°F" : ""}`,
      start: b.start,
      end: b.end,
      n: b.n,
      meanY: b.meanY === null ? null : +b.meanY.toFixed(1),
      // ErrorBar skips a missing value, so an empty bucket draws nothing.
      sem: b.sem === null ? undefined : +b.sem.toFixed(2),
      sd: b.sd === null ? null : +b.sd.toFixed(2),
      fit: fit.curve ? +predictQuadratic(fit.curve, b.mid).toFixed(2) : null,
    }));
    const filled = data.filter((r) => r.meanY !== null);
    const reliable = filled.filter((r) => r.n >= 5);
    const peakRow = (reliable.length > 0 ? reliable : filled).reduce(
      (m, r) => ((r.meanY as number) > (m.meanY as number) ? r : m),
    );
    const fitPeakBucket = fit.peak
      ? data.find((r) => fit.peak!.x >= r.start && fit.peak!.x < r.end)?.bucket ?? null
      : null;
    return { size, data, filled, reliable, peakRow, fit, fitPeakBucket };
  }, [enough, points, xMeta.bucketSize, isTemp]);

  const fmtX = (v: number) => `${v.toFixed(xMeta.decimals)}${isTemp ? "" : " "}${xMeta.unit}`;
  const fmtY = (v: number) => `${v.toFixed(1)} ${yMeta.unit}`;

  let fitNote: ReactNode = null;
  if (chart) {
    const { fit } = chart;
    const lead = fit.curve ? (
      <>
        <strong className="text-text-secondary">Fitted curve</strong> (least-squares parabola on the{" "}
        {fit.n} nightly points, R² = {fit.curve.r2.toFixed(2)}):{" "}
      </>
    ) : null;
    if (fit.status === "too_few") {
      fitNote = (
        <>
          <strong className="text-text-secondary">Fitted curve hidden:</strong> it needs at least{" "}
          {SWEET_SPOT_MIN_NIGHTS_FIT} nights and this pair has {fit.n}.
        </>
      );
    } else if (fit.status === "degenerate") {
      fitNote = (
        <>
          <strong className="text-text-secondary">Fitted curve hidden:</strong> too few distinct{" "}
          {xName} values to fit a curve.
        </>
      );
    } else if (fit.status === "ok" && fit.peak) {
      fitNote = (
        <>
          {lead}it peaks at <strong className="text-text-secondary">{fmtX(fit.peak.x)}</strong>, where the
          fitted {yName} is {fmtY(fit.peak.y)}.{" "}
          {Math.abs(fit.curve!.curvatureT) < 3 && (
            <>
              The bend is weak ({Math.abs(fit.curve!.curvatureT).toFixed(1)} standard errors from zero,
              and nights are not independent), so treat this peak as tentative.{" "}
            </>
          )}
          That is the level your better nights clustered around, not proof that moving to it would
          change {yName}.
        </>
      );
    } else if (fit.status === "flat") {
      fitNote = (
        <>
          {lead}no peak shown. The bend in the curve can&apos;t be told apart from a straight line with
          this many nights (it is {Math.abs(fit.curve!.curvatureT).toFixed(1)} standard errors from zero;
          a peak needs {SWEET_SPOT_MIN_CURVATURE_T}).
        </>
      );
    } else if (fit.status === "convex") {
      fitNote = (
        <>
          {lead}no peak shown. The curve bends upward, so its turning point is a low, not a high: there
          is no best level inside the range you&apos;ve recorded.
        </>
      );
    } else if (fit.status === "outside_range") {
      const rising = -fit.curve!.b / (2 * fit.curve!.a) >= fit.xMax!;
      fitNote = (
        <>
          {lead}no peak shown. The fitted {yName} keeps {rising ? "rising" : "falling"} as {xName} goes up
          across everything you&apos;ve recorded ({fmtX(fit.xMin!)} to {fmtX(fit.xMax!)}), so any high
          point would be a guess beyond the data.
        </>
      );
    }
  }

  return (
    <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 shadow-card">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[18px] font-medium text-text-primary">Environment Sweet Spot</h3>
          <p className="text-[12px] text-text-tertiary mt-1">
            Mean {yMeta.label} per {xName} bucket · {n} nights · association, not cause
          </p>
        </div>
        <span className="text-[9px] font-mono text-text-tertiary px-2 py-0.5 rounded border border-border-subtle whitespace-nowrap">
          BINNED MEAN ± SEM
        </span>
      </div>

      {/* Axis selectors sit above the explanation so the chart-controls link is obvious. */}
      <div className="flex flex-col gap-y-2 mb-4 text-[11px] font-mono">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-tertiary uppercase tracking-wide">Input</span>
          {SWEET_SPOT_X_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setXKey(k)}
              aria-pressed={xKey === k}
              title={`${nightsByX[k]} nights with ${yName}`}
              className={`${pillBase} ${xKey === k ? "bg-accent/15 border-accent/40 text-text-primary" : pillOff}`}
            >
              {SWEET_SPOT_X[k].label}
              <span className={`ml-1.5 ${nightsByX[k] < SWEET_SPOT_MIN_NIGHTS_CHART ? "text-amber-400/80" : "text-text-tertiary"}`}>
                {nightsByX[k]}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-tertiary uppercase tracking-wide">Outcome</span>
          {SWEET_SPOT_Y_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setYKey(k)}
              aria-pressed={yKey === k}
              className={`${pillBase} ${yKey === k ? "bg-up/15 border-up/40 text-text-primary" : pillOff}`}
            >
              {SWEET_SPOT_Y[k].label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-[12px] text-text-secondary leading-relaxed space-y-3 max-w-4xl mb-4">
        <p>
          The Causal Inference section above asks whether <em>more</em> or <em>less</em> of something than
          usual moves your outcome. This panel asks a different question:{" "}
          <strong>at which level of the input did your best nights sit?</strong> Every night with both
          a {xName} value and a {yName} value is grouped into equal-width buckets and plotted as the
          per-bucket mean; the number next to each input is how many nights it has. The best level for
          HRV may differ from the best for deep sleep, which is the point of the outcome toggle.
        </p>
        <p>
          <strong>Descriptive, not causal.</strong> Nothing is adjusted for (training load, alcohol,
          season, the slow drift in your HRV), so a peak can come from whatever else was going on those
          nights. Each input is paired with the sleep that followed it the same night.
        </p>
        <p>
          <strong>Error bars are ±1 SEM</strong> (standard error of the mean). Narrower bars = more
          nights in that bucket = more trustworthy. Bars at &lt;35% opacity have n&lt;5 nights and
          shouldn&apos;t drive decisions yet. The yellow line is a parabola fitted to the nightly
          points; it is drawn from {SWEET_SPOT_MIN_NIGHTS_FIT} nights up, and its peak is marked only
          when the curve bends downward clearly enough and the high point falls inside the range
          you&apos;ve recorded.
        </p>
        <p>
          <strong>⚠ About this input ({xMeta.label}):</strong> {xMeta.caveat}
        </p>
        <p className="text-[11px] text-text-tertiary">
          <strong>Sample size today:</strong> {n} nights for this {xName} × {yName} pair.{" "}
          {n < 30 && (
            <span>Directional reads need <strong>~30 nights</strong>; confident reads need <strong>~100</strong>. {xMeta.fillsBy}</span>
          )}
          {n >= 30 && n < 100 && (
            <span>Enough for a <strong>directional read</strong>. More nights will tighten the bars.</span>
          )}
          {n >= 100 && (
            <span>Sample size is sufficient for a <strong>confident read</strong> on the best bucket.</span>
          )}
        </p>
      </div>

      {!chart ? (
        <p className="text-[11px] text-text-tertiary py-8 text-center" data-testid="sweet-spot-not-enough">
          Not enough nights yet: {n} of the {SWEET_SPOT_MIN_NIGHTS_CHART} needed with both {xName} and{" "}
          {yName}. {xMeta.fillsBy}
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chart.data} margin={{ left: 8, right: 20, top: 18, bottom: 20 }}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="bucket" tick={axisTick} label={axisLabel(xMeta.axisLabel, "x")} />
              <YAxis tick={axisTick} width={55} label={axisLabel(yMeta.axisLabel, "y")} />
              <Tooltip
                {...chartTooltip}
                formatter={(v: any, _name: any, p: any) => {
                  if (p?.dataKey === "fit") return [fmtY(Number(v)), "Fitted curve (bucket middle)"];
                  const d = p?.payload ?? {};
                  return [
                    `${Number(v).toFixed(1)} ${yMeta.unit} (n=${d.n}, SEM=±${d.sem}, SD=${d.sd})`,
                    `Mean ${yMeta.label}`,
                  ];
                }}
              />
              <Bar dataKey="meanY" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {chart.data.map((r, i) => (
                  <Cell
                    key={i}
                    fill={r.bucket === chart.peakRow.bucket ? C.up : C.accent}
                    fillOpacity={r.n < 5 ? 0.35 : 0.85}
                  />
                ))}
                <ErrorBar dataKey="sem" width={4} strokeWidth={1.5} stroke={C.source.whoop} />
              </Bar>
              {chart.fit.curve && (
                <Line
                  type="monotone"
                  dataKey="fit"
                  stroke={C.mid}
                  strokeWidth={2}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
              )}
              {chart.fit.peak && chart.fitPeakBucket && (
                <ReferenceLine
                  x={chart.fitPeakBucket}
                  stroke={C.mid}
                  strokeDasharray="4 3"
                  label={{
                    value: `fit peak ≈ ${fmtX(chart.fit.peak.x)}`,
                    position: "top",
                    fill: C.mid,
                    fontSize: 10,
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-text-tertiary mt-3">
            {chart.filled.length >= 3 ? (
              <>
                Peak bucket ({xName}):{" "}
                <strong className="text-text-secondary">
                  {chart.peakRow.bucket}{isTemp ? "" : ` ${xMeta.unit}`}
                </strong>
                , {chart.peakRow.meanY} {yMeta.unit} mean {yName} across {chart.peakRow.n} night
                {chart.peakRow.n !== 1 ? "s" : ""}.
                {chart.reliable.length === 0 && " ⚠ No buckets yet have ≥5 nights, so treat the peak as preliminary."}
              </>
            ) : (
              <>Too few buckets to name a peak bucket. Check back as data accumulates.</>
            )}
          </p>
          <p className="text-[11px] text-text-tertiary mt-2" data-testid="sweet-spot-fit-note">
            {fitNote}
          </p>
        </>
      )}
    </div>
  );
}
