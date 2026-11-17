import "server-only";
import { after } from "next/server";
import { etDate } from "@/lib/format";
import { serviceClient } from "@/lib/finance-service-client";
import type { ForecastLoad } from "@/lib/cash-forecast-server";
import type { BudgetsLoad } from "@/lib/finance-budgets-server";
import { cashCheckAt, cashCheckExpired, cashForecastCheck, moneyAlerts, type CashForecastCheck, type MoneyAlert } from "@/lib/finance-alerts";
import { asOfNow } from "@/lib/cash-forecast-eligibility";
import type { RenewalsAhead } from "@/lib/procurement-renewals";
import { INPUTS_KEY, cacheBuild, decide, jsonSafe, parseAlertsBody, parseLoadBody, parseRow, type ResultKey, type StoredRow } from "@/lib/finance-result-cache";

// Speed (PERF-02, 2026-11-16): the computations (forecast engine + tax plan, budgets, subscription detection) are
// loaded only when a result is actually computed. A request answered from the stored row (the usual Today read)
// loads this module, the parse rules and the small client module only, so a cold first request does not parse
// the forecast engine first. Each loader is one shared import() per server instance.
const forecastServer = () => import("@/lib/cash-forecast-server");
const budgetsServer = () => import("@/lib/finance-budgets-server");
const recurringServer = () => import("@/lib/procurement-recurring-server");
const renewalsLib = () => import("@/lib/procurement-renewals");

/**
 * Stored finance results (sql/finance_result_cache.sql; rules in lib/finance-result-cache.ts). SERVICE ROLE
 * ONLY: pds.finance_result_cache has RLS on, no policies and no grants to anon / authenticated, like every
 * finance table; this module must never reach a client component ("server-only") and its callers sit behind
 * the owner-only middleware. Logs carry an error code or a result key only, never a stored value.
 *
 * A request reads ONE small row pair (the input version + the stored result) instead of recomputing from
 * ~2,500 ledger rows. Writes to any input table bump the version (database triggers), which makes every
 * stored result stale.
 */

const TABLE = "finance_result_cache";
const COLS = "key,version,et_date,build,computed_at,failed_at,body";

export interface StoreEntry {
  key: ResultKey;
  body: unknown;
}
export interface Computed<T> {
  /** The answer for this request; null = the inputs could not be read (the caller answers 500). */
  value: T | null;
  /** The results to store. The requested key is missing when its result is incomplete (a read failed). */
  store: StoreEntry[];
}
/**
 * stale-ok   (Today routes): a stale result is answered at once and recomputed after the response.
 * fresh-only (pages): a stale result is recomputed before answering, so an edit shows on the next render.
 */
export type ServeMode = "stale-ok" | "fresh-only";

const codeOf = (e: unknown): string => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unexpected");

async function readStored(key: ResultKey): Promise<{ version: number | null; row: StoredRow | null } | null> {
  try {
    const { data, error } = await serviceClient().from(TABLE).select(COLS).in("key", [INPUTS_KEY, key]);
    if (error) {
      console.error("[finance cache] read failed", error.code ?? "unknown");
      return null;
    }
    let version: number | null = null;
    let row: StoredRow | null = null;
    for (const raw of data ?? []) {
      const r = parseRow(raw);
      if (r?.key === INPUTS_KEY) version = r.version;
      else if (r?.key === key) row = r;
    }
    return { version, row };
  } catch (e) {
    console.error("[finance cache] read failed", codeOf(e));
    return null;
  }
}

async function save(version: number | null, today: string, computedAt: Date, entries: StoreEntry[]): Promise<void> {
  const build = cacheBuild();
  const rows = [];
  for (const e of entries) {
    if (!jsonSafe(e.body)) {
      console.error("[finance cache] not stored, not plain JSON:", e.key);
      continue;
    }
    // No input version (the "inputs" row is missing) stores -1, which is never fresh.
    rows.push({ key: e.key, version: version ?? -1, et_date: today, build, computed_at: computedAt.toISOString(), failed_at: null, body: e.body });
  }
  if (!rows.length) return;
  try {
    const { error } = await serviceClient().from(TABLE).upsert(rows, { onConflict: "key" });
    if (error) console.error("[finance cache] store failed", error.code ?? "unknown");
  } catch (e) {
    console.error("[finance cache] store failed", codeOf(e));
  }
}

/** The last refresh failed: the next request computes before answering instead of serving the old result. */
async function markFailed(key: ResultKey, at: Date): Promise<void> {
  try {
    const { error } = await serviceClient().from(TABLE).update({ failed_at: at.toISOString() }).eq("key", key);
    if (error) console.error("[finance cache] mark failed", error.code ?? "unknown");
  } catch (e) {
    console.error("[finance cache] mark failed", codeOf(e));
  }
}

/** Run after the response is sent (Next 15 after()); outside a request scope, just start it. */
function later(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task().catch(() => {});
  }
}

