"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine, Cell,
} from "recharts";
import {
  getWhoopSleep, getWhoopSleepAll, getWhoopRecovery, getWhoopCycles, getWhoopJournal,
  getEightSleepTrends, getDailySummaries,
  rangeDays, rangeLabel, type Range,
} from "@/lib/queries";
import { formatDate, formatDuration, etDate, whoopSleepDay } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

function recoveryColor(score: number | null): string {
  if (!score) return "#71717a";
  if (score >= 67) return "#22c55e";
  if (score >= 34) return "#f59e0b";
  return "#ef4444";
}

export default function SleepPage() {
  const [whoopSleep, setWhoopSleep]     = useState<any[]>([]);
  const [whoopSleepAll, setWhoopSleepAll] = useState<any[]>([]);
  const [whoopRecovery, setWhoopRecovery] = useState<any[]>([]);
  const [whoopCycles, setWhoopCycles]   = useState<any[]>([]);
  const [journal, setJournal]           = useState<any[]>([]);
  const [eightSleep, setEightSleep]     = useState<any[]>([]);
  const [summaries, setSummaries]       = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [range, setRange]               = useState<Range>("30d");

  useEffect(() => {
    setLoading(true);
    const days = rangeDays(range);
    Promise.all([
      getWhoopSleep(days),
      getWhoopSleepAll(days),
      getWhoopRecovery(days),
      getWhoopCycles(days),
      getWhoopJournal(days),
      getEightSleepTrends(days),
      getDailySummaries(days),
    ])
      .then(([s, sAll, r, c, j, e, sum]) => {
        setWhoopSleep(s);
        setWhoopSleepAll(sAll);
        setWhoopRecovery(r);
        setWhoopCycles(c);
        setJournal(j);
        setEightSleep(e);
        setSummaries(sum);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

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

  // Aggregate helper: mean over the selected range, ignoring null/NaN.
  const avg = (arr: any[], key: string): number | null => {
    const vals = arr
      .map((d) => d?.[key])
      .filter((v) => v != null && !isNaN(Number(v)))
      .map(Number);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const rangeNote = range === "1d" ? "today" : `${rangeLabel(range)} avg`;

  // ── WHOOP ────────────────────────────────────────────────────────────────────
  const avgRecoveryScore = avg(whoopRecovery, "recovery_score");
  const avgWhoopHrv      = avg(whoopRecovery, "hrv_rmssd_milli");
  const avgWhoopRhr      = avg(whoopRecovery, "resting_heart_rate");
  const avgStrain        = avg(whoopCycles, "strain");
  const recoveryByCycle = new Map(whoopRecovery.map((r) => [r.cycle_id, r]));
  const sleepByCycle    = new Map(whoopSleep.map((s) => [s.cycle_id, s]));

  const recoveryData = whoopRecovery.map((d) => {
    const sleep = sleepByCycle.get(d.cycle_id);
    return {
      date:     formatDate(new Date(d.created_at).toISOString().split("T")[0]),
      recovery: d.recovery_score,
      rhr:      d.resting_heart_rate,
      hrv:      d.hrv_rmssd_milli ? +Number(d.hrv_rmssd_milli).toFixed(1) : null,
      spo2:     d.spo2_percentage  ? +Number(d.spo2_percentage).toFixed(1)  : null,
      skinTemp: d.skin_temp_celsius ? +Number(d.skin_temp_celsius).toFixed(1) : null,
      respRate: sleep?.respiratory_rate ? +Number(sleep.respiratory_rate).toFixed(1) : null,
    };
  });

  const strainData = whoopCycles.map((d) => ({
    date:   formatDate(etDate(d.end_time ?? d.start_time)),
    strain: d.strain ? +Number(d.strain).toFixed(1) : null,
  }));

  // Aggregate WHOOP nap rows per wake-day so we can stack them on top of the
  // main-sleep stage bars and surface them in the Duration StatCard.
  const whoopNapsByDate = new Map<string, { deep: number; light: number; rem: number; awake: number; inBedMs: number }>();
  whoopSleepAll.forEach((s: any) => {
    if (!s.is_nap) return;
    const date = formatDate(etDate(s.end_time));
    const cur = whoopNapsByDate.get(date) || { deep: 0, light: 0, rem: 0, awake: 0, inBedMs: 0 };
    cur.deep    += (s.total_slow_wave_sleep_time_milli || 0) / 3600000;
    cur.light   += (s.total_light_sleep_time_milli     || 0) / 3600000;
    cur.rem     += (s.total_rem_sleep_time_milli       || 0) / 3600000;
    cur.awake   += (s.total_awake_time_milli           || 0) / 3600000;
    cur.inBedMs += s.total_in_bed_time_milli || 0;
    whoopNapsByDate.set(date, cur);
  });

  const whoopDurationData = whoopSleep.map((d) => {
    const date = formatDate(etDate(d.end_time));
    const nap = whoopNapsByDate.get(date);
    return {
      date,
      deep:  d.total_slow_wave_sleep_time_milli ? +(d.total_slow_wave_sleep_time_milli / 3600000).toFixed(2) : 0,
      light: d.total_light_sleep_time_milli     ? +(d.total_light_sleep_time_milli / 3600000).toFixed(2)     : 0,
      rem:   d.total_rem_sleep_time_milli       ? +(d.total_rem_sleep_time_milli / 3600000).toFixed(2)       : 0,
      awake: d.total_awake_time_milli           ? +(d.total_awake_time_milli / 3600000).toFixed(2)           : 0,
      nap_deep:  nap ? +nap.deep.toFixed(2)  : 0,
      nap_light: nap ? +nap.light.toFixed(2) : 0,
      nap_rem:   nap ? +nap.rem.toFixed(2)   : 0,
      nap_awake: nap ? +nap.awake.toFixed(2) : 0,
    };
  });
  const avgWhoopNapMs = whoopNapsByDate.size
    ? Array.from(whoopNapsByDate.values()).reduce((a, b) => a + b.inBedMs, 0) / whoopSleep.length
    : 0;

  // Hours vs Needed (WHOOP "Sleep Sufficiency"): asleep / sleep_need.
  // asleep = in_bed − awake − no_data; need = baseline + debt + strain + nap.
  // WHOOP's API returns need_from_recent_nap_milli as a NEGATIVE number when
  // a recent nap has credited toward tonight's need — so we ADD it (signed)
  // rather than subtracting, which would invert the credit.
  const hoursVsNeeded = (d: any): number | null => {
    const inBed = d.total_in_bed_time_milli;
    const baseline = d.baseline_milli;
    if (inBed == null || baseline == null) return null;
    const asleep = inBed - (d.total_awake_time_milli ?? 0) - (d.total_no_data_time_milli ?? 0);
    const need   = baseline + (d.need_from_sleep_debt_milli ?? 0) + (d.need_from_recent_strain_milli ?? 0) + (d.need_from_recent_nap_milli ?? 0);
    if (!need) return null;
    return (100 * asleep) / need;
  };

  const whoopScoreData = whoopSleep.map((d) => ({
    date:         formatDate(etDate(d.end_time)),
    performance:  d.sleep_performance_percentage,
    hoursNeeded:  hoursVsNeeded(d) != null ? +hoursVsNeeded(d)!.toFixed(1) : null,
    efficiency:   d.sleep_efficiency_percentage,
    consistency:  d.sleep_consistency_percentage,
  }));

  // Sleep Debt: WHOOP's `need_from_sleep_debt_milli` is the extra sleep need
  // (in ms) that WHOOP says you're carrying from prior nights — i.e. your
  // running sleep debt as of this cycle. Convert to hours.
  // WHOOP labels sleep debt by the calendar day the sleep event belongs to:
  // pre-6 AM ET bedtimes fold into the previous day's nightly cycle (so a
  // post-midnight main sleep lands on "yesterday"), but daytime naps stay on
  // their actual day. Includes naps so travel days like April 30 — where the
  // only sleep events are naps — still surface WHOOP's debt value. When a
  // labeled day has multiple events (main + nap), the latest event's
  // need_from_sleep_debt wins, matching WHOOP's "most recent reading" display.
  const debtByDay = new Map<string, number>();
  whoopSleepAll.forEach((d) => {
    if (d.need_from_sleep_debt_milli == null) return;
    debtByDay.set(whoopSleepDay(d.start_time), d.need_from_sleep_debt_milli);
  });
  const sleepDebtData = Array.from(debtByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, debtMs]) => ({
      date: formatDate(date),
      debt: +(debtMs / 3600000).toFixed(2),
    }));

  const inBedData = whoopSleep.map((d) => ({
    date:  formatDate(etDate(d.end_time)),
    hours: d.total_in_bed_time_milli ? +(d.total_in_bed_time_milli / 3600000).toFixed(2) : null,
  }));

  const whoopHrData = whoopSleep.map((d) => {
    const rec = recoveryByCycle.get(d.cycle_id);
    return {
      date:     formatDate(etDate(d.end_time)),
      hr:       rec?.resting_heart_rate,
      hrv:      rec?.hrv_rmssd_milli ? +Number(rec.hrv_rmssd_milli).toFixed(1) : null,
      respRate: d.respiratory_rate   ? +Number(d.respiratory_rate).toFixed(1)  : null,
    };
  });

  // ── Garmin ───────────────────────────────────────────────────────────────────
  // Only RHR lives here; Max HR / Min HR / Stress Level + HR Range and Stress
  // charts moved to /activities since they're daytime/activity metrics.
  const avgGarminRhr = avg(summaries, "resting_heart_rate")
    ?? avg(summaries, "last_seven_days_avg_rhr");

  // ── Eight Sleep ───────────────────────────────────────────────────────────────
  const avgEightSleep    = avg(eightSleep, "sleep_score");
  const avgEightDuration = avg(eightSleep, "time_slept_seconds");
  const avgEightHrv      = avg(eightSleep, "avg_hrv");
  const avgEightLatency  = avg(eightSleep, "latency_asleep_seconds");

  // ── WHOOP Sleep aggregates ───────────────────────────────────────────────────
  const avgInBedMs       = avg(whoopSleep, "total_in_bed_time_milli");
  const avgSleepPerf     = avg(whoopSleep, "sleep_performance_percentage");
  const avgSleepEff      = avg(whoopSleep, "sleep_efficiency_percentage");
  const avgDeepMs        = avg(whoopSleep, "total_slow_wave_sleep_time_milli");
  const avgRemMs         = avg(whoopSleep, "total_rem_sleep_time_milli");
  const hoursVsNeededVals = whoopSleep.map(hoursVsNeeded).filter((v): v is number => v != null);
  const avgHoursVsNeeded = hoursVsNeededVals.length
    ? hoursVsNeededVals.reduce((a, b) => a + b, 0) / hoursVsNeededVals.length
    : null;

  const eightScoreData = eightSleep.map((d) => ({
    date:    formatDate(d.calendar_date),
    sleep:   d.sleep_score,
    fitness: d.sleep_fitness_score,
    quality: d.sleep_quality_score,
  }));

  // Eight Sleep stages: split each stage between main session and nap so the
  // bar surfaces both the per-stage main breakdown AND the per-stage nap
  // breakdown. nap_stage = total_stage − main_stage from the DB columns.
  const eightStagesData = eightSleep.map((d) => {
    const deepMain  = d.deep_sleep_main_session_seconds  ?? d.deep_sleep_seconds  ?? 0;
    const lightMain = d.light_sleep_main_session_seconds ?? d.light_sleep_seconds ?? 0;
    const remMain   = d.rem_sleep_main_session_seconds   ?? d.rem_sleep_seconds   ?? 0;
    const awakeMain = d.awake_main_session_seconds       ?? d.awake_seconds       ?? 0;
    const napDeep   = Math.max(0, (d.deep_sleep_seconds  || 0) - deepMain);
    const napLight  = Math.max(0, (d.light_sleep_seconds || 0) - lightMain);
    const napRem    = Math.max(0, (d.rem_sleep_seconds   || 0) - remMain);
    const napAwake  = Math.max(0, (d.awake_seconds       || 0) - awakeMain);
    return {
      date:  formatDate(d.calendar_date),
      deep:  +(deepMain  / 3600).toFixed(2),
      light: +(lightMain / 3600).toFixed(2),
      rem:   +(remMain   / 3600).toFixed(2),
      awake: +(awakeMain / 3600).toFixed(2),
      nap_deep:  +(napDeep  / 3600).toFixed(2),
      nap_light: +(napLight / 3600).toFixed(2),
      nap_rem:   +(napRem   / 3600).toFixed(2),
      nap_awake: +(napAwake / 3600).toFixed(2),
    };
  });
  // Range averages: main sleep duration + average nap duration across the range
  // (nap-less days contribute 0, so this is a per-day average that adds back to
  // avgEightDuration when both are summed).
  const avgEightMainSec = avg(eightSleep, "time_slept_main_session_seconds");
  const avgEightNapSec  = avgEightDuration != null && avgEightMainSec != null
    ? Math.max(0, avgEightDuration - avgEightMainSec)
    : null;

  const eightBiometricsData = eightSleep.map((d) => ({
    date:       formatDate(d.calendar_date),
    hr:         d.avg_heart_rate ? +Number(d.avg_heart_rate).toFixed(0) : null,
    hrv:        d.avg_hrv        ? +Number(d.avg_hrv).toFixed(0)        : null,
    breathRate: d.avg_breath_rate ? +Number(d.avg_breath_rate).toFixed(1) : null,
  }));

  const eightEnvData = eightSleep.map((d) => ({
    date:      formatDate(d.calendar_date),
    bedTemp:   d.avg_bed_temp  ? +Number(d.avg_bed_temp).toFixed(1)  : null,
    roomTemp:  d.avg_room_temp ? +Number(d.avg_room_temp).toFixed(1) : null,
    tossTurns: d.toss_and_turns,
  }));

  // Sleep-onset latency in minutes; color-coded by clinical convention
  // (<15 normal, 15–30 mild, >30 prolonged).
  const eightLatencyData = eightSleep.map((d) => ({
    date:    formatDate(d.calendar_date),
    minutes: d.latency_asleep_seconds != null
      ? +(d.latency_asleep_seconds / 60).toFixed(1)
      : null,
  }));
  const latencyColor = (min: number | null) =>
    min == null ? "#52525b" : min <= 15 ? "#22c55e" : min <= 30 ? "#f59e0b" : "#ef4444";

  // Snoring (Pod microphone-detected). Sparse: most nights are 0.
  // Plotted in minutes; heavy-snore is stacked on top so total bar height = total snoring.
  const eightSnoreData = eightSleep.map((d) => {
    const totalSec = d.snore_duration_seconds ?? 0;
    const heavySec = d.heavy_snore_duration_seconds ?? 0;
    const lightSec = Math.max(0, totalSec - heavySec);
    return {
      date: formatDate(d.calendar_date),
      light: +(lightSec / 60).toFixed(1),
      heavy: +(heavySec / 60).toFixed(1),
    };
  });
  const snoreNightsTracked = eightSleep.filter((d) => d.snore_duration_seconds != null).length;
  const snoreNightsWithAny = eightSleep.filter((d) => (d.snore_duration_seconds ?? 0) > 0).length;
  const avgSnoreMinutes    = snoreNightsTracked > 0
    ? eightSleep.reduce((a, d) => a + (d.snore_duration_seconds ?? 0), 0) / snoreNightsTracked / 60
    : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Sleep &amp; Recovery</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Sleep, recovery, and cardiac trends — {rangeLabel(range)}</p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      {/* ── WHOOP Recovery ──────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">WHOOP · Recovery</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Recovery"
          value={avgRecoveryScore != null ? `${avgRecoveryScore.toFixed(0)}%` : null}
          sublabel={avgRecoveryScore != null ? `${avgRecoveryScore >= 67 ? "Green" : avgRecoveryScore >= 34 ? "Yellow" : "Red"} · ${rangeNote}` : rangeNote}
          source="WHOOP"
        />
        <StatCard label="HRV" value={avgWhoopHrv != null ? avgWhoopHrv.toFixed(0) : null} unit="ms" sublabel={rangeNote} source="WHOOP" />
        <StatCard label="Day Strain" value={avgStrain != null ? avgStrain.toFixed(1) : null} sublabel={rangeNote} source="WHOOP" />
        <StatCard label="Resting HR" value={avgWhoopRhr != null ? avgWhoopRhr.toFixed(0) : null} unit="bpm" sublabel={rangeNote} source="WHOOP" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        <ChartCard title="Recovery Score" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={recoveryData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Bar dataKey="recovery" name="Recovery %" radius={[3, 3, 0, 0]}
                fill="#22c55e"
                shape={(props: any) => {
                  const { x, y, width, height, payload } = props;
                  return <rect x={x} y={y} width={width} height={height} rx={3} fill={recoveryColor(payload.recovery)} />;
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Daily Strain" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={strainData}>
              <defs>
                <linearGradient id="recStrainGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={55} domain={[0, 21]} label={axisLabel("strain", "y")} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="strain" stroke="#3b82f6" fill="url(#recStrainGrad)" strokeWidth={2} name="Strain" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="SpO2, Skin Temp & Resp Rate" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={recoveryData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis yAxisId="spo2" tick={axisTick} width={40} domain={[90, 100]} />
              <YAxis yAxisId="temp" orientation="right" tick={axisTick} width={40} />
              <YAxis yAxisId="resp" orientation="right" hide domain={[10, 22]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line yAxisId="spo2" type="monotone" dataKey="spo2" stroke="#06b6d4" strokeWidth={2} dot={false} name="SpO2 %" />
              <Line yAxisId="temp" type="monotone" dataKey="skinTemp" stroke="#f97316" strokeWidth={2} dot={false} name="Skin Temp (°C)" />
              <Line yAxisId="resp" type="monotone" dataKey="respRate" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Resp Rate (br/min)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── WHOOP Sleep ─────────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">WHOOP · Sleep</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Duration"
          value={avgInBedMs != null ? formatDuration(Math.round((avgInBedMs + avgWhoopNapMs) / 1000)) : null}
          sublabel={
            avgInBedMs != null && avgWhoopNapMs > 0
              ? `${formatDuration(Math.round(avgInBedMs / 1000))} main + ${formatDuration(Math.round(avgWhoopNapMs / 1000))} nap · ${rangeNote}`
              : rangeNote
          }
          source="WHOOP"
        />
        <StatCard label="Hours vs Needed" value={avgHoursVsNeeded != null ? `${avgHoursVsNeeded.toFixed(0)}%` : null} sublabel={rangeNote} source="WHOOP" />
        <StatCard label="Sleep Performance" value={avgSleepPerf != null ? `${avgSleepPerf.toFixed(0)}%` : null} sublabel={rangeNote} source="WHOOP" />
        <StatCard label="Sleep Efficiency" value={avgSleepEff != null ? `${avgSleepEff.toFixed(0)}%` : null} sublabel={rangeNote} source="WHOOP" />
        <StatCard label="Deep Sleep" value={avgDeepMs != null ? formatDuration(Math.round(avgDeepMs / 1000)) : null} sublabel={rangeNote} source="WHOOP" />
        <StatCard label="REM Sleep" value={avgRemMs != null ? formatDuration(Math.round(avgRemMs / 1000)) : null} sublabel={rangeNote} source="WHOOP" />
      </div>

      <div className="mb-6">
        <ChartCard title="Time in Bed" source="WHOOP">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={inBedData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} label={axisLabel("hours", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [`${v}h`, "Time in Bed"]} />
              <Bar dataKey="hours" name="Time in Bed" radius={[3, 3, 0, 0]} fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <ChartCard title="Sleep Debt" source="WHOOP">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={sleepDebtData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} label={axisLabel("hours", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [`${v} h`, "Sleep Debt"]} />
              <Bar dataKey="debt" name="Sleep Debt" radius={[3, 3, 0, 0]}>
                {sleepDebtData.map((d, i) => (
                  <Cell key={i} fill={d.debt == null ? "#52525b" : d.debt < 1 ? "#22c55e" : d.debt < 2 ? "#f59e0b" : "#ef4444"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Hours vs Needed" source="WHOOP">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={whoopScoreData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} domain={[0, (max: number) => Math.max(110, Math.ceil(max / 10) * 10)]} label={axisLabel("% of need met", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [`${v}%`, "Hours vs Needed"]} />
              <ReferenceLine y={100} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} label={{ value: "100%", position: "right", fill: "#22c55e", fontSize: 10 }} />
              <Bar dataKey="hoursNeeded" name="Hours vs Needed" radius={[3, 3, 0, 0]}>
                {whoopScoreData.map((d, i) => (
                  <Cell key={i} fill={d.hoursNeeded == null ? "#52525b" : d.hoursNeeded >= 100 ? "#22c55e" : d.hoursNeeded >= 85 ? "#f59e0b" : "#ef4444"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Consistency" source="WHOOP">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={whoopScoreData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} domain={[0, 100]} label={axisLabel("consistency %", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [`${v}%`, "Sleep Consistency"]} />
              <Bar dataKey="consistency" name="Sleep Consistency" radius={[3, 3, 0, 0]}>
                {whoopScoreData.map((d, i) => (
                  <Cell key={i} fill={d.consistency == null ? "#52525b" : d.consistency >= 70 ? "#22c55e" : d.consistency >= 50 ? "#f59e0b" : "#ef4444"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
        <ChartCard title="Sleep Stages" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={whoopDurationData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={50} label={axisLabel("hours", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any, name: any) => [formatDuration(Math.round(Number(v) * 3600)), name]} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="deep"  stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem"   stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" />
              <Bar dataKey="nap_deep"  stackId="a" fill="#1e40af" fillOpacity={0.5} name="Deep (nap)" />
              <Bar dataKey="nap_light" stackId="a" fill="#60a5fa" fillOpacity={0.5} name="Light (nap)" />
              <Bar dataKey="nap_rem"   stackId="a" fill="#a78bfa" fillOpacity={0.5} name="REM (nap)" />
              <Bar dataKey="nap_awake" stackId="a" fill="#f87171" fillOpacity={0.5} name="Awake (nap)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={whoopScoreData}>
              <defs>
                <linearGradient id="sleepPerfGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepNeededGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ec4899" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ec4899" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepEffGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepConsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={35} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Area type="monotone" dataKey="performance" stroke="#f59e0b" fill="url(#sleepPerfGrad)" strokeWidth={2} name="Performance" />
              <Area type="monotone" dataKey="hoursNeeded" stroke="#ec4899" fill="url(#sleepNeededGrad)" strokeWidth={2} name="Hours vs Needed" />
              <Area type="monotone" dataKey="efficiency" stroke="#22c55e" fill="url(#sleepEffGrad)" strokeWidth={1.5} name="Efficiency" />
              <Area type="monotone" dataKey="consistency" stroke="#3b82f6" fill="url(#sleepConsGrad)" strokeWidth={1.5} name="Consistency" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR, HRV & Respiratory Rate" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={whoopHrData}>
              <defs>
                <linearGradient id="sleepRhrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepHrvGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis yAxisId="hr" tick={axisTick} width={40} />
              <YAxis yAxisId="hrv" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Area yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" fill="url(#sleepRhrGrad)" strokeWidth={2} name="RHR (bpm)" />
              <Area yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" fill="url(#sleepHrvGrad)" strokeWidth={2} name="HRV (ms)" />
              <Area yAxisId="hr" type="monotone" dataKey="respRate" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} name="Resp Rate" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Journal ─────────────────────────────────────────────────────────── */}
      {journal.length > 0 && (() => {
        // `behaviors_date` is the calendar day the journal answer describes
        // (the day the user was awake leading into bedtime). Computed at the
        // DB layer via trigger from each cycle's start_time − 6h in local TZ;
        // falls back to cycle_date for rows without a matching cycle.
        const journalDate = (j: any) => j.behaviors_date ?? j.cycle_date;

        const behaviors = [...new Set(journal.map((j: any) => j.question))].sort();
        const dates     = [...new Set(journal.map(journalDate))].sort();
        const journalMap = new Map<string, string>();
        journal.forEach((j: any) => {
          journalMap.set(`${journalDate(j)}|${j.question}`, j.answer);
        });

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
            <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-4">WHOOP · Journal</p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {[...categoryMap.entries()].map(([cat, qs]) => (
                <div key={cat} className="bg-surface-card border border-border-subtle rounded-[6px] p-4">
                  <p className="text-[10px] text-text-tertiary font-mono font-medium uppercase tracking-wider">{cat}</p>
                  <p className="text-lg font-semibold text-text-primary mt-1">{qs.length} behavior{qs.length !== 1 ? "s" : ""}</p>
                  <p className="text-xs text-text-tertiary mt-1">{qs.slice(0, 3).join(", ")}{qs.length > 3 ? "…" : ""}</p>
                </div>
              ))}
            </div>

            <ChartCard title="Journal Heatmap" source="WHOOP">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left align-bottom bg-surface text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal pr-3 pb-2 sticky left-0 bg-surface-card min-w-[140px]">Behavior</th>
                      {dates.map((d) => (
                        <th key={d} className="align-bottom bg-surface text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal px-0.5 min-w-[36px]">
                          <div className="h-14 flex items-end justify-center">
                            <span className="rotate-[-45deg] origin-bottom-left whitespace-nowrap translate-x-2">
                              {formatDate(d)}
                            </span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {behaviors.map((b) => (
                      <tr key={b} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="text-text-secondary pr-3 py-1 sticky left-0 bg-surface-card truncate max-w-[160px]" title={b}>{b}</td>
                        {dates.map((d) => {
                          const answer = journalMap.get(`${d}|${b}`);
                          const active = isPositive(answer);
                          return (
                            <td key={d} className="px-0.5 py-1 text-center">
                              <div
                                className={`w-5 h-5 rounded-sm mx-auto ${active ? "bg-green-500/80" : "bg-white/5"}`}
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

      <div className="border-t border-border-subtle mb-8" />

      {/* ── Garmin Cardiac ──────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">GARMIN · Cardiac</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <StatCard label="Avg RHR" value={avgGarminRhr != null ? avgGarminRhr.toFixed(0) : null} unit="bpm" sublabel={rangeNote} source="GARMIN" />
      </div>

      <div className="border-t border-border-subtle mb-8" />

      {/* ── Eight Sleep ─────────────────────────────────────────────────────── */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Eight Sleep</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Sleep Score" value={avgEightSleep != null ? avgEightSleep.toFixed(0) : null} sublabel={rangeNote} source="8SLP" />
        <StatCard
          label="Duration"
          value={avgEightDuration != null ? formatDuration(Math.round(avgEightDuration)) : null}
          sublabel={
            avgEightMainSec != null && avgEightNapSec != null && avgEightNapSec > 0
              ? `${formatDuration(Math.round(avgEightMainSec))} main + ${formatDuration(Math.round(avgEightNapSec))} nap · ${rangeNote}`
              : rangeNote
          }
          source="8SLP"
        />
        <StatCard label="HRV" value={avgEightHrv != null ? avgEightHrv.toFixed(0) : null} unit="ms" sublabel={rangeNote} source="8SLP" />
        <StatCard label="Sleep Latency" value={avgEightLatency != null ? (avgEightLatency / 60).toFixed(0) : null} unit="min" sublabel={rangeNote} source="8SLP" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        <ChartCard title="Sleep Scores" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightScoreData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={55} domain={[0, 100]} label={axisLabel("score (0–100)", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="sleep" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Sleep" />
              <Line type="monotone" dataKey="fitness" stroke="#22c55e" strokeWidth={1.5} dot={false} name="Fitness" />
              <Line type="monotone" dataKey="quality" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Quality" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Stages" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={eightStagesData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={50} label={axisLabel("hours", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any, name: any) => [formatDuration(Math.round(Number(v) * 3600)), name]} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="deep"  stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem"   stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" />
              <Bar dataKey="nap_deep"  stackId="a" fill="#1e40af" fillOpacity={0.5} name="Deep (nap)" />
              <Bar dataKey="nap_light" stackId="a" fill="#60a5fa" fillOpacity={0.5} name="Light (nap)" />
              <Bar dataKey="nap_rem"   stackId="a" fill="#a78bfa" fillOpacity={0.5} name="REM (nap)" />
              <Bar dataKey="nap_awake" stackId="a" fill="#f87171" fillOpacity={0.5} name="Awake (nap)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Heart Rate & HRV" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightBiometricsData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis yAxisId="hr" tick={axisTick} width={40} />
              <YAxis yAxisId="hrv" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" strokeWidth={2} dot={false} name="Avg HR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={2} dot={false} name="Avg HRV (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Bed & Room Temperature" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightEnvData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis yAxisId="temp" tick={axisTick} width={40} />
              <YAxis yAxisId="toss" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line yAxisId="temp" type="monotone" dataKey="bedTemp" stroke="#f97316" strokeWidth={2} dot={false} name="Bed Temp" />
              <Line yAxisId="temp" type="monotone" dataKey="roomTemp" stroke="#06b6d4" strokeWidth={2} dot={false} name="Room Temp" />
              <Line yAxisId="toss" type="monotone" dataKey="tossTurns" stroke="#a1a1aa" strokeWidth={1.5} dot={false} name="Toss & Turns" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Snoring"
          source="8SLP"
          subtitle={
            snoreNightsTracked > 0
              ? `${snoreNightsWithAny}/${snoreNightsTracked} nights · avg ${avgSnoreMinutes?.toFixed(1) ?? "0"} min`
              : "no data"
          }
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={eightSnoreData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} label={axisLabel("minutes", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any, name: any) => [`${v} min`, name]} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="light" stackId="snore" fill="#60a5fa" name="Snoring" />
              <Bar dataKey="heavy" stackId="snore" fill="#ef4444" name="Heavy snoring" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Time to Fall Asleep"
          source="8SLP"
          subtitle={avgEightLatency != null ? `avg ${formatDuration(Math.round(avgEightLatency))}` : undefined}
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={eightLatencyData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={{ ...axisTick, angle: -45, textAnchor: "end" }} interval={0} height={60} />
              <YAxis tick={axisTick} width={45} label={axisLabel("minutes", "y")} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [formatDuration(Math.round(Number(v) * 60)), "Latency"]} />
              <ReferenceLine y={15} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} label={{ value: "15 min", position: "right", fill: "#22c55e", fontSize: 10 }} />
              <Bar dataKey="minutes" name="Latency" radius={[3, 3, 0, 0]}>
                {eightLatencyData.map((d, i) => (
                  <Cell key={i} fill={latencyColor(d.minutes)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
