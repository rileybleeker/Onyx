"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import {
  DEFAULT_POLLEN_RANGE, POLLEN_RANGES, POLLEN_RANGE_KEYS, chartPoints, countsInRange, etDate, newestCount,
  type PollenDay, type PollenLevel, type PollenPoint, type PollenRange,
} from "@/lib/pollen";

const POLLEN_URL = "/api/pollen";

type Load =
  | { s: "loading" }
  | { s: "not_connected" }
  | { s: "error" }
  | { s: "ready"; days: PollenDay[] };

const MIN_HEIGHT = 340;
const pillBase = "px-2 py-0.5 rounded-[3px] border text-[11px]";
const pillOff = "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover";

function levelColor(level: PollenLevel | null): string {
  if (level === "low") return C.up;
  if (level === "medium") return C.mid;
  if (level === "high") return C.accent;
  if (level === "extreme") return C.down;
  return C.neutral;
}

function isDay(v: unknown): v is PollenDay {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return typeof d.countDate === "string" && typeof d.airDate === "string" && typeof d.total === "number";
}

/** A cached or fresh /api/pollen answer as a panel state, or null when it is malformed. */
function asLoad(raw: unknown): Load | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as { status?: unknown; days?: unknown };
  if (j.status === "not_connected") return { s: "not_connected" };
  if (j.status === "ready" && Array.isArray(j.days) && j.days.every(isDay)) return { s: "ready", days: j.days as PollenDay[] };
  return null;
}

function checkAnswer(raw: unknown) {
  if (!asLoad(raw)) throw new Error("unexpected pollen answer");
}

function Note({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-text-tertiary" style={{ minHeight: MIN_HEIGHT }}>
      {children}
    </div>
  );
}

function Chip({ name, level }: { name: string; level: PollenLevel | null }) {
  const color = levelColor(level);
  return (
    <span className="px-1.5 py-0.5 rounded-[3px] border text-[11px]" style={{ borderColor: color, color }}>
      {name} {level ?? "n/a"}
    </span>
  );
}

export default function PollenPanel() {
  const [load, setLoad] = useState<Load>(() => asLoad(clientCache.peek(POLLEN_URL)) ?? { s: "loading" });
  const [range, setRange] = useState<PollenRange>(DEFAULT_POLLEN_RANGE);
  const etToday = useMemo(() => etDate(new Date()), []);

  useEffect(() => {
    let alive = true;
    const show = (next: Load) => setLoad((prev) => (sameJson(prev, next) ? prev : next));
    // First paint from the persisted copy when memory has none; the fetch below always revalidates.
    void clientCache.read(POLLEN_URL).then((raw) => {
      const cached = asLoad(raw);
      if (alive && cached) setLoad((prev) => (prev.s === "loading" ? cached : prev));
    }).catch(() => {});
    cachedJson(POLLEN_URL, { check: checkAnswer })
      .then((raw) => {
        if (!alive) return;
        show(asLoad(raw) ?? { s: "error" });
      })
      .catch(() => {
        if (alive) setLoad((prev) => (prev.s === "loading" ? { s: "error" } : prev));
      });
    return () => {
      alive = false;
    };
  }, []);

  const days = load.s === "ready" ? load.days : null;
  const points = useMemo(() => (days ? chartPoints(days, range, etToday) : []), [days, range, etToday]);
  const inRange = useMemo(() => countsInRange(points), [points]);
  const newest = useMemo(() => (days ? newestCount(days) : null), [days]);
  const hasParts = !!newest && [newest.tree, newest.grass, newest.weed, newest.mold].some((l) => l !== null);

  let body;
  if (load.s === "loading") {
    body = (
      <div role="status" className="animate-pulse rounded bg-surface-hover/40" style={{ minHeight: MIN_HEIGHT }}>
        <span className="sr-only">Loading pollen</span>
      </div>
    );
  } else if (load.s === "not_connected") {
    body = <Note>Pollen isn&apos;t connected yet</Note>;
  } else if (load.s === "error") {
    body = <Note>Couldn&apos;t load pollen</Note>;
  } else {
    body = (
      <div style={{ minHeight: MIN_HEIGHT }}>
        {newest && hasParts && (
          <p className="sr-only">
            Newest count on {newest.airDate}: tree {newest.tree ?? "n/a"}, grass {newest.grass ?? "n/a"}, weed {newest.weed ?? "n/a"}, mold {newest.mold ?? "n/a"}.
          </p>
        )}
        {newest && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 text-[12px] text-text-tertiary">
            <span>
              <span className="text-[20px] font-mono text-text-primary">{newest.total}</span>
              {" "}grains/m³
              {newest.level && <span style={{ color: levelColor(newest.level) }}> · {newest.level}</span>}
              {" "}· air day {newest.airDate}
            </span>
            {hasParts && (
              <span className="flex flex-wrap gap-1.5">
                <Chip name="Tree" level={newest.tree} />
                <Chip name="Grass" level={newest.grass} />
                <Chip name="Weed" level={newest.weed} />
                <Chip name="Mold" level={newest.mold} />
              </span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {POLLEN_RANGE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRange(k)}
              aria-pressed={range === k}
              className={`${pillBase} ${range === k ? "bg-accent/15 border-accent/40 text-text-primary" : pillOff}`}
            >
              {POLLEN_RANGES[k].label}
            </button>
          ))}
        </div>
        {inRange === 0 ? (
          <div className="flex items-center justify-center text-[12px] text-text-tertiary" style={{ height: MIN_HEIGHT - 110 }}>
            No pollen counts in this range
          </div>
        ) : (
          <div style={{ height: MIN_HEIGHT - 110 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points}>
                <CartesianGrid {...gridStyle} vertical={false} />
                <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" minTickGap={40} />
                <YAxis tick={axisTick} width={45} domain={[0, "auto"]} allowDecimals={false} />
                <Tooltip
                  {...chartTooltip}
                  labelFormatter={(v: unknown, payload: readonly unknown[]) => {
                    const p = (payload?.[0] as { payload?: PollenPoint } | undefined)?.payload;
                    if (!p || !p.countDate) return String(v);
                    return `${String(v)} · counted ${p.countDate}${p.level ? ` · ${p.level}` : ""}`;
                  }}
                  formatter={(v: unknown) => [v === null || v === undefined ? "no count" : String(v), "Total (grains/m³)"]}
                />
                <Bar dataKey="total" name="Total (grains/m³)" isAnimationActive={false}>
                  {points.map((p) => (
                    <Cell key={p.date} fill={levelColor(p.level)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    );
  }

  return (
    <ChartCard title="Pollen" subtitle="Daily total count, Atlanta" tick="descriptive">
      {body}
    </ChartCard>
  );
}
