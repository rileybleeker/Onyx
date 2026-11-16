/**
 * Stored finance results (sql/finance_result_cache.sql): the rules for when a stored result may be served.
 *
 * The Today money alerts, the Today renewals summary and the /financials/forecast and /financials/budgets
 * renders are computed from the ledger and the plan tables, which change only when the SimpleFIN ETL runs
 * (every 6 h) or Riley edits something. Each result is stored in pds.finance_result_cache with the input
 * version it was computed from; a trigger on every input table bumps the version (row key "inputs").
 *
 * PURE: no I/O, no clock (callers pass the time and the ET date). The server side is
 * lib/finance-result-cache-server.ts.
 */

/** The row whose `version` is the current input version (bumped by the database triggers). */
export const INPUTS_KEY = "inputs";
export type ResultKey = "alerts" | "renewals" | "forecast" | "budgets";

/** A stored result is recomputed at least this often while it is being read, even when nothing changed. */
export const FRESH_MS = 60 * 60_000;
/** Older than this (Riley has not opened the app for days), a stored result is not served at all. */
export const MAX_STALE_MS = 72 * 3_600_000;
/** Bump when the stored form of a result changes, so rows written by older code are never served as fresh.
 *  2: the forecast result carries `eligibility` and the alerts answer `cash` (the safe-to-move gate). */
export const CACHE_FORMAT = 2;

/** The deployment a result was computed by: a stored result is fresh only for the same build. */
export function cacheBuild(env: Record<string, string | undefined> = process.env): string {
  const id = env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || "local";
  return `${CACHE_FORMAT}:${id}`.slice(0, 80);
}

export interface StoredRow {
  key: string;
  version: number;
  etDate: string | null;
  build: string | null;
  computedAt: string;
  failedAt: string | null;
  body: unknown;
}

export function parseRow(raw: unknown): StoredRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "string" ? Number(r.version) : r.version;
  if (typeof r.key !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || typeof r.computed_at !== "string") return null;
  return {
    key: r.key,
    version,
    etDate: typeof r.et_date === "string" ? r.et_date : null,
    build: typeof r.build === "string" ? r.build : null,
    computedAt: r.computed_at,
    failedAt: typeof r.failed_at === "string" ? r.failed_at : null,
    body: r.body ?? null,
  };
}

/**
 * fresh   = computed from the current inputs, on this ET day, by this build, within FRESH_MS: serve it.
 * stale   = an older but usable result: the Today routes serve it and recompute after answering; the
 *           pages recompute before answering (an edit must show at once).
 * compute = nothing usable (no row, the last refresh failed, or older than MAX_STALE_MS): compute now.
 */
export type CacheDecision = "fresh" | "stale" | "compute";

export function decide(row: StoredRow | null, inputVersion: number | null, today: string, build: string, nowMs: number): CacheDecision {
  if (!row || row.body === null || row.failedAt !== null) return "compute";
  const age = nowMs - Date.parse(row.computedAt);
  if (!Number.isFinite(age) || age > MAX_STALE_MS) return "compute";
  const current = inputVersion !== null && row.version === inputVersion && row.etDate === today && row.build === build;
  return current && age > -60_000 && age < FRESH_MS ? "fresh" : "stale";
}

/**
 * True when `value` survives JSON unchanged (what jsonb stores): no NaN / Infinity, no Date, Map, Set,
 * bigint or function, no undefined inside an array. A result that fails is computed every time instead
 * of being stored with silently changed values.
 */
export function jsonSafe(value: unknown): boolean {
  let ok = true;
  try {
    JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
      if (!ok) return undefined;
      const raw = (this as Record<string, unknown>)[key];
      if (typeof raw === "number" && !Number.isFinite(raw)) ok = false;
      else if (typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint") ok = false;
      else if (raw instanceof Date || raw instanceof Map || raw instanceof Set) ok = false;
      else if (raw === undefined && Array.isArray(this)) ok = false;
      return v;
    });
  } catch {
    return false;
  }
  return ok;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The stored /api/finance/alerts answer ({status: "ready", alerts}), or null. */
export function parseAlertsBody<T extends { status: "ready"; alerts: unknown[] }>(body: unknown): T | null {
  return isObj(body) && body.status === "ready" && Array.isArray(body.alerts) ? (body as T) : null;
}

/** A stored page load (ForecastLoad / BudgetsLoad): only "ok" and "empty" are ever stored. */
export function parseLoadBody<T extends { kind: string }>(body: unknown): T | null {
  return isObj(body) && (body.kind === "ok" || body.kind === "empty") ? (body as T) : null;
}
