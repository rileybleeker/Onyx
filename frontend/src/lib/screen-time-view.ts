import type { ScreenSync, ScreenTimeLoad } from "@/lib/screen-time-server";
import { chartPoints, summarize, topEntries, type ScreenPoint, type ScreenSummary, type TopEntry } from "@/lib/screen-time";
import { isAiSection, type AiSection } from "@/lib/ai-usage";

/**
 * What the /screen-time screen draws (app/screen-time/ScreenTimeView.tsx): the averages, the chart points and
 * the two top-10 lists worked out from the day rows, never the rows themselves. The server page computes it
 * during its render; GET /api/screen-time/page-data answers the same shape for the page's section of the
 * continuous scroll, so the browser receives exactly what the screen shows and no per-day app breakdown.
 * `ai` is the "AI tools" section, already reduced to aggregates on the server (lib/ai-usage.ts).
 * Pure (no I/O), so node tests can load it.
 */
export type ScreenTimeViewData =
  | { kind: "error"; hint: string }
  | { kind: "empty"; windowDays: number; sync: ScreenSync | null; ai: AiSection }
  | {
      kind: "ok";
      windowDays: number;
      sync: ScreenSync | null;
      skippedRows: number;
      summary: ScreenSummary;
      points: ScreenPoint[];
      topApps: TopEntry[];
      topCategories: TopEntry[];
      ai: AiSection;
    };

export function screenTimeViewData(load: ScreenTimeLoad): ScreenTimeViewData {
  if (load.kind !== "ok") return load;
  return {
    kind: "ok",
    windowDays: load.windowDays,
    sync: load.sync,
    ai: load.ai,
    skippedRows: load.skippedRows,
    summary: summarize(load.days),
    points: chartPoints(load.days),
    topApps: topEntries(load.days, "byApp"),
    topCategories: topEntries(load.days, "byCategory"),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSync = (v: unknown) => v === null || (isObject(v) && (v.at === null || typeof v.at === "string"));

/** A cached or fetched answer checked like the server's own shape; throws on anything else. */
export function readScreenTimeViewData(raw: unknown): ScreenTimeViewData {
  if (!isObject(raw)) throw new Error("malformed screen time answer");
  if (raw.kind === "error" && typeof raw.hint === "string") return raw as ScreenTimeViewData;
  if (raw.kind === "empty" && typeof raw.windowDays === "number" && isSync(raw.sync) && isAiSection(raw.ai)) {
    return raw as ScreenTimeViewData;
  }
  if (
    raw.kind === "ok" &&
    typeof raw.windowDays === "number" &&
    typeof raw.skippedRows === "number" &&
    isSync(raw.sync) &&
    isAiSection(raw.ai) &&
    isObject(raw.summary) &&
    Array.isArray(raw.points) &&
    Array.isArray(raw.topApps) &&
    Array.isArray(raw.topCategories)
  ) {
    return raw as ScreenTimeViewData;
  }
  throw new Error("malformed screen time answer");
}
