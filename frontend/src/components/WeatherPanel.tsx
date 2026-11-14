"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import {
  WEATHER_METRICS, WEATHER_METRIC_KEYS, chartPoints, newestCompleteDate, summary30,
  type WeatherDay, type WeatherMetric,
} from "@/lib/weather";

type Load =
  | { s: "loading" }
  | { s: "not_connected" }
  | { s: "error" }
  | { s: "ready"; days: WeatherDay[] };

const MIN_HEIGHT = 340;
const pillBase = "px-2 py-0.5 rounded-[3px] border text-[11px]";
const pillOff = "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover";
const SECONDARY_COLORS = [C.categorical[0], C.categorical[1]];

function Note({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-text-tertiary" style={{ minHeight: MIN_HEIGHT }}>
      {children}
    </div>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-[20px] font-mono text-text-primary">{value}</div>
      {label}
    </div>
  );
}

const show = (v: number | null, unit = "") => (v === null ? "n/a" : `${v}${unit}`);

export default function WeatherPanel() {
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [metric, setMetric] = useState<WeatherMetric>("temperature");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/weather", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then((j) => {
        if (cancelled) return;
        if (j?.status === "not_connected") setLoad({ s: "not_connected" });
        else if (j?.status === "ready" && Array.isArray(j.days)) setLoad({ s: "ready", days: j.days as WeatherDay[] });
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
  const summary = useMemo(() => (days ? summary30(days) : null), [days]);
  const newest = useMemo(() => (days ? newestCompleteDate(days) : null), [days]);
  const series = WEATHER_METRICS[metric].series;
  const hasRightAxis = series.some((s) => s.rightAxis);

  let body;
  if (load.s === "loading") {
    body = <div className="animate-pulse rounded bg-surface-hover/40" style={{ minHeight: MIN_HEIGHT }} aria-label="Loading weather" />;
  } else if (load.s === "not_connected") {
    body = <Note>Weather table not set up yet</Note>;
  } else if (load.s === "error") {
    body = <Note>Couldn&apos;t load weather</Note>;
  } else if (load.days.length === 0) {
    body = <Note>No weather days yet</Note>;
  } else {
    body = (
      <>
        <div className="flex flex-wrap gap-x-6 gap-y-3 mb-3 text-[12px] text-text-tertiary">
          <Tile value={show(summary?.highF ?? null, "°F")} label="30-day mean high" />
          <Tile value={show(summary?.nightF ?? null, "°F")} label="30-day mean night (1-8 AM)" />
          <Tile value={show(summary?.sunshineH ?? null, " h")} label="30-day sunshine per day" />
          <Tile value={show(summary?.rainIn ?? null, " in")} label="30-day rain" />
          <Tile value={newest ?? "n/a"} label="Newest complete day" />
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {WEATHER_METRIC_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setMetric(k)}
              aria-pressed={metric === k}
              className={`${pillBase} ${metric === k ? "bg-accent/15 border-accent/40 text-text-primary" : pillOff}`}
            >
              {WEATHER_METRICS[k].label}
            </button>
          ))}
        </div>
        <div style={{ height: MIN_HEIGHT - 110 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={axisTick} width={45} domain={["auto", "auto"]} />
              {hasRightAxis && (
                <YAxis yAxisId="right" orientation="right" tick={axisTick} width={40} domain={[0, "auto"]} />
              )}
              <Tooltip {...chartTooltip} />
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  yAxisId={s.rightAxis ? "right" : "left"}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.secondary ? SECONDARY_COLORS[(i - 1) % SECONDARY_COLORS.length] : C.accent}
                  strokeOpacity={s.secondary ? 0.7 : 1}
                  strokeWidth={s.secondary ? 1.25 : 2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </>
    );
  }

  return (
    <ChartCard title="Weather" subtitle="Daily outdoor weather, last 90 days" tick="descriptive" className="mt-4">
      {body}
      <p className="text-[11px] text-text-tertiary mt-3">
        Model data (Open-Meteo) for the fixed home location, not a sensor at home and not where you were on a trip.
        Today is left out of the daytime lines and the 30-day figures until the day is over. In the HRV analysis the night temperature
        (1-8 AM) is matched to the sleep it falls in; weather results there are exploratory, with no seasonal adjustment.
      </p>
    </ChartCard>
  );
}
