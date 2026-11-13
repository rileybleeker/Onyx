"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import { chartPoints, mean30, newestCompleteDate, type AirDay } from "@/lib/air-quality";

type Load =
  | { s: "loading" }
  | { s: "not_connected" }
  | { s: "error" }
  | { s: "ready"; days: AirDay[] };

const MIN_HEIGHT = 300;

function Note({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-text-tertiary" style={{ minHeight: MIN_HEIGHT }}>
      {children}
    </div>
  );
}

export default function AirQualityPanel() {
  const [load, setLoad] = useState<Load>({ s: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/air-quality", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then((j) => {
        if (cancelled) return;
        if (j?.status === "not_connected") setLoad({ s: "not_connected" });
        else if (j?.status === "ready" && Array.isArray(j.days)) setLoad({ s: "ready", days: j.days as AirDay[] });
        else setLoad({ s: "error" });
      })
      .catch(() => {
        if (!cancelled) setLoad({ s: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const days = load.s === "ready" ? load.days : null;
  const points = useMemo(() => (days ? chartPoints(days) : []), [days]);
  const avg = useMemo(() => (days ? mean30(days) : null), [days]);
  const newest = useMemo(() => (days ? newestCompleteDate(days) : null), [days]);

  let body;
  if (load.s === "loading") {
    body = <div className="animate-pulse rounded bg-surface-hover/40" style={{ minHeight: MIN_HEIGHT }} aria-label="Loading air quality" />;
  } else if (load.s === "not_connected") {
    body = <Note>Air-quality table not set up yet</Note>;
  } else if (load.s === "error") {
    body = <Note>Couldn&apos;t load air quality</Note>;
  } else if (load.days.length === 0) {
    body = <Note>No air-quality days yet</Note>;
  } else {
    body = (
      <>
        <div className="flex gap-6 mb-3 text-[12px] text-text-tertiary">
          <div>
            <div className="text-[20px] font-mono text-text-primary">{avg !== null ? avg : "n/a"}</div>
            30-day mean (µg/m³)
          </div>
          <div>
            <div className="text-[20px] font-mono text-text-primary">{newest ?? "n/a"}</div>
            Newest complete day
          </div>
        </div>
        <div style={{ height: MIN_HEIGHT - 60 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={45} domain={[0, "auto"]} />
              <Tooltip {...chartTooltip} />
              <Line type="monotone" dataKey="max" name="Max hour (µg/m³)" stroke={C.accent}
                    strokeOpacity={0.3} strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
              <Line type="monotone" dataKey="mean" name="Daily mean (µg/m³)" stroke={C.accent}
                    strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="partialMean" name="Partial day mean (µg/m³)" stroke={C.accent}
                    strokeOpacity={0.4} strokeDasharray="3 3" dot={{ r: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </>
    );
  }

  return (
    <ChartCard title="Air quality (PM2.5)" subtitle="Daily PM2.5, last 90 days" tick="descriptive" className="mt-4">
      {body}
      <p className="text-[11px] text-text-tertiary mt-3">
        Regional model estimate (Open-Meteo / CAMS) for the fixed location, not a sensor at home; exploratory, no seasonal adjustment.
      </p>
    </ChartCard>
  );
}
