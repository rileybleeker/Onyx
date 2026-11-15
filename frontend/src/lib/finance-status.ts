import { ingestionHeartbeatStatus, type HealthStatus } from "@/lib/status-freshness";

/**
 * Finance ledger health, from the two sync_log heartbeats the feed writes on every run (data_type
 * 'transactions' and 'balances'). Since 2026-11-14 the feed is SimpleFIN Bridge (simplefin_etl.py,
 * source 'simplefin', every 6 h, thresholds SIMPLEFIN_*_HOURS); before that it was the Rocket Money
 * harvester (source 'rocketmoney', daily, the FINANCE_*_HOURS defaults). Used by the /status card and
 * by the freshness line at the top of /financials, so both always agree.
 *
 * Thresholds: a heartbeat older than 36 h is degraded, older than 72 h is failed; a failed or
 * 'error' heartbeat is failed immediately and its own error text (for example a "login required"
 * message from the harvester) is shown as is. Pure: no network, no clock unless passed.
 *
 * Keep-alive visits (the harvester opens the app every 2 hours between imports to hold the sign-in)
 * write a third heartbeat, data_type 'keepalive': success, partial on the first failed visit in a
 * row, failed from the second. It never makes the card fresher (the import heartbeats alone set the
 * age), but when it is newer than both import heartbeats and not a success it drags the card down
 * with its own text, so a keep-alive that keeps failing is seen before the sign-in lapses.
 */
export const FINANCE_WARN_HOURS = 36;
export const FINANCE_FAIL_HOURS = 72;
/** SimpleFIN runs every 6 h: two missed runs is degraded, a day and more without one is red. */
export const SIMPLEFIN_WARN_HOURS = 14;
export const SIMPLEFIN_FAIL_HOURS = 30;
export const FINANCE_SOURCE = "simplefin";
export const SIMPLEFIN_THRESHOLDS = { warnHours: SIMPLEFIN_WARN_HOURS, failHours: SIMPLEFIN_FAIL_HOURS } as const;

type Entry = Record<string, unknown> | null | undefined;
export interface FinanceCard {
  status: HealthStatus;
  lastSync: string | null;
  latestDataDate: string | null;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
const ageHours = (e: Entry, now: number): number => {
  const t = typeof e?.sync_start === "string" ? Date.parse(e.sync_start) : NaN;
  return Number.isFinite(t) ? (now - t) / 3_600_000 : Infinity;
};

const startedAt = (e: Entry): number => (typeof e?.sync_start === "string" ? Date.parse(e.sync_start) : NaN);

/** The keep-alive heartbeat's status when it should count (newest, not a success), else null. */
function keepaliveStatus(keepalive: Entry, imports: Entry[]): HealthStatus | null {
  if (!keepalive) return null;
  const at = startedAt(keepalive);
  if (!Number.isFinite(at)) return null;
  if (imports.some((e) => e && !(startedAt(e) < at))) return null;
  if (keepalive.status === "failed" || keepalive.status === "error") return "failed";
  if (keepalive.status === "partial") return "partial";
  return null;
}

export function financeLedgerCard(
  transactions: Entry,
  balances: Entry,
  now = Date.now(),
  keepalive: Entry = null,
  thresholds: { warnHours: number; failHours: number } = { warnHours: FINANCE_WARN_HOURS, failHours: FINANCE_FAIL_HOURS },
): FinanceCard {
  const { warnHours, failHours } = thresholds;
  const parts = [
    { name: "transactions", entry: transactions ?? null },
    { name: "balances", entry: balances ?? null },
  ].map((p) => ({
    ...p,
    status: p.entry ? ingestionHeartbeatStatus("success", p.entry, warnHours, failHours, now) : ("unknown" as HealthStatus),
  }));
  const present = parts.filter((p) => p.entry);
  const keep = present.length ? keepaliveStatus(keepalive, present.map((p) => p.entry)) : null;
  const ranked = keep ? [...parts, { name: "keep-alive", entry: keepalive ?? null, status: keep }] : parts;

  let status: HealthStatus;
  if (present.length === 0) status = "unknown";
  else if (ranked.some((p) => p.status === "failed")) status = "failed";
  else if (ranked.some((p) => p.status === "partial")) status = "partial";
  // One kind never reported, or a heartbeat we cannot read: half the pipeline is not
  // checking in, so the card must not look healthy.
  else if (parts.some((p) => p.status === "unknown")) status = "partial";
  else status = "success";

  // Words for the card: the importer's own error text wins; otherwise say what is wrong.
  let errorMessage: string | null = null;
  for (const wantStatus of ["failed", "partial"] as const) {
    for (const p of ranked) {
      if (p.status === wantStatus && p.entry) errorMessage ??= text(p.entry.error_message);
    }
  }
  if (!errorMessage && status !== "success" && status !== "unknown") {
    for (const p of parts) {
      if (p.status === "success") continue;
      const reported = p.entry?.status;
      if (!p.entry) errorMessage = `No ${p.name} heartbeat yet - the ${p.name} importer has not reported.`;
      else if (reported === "failed" || reported === "error") errorMessage = `The latest ${p.name} import failed (no error text recorded).`;
      else if (reported === "partial") errorMessage = `The latest ${p.name} import finished with warnings (no detail recorded).`;
      else {
        const h = ageHours(p.entry, now);
        errorMessage = Number.isFinite(h)
          ? `Last ${p.name} import was ${Math.floor(h)}h ago (degraded after ${warnHours}h, failed after ${failHours}h).`
          : `The ${p.name} heartbeat could not be read.`;
      }
      break;
    }
  }

  const newest = present
    .map((p) => p.entry as Record<string, unknown>)
    .sort((a, b) => Date.parse(String(b.sync_start)) - Date.parse(String(a.sync_start)))[0];
  const lastSync = newest && Number.isFinite(Date.parse(String(newest.sync_start))) ? String(newest.sync_start) : null;
  return {
    status,
    lastSync,
    latestDataDate: lastSync ? lastSync.slice(0, 10) : null,
    recordsSynced: present.reduce((n, p) => n + num(p.entry?.records_synced), 0),
    durationSeconds: newest && typeof newest.duration_seconds === "number" ? newest.duration_seconds : null,
    errorMessage,
  };
}
