import { ingestionHeartbeatStatus, type HealthStatus } from "@/lib/status-freshness";

/**
 * Rocket Money ledger health, from the two sync_log heartbeats the importers write on EVERY run:
 * source 'rocketmoney', data_type 'transactions' and 'balances'. Used by the /status card and
 * by the freshness line at the top of /financials, so both always agree.
 *
 * Thresholds: a heartbeat older than 36 h is degraded, older than 72 h is failed; a failed or
 * 'error' heartbeat is failed immediately and its own error text (for example a "login required"
 * message from the harvester) is shown as is. Pure: no network, no clock unless passed.
 */
export const FINANCE_WARN_HOURS = 36;
export const FINANCE_FAIL_HOURS = 72;

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

export function financeLedgerCard(transactions: Entry, balances: Entry, now = Date.now()): FinanceCard {
  const parts = [
    { name: "transactions", entry: transactions ?? null },
    { name: "balances", entry: balances ?? null },
  ].map((p) => ({
    ...p,
    status: p.entry ? ingestionHeartbeatStatus("success", p.entry, FINANCE_WARN_HOURS, FINANCE_FAIL_HOURS, now) : ("unknown" as HealthStatus),
  }));
  const present = parts.filter((p) => p.entry);

  let status: HealthStatus;
  if (present.length === 0) status = "unknown";
  else if (parts.some((p) => p.status === "failed")) status = "failed";
  else if (parts.some((p) => p.status === "partial")) status = "partial";
  // One kind never reported, or a heartbeat we cannot read: half the pipeline is not
  // checking in, so the card must not look healthy.
  else if (parts.some((p) => p.status === "unknown")) status = "partial";
  else status = "success";

  // Words for the card: the importer's own error text wins; otherwise say what is wrong.
  let errorMessage: string | null = null;
  for (const wantStatus of ["failed", "partial"] as const) {
    for (const p of parts) {
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
          ? `Last ${p.name} import was ${Math.floor(h)}h ago (degraded after ${FINANCE_WARN_HOURS}h, failed after ${FINANCE_FAIL_HOURS}h).`
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
