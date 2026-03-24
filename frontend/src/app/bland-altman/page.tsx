"use client";

import { useEffect, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid, Label,
} from "recharts";
import { getHealthMatrix } from "@/lib/queries";
import { blandAltman } from "@/lib/stats";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BAResult {
  bias: number;
  sd: number;
  lowerLoA: number;
  upperLoA: number;
  points: { mean: number; diff: number }[];
  n: number;
}

const PAIRS: [string, string, string][] = [
  ["Garmin", "WHOOP", "#3b82f6"],
  ["Garmin", "Eight Sleep", "#8b5cf6"],
  ["WHOOP", "Eight Sleep", "#22c55e"],
];

function fmtBA(ba: BAResult | null): string {
  if (!ba) return "Insufficient overlapping data";
  return `Bias = ${ba.bias.toFixed(1)} | LoA = [${ba.lowerLoA.toFixed(1)}, ${ba.upperLoA.toFixed(1)}] | n = ${ba.n}`;
}

function BAPlot({
  title,
  subtitle,
  result,
  color,
  unit,
}: {
  title: string;
  subtitle: string;
  result: BAResult | null;
  color: string;
  unit: string;
}) {
  if (!result) {
    return (
      <ChartCard title={title} subtitle="Insufficient overlapping data">
        <div className="flex items-center justify-center h-[260px] text-text-tertiary text-sm">
          Not enough paired observations
        </div>
      </ChartCard>
    );
  }

  const xMin = Math.min(...result.points.map((p) => p.mean));
  const xMax = Math.max(...result.points.map((p) => p.mean));
  const pad = (xMax - xMin) * 0.05 || 5;

  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid {...gridStyle} />
          <XAxis
            dataKey="mean"
            type="number"
            domain={[xMin - pad, xMax + pad]}
            tick={axisTick}
            name="Mean"
          />
          <YAxis
            dataKey="diff"
            type="number"
            tick={axisTick}
            width={50}
            name="Difference"
          />
          <Tooltip
            {...chartTooltip}
            formatter={(value: any, name: any) => [(+value).toFixed(1), name]}
          />
          {/* Bias line */}
          <ReferenceLine y={result.bias} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={2}>
            <Label value={`Bias ${result.bias.toFixed(1)}`} fill="#f59e0b" fontSize={10} position="right" />
          </ReferenceLine>
          {/* Upper LoA */}
          <ReferenceLine y={result.upperLoA} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1.5}>
            <Label value={`+1.96 SD (${result.upperLoA.toFixed(1)})`} fill="#ef4444" fontSize={10} position="right" />
          </ReferenceLine>
          {/* Lower LoA */}
          <ReferenceLine y={result.lowerLoA} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1.5}>
            <Label value={`-1.96 SD (${result.lowerLoA.toFixed(1)})`} fill="#ef4444" fontSize={10} position="right" />
          </ReferenceLine>
          {/* Zero line */}
          <ReferenceLine y={0} stroke="#3f3f46" strokeWidth={1} />
          <Scatter data={result.points} fill={color} fillOpacity={0.7} r={4} />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export default function BlandAltmanPage() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHealthMatrix(90)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-baseline justify-between mb-8">
          <div>
            <div className="h-7 w-64 bg-white/5 animate-pulse rounded-[4px]" />
            <div className="h-4 w-96 bg-white/5 animate-pulse rounded-[4px] mt-2" />
          </div>
        </div>
        <div className="h-40 bg-white/5 animate-pulse rounded-[6px]" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-[320px] bg-white/5 animate-pulse rounded-[6px]" />
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <>
        <div className="flex items-baseline justify-between mb-8">
          <div>
            <h2 className="text-[28px] font-medium text-text-primary">Bland-Altman Analysis</h2>
            <p className="text-sm text-text-tertiary mt-0.5">Method agreement analysis</p>
          </div>
        </div>
        <p className="text-text-tertiary">No data available. Make sure your ETL pipelines have synced data.</p>
      </>
    );
  }

  // Extract arrays per source
  const garminSleep = data.map((d) => d.garmin_sleep_score);
  const whoopSleep = data.map((d) => d.whoop_sleep_performance);
  const eightSleep = data.map((d) => d.eight_sleep_score);

  const garminHrv = data.map((d) => d.garmin_hrv ? +d.garmin_hrv : null);
  const whoopHrv = data.map((d) => d.whoop_hrv_rmssd ? +d.whoop_hrv_rmssd : null);
  const eightHrv = data.map((d) => d.eight_sleep_hrv ? +d.eight_sleep_hrv : null);

  const garminRhr = data.map((d) => d.garmin_rhr);
  const whoopRhr = data.map((d) => d.whoop_rhr);
  const eightHr = data.map((d) => d.eight_sleep_hr ? +d.eight_sleep_hr : null);

  // Compute all 9 Bland-Altman comparisons
  const sleepBA = [
    blandAltman(garminSleep, whoopSleep),
    blandAltman(garminSleep, eightSleep),
    blandAltman(whoopSleep, eightSleep),
  ];
  const hrvBA = [
    blandAltman(garminHrv, whoopHrv),
    blandAltman(garminHrv, eightHrv),
    blandAltman(whoopHrv, eightHrv),
  ];
  const rhrBA = [
    blandAltman(garminRhr, whoopRhr),
    blandAltman(garminRhr, eightHr),
    blandAltman(whoopRhr, eightHr),
  ];

  const metrics = [
    { label: "Sleep Score", unit: "%", results: sleepBA },
    { label: "HRV", unit: "ms", results: hrvBA },
    { label: "Resting Heart Rate", unit: "bpm", results: rhrBA },
  ];

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Bland-Altman Analysis</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Method agreement between Garmin, WHOOP, and Eight Sleep — last 90 days, pairwise.
          </p>
        </div>
      </div>

      <div className="bg-surface-card border border-border-subtle rounded-[6px] p-5 mb-8 text-sm text-text-secondary space-y-3 max-w-3xl">
        <p>
          <span className="text-text-primary font-medium">What is Bland-Altman?</span>{" "}
          A Bland-Altman plot tests whether two devices <em>agree</em> on the same measurement — not just whether they correlate.
          Two devices can be perfectly correlated (r = 1.0) yet still disagree if one consistently reads higher.
          Each dot plots <span className="text-text-primary">the difference</span> (Device A − Device B) against{" "}
          <span className="text-text-primary">the mean</span> of both readings for that day.
        </p>
        <p>
          <span className="text-amber-400 font-medium">Bias</span> (amber line) is the average difference between two devices.
          A bias of 0 means no systematic offset. Positive bias means Device A reads higher on average;
          negative means Device B reads higher. Small bias = the devices are calibrated similarly.
        </p>
        <p>
          <span className="text-red-400 font-medium">Limits of Agreement</span> (red dashed lines) mark the range where 95% of day-to-day differences fall (bias ± 1.96 × SD).
          Narrow LoA = devices give similar readings on any given day.
          Wide LoA = even if the average bias is small, individual readings can differ substantially.
        </p>
        <p>
          <span className="text-text-primary font-medium">What to look for:</span>{" "}
          Dots should be randomly scattered with no pattern. A fan/funnel shape means the devices diverge more at higher or lower values (proportional bias).
          If most dots cluster near the zero line with narrow LoA, the devices are effectively interchangeable for that metric.
        </p>

        <div className="border-t border-border-subtle pt-3">
          <p className="text-text-primary font-medium mb-2">Interpretation guide</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-tertiary uppercase text-[10px] font-mono tracking-wider">
                <th className="text-left py-1 font-medium">Metric</th>
                <th className="text-center py-1 font-medium">Excellent bias</th>
                <th className="text-center py-1 font-medium">Moderate bias</th>
                <th className="text-center py-1 font-medium">Poor bias</th>
                <th className="text-center py-1 font-medium">Tight LoA width</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-t border-white/5">
                <td className="py-1.5">Sleep Score (%)</td>
                <td className="text-center text-green-400 font-mono">&lt; 5 pts</td>
                <td className="text-center text-amber-400 font-mono">5 – 10 pts</td>
                <td className="text-center text-red-400 font-mono">&gt; 10 pts</td>
                <td className="text-center font-mono">± 10 pts</td>
              </tr>
              <tr className="border-t border-white/5">
                <td className="py-1.5">HRV (ms)</td>
                <td className="text-center text-green-400 font-mono">&lt; 5 ms</td>
                <td className="text-center text-amber-400 font-mono">5 – 15 ms</td>
                <td className="text-center text-red-400 font-mono">&gt; 15 ms</td>
                <td className="text-center font-mono">± 15 ms</td>
              </tr>
              <tr className="border-t border-white/5">
                <td className="py-1.5">Resting HR (bpm)</td>
                <td className="text-center text-green-400 font-mono">&lt; 2 bpm</td>
                <td className="text-center text-amber-400 font-mono">2 – 5 bpm</td>
                <td className="text-center text-red-400 font-mono">&gt; 5 bpm</td>
                <td className="text-center font-mono">± 5 bpm</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {metrics.map((metric) => (
        <div key={metric.label} className="mb-8">
          <h3 className="text-lg font-semibold text-text-primary mb-4">{metric.label}</h3>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {PAIRS.map(([a, b, color], i) => (
              <BAPlot
                key={`${metric.label}-${a}-${b}`}
                title={`${a} vs ${b}`}
                subtitle={fmtBA(metric.results[i])}
                result={metric.results[i]}
                color={color}
                unit={metric.unit}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
