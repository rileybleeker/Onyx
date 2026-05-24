"use client";

import { useEffect, useState } from "react";
import { AreaChart, Area, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { getActivities, getDailySummaries, getWorkouts, getWhoopWorkouts, getWhoopCycles, getHeartRateData, getRunningRecoveryContext, getActivityLaps, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { formatDuration, formatDistance, formatPace, formatDate } from "@/lib/format";
import RangeFilter from "@/components/RangeFilter";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle, accentColor, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

type ActivityRow = {
  source: "garmin" | "whoop";
  id: string;
  type: string;
  name: string;
  display_time: string;
  utc_ms: number;
  duration_seconds: number | null;
  distance_meters: number | null;
  avg_speed_mps: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  calories: number | null;
  raw_json?: any;
};

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function shiftToLocalIso(utcIso: string, tzOffset: string | null): string {
  if (!tzOffset) return utcIso;
  const d = new Date(utcIso);
  const sign = tzOffset[0] === "-" ? -1 : 1;
  const [hh, mm] = tzOffset.slice(1).split(":").map(Number);
  d.setUTCMinutes(d.getUTCMinutes() + sign * (hh * 60 + (mm || 0)));
  return d.toISOString().replace("Z", "");
}

function normalizeGarmin(a: any): ActivityRow {
  return {
    source: "garmin",
    id: `garmin:${a.activity_id}`,
    type: a.activity_type ?? "unknown",
    name: a.activity_name ?? "Untitled",
    display_time: a.start_time_local,
    utc_ms: a.start_time_gmt ? new Date(a.start_time_gmt).getTime() : NaN,
    duration_seconds: a.duration_seconds ?? null,
    distance_meters: a.distance_meters ?? null,
    avg_speed_mps: a.avg_speed_mps ?? null,
    avg_heart_rate: a.avg_heart_rate ?? null,
    max_heart_rate: a.max_heart_rate ?? null,
    calories: a.calories ?? null,
    raw_json: a.raw_json,
  };
}

function normalizeWhoop(w: any): ActivityRow {
  const startMs = new Date(w.start_time).getTime();
  const endMs = w.end_time ? new Date(w.end_time).getTime() : null;
  const durationSec = endMs ? Math.round((endMs - startMs) / 1000) : null;
  const distance = w.distance_meter && w.distance_meter > 0 ? w.distance_meter : null;
  const avgSpeed = distance && durationSec ? distance / durationSec : null;
  const kcal = w.kilojoule ? Math.round(w.kilojoule / 4.184) : null;
  const sportName = w.sport_name ?? "workout";

  return {
    source: "whoop",
    id: `whoop:${w.workout_id}`,
    type: sportName.toLowerCase().replace(/_/g, " "),
    name: sportName,
    display_time: shiftToLocalIso(w.start_time, w.timezone_offset),
    utc_ms: startMs,
    duration_seconds: durationSec,
    distance_meters: distance,
    avg_speed_mps: avgSpeed,
    avg_heart_rate: w.average_heart_rate ?? null,
    max_heart_rate: w.max_heart_rate ?? null,
    calories: kcal,
  };
}

function mergeAndDedup(garmin: ActivityRow[], whoop: ActivityRow[]): ActivityRow[] {
  const garminTimes = garmin.map((g) => g.utc_ms).filter((t) => !Number.isNaN(t));
  const whoopKept = whoop.filter(
    (w) => !garminTimes.some((gt) => Math.abs(gt - w.utc_ms) <= DEDUP_WINDOW_MS),
  );
  return [...garmin, ...whoopKept].sort((a, b) => {
    const aT = new Date(a.display_time).getTime();
    const bT = new Date(b.display_time).getTime();
    return bT - aT;
  });
}

type SegmentTarget = {
  step_order: number;
  target_low_mps: number;
  target_high_mps: number;
  distance_meters: number | null;
  duration_seconds: number | null;
  iterations: number;
};

type Lap = {
  lap_index: number;
  distance_meters: number;
  duration_seconds: number;
  avg_speed_mps: number;
  avg_heart_rate: number | null;
};

type SegmentMatch = {
  rep_index: number;       // 1-based index within iterations of this segment
  iter_total: number;
  target_low_mps: number;
  target_high_mps: number;
  planned_distance_m: number | null;
  lap: Lap | null;
  delta_pct: number | null;
  in_range: boolean;
};

// Greedy positional match: expand each segment_target by its iterations, then
// consume active laps (speed > 1.5 mps, distance > 100m) in order, picking the
// next lap whose distance is within ±20% of the planned segment distance.
// Laps that don't match advance the cursor (treated as warmup/cooldown).
function matchSegmentsToLaps(segments: SegmentTarget[], laps: Lap[]): SegmentMatch[] {
  const expanded: { seg: SegmentTarget; rep: number; total: number }[] = [];
  for (const s of segments) {
    for (let i = 1; i <= (s.iterations || 1); i++) {
      expanded.push({ seg: s, rep: i, total: s.iterations || 1 });
    }
  }
  const active = laps.filter((l) => l.avg_speed_mps > 1.5 && l.distance_meters > 100);
  const matches: SegmentMatch[] = [];
  let cursor = 0;
  for (const { seg, rep, total } of expanded) {
    let matched: Lap | null = null;
    const target = seg.distance_meters;
    while (cursor < active.length && matched == null) {
      const lap = active[cursor];
      cursor++;
      if (target == null) {
        // time-based segment — match by duration ±20%
        if (seg.duration_seconds != null
          && Math.abs(lap.duration_seconds - seg.duration_seconds) / seg.duration_seconds <= 0.2) {
          matched = lap;
        }
      } else if (Math.abs(lap.distance_meters - target) / target <= 0.2) {
        matched = lap;
      }
    }
    const mid = (seg.target_low_mps + seg.target_high_mps) / 2;
    matches.push({
      rep_index: rep,
      iter_total: total,
      target_low_mps:  seg.target_low_mps,
      target_high_mps: seg.target_high_mps,
      planned_distance_m: seg.distance_meters,
      lap: matched,
      delta_pct: matched ? ((mid - matched.avg_speed_mps) / mid) * 100 : null,
      in_range: matched
        ? matched.avg_speed_mps >= seg.target_low_mps && matched.avg_speed_mps <= seg.target_high_mps
        : false,
    });
  }
  return matches;
}

export default function ActivitiesPage() {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [workoutMap, setWorkoutMap] = useState<Record<string, any>>({});
  const [summaries, setSummaries] = useState<any[]>([]);
  const [whoopCycles, setWhoopCycles] = useState<any[]>([]);
  const [hr, setHr] = useState<any[]>([]);
  const [recoveryMap, setRecoveryMap] = useState<Record<string, { recovery: number | null; hrv: number | null; sleepPerf: number | null; paceDelta: number | null; segments: SegmentTarget[] | null; segmentCount: number }>>({});
  const [lapsByActivity, setLapsByActivity] = useState<Record<number, Lap[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");

  useEffect(() => {
    setLoading(true);
    setExpanded(new Set());
    const days = rangeDays(range);
    Promise.all([getActivities(days), getWhoopWorkouts(days), getWorkouts(), getDailySummaries(days), getWhoopCycles(days), getHeartRateData(days), getRunningRecoveryContext(days)])
      .then(([garmin, whoop, wkts, sums, cycles, h, recCtx]) => {
        const merged = mergeAndDedup(
          garmin.map(normalizeGarmin),
          whoop.map(normalizeWhoop),
        );
        setRows(merged);
        const map: Record<string, any> = {};
        for (const w of wkts) map[String(w.workout_id)] = w;
        setWorkoutMap(map);
        setSummaries(sums);
        setWhoopCycles(cycles);
        setHr(h);
        const recMap: Record<string, { recovery: number | null; hrv: number | null; sleepPerf: number | null; paceDelta: number | null; segments: SegmentTarget[] | null; segmentCount: number }> = {};
        for (const r of recCtx) {
          recMap[`garmin:${r.activity_id}`] = {
            recovery:  r.whoop_recovery != null ? +r.whoop_recovery : null,
            hrv:       r.whoop_hrv != null ? +Number(r.whoop_hrv).toFixed(1) : null,
            sleepPerf: r.whoop_sleep_performance != null ? +r.whoop_sleep_performance : null,
            paceDelta: r.pace_delta_pct != null ? +r.pace_delta_pct : null,
            segments:  Array.isArray(r.segment_targets) ? r.segment_targets as SegmentTarget[] : null,
            segmentCount: r.segment_target_count ?? 0,
          };
        }
        setRecoveryMap(recMap);

        // Batch-fetch laps for every Garmin running activity with a multi-segment plan
        const multiSegIds = recCtx
          .filter((r) => (r.segment_target_count ?? 0) > 1)
          .map((r) => Number(r.activity_id))
          .filter((n) => !Number.isNaN(n));
        if (multiSegIds.length > 0) {
          getActivityLaps(multiSegIds).then((laps) => {
            const grouped: Record<number, Lap[]> = {};
            for (const l of laps) {
              const aid = Number(l.activity_id);
              if (!grouped[aid]) grouped[aid] = [];
              grouped[aid].push({
                lap_index:        l.lap_index,
                distance_meters:  Number(l.distance_meters),
                duration_seconds: Number(l.duration_seconds),
                avg_speed_mps:    Number(l.avg_speed_mps),
                avg_heart_rate:   l.avg_heart_rate,
              });
            }
            setLapsByActivity(grouped);
          }).catch(console.error);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const latestSummary = summaries[summaries.length - 1];
  const stepsData = summaries.map((d) => ({
    date: formatDate(d.calendar_date),
    steps: d.total_steps,
  }));

  // WHOOP day-wide cycle avg HR (one value per cycle = behavioral day).
  const cycleHrData = whoopCycles
    .filter((c) => c.average_heart_rate != null)
    .map((c) => ({
      date: formatDate(new Date(c.start_time).toISOString().split("T")[0]),
      hr:   c.average_heart_rate,
    }));
  const avgCycleHr = cycleHrData.length
    ? cycleHrData.reduce((a, b) => a + b.hr, 0) / cycleHrData.length
    : null;

  // Garmin daytime cardiac (moved from /sleep): max/min HR + stress level.
  const avg = (arr: any[], key: string): number | null => {
    const vals = arr.map((d) => d?.[key]).filter((v) => v != null && !isNaN(Number(v))).map(Number);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgMaxHr  = avg(hr, "max_heart_rate");
  const avgMinHr  = avg(hr, "min_heart_rate");
  const avgStress = avg(summaries, "avg_stress_level");
  const hrData = hr.map((d) => ({
    date: formatDate(d.calendar_date),
    min:  d.min_heart_rate,
    max:  d.max_heart_rate,
  }));
  const stressData = summaries.map((d) => ({
    date:    formatDate(d.calendar_date),
    overall: d.avg_stress_level,
  }));
  const rangeNote = range === "1d" ? "today" : `${rangeLabel(range)} avg`;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 bg-white/5 animate-pulse rounded-[6px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Activities</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Training — {rangeLabel(range)}</p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard
          label="Steps"
          value={latestSummary?.total_steps?.toLocaleString()}
          sublabel={latestSummary?.calendar_date}
          source="GARMIN"
        />
        <StatCard
          label="Avg HR"
          value={avgCycleHr != null ? avgCycleHr.toFixed(0) : null}
          unit="bpm"
          sublabel={range === "1d" ? "today" : `${rangeLabel(range)} avg`}
          source="WHOOP"
        />
        <StatCard label="Max HR" value={avgMaxHr != null ? avgMaxHr.toFixed(0) : null} unit="bpm" sublabel={rangeNote} source="GARMIN" />
        <StatCard label="Min HR" value={avgMinHr != null ? avgMinHr.toFixed(0) : null} unit="bpm" sublabel={rangeNote} source="GARMIN" />
        <StatCard label="Stress Level" value={avgStress != null ? avgStress.toFixed(0) : null} sublabel={rangeNote} source="GARMIN" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <ChartCard title="Daily Steps" subtitle={rangeLabel(range)} source="GARMIN">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stepsData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} label={axisLabel("steps", "y")} />
              <Tooltip {...chartTooltip} />
              <Bar dataKey="steps" fill={accentColor} radius={[2, 2, 0, 0]} fillOpacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Avg Heart Rate" subtitle={rangeLabel(range)} source="WHOOP">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={cycleHrData}>
              <defs>
                <linearGradient id="cycleHrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} label={axisLabel("bpm", "y")} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="hr" stroke="#ef4444" fill="url(#cycleHrGrad)" strokeWidth={2} name="Avg HR" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Heart Rate Range" source="GARMIN">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={hrData}>
              <defs>
                <linearGradient id="heartMaxGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="heartMinGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} label={axisLabel("bpm", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Area type="monotone" dataKey="max" stroke="#ef4444" fill="url(#heartMaxGrad)" strokeWidth={1.5} name="Max HR" />
              <Area type="monotone" dataKey="min" stroke="#22c55e" fill="url(#heartMinGrad)" strokeWidth={1.5} name="Min HR" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress Level" source="GARMIN">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={stressData}>
              <defs>
                <linearGradient id="heartStressGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} domain={[0, 100]} label={axisLabel("stress (0–100)", "y")} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="overall" stroke="#f97316" fill="url(#heartStressGrad)" strokeWidth={2} name="Stress Level" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <svg className="w-10 h-10 text-text-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <p className="text-text-secondary font-medium">No activities found</p>
          <p className="text-text-tertiary text-sm mt-1">No activities recorded in this range.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((act) => {
            let workout: any = null;
            if (act.source === "garmin") {
              try {
                const raw = typeof act.raw_json === "string" ? JSON.parse(act.raw_json) : act.raw_json;
                const wid = raw?.workoutId;
                if (wid) workout = workoutMap[String(wid)];
              } catch { /* ignore */ }
            }

            const targetLow = workout?.interval_target_pace_low_mps;
            const targetHigh = workout?.interval_target_pace_high_mps;
            const hasTarget = targetLow && targetHigh && Number(targetLow) > 0 && Number(targetHigh) > 0;
            const sourceBadge = act.source === "whoop"
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-sky-500/10 text-sky-300";
            const recCtx = recoveryMap[act.id];
            const recColor = recCtx?.recovery == null
              ? "text-text-secondary"
              : recCtx.recovery >= 67 ? "text-green-400"
              : recCtx.recovery >= 34 ? "text-amber-400"
              : "text-red-400";
            const isMultiSeg = (recCtx?.segmentCount ?? 0) > 1;
            // Suppress the single-target chip when the workout is actually multi-segment.
            const showInlineTarget = hasTarget && !isMultiSeg;
            const canExpand = recCtx != null;
            const isExpanded = expanded.has(act.id);
            const activityIdNum = act.source === "garmin"
              ? Number(act.id.split(":")[1])
              : null;
            const laps = activityIdNum != null ? lapsByActivity[activityIdNum] : undefined;
            const matches = isExpanded && isMultiSeg && recCtx?.segments && laps
              ? matchSegmentsToLaps(recCtx.segments, laps)
              : null;

            return (
            <div key={act.id} className="bg-surface-card border border-border-subtle rounded-[6px] hover:border-border-hover transition-colors">
              <div
                className={`p-4 flex flex-col sm:flex-row sm:items-center gap-3 ${canExpand ? "cursor-pointer" : ""}`}
                onClick={canExpand ? () => toggleExpanded(act.id) : undefined}
                role={canExpand ? "button" : undefined}
                aria-expanded={canExpand ? isExpanded : undefined}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`${sourceBadge} text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-[2px]`}>
                      {act.source}
                    </span>
                    <span className="bg-white/5 text-text-secondary text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-[2px]">
                      {act.type}
                    </span>
                    <span className="text-[11px] text-text-tertiary">
                      {act.display_time ? new Date(act.display_time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
                    </span>
                  </div>
                  <p className="text-text-primary font-medium mt-1 truncate">{act.name}</p>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                  <div>
                    <span className="text-text-tertiary text-[12px]">Distance </span>
                    <span className="text-text-secondary font-mono text-[13px]">{formatDistance(act.distance_meters)}</span>
                  </div>
                  <div>
                    <span className="text-text-tertiary text-[12px]">Duration </span>
                    <span className="text-text-secondary font-mono text-[13px]">{formatDuration(act.duration_seconds)}</span>
                  </div>
                  <div>
                    <span className="text-text-tertiary text-[12px]">Pace </span>
                    <span className="text-text-secondary font-mono text-[13px]">{formatPace(act.avg_speed_mps)}</span>
                  </div>
                  {showInlineTarget && (
                    <div>
                      <span className="text-text-tertiary text-[12px]">Target </span>
                      <span className="text-text-secondary font-mono text-[13px]">{formatPace(Number(targetLow))}</span>
                      <span className="text-text-tertiary text-[12px]"> – </span>
                      <span className="text-text-secondary font-mono text-[13px]">{formatPace(Number(targetHigh))}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-text-tertiary text-[12px]">HR </span>
                    <span className="text-text-secondary font-mono text-[13px]">{act.avg_heart_rate ?? "—"}</span>
                    <span className="text-text-tertiary text-[12px]"> / </span>
                    <span className="text-text-secondary font-mono text-[13px]">{act.max_heart_rate ?? "—"}</span>
                    <span className="text-text-tertiary text-[12px]"> bpm</span>
                  </div>
                  {act.calories && (
                    <div>
                      <span className="text-text-tertiary text-[12px]">Cal </span>
                      <span className="text-text-secondary font-mono text-[13px]">{act.calories}</span>
                    </div>
                  )}
                  {recCtx?.recovery != null && (
                    <div className="flex items-center gap-1">
                      <span className="text-text-tertiary text-[12px]">Recovery </span>
                      <span className={`${recColor} font-mono text-[13px]`}>{recCtx.recovery.toFixed(0)}%</span>
                    </div>
                  )}
                  {canExpand && (
                    <svg className={`w-4 h-4 text-text-tertiary transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </div>
              </div>

              {canExpand && isExpanded && (
                <div className="border-t border-border-subtle px-4 py-3 space-y-3">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {recCtx?.hrv != null && (
                      <div>
                        <span className="text-text-tertiary text-[12px]">HRV </span>
                        <span className="text-text-secondary font-mono text-[13px]">{recCtx.hrv.toFixed(0)} ms</span>
                      </div>
                    )}
                    {recCtx?.sleepPerf != null && (
                      <div>
                        <span className="text-text-tertiary text-[12px]">Sleep Perf </span>
                        <span className="text-text-secondary font-mono text-[13px]">{recCtx.sleepPerf.toFixed(0)}%</span>
                      </div>
                    )}
                    {!isMultiSeg && recCtx?.paceDelta != null && (
                      <div>
                        <span className="text-text-tertiary text-[12px]">Pace Δ </span>
                        <span className={`${recCtx.paceDelta <= 0 ? "text-green-400" : "text-red-400"} font-mono text-[13px]`}>
                          {recCtx.paceDelta > 0 ? "+" : ""}{recCtx.paceDelta.toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>

                  {isMultiSeg && (
                    matches ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[12px] font-mono">
                          <thead>
                            <tr className="text-text-tertiary uppercase text-[10px] tracking-wider border-b border-border-subtle">
                              <th className="text-left py-1.5 font-medium">Segment</th>
                              <th className="text-right py-1.5 font-medium pl-4">Target</th>
                              <th className="text-right py-1.5 font-medium pl-4">Actual</th>
                              <th className="text-right py-1.5 font-medium pl-4">Δ</th>
                              <th className="text-right py-1.5 font-medium pl-4">HR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matches.map((m, i) => {
                              const label = m.iter_total > 1
                                ? `${m.planned_distance_m ?? "?"}m (${m.rep_index}/${m.iter_total})`
                                : `${m.planned_distance_m ?? "?"}m`;
                              return (
                                <tr key={i} className="border-b border-white/5">
                                  <td className="py-1.5 text-text-secondary">{label}</td>
                                  <td className="py-1.5 text-right text-text-secondary pl-4">
                                    {formatPace(m.target_high_mps)} – {formatPace(m.target_low_mps)}
                                  </td>
                                  <td className={`py-1.5 text-right pl-4 ${m.lap ? "text-text-primary" : "text-text-tertiary"}`}>
                                    {m.lap ? formatPace(m.lap.avg_speed_mps) : "—"}
                                  </td>
                                  <td className={`py-1.5 text-right pl-4 ${
                                    m.delta_pct == null ? "text-text-tertiary"
                                    : m.in_range ? "text-green-400"
                                    : m.delta_pct < 0 ? "text-emerald-300"
                                    : "text-red-400"
                                  }`}>
                                    {m.delta_pct == null ? "—" : `${m.delta_pct > 0 ? "+" : ""}${m.delta_pct.toFixed(1)}%`}
                                  </td>
                                  <td className="py-1.5 text-right text-text-secondary pl-4">
                                    {m.lap?.avg_heart_rate ?? "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="text-[12px] text-text-tertiary font-mono">
                        Loading per-segment splits…
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
