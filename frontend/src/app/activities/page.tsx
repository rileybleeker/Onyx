"use client";

import { useEffect, useState } from "react";
import { getActivities, getWorkouts, getWhoopWorkouts, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { formatDuration, formatDistance, formatPace } from "@/lib/format";
import RangeFilter from "@/components/RangeFilter";

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

export default function ActivitiesPage() {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [workoutMap, setWorkoutMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");

  useEffect(() => {
    setLoading(true);
    const days = rangeDays(range);
    Promise.all([getActivities(days), getWhoopWorkouts(days), getWorkouts()])
      .then(([garmin, whoop, wkts]) => {
        const merged = mergeAndDedup(
          garmin.map(normalizeGarmin),
          whoop.map(normalizeWhoop),
        );
        setRows(merged);
        const map: Record<string, any> = {};
        for (const w of wkts) map[String(w.workout_id)] = w;
        setWorkoutMap(map);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

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

            return (
            <div key={act.id} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 hover:border-border-hover transition-colors flex flex-col sm:flex-row sm:items-center gap-3">
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

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
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
                {hasTarget && (
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
              </div>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
