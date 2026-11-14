import "server-only";
import { LedgerQueryError, fetchPaged, serviceClient } from "@/lib/finance-ledger-server";
import {
  USAGE_WINDOW_DAYS,
  buildAdvice,
  dismissalKey,
  sumUsage,
  type AdviceLoad,
  type FlagMark,
  type UsageTotals,
} from "@/lib/procurement-flags";
import type { DetectedSubscription } from "@/lib/procurement-recurring";

/**
 * Server side of the waste flags on /procurement. SERVICE ROLE ONLY: it reads the Screen Time
 * tables (pds.phone_usage_segments / phone_usage_items) and pds.procurement_flag_dismissals, none
 * of which the browser can query; never import this from a client component. Explicit column
 * lists everywhere. Failures log an error code only - never an app, a merchant or an amount.
 *
 * Both reads fail open in the honest direction: without usage data the page says "usage unknown"
 * (no flag is raised from missing data), and without the dismissals table every flag shows.
 */

const SEGMENT_COLS = "segment_start";
const ITEM_COLS = "kind,identifier,seconds";
const DISMISSAL_COLS = "sub_id,flag_key";
const MAX_PAGES = 20;
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const DAY_MS = 86_400_000;

type Db = ReturnType<typeof serviceClient>;
const errorCode = (e: unknown): string => (e instanceof LedgerQueryError && e.code ? e.code : "unexpected");

/** iPhone usage per app / site over the last 30 days, or null when it cannot be read. */
export async function loadUsageTotals(db: Db, now: Date): Promise<UsageTotals | null> {
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS).toISOString();
  try {
    const [segments, items] = await Promise.all([
      fetchPaged(
        (from, to) =>
          db.from("phone_usage_segments").select(SEGMENT_COLS, { count: "exact" }).gte("segment_start", since)
            .order("segment_start", { ascending: true }).range(from, to),
        MAX_PAGES,
      ),
      fetchPaged(
        (from, to) =>
          db.from("phone_usage_items").select(ITEM_COLS, { count: "exact" }).gte("segment_start", since)
            .order("segment_start", { ascending: true }).order("kind", { ascending: true }).order("identifier", { ascending: true })
            .range(from, to),
        MAX_PAGES,
      ),
    ]);
    // A cut-off read would under-count minutes and could raise a false "no recent use": treat it as unknown.
    if (segments.truncated || items.truncated) return null;
    // Days with any reported hour. UTC days are close enough for "is the window covered".
    const days = new Set<string>();
    for (const row of segments.rows) {
      const start = (row as { segment_start?: unknown } | null)?.segment_start;
      if (typeof start === "string" && start.length >= 10) days.add(start.slice(0, 10));
    }
    return sumUsage(items.rows, days.size);
  } catch (e) {
    console.error("[/procurement] screen time read failed", errorCode(e));
    return null;
  }
}

export interface Dismissals {
  keys: Set<string>;
  /** False until sql/procurement_flag_dismissals.sql is applied (or the read failed): dismissing cannot be saved. */
  canSave: boolean;
}

export async function loadDismissals(db: Db): Promise<Dismissals> {
  const { data, error } = await db
    .from("procurement_flag_dismissals")
    .select(DISMISSAL_COLS)
    .eq("dismissed", true)
    .order("sub_id", { ascending: true })
    .order("flag_key", { ascending: true })
    .limit(2000);
  if (error) {
    if (!MISSING_TABLE.has(error.code ?? "")) console.error("[/procurement] flag dismissals read failed", error.code ?? "unknown");
    return { keys: new Set(), canSave: false };
  }
  const keys = new Set<string>();
  for (const row of data ?? []) {
    const r = row as { sub_id?: unknown; flag_key?: unknown };
    if (typeof r.sub_id === "string" && typeof r.flag_key === "string") keys.add(dismissalKey(r.sub_id, r.flag_key));
  }
  return { keys, canSave: true };
}

/** Flags and usage notes for the detected subscriptions. Never throws: the page renders without it. */
export async function loadSubscriptionAdvice(subs: readonly DetectedSubscription[], now: Date = new Date()): Promise<AdviceLoad> {
  let db: Db;
  try {
    db = serviceClient();
  } catch {
    return { advice: buildAdvice(subs, null), usageAvailable: false, canDismiss: false };
  }
  const [usage, dismissals] = await Promise.all([
    loadUsageTotals(db, now),
    loadDismissals(db).catch((): Dismissals => ({ keys: new Set(), canSave: false })),
  ]);
  return { advice: buildAdvice(subs, usage, dismissals.keys), usageAvailable: usage !== null, canDismiss: dismissals.canSave };
}

export type SaveResult = { ok: true } | { ok: false; status: number; setupPending: boolean };

/** Record (or take back) one dismissal. Writes pds.procurement_flag_dismissals and nothing else. */
export async function saveFlagMark(db: Db, mark: FlagMark, nowIso: string): Promise<SaveResult> {
  const { error } = await db
    .from("procurement_flag_dismissals")
    .upsert({ sub_id: mark.sub, flag_key: mark.flag, dismissed: mark.dismissed, updated_at: nowIso }, { onConflict: "sub_id,flag_key" });
  if (!error) return { ok: true };
  if (MISSING_TABLE.has(error.code ?? "")) return { ok: false, status: 503, setupPending: true };
  console.error("[/procurement] flag dismissal save failed", error.code ?? "unknown");
  return { ok: false, status: 500, setupPending: false };
}