/** An answer and how current it is. */
export interface Served<T> {
  value: T;
  /** When the value was computed (ISO): the stored row's time, or now for a value computed for this request. */
  computedAt: string;
  /** A stale stored value (stale-ok mode): it is being recomputed after this response. */
  stale: boolean;
}

/**
 * Serve `key` from the stored result when it may be served (see ServeMode), else compute it now. Only a
 * missing, failed or very old result is computed inline on the Today routes. When the stored table cannot
 * be read at all, this computes every time, exactly as before the table existed.
 */
export async function serveStored<T>(
  key: ResultKey,
  now: Date,
  compute: () => Promise<Computed<T>>,
  parse: (body: unknown) => T | null,
  mode: ServeMode,
  expired?: (value: T) => boolean,
): Promise<T | null> {
  return (await serveStoredWithAge(key, now, compute, parse, mode, expired))?.value ?? null;
}

/**
 * serveStored, also saying when the answer was computed and whether a newer one is on its way. `expired` = a stored
 * value whose own check no longer holds at `now` (the safe-to-move check after a counted balance turned 48 hours
 * old): it is treated as stale even inside the fresh hour, so the page recomputes it (with the real reason) instead
 * of serving a copy that can only say "gone stale".
 */
export async function serveStoredWithAge<T>(
  key: ResultKey,
  now: Date,
  compute: () => Promise<Computed<T>>,
  parse: (body: unknown) => T | null,
  mode: ServeMode,
  expired?: (value: T) => boolean,
): Promise<Served<T> | null> {
  const today = etDate(now.toISOString());
  const stored = await readStored(key);
  if (stored?.row) {
    const decided = decide(stored.row, stored.version, today, cacheBuild(), now.getTime());
    const value = decided === "compute" ? null : parse(stored.row.body);
    const decision = decided === "fresh" && value !== null && expired?.(value) ? "stale" : decided;
    if (value !== null && (decision === "fresh" || mode === "stale-ok")) {
      if (decision === "stale") {
        later(async () => {
          try {
            const c = await compute();
            await save(stored.version, today, now, c.store);
            if (!c.store.some((e) => e.key === key)) await markFailed(key, new Date());
          } catch (e) {
            console.error("[finance cache] refresh failed", key, codeOf(e));
            await markFailed(key, new Date());
          }
        });
      }
      return { value, computedAt: stored.row.computedAt, stale: decision === "stale" };
    }
  }
  let c: Computed<T>;
  try {
    c = await compute();
  } catch (e) {
    // A computation that throws (a module that failed to load) answers like a failed read: null = the caller's 500.
    console.error("[finance cache] compute failed", key, codeOf(e));
    return null;
  }
  // The version read BEFORE computing is the one stored: a write during the computation leaves it stale.
  if (stored && c.store.length) later(() => save(stored.version, today, now, c.store));
  return c.value === null ? null : { value: c.value, computedAt: now.toISOString(), stale: false };
}

// ─── The stored results ───────────────────────────────────────────────────────────────────────────

/** The stored form of the money alerts. `cash` = the forecast's input check (absent when there is no ledger). */
export type MoneyAlertsBody = { status: "ready"; alerts: MoneyAlert[]; cash?: CashForecastCheck };
/**
 * What GET /api/finance/alerts answers: the alerts and how current and complete they are (Today shows it;
 * lib/money-alerts-view.ts).
 */
export type MoneyAlertsAnswer = MoneyAlertsBody & {
  /** When these alerts were computed (ISO). */
  asOf: string;
  /** An older stored answer, recomputed after this response: ask again with ?fresh=1 for the current one. */
  updating?: true;
  /** The forecast or the budgets could not be read, so an alert from that part may be missing (never stored). */
  partial?: "forecast" | "budgets";
};

/**
 * GET /api/finance/alerts. Computes the forecast and the budgets; the two page loads computed on the way are
 * stored too (the forecast with no what-if levers is the /financials/forecast default), so the pages are
 * fresh after Today has loaded. mode "stale-ok" (Today's first read) answers an older stored result at once,
 * marked `updating`; "fresh-only" (Today's follow-up, ?fresh=1) computes before answering unless the stored
 * result is current.
 */
