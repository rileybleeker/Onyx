"use client";

import { useEffect, useState, useMemo } from "react";
import {
  ScatterChart, Scatter, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell,
  CartesianGrid, ReferenceLine,
} from "recharts";
import { getRecoveryVsPace } from "@/lib/queries";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

const WORKOUT_COLORS: Record<string, string> = {
  AEROBIC_BASE: "#3b82f6",
  TEMPO: "#f59e0b",
  LACTATE_THRESHOLD: "#f97316",
  VO2MAX: "#ef4444",
  ANAEROBIC_CAPACITY: "#a855f7",
  RECOVERY: "#22c55e",
};

function recoveryColor(score: number): string {
  if (score >= 67) return "#22c55e";
  if (score >= 34) return "#f59e0b";
  return "#ef4444";
}

function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 text-xs space-y-1">
      <p className="font-medium text-white">{d.name}</p>
      <p className="text-zinc-400">{d.date}</p>
      <p>Recovery: <span className="text-white">{d.recovery}%</span></p>
      {d.paceDelta != null && <p>Pace Delta: <span className={d.paceDelta <= 0 ? "text-green-400" : "text-red-400"}>{d.paceDelta > 0 ? "+" : ""}{d.paceDelta}%</span></p>}
      <p>Actual: <span className="text-white">{d.actualPace} min/mi</span></p>
      {d.targetPace && <p>Target: <span className="text-zinc-300">{d.targetPace} min/mi</span></p>}
      <p>HRV: <span className="text-white">{d.hrv} ms</span></p>
      <p className="text-zinc-500">{d.type}</p>
    </div>
  );
}

