// Apple Health upload from the Onyx iPhone app (tools/screentime_ios, HealthKit; 2026-11-17).
// Pure validation for POST /api/apple-health/import: no I/O, no clock (the caller passes `now`).
// Tables: sql/apple_health_schema.sql (service role only).

/** metric -> unit stored with it, and whether the hour value is a sum or an average. */
export const HEALTH_METRICS = {
  steps: { unit: "count", kind: "sum", max: 20_000 },
  distance_m: { unit: "m", kind: "sum", max: 100_000 },
  flights: { unit: "count", kind: "sum", max: 500 },
  mindful_seconds: { unit: "s", kind: "sum", max: 3600 },
  walking_speed_ms: { unit: "m/s", kind: "avg", max: 6 },
  walking_steadiness_pct: { unit: "%", kind: "avg", max: 100 },
  headphone_db: { unit: "dB", kind: "avg", max: 140 },
} as const;

export type HealthMetric = keyof typeof HEALTH_METRICS;

export const MIND_KINDS = ["momentary_emotion", "daily_mood"] as const;

export const MAX_HOURLY = 6000; // ~35 days of seven metrics
export const MAX_WORKOUTS = 500;
export const MAX_MIND = 1000;
export const MAX_FUTURE_MS = 2 * 3_600_000;
export const MAX_AGE_MS = 400 * 86_400_000;

export interface HourlyRow {
  device: string;
  metric: HealthMetric;
  hour_start: string;
  value: number;
  unit: string;
  samples: number | null;
}

export interface WorkoutRow {
  workout_uuid: string;
  device: string;
  activity_type: string;
  start_time: string;
  end_time: string;
  duration_s: number;
  distance_m: number | null;
  energy_kcal: number | null;
  source_name: string | null;
}

export interface MindRow {
  sample_uuid: string;
  device: string;
  logged_at: string;
  kind: (typeof MIND_KINDS)[number];
  valence: number;
  labels: string[];
  associations: string[];
}

export type Parsed<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function text(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

function inRange(ms: number, now: number): boolean {
  return ms <= now + MAX_FUTURE_MS && ms >= now - MAX_AGE_MS;
}

function textList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = text(x, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Hourly metric rows. One row per (metric, hour): a repeat inside one upload keeps the last. */
export function parseHourly(input: unknown, device: string, now: number): Parsed<HourlyRow> {
  if (input === undefined || input === null) return { ok: true, rows: [] };
  if (!Array.isArray(input)) return { ok: false, reason: "hourly must be an array" };
  if (input.length > MAX_HOURLY) return { ok: false, reason: `${input.length} hourly rows (limit ${MAX_HOURLY})` };
  const rows = new Map<string, HourlyRow>();
  for (const raw of input as Record<string, unknown>[]) {
    const metric = typeof raw?.metric === "string" && raw.metric in HEALTH_METRICS ? (raw.metric as HealthMetric) : null;
    const start = iso(raw?.start);
    const value = num(raw?.value);
    if (!metric || !start || value === null) return { ok: false, reason: "an hourly row lacks a known metric, start or value" };
    const spec = HEALTH_METRICS[metric];
    if (value < 0 || value > spec.max) return { ok: false, reason: `${metric} value out of range` };
    if (!inRange(new Date(start).getTime(), now)) return { ok: false, reason: "an hourly row is outside the accepted time range" };
    const samples = num(raw?.samples);
    rows.set(`${metric}|${start}`, {
      device,
      metric,
      hour_start: start,
      value: Math.round(value * 1000) / 1000,
      unit: spec.unit,
      samples: spec.kind === "avg" && samples !== null ? Math.max(1, Math.round(samples)) : null,
    });
  }
  return { ok: true, rows: [...rows.values()] };
}

export function parseWorkouts(input: unknown, device: string, now: number): Parsed<WorkoutRow> {
  if (input === undefined || input === null) return { ok: true, rows: [] };
  if (!Array.isArray(input)) return { ok: false, reason: "workouts must be an array" };
  if (input.length > MAX_WORKOUTS) return { ok: false, reason: `${input.length} workouts (limit ${MAX_WORKOUTS})` };
  const rows = new Map<string, WorkoutRow>();
  for (const raw of input as Record<string, unknown>[]) {
    const uuid = text(raw?.uuid, 80);
    const type = text(raw?.type, 60);
    const start = iso(raw?.start);
    const end = iso(raw?.end);
    const duration = num(raw?.duration_s);
    if (!uuid || !type || !start || !end || duration === null || duration < 0) {
      return { ok: false, reason: "a workout lacks uuid, type, start, end or duration_s" };
    }
    if (new Date(end).getTime() < new Date(start).getTime() || !inRange(new Date(start).getTime(), now)) {
      return { ok: false, reason: "a workout has an impossible or out-of-range time" };
    }
    const distance = num(raw?.distance_m);
    const energy = num(raw?.energy_kcal);
    rows.set(uuid, {
      workout_uuid: uuid,
      device,
      activity_type: type,
      start_time: start,
      end_time: end,
      duration_s: Math.round(duration * 10) / 10,
      distance_m: distance !== null && distance >= 0 ? Math.round(distance * 10) / 10 : null,
      energy_kcal: energy !== null && energy >= 0 ? Math.round(energy * 10) / 10 : null,
      source_name: text(raw?.source, 80),
    });
  }
  return { ok: true, rows: [...rows.values()] };
}

export function parseMind(input: unknown, device: string, now: number): Parsed<MindRow> {
  if (input === undefined || input === null) return { ok: true, rows: [] };
  if (!Array.isArray(input)) return { ok: false, reason: "mind must be an array" };
  if (input.length > MAX_MIND) return { ok: false, reason: `${input.length} mind entries (limit ${MAX_MIND})` };
  const rows = new Map<string, MindRow>();
  for (const raw of input as Record<string, unknown>[]) {
    const uuid = text(raw?.uuid, 80);
    const at = iso(raw?.at);
    const valence = num(raw?.valence);
    const kind = (MIND_KINDS as readonly unknown[]).includes(raw?.kind) ? (raw.kind as MindRow["kind"]) : null;
    if (!uuid || !at || valence === null || !kind || valence < -1 || valence > 1) {
      return { ok: false, reason: "a mind entry lacks uuid, at, kind or a valence between -1 and 1" };
    }
    if (!inRange(new Date(at).getTime(), now)) return { ok: false, reason: "a mind entry is outside the accepted time range" };
    rows.set(uuid, {
      sample_uuid: uuid,
      device,
      logged_at: at,
      kind,
      valence: Math.round(valence * 10000) / 10000,
      labels: textList(raw?.labels, 12, 40),
      associations: textList(raw?.associations, 12, 40),
    });
  }
  return { ok: true, rows: [...rows.values()] };
}

// Where a sync can break on the phone (tools/screentime_ios HealthSync.swift HealthStage).
export const HEALTH_FAILURE_STAGES = ["access", "read", "encode", "network", "http"] as const;

/** Heartbeat text for an app failure report. Never echoes health data. */
export function healthFailureMessage(failure: unknown, appVersion: unknown): string {
  const f = failure && typeof failure === "object" ? (failure as { stage?: unknown; message?: unknown }) : {};
  const stage = (HEALTH_FAILURE_STAGES as readonly unknown[]).includes(f.stage) ? (f.stage as string) : "unknown";
  const version = text(appVersion, 40);
  return `iPhone Health sync failed (${stage}): ${text(f.message, 300) ?? "no detail"}${version ? ` [app ${version}]` : ""}`;
}
