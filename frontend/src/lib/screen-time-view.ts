import type { ScreenSync, ScreenTimeLoad } from "@/lib/screen-time-server";
import { chartPoints, summarize, topEntries, type ScreenPoint, type ScreenSummary, type TopEntry } from "@/lib/screen-time";
import { isAiSection, type AiSection } from "@/lib/ai-usage";
import { isPcSection, type PcSection } from "@/lib/pc-activity-view";

/**
 * What the /screen-time screen draws (app/screen-time/ScreenTimeView.tsx): the averages, the chart points and
 * the two top-10 lists worked out from the day rows, never the rows themselves. The server page computes it
 * during its render; GET /api/screen-time/page-data answers the same shape for the page's section of the
 * continuous scroll, so the browser receives exactly what the screen shows and no per-day app breakdown.
 * `ai` is the "AI tools" section, already reduced to aggregates on the server (lib/ai-usage.ts); `pc` the "PC"
 * section (lib/pc-activity-view.ts), optional because an answer cached before the field existed has none.
 * Pure (no I/O), so node tests can load it.
 */
export type ScreenTimeViewData =
  /** ai / pc: the sections read when only the phone query failed (absent when nothing was read). */
  | { kind: "error"; hint: string; ai?: AiSection; pc?: PcSection }
  | { kind: "empty"; windowDays: number; sync: ScreenSync | null; ai: AiSection; pc?: PcSection }
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
      pc?: PcSection;
    };

export function screenTimeViewData(load: ScreenTimeLoad): ScreenTimeViewData {
  if (load.kind !== "ok") return load;
  return {
    kind: "ok",
    windowDays: load.windowDays,
    sync: load.sync,
    ai: load.ai,
    pc: load.pc,
    skippedRows: load.skippedRows,
    summary: summarize(load.days),
    points: chartPoints(load.days),
    topApps: topEntries(load.days, "byApp"),
    topCategories: topEntries(load.days, "byCategory"),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSync = (v: unknown) => v === null || (isObject(v) && (v.at === null || typeof v.at === "string"));
/** Absent pc is accepted (an answer cached before the field existed); a present one must be well-formed. */
const pcOk = (v: unknown) => v === undefined || isPcSection(v);
/** An error answer may carry ai (and pc) when only the phone query failed; absent is fine, malformed is not. */
const aiOk = (v: unknown) => v === undefined || isAiSection(v);

/** A cached or fetched answer checked like the server's own shape; throws on anything else. */
export function readScreenTimeViewData(raw: unknown): ScreenTimeViewData {
  if (!isObject(raw)) throw new Error("malformed screen time answer");
  if (raw.kind === "error" && typeof raw.hint === "string" && aiOk(raw.ai) && pcOk(raw.pc)) return raw as ScreenTimeViewData;
  if (raw.kind === "empty" && typeof raw.windowDays === "number" && isSync(raw.sync) && isAiSection(raw.ai) && pcOk(raw.pc)) {
    return raw as ScreenTimeViewData;
  }
  if (
    raw.kind === "ok" &&
    typeof raw.windowDays === "number" &&
    typeof raw.skippedRows === "number" &&
    isSync(raw.sync) &&
    isAiSection(raw.ai) &&
    pcOk(raw.pc) &&
    isObject(raw.summary) &&
    Array.isArray(raw.points) &&
    Array.isArray(raw.topApps) &&
    Array.isArray(raw.topCategories)
  ) {
    return raw as ScreenTimeViewData;
  }
  throw new Error("malformed screen time answer");
}
