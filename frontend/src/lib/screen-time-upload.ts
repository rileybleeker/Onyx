/**
 * Completeness metadata of one Screen Time upload (PIPE-11). Pure (no I/O), so node tests can load it
 * (tests/screen-time-upload.test.cjs, synthetic values only). Used by POST /api/screen-time/usage.
 *
 * The Onyx Screen Time app (builds from 2026-11-16, tools/screentime_ios SyncService.swift) sends a `run`
 * object with every chunk of one sync:
 *   run_id         one UUID per sync run (every chunk of the run carries the same one)
 *   window_start   the start of the window the app asked Apple for (local midnight, days back)
 *   window_end     when the export was read (the window's end)
 *   stream_ended   true when Apple's stream ended on its own; false when the app's watchdog stopped it
 *   segment_count  hours in the whole run
 *   chunk_index    this chunk, 0-based
 *   chunk_count    chunks in the run
 *
 * The route records the chunk only after its hours are written, and the database
 * (pds.finalize_phone_usage_run, sql/phone_usage_completeness.sql) marks hours verified only when every chunk
 * of the run arrived, the chunks agree and the stream ended. An upload without `run` (every app build before
 * this change) is accepted as before and its hours stay unverified: completeness unknown, never complete.
 */

export interface UploadRun {
  runId: string; // lower-case UUID
  windowStart: string; // ISO instant
  windowEnd: string;
  windowStartMs: number;
  windowEndMs: number;
  streamEnded: boolean;
  segmentCount: number;
  chunkIndex: number;
  chunkCount: number;
}

export type RunParse = { kind: "none" } | { kind: "ok"; run: UploadRun } | { kind: "bad"; reason: string };

export const MAX_RUN_CHUNKS = 100;
/** 40 days of hours: the app asks for at most 30 days, plus DST and the hour in progress. */
export const MAX_RUN_HOURS = 40 * 25;
const MAX_WINDOW_MS = 40 * 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statuses pds.finalize_phone_usage_run answers; anything else reads as "unknown". */
export const RUN_STATUSES = ["complete", "receiving", "stream_open", "inconsistent", "unknown_run"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number] | "unknown";

function instantMs(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function wholeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * Reads `body.run`. Absent (undefined or null) = an older app build: { kind: "none" }. Present but not exactly
 * right = { kind: "bad" } with a reason that names the field and never echoes a value (the reason goes into the
 * owner-readable heartbeat).
 */
export function parseUploadRun(
  raw: unknown,
  nowMs: number,
  limits: { maxFutureMs: number; maxAgeMs: number },
): RunParse {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "bad", reason: "run is not an object" };
  const r = raw as Record<string, unknown>;
  const runId = typeof r.run_id === "string" ? r.run_id.trim() : "";
  if (!UUID.test(runId)) return { kind: "bad", reason: "run_id is not a UUID" };
  const startMs = instantMs(r.window_start);
  const endMs = instantMs(r.window_end);
  if (startMs === null || endMs === null) return { kind: "bad", reason: "window_start or window_end is not a time" };
  if (endMs <= startMs) return { kind: "bad", reason: "window_end is not after window_start" };
  if (endMs - startMs > MAX_WINDOW_MS) return { kind: "bad", reason: "the window is longer than 40 days" };
  if (endMs > nowMs + limits.maxFutureMs || startMs < nowMs - limits.maxAgeMs) {
    return { kind: "bad", reason: "the window is outside the accepted time range" };
  }
  const streamEnded = r.stream_ended;
  if (typeof streamEnded !== "boolean") return { kind: "bad", reason: "stream_ended is not true or false" };
  const segmentCount = wholeNumber(r.segment_count);
  if (segmentCount === null || segmentCount < 1 || segmentCount > MAX_RUN_HOURS) {
    return { kind: "bad", reason: `segment_count is not a whole number from 1 to ${MAX_RUN_HOURS}` };
  }
  const chunkCount = wholeNumber(r.chunk_count);
  if (chunkCount === null || chunkCount < 1 || chunkCount > MAX_RUN_CHUNKS) {
    return { kind: "bad", reason: `chunk_count is not a whole number from 1 to ${MAX_RUN_CHUNKS}` };
  }
  const chunkIndex = wholeNumber(r.chunk_index);
  if (chunkIndex === null || chunkIndex < 0 || chunkIndex >= chunkCount) {
    return { kind: "bad", reason: "chunk_index is not a whole number below chunk_count" };
  }
  return {
    kind: "ok",
    run: {
      runId: runId.toLowerCase(),
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      windowStartMs: startMs,
      windowEndMs: endMs,
      streamEnded,
      segmentCount,
      chunkIndex,
      chunkCount,
    },
  };
}

/** A segment belongs to the run's window when it overlaps it (the hour in progress ends after window_end). */
export function segmentInWindow(startMs: number, endMs: number, run: UploadRun): boolean {
  return startMs < run.windowEndMs && endMs > run.windowStartMs;
}

/** Items per hour, counted after the route merged duplicates: the run's claim for that hour. */
export function itemCountsBySegment(items: Iterable<Record<string, unknown>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    const key = String(it.segment_start);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** The pds.phone_usage_sync_chunks row for one received chunk (written after its hours). */
export function chunkRow(
  device: string,
  run: UploadRun,
  segments: ReadonlyArray<{ segment_start: string; segment_end: string }>,
  appVersion: string | null,
): Record<string, unknown> {
  let first = Infinity;
  let last = -Infinity;
  for (const s of segments) {
    first = Math.min(first, Date.parse(s.segment_start));
    last = Math.max(last, Date.parse(s.segment_end));
  }
  return {
    device,
    run_id: run.runId,
    chunk_index: run.chunkIndex,
    chunk_count: run.chunkCount,
    window_start: run.windowStart,
    window_end: run.windowEnd,
    stream_ended: run.streamEnded,
    run_segment_count: run.segmentCount,
    segment_count: segments.length,
    first_segment_start: new Date(first).toISOString(),
    last_segment_end: new Date(last).toISOString(),
    app_version: appVersion,
    received_at: new Date().toISOString(),
  };
}

/** The status field of pds.finalize_phone_usage_run's answer; anything unexpected is "unknown". */
export function runStatusOf(answer: unknown): RunStatus {
  const status = answer && typeof answer === "object" ? (answer as { status?: unknown }).status : undefined;
  return (RUN_STATUSES as readonly unknown[]).includes(status) ? (status as RunStatus) : "unknown";
}
