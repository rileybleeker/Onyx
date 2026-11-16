// The /status card "Reading Questions" (READ-QUIZ-01; docs/reading-question-bank.md "Heartbeat and the /status card").
// Pure: no I/O, no imports, so /api/status and the tests use it as is.
//
// What it reads: the newest reading_bank|generate heartbeat (a dedicated limit-1 read: the shared 100-row window
// spans about 13 hours) and pds.reading_bank_status() (counts only: approved books, queued / failed jobs, chapters
// lagging, this month's spend, the schema checks). Both hold counts, chapter numbers and codes only; /api/status is
// CDN-cacheable, so nothing else may leave it.
//
// States:
// - unknown:  the SQL is not applied (and no failed heartbeat), no book is turned on ("Off"), or no run yet;
// - failed:   a failed heartbeat; a chapter waiting more than 24 h; jobs queued with no heartbeat for 24 h; a job that
//             failed in the last 24 h;
// - partial:  a partial heartbeat; a chapter waiting more than 6 h; jobs queued and the heartbeat older than 3 h;
//             the T07 checks not widened (sql/reading_question_bank_checks.sql);
// - success:  otherwise.

export const READING_BANK_LABEL = "Reading Questions";
export const READING_BANK_SQL = "sql/reading_question_bank.sql";
export const READING_BANK_CHECKS_SQL = "sql/reading_question_bank_checks.sql";
/** Heartbeat age (h) that, with jobs queued, reads degraded / red. */
export const READING_BANK_DEGRADED_HOURS = 3;
export const READING_BANK_FAILED_HOURS = 24;

export interface ReadingBankHeartbeat {
  status?: string | null;
  sync_start?: string | null;
  records_synced?: number | null;
  duration_seconds?: number | null;
  error_message?: string | null;
}

/** pds.reading_bank_status() (counts only). */
export interface ReadingBankStatusCounts {
  approved_books?: number | null;
  paused_budget?: number | null;
  uncertain?: number | null;
  queued?: number | null;
  failed_24h?: number | null;
  lagging_6h?: number | null;
  lagging_24h?: number | null;
  pending_grades?: number | null;
  month_cents?: number | string | null;
  schema?: { all_ok?: boolean | null } | null;
}

export interface ReadingBankCard {
  label: string;
  lastSync: string | null;
  status: "success" | "partial" | "failed" | "unknown";
  latestDataDate: string | null;
  daysLag: number;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
  /** "Spend: $4.20 of $30 this month" (and the paused / grading counts) as extra detail rows. */
  extraRows: { label: string; value: string }[];
}

const MISSING_CODES = new Set(["PGRST202", "PGRST205", "42883", "42P01", "42703"]);

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** "$4.20" / "$30" (cents in). */
export function money(cents: number): string {
  const d = Math.max(0, cents) / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

/** A heartbeat message is shown only when it is counts and codes (the generator writes nothing else). */
function safeMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return /^[\w .;:/,()+%\-]{1,500}$/.test(value) ? value : null;
}

function hoursSince(iso: string | null | undefined, nowMs: number): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 3_600_000) : Infinity;
}

export function readingBankCard(p: {
  heartbeat: ReadingBankHeartbeat | null;
  counts: ReadingBankStatusCounts | null;
  countsError: { code?: string | null } | null;
  monthCapCents: number;
  nowMs: number;
}): ReadingBankCard {
  const hb = p.heartbeat;
  const ageH = hoursSince(hb?.sync_start, p.nowMs);
  const hbMsg = safeMessage(hb?.error_message);
  const base: ReadingBankCard = {
    label: READING_BANK_LABEL,
    lastSync: hb?.sync_start ?? null,
    status: "unknown",
    latestDataDate: hb?.sync_start ? String(hb.sync_start).slice(0, 10) : null,
    daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
    recordsSynced: n(hb?.records_synced),
    durationSeconds: typeof hb?.duration_seconds === "number" ? hb.duration_seconds : null,
    errorMessage: null,
    extraRows: [],
  };

  if (p.countsError) {
    const code = String(p.countsError.code ?? "");
    if (MISSING_CODES.has(code)) {
      // Not set up yet: unknown, unless the worker already reported the missing schema as a failure.
      if (hb?.status === "failed") return { ...base, status: "failed", errorMessage: hbMsg ?? `Apply ${READING_BANK_SQL}.` };
      return { ...base, label: `${READING_BANK_LABEL} (not set up)`, errorMessage: `Not set up: apply ${READING_BANK_SQL}.` };
    }
    return { ...base, status: "failed", errorMessage: `Could not read the question bank status (${/^[A-Za-z0-9_]{1,12}$/.test(code) ? code : "unknown"}).` };
  }

  const c = p.counts ?? {};
  const month = n(c.month_cents);
  const extraRows = [{ label: "Spend", value: `${money(month)} of ${money(p.monthCapCents)} this month` }];
  if (n(c.paused_budget)) extraRows.push({ label: "Paused", value: `${plural(n(c.paused_budget), "book")} at budget` });
  if (n(c.pending_grades)) extraRows.push({ label: "Grading", value: plural(n(c.pending_grades), "answer") });
  const card = { ...base, extraRows };

  if (n(c.approved_books) === 0 && n(c.paused_budget) === 0) {
    return { ...card, label: `${READING_BANK_LABEL} (off)`, status: "unknown", errorMessage: "Off · turn it on per book on Reading." };
  }

  const queued = n(c.queued);
  const red: string[] = [];
  const amber: string[] = [];
  if (hb?.status === "failed" || hb?.status === "error") red.push(hbMsg ? `Last run failed: ${hbMsg}` : "Last run failed.");
  if (n(c.lagging_24h)) red.push(`${plural(n(c.lagging_24h), "chapter")} waiting more than 24 h for questions.`);
  if (queued && ageH > READING_BANK_FAILED_HOURS) red.push(`${plural(queued, "job")} queued and no run for ${Number.isFinite(ageH) ? `${Math.floor(ageH)} h` : "ever"}: check the Reading Question Bank workflow.`);
  if (n(c.failed_24h)) red.push(`${plural(n(c.failed_24h), "job")} failed in the last 24 h: Rebuild on the chapter, or check Status history.`);
  if (hb?.status === "partial") amber.push(hbMsg ? `Last run: ${hbMsg}` : "Last run was partial.");
  if (n(c.lagging_6h)) amber.push(`${plural(n(c.lagging_6h), "chapter")} waiting more than 6 h for questions.`);
  if (queued && ageH > READING_BANK_DEGRADED_HOURS && ageH <= READING_BANK_FAILED_HOURS) amber.push(`${plural(queued, "job")} queued, last run ${Math.floor(ageH)} h ago.`);
  if (c.schema && c.schema.all_ok === false) amber.push(`T07 checks not widened: run ${READING_BANK_CHECKS_SQL} in the dashboard.`);
  if (red.length) return { ...card, status: "failed", errorMessage: red.join(" ") };
  if (amber.length) return { ...card, status: "partial", errorMessage: amber.join(" ") };
  if (!hb) return { ...card, status: "unknown", errorMessage: "On; no run yet." };
  return { ...card, status: "success" };
}
