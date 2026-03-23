"use client";

import { useEffect, useState } from "react";
import { getActivities } from "@/lib/queries";
import { formatDuration, formatDistance, formatPace } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function ActivitiesPage() {
  const [activities, setActivities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getActivities(60)
      .then(setActivities)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading activities...</div></div>;
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Activities</h2>

      {activities.length === 0 ? (
        <p className="text-zinc-500">No activities found in the last 60 days.</p>
      ) : (
        <div className="space-y-3">
          {activities.map((act) => (
            <div key={act.activity_id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 uppercase">
                    {act.activity_type ?? "unknown"}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {act.start_time_local ? new Date(act.start_time_local).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
                  </span>
                </div>
                <p className="text-white font-semibold mt-1 truncate">{act.activity_name ?? "Untitled"}</p>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div>
                  <span className="text-zinc-500">Distance </span>
                  <span className="text-zinc-200">{formatDistance(act.distance_meters)}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Duration </span>
                  <span className="text-zinc-200">{formatDuration(act.duration_seconds)}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Pace </span>
                  <span className="text-zinc-200">{formatPace(act.avg_speed_mps)}</span>
                </div>
                <div>
                  <span className="text-zinc-500">HR </span>
                  <span className="text-zinc-200">{act.avg_heart_rate ?? "—"}</span>
                  <span className="text-zinc-500"> / </span>
                  <span className="text-zinc-200">{act.max_heart_rate ?? "—"}</span>
                  <span className="text-zinc-500"> bpm</span>
                </div>
                {act.calories && (
                  <div>
                    <span className="text-zinc-500">Cal </span>
                    <span className="text-zinc-200">{act.calories}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