export async function cachedMoneyAlerts(now: Date, mode: ServeMode = "stale-ok"): Promise<MoneyAlertsAnswer | null> {
  const served = await serveStoredWithAge<MoneyAlertsBody & { partial?: "forecast" | "budgets" }>(
    "alerts",
    now,
    async () => {
      const [{ loadForecast }, { loadBudgets }] = await Promise.all([forecastServer(), budgetsServer()]);
      const [f, b] = await Promise.all([loadForecast(now), loadBudgets(now)]);
      if (f.kind === "error" && b.kind === "error") return { value: null, store: [] };
      const buffer = f.kind === "ok" ? Number((f.drivers.find((d) => d.key === "settings")?.value as { bufferCents?: number } | undefined)?.bufferCents ?? 0) : 0;
      const body: MoneyAlertsBody = { status: "ready", alerts: moneyAlerts(f.kind === "ok" ? f.result : null, b.kind === "ok" ? b.result : null, buffer, etDate(now.toISOString())) };
      // The same eligibility the forecast page uses for safe to move: Today never reads "nothing to act on" as an
      // all-clear when the forecast rests on a stale, missing or unreadable input.
      const cash = cashForecastCheck(f.kind === "ok" ? f.result : null);
      if (cash) body.cash = cash;
      const store: StoreEntry[] = [];
      if (f.kind !== "error") store.push({ key: "forecast", body: f });
      if (b.kind !== "error") store.push({ key: "budgets", body: b });
      // Alerts from a half-failed read are answered, marked partial, and never stored.
      if (f.kind !== "error" && b.kind !== "error") store.push({ key: "alerts", body });
      const partial = f.kind === "error" ? "forecast" : b.kind === "error" ? "budgets" : undefined;
      return { value: partial ? { ...body, partial } : body, store };
    },
    parseAlertsBody,
    mode,
    // A stored check that has expired since: answered at once marked `updating` (Today asks again with ?fresh=1),
    // or recomputed before answering in fresh-only mode.
    (v) => !!v.cash && cashCheckExpired(v.cash, now),
  );
  if (!served) return null;
  const { status, alerts, partial } = served.value;
  // The stored check as of this request: a balance that turned 48 hours old since it was computed (up to an hour
  // in the fresh window, longer when a refresh failed) makes it not eligible.
  const cash = served.value.cash ? cashCheckAt(served.value.cash, now) : null;
  return { status, alerts, ...(cash ? { cash } : {}), asOf: served.computedAt, ...(served.stale ? { updating: true as const } : {}), ...(partial ? { partial } : {}) };
}

/** The stored renewals detection (the "stale-ok" read of cachedRenewalsAheadWithAge, without its age). */
export async function cachedRenewalsAhead(now: Date): Promise<RenewalsAhead | null> {
  return (await cachedRenewalsAheadWithAge(now, "stale-ok"))?.value ?? null;
}

/**
 * GET /api/procurement/renewals/summary: the stored form, turned into today's summary by the route, and how current
 * it is (like the money alerts): "stale-ok" (Today's first read) answers an older stored result at once, marked
 * stale and recomputed after the response; "fresh-only" (Today's follow-up, ?fresh=1) computes it first, so an
 * outdated "nothing renews" is never the last word.
 */
export async function cachedRenewalsAheadWithAge(now: Date, mode: ServeMode = "stale-ok"): Promise<Served<RenewalsAhead> | null> {
  // The renewals route imports lib/procurement-renewals itself, so this resolves at once there.
  const { parseRenewalsAhead, renewalsAhead } = await renewalsLib();
  return serveStoredWithAge<RenewalsAhead>(
    "renewals",
    now,
    async () => {
      const { loadDetectedSubscriptions } = await recurringServer();
      const load = await loadDetectedSubscriptions(now);
      if (load.state === "error") return { value: null, store: [] };
      const value = renewalsAhead(load);
      return { value, store: [{ key: "renewals", body: value }] };
    },
    parseRenewalsAhead,
    mode,
  );
}

/**
 * A forecast load as of `now`: a stored one keeps its safe-to-move amount only while every balance it counted is
 * still under 48 hours old (eligibility.validUntil); past that, the base plan and the what-if both withhold it.
 * Returns the same object when nothing changes.
 */
export function forecastLoadAt(load: ForecastLoad, now: Date): ForecastLoad {
  if (load.kind !== "ok") return load;
  const result = asOfNow(load.result, now);
  const scenario = load.scenario ? { ...load.scenario, result: asOfNow(load.scenario.result, now) } : null;
  return result === load.result && scenario?.result === load.scenario?.result ? load : { ...load, result, scenario };
}

/** /financials/forecast without what-if levers. */
export async function cachedForecast(now: Date): Promise<ForecastLoad> {
  const load = await serveStored<ForecastLoad>(
    "forecast",
    now,
    async () => {
      const { loadForecast } = await forecastServer();
      const f = await loadForecast(now);
      return { value: f, store: f.kind === "error" ? [] : [{ key: "forecast", body: f }] };
    },
    parseLoadBody<ForecastLoad>,
    "fresh-only",
    // A stored load whose safe-to-move check has expired since is recomputed, so the page names the account and offers
    // Leave it out instead of the generic "gone stale" reason.
    (l) => forecastLoadAt(l, now) !== l,
  );
  return load ? forecastLoadAt(load, now) : { kind: "error", code: "unknown" };
}

/** /financials/budgets. */
export async function cachedBudgets(now: Date): Promise<BudgetsLoad> {
  const load = await serveStored<BudgetsLoad>(
    "budgets",
    now,
    async () => {
      const { loadBudgets } = await budgetsServer();
      const b = await loadBudgets(now);
      return { value: b, store: b.kind === "error" ? [] : [{ key: "budgets", body: b }] };
    },
    parseLoadBody<BudgetsLoad>,
    "fresh-only",
  );
  return load ?? { kind: "error", code: "unknown" };
}
