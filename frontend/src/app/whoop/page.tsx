"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopRecovery, getWhoopCycles, getWhoopSleep, getWhoopJournal } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

function recoveryColor(score: number | null): string {
  if (!score) return "#71717a";
  if (score >= 67) return "#22c55e";
  if (score >= 34) return "#f59e0b";
  return "#ef4444";
}

export default function WhoopPage() {
  const [recovery, setRecovery] = useState<any[]>([]);
  const [cycles, setCycles] = useState<any[]>([]);
  const [sleep, setSleep] = useState<any[]>([]);
  const [journal, setJournal] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getWhoopRecovery(30), getWhoopCycles(30), getWhoopSleep(30), getWhoopJournal(30)])
      .then(([r, c, s, j]) => { setRecovery(r); setCycles(c); setSleep(s); setJournal(j); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading WHOOP data...</div></div>;
  }

  const latestRecovery = recovery[recovery.length - 1];
  const latestCycle = cycles[cycles.length - 1];
  const latestSleep = sleep[sleep.length - 1];

  const recoveryData = recovery.map((d) => ({
    date: formatDate(new Date(d.created_at).toISOString().split("T")[0]),
    recovery: d.recovery_score,
    rhr: d.resting_heart_rate,
    hrv: d.hrv_rmssd_milli ? +Number(d.hrv_rmssd_milli).toFixed(1) : null,
    spo2: d.spo2_percentage ? +Number(d.spo2_percentage).toFixed(1) : null,
    skinTemp: d.skin_temp_celsius ? +Number(d.skin_temp_celsius).toFixed(1) : null,
  }));

  const strainData = cycles.map((d) => ({
    date: formatDate(new Date(d.start_time).toISOString().split("T")[0]),
    strain: d.strain ? +Number(d.strain).toFixed(1) : null,
    calories: d.kilojoule ? Math.round(Number(d.kilojoule) / 4.184) : null,
    avgHr: d.average_heart_rate,
    maxHr: d.max_heart_rate,
  }));

  const sleepData = sleep.map((d) => ({
    date: formatDate(new Date(d.start_time).toISOString().split("T")[0]),
    performance: d.sleep_performance_percentage,
    efficiency: d.sleep_efficiency_percentage ? +Number(d.sleep_efficiency_percentage).toFixed(0) : null,
    deep: d.total_slow_wave_sleep_time_milli ? +(d.total_slow_wave_sleep_time_milli / 3600000).toFixed(2) : 0,
    rem: d.total_rem_sleep_time_milli ? +(d.total_rem_sleep_time_milli / 3600000).toFixed(2) : 0,
    light: d.total_light_sleep_time_milli ? +(d.total_light_sleep_time_milli / 3600000).toFixed(2) : 0,
    awake: d.total_awake_time_milli ? +(d.total_awake_time_milli / 3600000).toFixed(2) : 0,
    disturbances: d.disturbance_count,
    respRate: d.respiratory_rate ? +Number(d.respiratory_rate).toFixed(1) : null,
  }));

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">WHOOP</h2>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Recovery"
          value={latestRecovery?.recovery_score != null ? `${latestRecovery.recovery_score}%` : null}
          sublabel={latestRecovery?.recovery_score != null ? (latestRecovery.recovery_score >= 67 ? "Green" : latestRecovery.recovery_score >= 34 ? "Yellow" : "Red") : undefined}
        />
        <StatCard label="HRV" value={latestRecovery?.hrv_rmssd_milli ? Number(latestRecovery.hrv_rmssd_milli).toFixed(0) : null} unit="ms" />
        <StatCard label="Day Strain" value={latestCycle?.strain ? Number(latestCycle.strain).toFixed(1) : null} />
        <StatCard label="Sleep Performance" value={latestSleep?.sleep_performance_percentage != null ? `${latestSleep.sleep_performance_percentage}%` : null} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Recovery Score">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={recoveryData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[0, 100]} />
              <Tooltip {...tt} />
              <Bar dataKey="recovery" name="Recovery %" radius={[3, 3, 0, 0]}
                fill="#22c55e"
                // Color each bar by recovery zone
                shape={(props: any) => {
                  const { x, y, width, height, payload } = props;
                  return <rect x={x} y={y} width={width} height={height} rx={3} fill={recoveryColor(payload.recovery)} />;
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="HRV & Resting HR">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={recoveryData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="hrv" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <YAxis yAxisId="rhr" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={2} dot={false} name="HRV (ms)" />
              <Line yAxisId="rhr" type="monotone" dataKey="rhr" stroke="#ef4444" strokeWidth={2} dot={false} name="RHR (bpm)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Daily Strain">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={strainData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[0, 21]} />
              <Tooltip {...tt} />
              <Area type="monotone" dataKey="strain" stroke="#3b82f6" fill="#3b82f640" strokeWidth={2} name="Strain" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Stages (hours)">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={sleepData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="deep" stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem" stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Performance & Efficiency">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={sleepData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[0, 100]} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="performance" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Performance %" />
              <Line type="monotone" dataKey="efficiency" stroke="#f59e0b" strokeWidth={2} dot={false} name="Efficiency %" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="SpO2 & Skin Temp">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={recoveryData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="spo2" tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[90, 100]} />
              <YAxis yAxisId="temp" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="spo2" type="monotone" dataKey="spo2" stroke="#06b6d4" strokeWidth={2} dot={false} name="SpO2 %" />
              <Line yAxisId="temp" type="monotone" dataKey="skinTemp" stroke="#f97316" strokeWidth={2} dot={false} name="Skin Temp (°C)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Journal Section */}
      {journal.length > 0 && (() => {
        // Build a heatmap: for each behavior, show which days it was logged as "Yes" or had a value
        const behaviors = [...new Set(journal.map((j: any) => j.question))].sort();
        const dates = [...new Set(journal.map((j: any) => j.cycle_date))].sort();
        const journalMap = new Map<string, string>();
        journal.forEach((j: any) => {
          journalMap.set(`${j.cycle_date}|${j.question}`, j.answer);
        });

        // Group by category
        const categoryMap = new Map<string, string[]>();
        journal.forEach((j: any) => {
          const cat = j.category || "Other";
          if (!categoryMap.has(cat)) categoryMap.set(cat, []);
          const list = categoryMap.get(cat)!;
          if (!list.includes(j.question)) list.push(j.question);
        });

        const isPositive = (answer: string | undefined) => {
          if (!answer) return false;
          const a = answer.toLowerCase();
          return a === "yes" || a === "true" || (parseFloat(a) > 0 && !isNaN(parseFloat(a)));
        };

        return (
          <>
            <h3 className="text-xl font-bold mt-10 mb-4">Journal</h3>

            {/* Category summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {[...categoryMap.entries()].map(([cat, qs]) => (
                <div key={cat} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">{cat}</p>
                  <p className="text-lg font-semibold text-zinc-100 mt-1">{qs.length} behavior{qs.length !== 1 ? "s" : ""}</p>
                  <p className="text-xs text-zinc-500 mt-1">{qs.slice(0, 3).join(", ")}{qs.length > 3 ? "…" : ""}</p>
                </div>
              ))}
            </div>

            {/* Heatmap grid */}
            <ChartCard title="Journal Heatmap">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left text-zinc-500 font-normal pr-3 py-1 sticky left-0 bg-zinc-900 min-w-[140px]">Behavior</th>
                      {dates.map((d) => (
                        <th key={d} className="text-zinc-500 font-normal px-0.5 py-1 min-w-[24px]">
                          <span className="block rotate-[-45deg] origin-bottom-left translate-x-2 whitespace-nowrap">
                            {formatDate(d)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {behaviors.map((b) => (
                      <tr key={b} className="border-t border-zinc-800/50">
                        <td className="text-zinc-300 pr-3 py-1 sticky left-0 bg-zinc-900 truncate max-w-[160px]" title={b}>{b}</td>
                        {dates.map((d) => {
                          const answer = journalMap.get(`${d}|${b}`);
                          const active = isPositive(answer);
                          return (
                            <td key={d} className="px-0.5 py-1 text-center">
                              <div
                                className={`w-5 h-5 rounded-sm mx-auto ${active ? "bg-green-500/80" : "bg-zinc-800/40"}`}
                                title={answer ? `${b}: ${answer}` : `${b}: —`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>
          </>
        );
      })()}
    </>
  );
}
