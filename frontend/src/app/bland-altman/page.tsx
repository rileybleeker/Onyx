"use client";

import { useEffect, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Label,
} from "recharts";
import { getHealthMatrix } from "@/lib/queries";
import { blandAltman } from "@/lib/stats";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

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
        <div className="flex items-center justify-center h-[260px] text-zinc-600 text-sm">
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
          <XAxis
            dataKey="mean"
            type="number"
            domain={[xMin - pad, xMax + pad]}
            tick={{ fill: "#71717a", fontSize: 11 }}
            name="Mean"
          >
            <Label value={`Mean of both (${unit})`} fill="#71717a" fontSize={11} position="insideBottom" offset={-10} />
          </XAxis>
          <YAxis
            dataKey="diff"
            type="number"
            tick={{ fill: "#71717a", fontSize: 11 }}
            width={50}
            name="Difference"
          >
            <Label value={`Difference (${unit})`} fill="#71717a" fontSize={11} angle={-90} position="insideLeft" />
          </YAxis>
          <Tooltip
            {...tt}
            formatter={(value: number, name: string) => [value.toFixed(1), name]}
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
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-zinc-500">Loading Bland-Altman analysis...</div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <>
        <h2 className="text-2xl font-bold mb-6">Bland-Altman Analysis</h2>
        <p className="text-zinc-500">No data available. Make sure your ETL pipelines have synced data.</p>
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
      <h2 className="text-2xl font-bold mb-2">Bland-Altman Analysis</h2>
      <p className="text-zinc-500 text-sm mb-6">
        Method agreement between Garmin, WHOOP, and Eight Sleep (last 90 days).
        Each plot shows the difference vs. the mean of two devices.
        The amber line is the bias (mean difference); red dashed lines are the 95% limits of agreement.
      </p>

      {metrics.map((metric) => (
        <div key={metric.label} className="mb-8">
          <h3 className="text-lg font-semibold text-zinc-200 mb-4">{metric.label}</h3>
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
