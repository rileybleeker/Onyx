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

/**
 * SimpleFIN heartbeat notes (SEC-07): an allowlist. simplefin_etl.py writes only "wording [code]" or
 * "wording [code x2]" segments built from NOTE_CODES; this table is the same list with the same wording (a test
 * reads both). The /status card, its sync history and the /financials freshness line show a SimpleFIN heartbeat
 * ONLY as re-rendered from these codes, so SimpleFIN's own text, an institution or account name or an id can
 * never reach those cacheable surfaces, even from an older row or a rolled-back ETL.
 */
export const SIMPLEFIN_NOTES: Readonly<Record<string, string>> = {
  sf_not_connected: "SimpleFIN is not connected: set the SIMPLEFIN_ACCESS_URL secret (simplefin_etl.py --claim --set-github-secret)",
  sf_access_url_invalid: "the SimpleFIN Access URL is not a valid SimpleFIN address: claim a new one (simplefin_etl.py --claim --set-github-secret)",
  sf_access_refused: "SimpleFIN refused the Access URL (revoked, disabled for too many requests, or wrong): create a new setup token at beta-bridge.simplefin.org and run simplefin_etl.py --claim --set-github-secret",
  sf_payment_required: "SimpleFIN says payment is required: renew the SimpleFIN Bridge subscription",
  sf_unreachable: "SimpleFIN could not be reached; the next run retries",
  sf_http_error: "SimpleFIN returned an unexpected HTTP status; the next run retries (the Actions log has the number)",
  sf_bad_answer: "SimpleFIN's answer was not the expected JSON (the format may have changed)",
  window_too_long: "the requested window is longer than SimpleFIN's 90-day limit",
  etl_error: "the SimpleFIN ETL failed unexpectedly (the Actions log names the error type)",
  db_write_failed: "the SimpleFIN ETL could not write to Supabase; the next run retries",
  sf_reauth: "SimpleFIN: a bank connection needs signing in again: reconnect it on SimpleFIN's site",
  sf_connection_error: "SimpleFIN: a bank connection reported an error: check it on SimpleFIN's site",
  sf_account_failed: "SimpleFIN could not read an account this run; it retries",
  sf_account_incomplete: "SimpleFIN says an account's transaction list is incomplete this run; it retries",
  sf_account_error: "SimpleFIN reported an account error: check the connections on SimpleFIN's site",
  sf_server_auth: "SimpleFIN reported an authentication problem with the Access URL: if it repeats, claim a new one",
  sf_api_error: "SimpleFIN says the request was malformed (a bug in simplefin_etl.py)",
  sf_general_error: "SimpleFIN reported a general problem: check SimpleFIN's site",
  sf_unclassified: "SimpleFIN reported a problem it did not classify: check the connections on SimpleFIN's site",
  account_no_id: "SimpleFIN sent an account without an id; it was skipped",
  account_unmatched: "an account was not imported: it could not be matched uniquely to a ledger account (run simplefin_etl.py --dry-run locally)",
  account_type_unset: "a new account is balances-only until its finance_accounts.account_type is set",
  cutover_review: "rows near the Rocket Money cutover were kept though a same-amount Rocket Money row is near: check for duplicates (simplefin_etl.py --dry-run locally)",
  cutover_provenance_unsaved: "the cutover match record was not saved (apply sql/finance_cutover_matches.sql); the next run retries",
};
export const SIMPLEFIN_NOTE_LIMIT = 300;
const SIMPLEFIN_MAX_COUNT = 9999;
/** Shown for a SimpleFIN heartbeat whose text carries no allowlisted code (an older row, or anything unexpected). */
export const SIMPLEFIN_UNREADABLE_NOTE =
  "SimpleFIN reported a problem; its details are not shown here: check the connections on SimpleFIN's site or run simplefin_etl.py --dry-run locally";

const noteToken = (code: string, n: number): string => (n > 1 ? `[${code} x${n}]` : `[${code}]`);

/** {code: count} -> the note text, exactly as simplefin_etl.py format_notes builds it. */
export function formatSimplefinNotes(counts: Readonly<Record<string, number>>): string | null {
  const items = Object.keys(SIMPLEFIN_NOTES)
    .map((c) => [c, Math.min(Math.floor(counts[c] ?? 0), SIMPLEFIN_MAX_COUNT)] as const)
    .filter(([, n]) => n > 0);
  if (!items.length) return null;
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const [c, n] = items[i];
    const seg = `${SIMPLEFIN_NOTES[c]} ${noteToken(c, n)}`;
    if (out.length && [...out, seg].join("; ").length > SIMPLEFIN_NOTE_LIMIT) {
      return `${out.join("; ")}; also ${items.slice(i).map(([rc, rn]) => noteToken(rc, rn)).join(" ")}`;
    }
    out.push(seg);
  }
  return out.join("; ");
}

/**
 * A stored SimpleFIN heartbeat text -> the same note re-rendered from its allowlisted codes only; any other text
 * in it is dropped. No allowlisted code -> SIMPLEFIN_UNREADABLE_NOTE. Empty -> null.
 */
export function safeSimplefinNote(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const counts: Record<string, number> = {};
  for (const m of value.matchAll(/\[([a-z][a-z0-9_]{0,40})(?: x(\d{1,4}))?\]/g)) {
    const code = m[1];
    if (!Object.prototype.hasOwnProperty.call(SIMPLEFIN_NOTES, code)) continue;
    counts[code] = Math.min((counts[code] ?? 0) + (m[2] ? Number(m[2]) : 1), SIMPLEFIN_MAX_COUNT);
  }
  return formatSimplefinNotes(counts) ?? SIMPLEFIN_UNREADABLE_NOTE;
}

/** A sync_log row with its error text made safe when it is a SimpleFIN heartbeat; other sources unchanged. */
export function withSafeSimplefinNote<T extends Record<string, unknown>>(row: T): T {
  return row && row.source === FINANCE_SOURCE ? { ...row, error_message: safeSimplefinNote(row.error_message) } : row;
}

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

/**
 * The SimpleFIN card (/status) and the /financials freshness line: financeLedgerCard with the SimpleFIN
 * thresholds, after each heartbeat's text is re-rendered from its allowlisted codes (safeSimplefinNote).
 */
export function simplefinLedgerCard(transactions: Entry, balances: Entry, now = Date.now()): FinanceCard {
  const safe = (e: Entry): Entry => (e ? { ...e, error_message: safeSimplefinNote(e.error_message) } : e);
  return financeLedgerCard(safe(transactions), safe(balances), now, null, SIMPLEFIN_THRESHOLDS);
}
