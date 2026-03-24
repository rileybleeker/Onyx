"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getHealthMatrix } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

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
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading health matrix...</div></div>;
  }

  if (data.length === 0) {
    return (
      <>
        <h2 className="text-2xl font-bold mb-6">Health Matrix</h2>
        <p className="text-zinc-500">No data in the daily_health_matrix view yet. Make sure your ETL pipelines have synced data.</p>
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

  return (
    <>
      <h2 className="text-2xl font-bold mb-2">Health Matrix</h2>
      <p className="text-zinc-500 text-sm mb-6">Cross-device comparison — Garmin, WHOOP, Eight Sleep side by side</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Recovery & Readiness">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} label={{ value: "Score (%)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="whoopRecovery" stroke="#22c55e" strokeWidth={2} dot={false} name="WHOOP Recovery" />
              <Line type="monotone" dataKey="trainingReadiness" stroke="#3b82f6" strokeWidth={2} dot={false} name="Garmin Readiness" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores (3 Sources)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} label={{ value: "Score (%)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="garminSleep" stroke="#3b82f6" strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopSleepPerf" stroke="#22c55e" strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightSleep" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="HRV Comparison (ms)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "HRV (ms)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="garminHrv" stroke="#3b82f6" strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopHrv" stroke="#22c55e" strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightHrv" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting Heart Rate (bpm)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "Heart Rate (bpm)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="garminRhr" stroke="#3b82f6" strokeWidth={2} dot={false} name="Garmin" />
              <Line type="monotone" dataKey="whoopRhr" stroke="#22c55e" strokeWidth={2} dot={false} name="WHOOP" />
              <Line type="monotone" dataKey="eightHr" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Eight Sleep" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Steps & Strain">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis yAxisId="steps" tick={{ fill: "#71717a", fontSize: 11 }} width={50} label={{ value: "Steps", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <YAxis yAxisId="strain" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 21]} label={{ value: "Strain (0-21)", fill: "#71717a", fontSize: 11, angle: 90, position: "insideRight" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="steps" dataKey="steps" fill="#3b82f640" stroke="#3b82f6" name="Steps" radius={[3, 3, 0, 0]} />
              <Line yAxisId="strain" type="monotone" dataKey="strain" stroke="#22c55e" strokeWidth={2} dot={false} name="WHOOP Strain" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress & Body Battery">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} label={{ value: "Level (0-100)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
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