export default function RecoveryPage() {
  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRecoveryVsPace(730)
      .then(setRaw)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // All runs with recovery data
  const allRuns = useMemo(() => raw.map((d) => ({
    date: d.activity_date,
    name: d.activity_name,
    recovery: d.whoop_recovery ? +d.whoop_recovery : null,
    hrv: d.whoop_hrv ? +Number(d.whoop_hrv).toFixed(1) : null,
    sleepPerf: d.whoop_sleep_performance ? +d.whoop_sleep_performance : null,
    paceDelta: d.pace_delta_pct != null ? +d.pace_delta_pct : null,
    actualPace: d.actual_pace_min_per_mile ? +d.actual_pace_min_per_mile : null,
    targetPace: d.target_pace_min_per_mile ? +d.target_pace_min_per_mile : null,
    overallPace: d.overall_pace_min_per_mile ? +d.overall_pace_min_per_mile : null,
    type: d.training_effect_label || "UNKNOWN",
    avgHr: d.avg_heart_rate,
    maxHr: d.max_heart_rate,
  })).filter((d) => d.recovery != null), [raw]);

  // Runs with pace delta (have target paces)
  const withTarget = useMemo(() => allRuns.filter((d) => d.paceDelta != null), [allRuns]);

  // Binned analysis
  const bins = useMemo(() => {
    const buckets = [
      { label: "Red (0-33)", min: 0, max: 33, color: "#ef4444", runs: [] as any[] },
      { label: "Yellow (34-66)", min: 34, max: 66, color: "#f59e0b", runs: [] as any[] },
      { label: "Green (67-100)", min: 67, max: 100, color: "#22c55e", runs: [] as any[] },
    ];
    for (const run of withTarget) {
      const b = buckets.find((b) => run.recovery! >= b.min && run.recovery! <= b.max);
      if (b) b.runs.push(run);
    }
    return buckets.map((b) => ({
      label: b.label,
      color: b.color,
      count: b.runs.length,
      avgPaceDelta: b.runs.length > 0
        ? +(b.runs.reduce((s, r) => s + r.paceDelta!, 0) / b.runs.length).toFixed(2)
        : 0,
      avgHrv: b.runs.length > 0
        ? +(b.runs.reduce((s, r) => s + (r.hrv || 0), 0) / b.runs.length).toFixed(0)
        : 0,
    }));
  }, [withTarget]);

  // Per-workout-type breakdown
  const byType = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const run of allRuns) {
      if (!groups[run.type]) groups[run.type] = [];
      groups[run.type].push(run);
    }
    return Object.entries(groups)
      .map(([type, runs]) => {
        const withDelta = runs.filter((r) => r.paceDelta != null);
        return {
          type,
          color: WORKOUT_COLORS[type] || "#71717a",
          count: runs.length,
          avgRecovery: +(runs.reduce((s, r) => s + r.recovery!, 0) / runs.length).toFixed(0),
          avgPace: runs.filter((r) => r.overallPace).length > 0
            ? +(runs.filter((r) => r.overallPace).reduce((s, r) => s + r.overallPace!, 0) / runs.filter((r) => r.overallPace).length).toFixed(2)
            : null,
          avgPaceDelta: withDelta.length > 0
            ? +(withDelta.reduce((s, r) => s + r.paceDelta!, 0) / withDelta.length).toFixed(2)
            : null,
          deltaCount: withDelta.length,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [allRuns]);

  // Scatter: recovery vs overall pace for ALL runs (not just those with targets)
  const scatterAll = useMemo(() => allRuns.filter((d) => d.overallPace != null), [allRuns]);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading recovery data...</div></div>;
  }

  const totalWithDelta = withTarget.length;
  const avgDelta = totalWithDelta > 0 ? +(withTarget.reduce((s, r) => s + r.paceDelta!, 0) / totalWithDelta).toFixed(1) : null;

  return (
    <>
      <h2 className="text-2xl font-bold mb-2">Recovery vs Performance</h2>
      <p className="text-zinc-500 text-sm mb-6">How WHOOP recovery correlates with running pace performance</p>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Runs" value={allRuns.length} sublabel="with recovery data" />
        <StatCard label="With Target Pace" value={totalWithDelta} sublabel="pace delta computed" />
        <StatCard label="Avg Pace Delta" value={avgDelta != null ? `${avgDelta > 0 ? "+" : ""}${avgDelta}%` : null} sublabel="negative = faster" />
        <StatCard label="Avg Recovery" value={allRuns.length > 0 ? `${Math.round(allRuns.reduce((s, r) => s + r.recovery!, 0) / allRuns.length)}%` : null} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Scatter: Recovery vs Pace Delta (workouts with targets) */}
        {totalWithDelta > 0 && (
          <ChartCard title={`Recovery % vs Pace Delta (${totalWithDelta} workouts)`}>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis type="number" dataKey="recovery" name="Recovery" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} domain={[0, 100]} />
                <YAxis type="number" dataKey="paceDelta" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                <Tooltip content={<ScatterTooltip />} />
                <Scatter data={withTarget} shape="circle">
                  {withTarget.map((d, i) => (
                    <Cell key={i} fill={WORKOUT_COLORS[d.type] || "#71717a"} fillOpacity={0.8} r={6} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-3 px-4 pb-3">
              {Object.entries(WORKOUT_COLORS).map(([type, color]) => {
                const count = withTarget.filter((d) => d.type === type).length;
                if (count === 0) return null;
                return (
                  <span key={type} className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                    {type.replace(/_/g, " ")} ({count})
                  </span>
                );
              })}
            </div>
          </ChartCard>
        )}

        {/* Scatter: Recovery vs Overall Pace (all runs) */}
        <ChartCard title={`Recovery % vs Overall Pace (${scatterAll.length} runs)`}>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis type="number" dataKey="recovery" name="Recovery" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} domain={[0, 100]} />
              <YAxis type="number" dataKey="overallPace" name="Pace" unit=" min/mi" tick={{ fill: "#71717a", fontSize: 11 }} reversed />
              <Tooltip content={<ScatterTooltip />} />
              <Scatter data={scatterAll} shape="circle">
                {scatterAll.map((d, i) => (
                  <Cell key={i} fill={WORKOUT_COLORS[d.type] || "#71717a"} fillOpacity={0.7} r={5} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Binned Analysis */}
        <ChartCard title="Avg Pace Delta by Recovery Zone">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={bins} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 11 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} />
              <ReferenceLine y={0} stroke="#71717a" />
              <Tooltip {...tt} formatter={(value: any) => [`${value}%`, "Avg Pace Delta"]} />
              <Bar dataKey="avgPaceDelta" name="Avg Pace Delta %" radius={[4, 4, 0, 0]}>
                {bins.map((b, i) => (
                  <Cell key={i} fill={b.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="px-4 pb-3 text-xs text-zinc-500">
            {bins.map((b) => (
              <span key={b.label} className="mr-4">{b.label}: {b.count} runs, avg HRV {b.avgHrv}ms</span>
            ))}
          </div>
        </ChartCard>

        {/* Per-Type Breakdown */}
        <ChartCard title="Performance by Workout Type">
          <div className="px-4 pb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 font-medium">Type</th>
                  <th className="text-right py-2 font-medium">Runs</th>
                  <th className="text-right py-2 font-medium">Avg Recovery</th>
                  <th className="text-right py-2 font-medium">Avg Pace</th>
                  <th className="text-right py-2 font-medium">Avg Delta</th>
                </tr>
              </thead>
              <tbody>
                {byType.map((t) => (
                  <tr key={t.type} className="border-b border-zinc-800/50">
                    <td className="py-2.5 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                      <span className="text-zinc-300">{t.type.replace(/_/g, " ")}</span>
                    </td>
                    <td className="text-right text-zinc-400">{t.count}</td>
                    <td className="text-right">
                      <span style={{ color: recoveryColor(t.avgRecovery) }}>{t.avgRecovery}%</span>
                    </td>
                    <td className="text-right text-zinc-300">{t.avgPace ?? "—"} min/mi</td>
                    <td className="text-right">
                      {t.avgPaceDelta != null ? (
                        <span className={t.avgPaceDelta <= 0 ? "text-green-400" : "text-red-400"}>
                          {t.avgPaceDelta > 0 ? "+" : ""}{t.avgPaceDelta}% <span className="text-zinc-600">({t.deltaCount})</span>
                        </span>
                      ) : <span className="text-zinc-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        {/* HRV vs Pace Delta scatter */}
        {totalWithDelta > 0 && (
          <ChartCard title={`HRV vs Pace Delta (${totalWithDelta} workouts)`}>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis type="number" dataKey="hrv" name="HRV" unit=" ms" tick={{ fill: "#71717a", fontSize: 11 }} />
                <YAxis type="number" dataKey="paceDelta" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                <Tooltip content={<ScatterTooltip />} />
                <Scatter data={withTarget.filter((d) => d.hrv != null)} shape="circle">
                  {withTarget.filter((d) => d.hrv != null).map((d, i) => (
                    <Cell key={i} fill={recoveryColor(d.recovery!)} fillOpacity={0.8} r={6} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Sleep Performance vs Pace Delta */}
        {totalWithDelta > 0 && (
          <ChartCard title={`Sleep Performance vs Pace Delta`}>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis type="number" dataKey="sleepPerf" name="Sleep Performance" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} domain={[50, 100]} />
                <YAxis type="number" dataKey="paceDelta" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                <Tooltip content={<ScatterTooltip />} />
                <Scatter data={withTarget.filter((d) => d.sleepPerf != null)} shape="circle">
                  {withTarget.filter((d) => d.sleepPerf != null).map((d, i) => (
                    <Cell key={i} fill={recoveryColor(d.recovery!)} fillOpacity={0.8} r={6} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    </>
  );
}
