"use client";

import { useEffect, useState } from "react";
import { getActivities, getWorkouts } from "@/lib/queries";
import { formatDuration, formatDistance, formatPace } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function ActivitiesPage() {
  const [activities, setActivities] = useState<any[]>([]);
  const [workoutMap, setWorkoutMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getActivities(60), getWorkouts()])
      .then(([acts, wkts]) => {
        setActivities(acts);
        const map: Record<string, any> = {};
        for (const w of wkts) map[String(w.workout_id)] = w;
        setWorkoutMap(map);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Activities</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Last 60 days of training</p>
        </div>
      </div>

      {activities.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <svg className="w-10 h-10 text-text-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <p className="text-text-secondary font-medium">No activities found</p>
          <p className="text-text-tertiary text-sm mt-1">No activities recorded in the last 60 days.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {activities.map((act) => {
            let workout: any = null;
            try {
              const raw = typeof act.raw_json === "string" ? JSON.parse(act.raw_json) : act.raw_json;
              const wid = raw?.workoutId;
              if (wid) workout = workoutMap[String(wid)];
            } catch { /* ignore */ }

            const targetLow = workout?.interval_target_pace_low_mps;
            const targetHigh = workout?.interval_target_pace_high_mps;
            const hasTarget = targetLow && targetHigh && Number(targetLow) > 0 && Number(targetHigh) > 0;

            return (
            <div key={act.activity_id} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 hover:border-border-hover transition-colors flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="bg-white/5 text-text-secondary text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-[2px]">
                    {act.activity_type ?? "unknown"}
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    {act.start_time_local ? new Date(act.start_time_local).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
                  </span>
                </div>
                <p className="text-text-primary font-medium mt-1 truncate">{act.activity_name ?? "Untitled"}</p>
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
