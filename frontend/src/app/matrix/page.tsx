"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid,
} from "recharts";
import { getHealthMatrix } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { icc } from "@/lib/stats";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SOURCE_COLORS = {
  garmin: "#3B82F6",
  whoop: "#F59E0B",
  eightsleep: "#8B5CF6",
};

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

export default function MatrixPage() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHealthMatrix(30)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 space-y-3">
              <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
              <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
            </div>
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
            <h2 className="text-[28px] font-medium text-text-primary">Health Matrix</h2>
            <p className="text-sm text-text-tertiary mt-0.5">Cross-device comparison</p>
          </div>
        </div>
        <p className="text-text-tertiary">No data in the daily_health_matrix view yet. Make sure your ETL pipelines have synced data.</p>
      </>
    );
  }

  const chartData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    // Recovery & readiness
    whoopRecovery: d.whoop_recovery_score,
    trainingReadiness: d.training_readiness_score,
    // Sleep scores across devices
    garminSleep: d.garmin_sleep_score,
    whoopSleepPerf: d.whoop_sleep_performance,
    eightSleep: d.eight_sleep_score,
    // HRV comparison
    garminHrv: d.garmin_hrv ? +Number(d.garmin_hrv).toFixed(0) : null,
    whoopHrv: d.whoop_hrv_rmssd ? +Number(d.whoop_hrv_rmssd).toFixed(0) : null,
    eightHrv: d.eight_sleep_hrv ? +Number(d.eight_sleep_hrv).toFixed(0) : null,
    // RHR comparison
    garminRhr: d.garmin_rhr,
    whoopRhr: d.whoop_rhr,
    eightHr: d.eight_sleep_hr ? +Number(d.eight_sleep_hr).toFixed(0) : null,
    // Activity
    steps: d.total_steps,
    strain: d.whoop_day_strain ? +Number(d.whoop_day_strain).toFixed(1) : null,
    // Stress & battery
    stress: d.avg_stress_level,
    bbHigh: d.body_battery_highest,
    bbLow: d.body_battery_lowest,
  }));

  const sleepIcc = icc([
    data.map((d) => d.garmin_sleep_score),
    data.map((d) => d.whoop_sleep_performance),
    data.map((d) => d.eight_sleep_score),
  ]);
  const hrvIcc = icc([
    data.map((d) => d.garmin_hrv ? +d.garmin_hrv : null),
    data.map((d) => d.whoop_hrv_rmssd ? +d.whoop_hrv_rmssd : null),
    data.map((d) => d.eight_sleep_hrv ? +d.eight_sleep_hrv : null),
  ]);
  const rhrIcc = icc([
    data.map((d) => d.garmin_rhr),
    data.map((d) => d.whoop_rhr),
    data.map((d) => d.eight_sleep_hr ? +d.eight_sleep_hr : null),
  ]);

  const fmtIcc = (result: ReturnType<typeof icc>) =>
    result ? `ICC(3,1) = ${result.value.toFixed(2)}  (n = ${result.n} days, k = ${result.k} sources)` : "ICC: insufficient overlapping data";

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Health Matrix</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Cross-device comparison — Garmin, WHOOP, Eight Sleep side by side</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Recovery & Readiness">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="whoopRecovery" stroke={SOURCE_COLORS.whoop} strokeWidth={2} dot={false} name="WHOOP Recovery" />
              <Line type="monotone" dataKey="trainingReadiness" stroke={SOURCE_COLORS.garmin} strokeWidth={2} dot={false} name="Garmin Readiness" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores (3 Sources)" subtitle={fmtIcc(sleepIcc)}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="garminSleep" stroke={SOURCE_COLORS.garmin} strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopSleepPerf" stroke={SOURCE_COLORS.whoop} strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightSleep" stroke={SOURCE_COLORS.eightsleep} strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="HRV Comparison (ms)" subtitle={fmtIcc(hrvIcc)}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="garminHrv" stroke={SOURCE_COLORS.garmin} strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopHrv" stroke={SOURCE_COLORS.whoop} strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightHrv" stroke={SOURCE_COLORS.eightsleep} strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting Heart Rate (bpm)" subtitle={fmtIcc(rhrIcc)}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="garminRhr" stroke={SOURCE_COLORS.garmin} strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopRhr" stroke={SOURCE_COLORS.whoop} strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightHr" stroke={SOURCE_COLORS.eightsleep} strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Steps & Strain">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="steps" tick={axisTick} width={50} />
              <YAxis yAxisId="strain" orientation="right" tick={axisTick} width={40} domain={[0, 21]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Bar yAxisId="steps" dataKey="steps" fill="#3b82f640" stroke={SOURCE_COLORS.garmin} name="Steps" radius={[3, 3, 0, 0]} />
              <Line yAxisId="strain" type="monotone" dataKey="strain" stroke={SOURCE_COLORS.whoop} strokeWidth={2} dot={false} name="WHOOP Strain" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress & Body Battery">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="bbHigh" stroke="#22c55e" strokeWidth={2} dot={false} name="BB High" />
              <Line type="monotone" dataKey="bbLow" stroke="#ef4444" strokeWidth={1.5} dot={false} name="BB Low" />
              <Line type="monotone" dataKey="stress" stroke="#f97316" strokeWidth={2} dot={false} name="Avg Stress" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
