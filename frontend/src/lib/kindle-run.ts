// "Run now" for the Kindle harvester (2026-11-16). Import-free so tests can bundle it by name.
//
// Event driven: POST /api/kindle/run inserts a row into pds.pc_run_requests, Supabase Realtime
// pushes it to the idle listener on Riley's PC (tools/kindle_harvest/run-listener.mjs), which
// starts the "Onyx Kindle Harvest" scheduled task and writes its answer back on the row. The
// button reads that row (GET /api/kindle/run?id=…) while it waits. Nothing on the PC polls.

export const KINDLE_RUN_URL = "/api/kindle/run";
export const MAX_RUN_BODY_BYTES = 256;

/** A press not picked up within this long is reused by the next press instead of a second row. */
export const REUSE_UNANSWERED_MS = 2 * 60_000;
/** A run the PC started is reused while it can still be running (task limit 20 min + margin). */
export const REUSE_RUNNING_MS = 25 * 60_000;
/** No answer from the PC after this long: say it looks asleep or off (the button keeps listening). */
export const NO_ANSWER_MS = 15_000;
/** Stop waiting for a pick-up after this long (a reconnecting PC picks up presses up to 2 min old). */
export const GIVE_UP_UNANSWERED_MS = REUSE_UNANSWERED_MS + 10_000;
/** Stop waiting for the end of a run after this long. */
export const GIVE_UP_RUNNING_MS = REUSE_RUNNING_MS + 60_000;

export type RunOutcome = "started" | "already_running" | "failed";

export type RunRequest = {
  id: string;
  requested_at: string;
  picked_up_at: string | null;
  outcome: RunOutcome | null;
  finished_at: string | null;
  exit_code: number | null;
  detail: string | null;
};

export const RUN_REQUEST_COLS = "id, requested_at, picked_up_at, outcome, finished_at, exit_code, detail";

type HeaderGetter = { get(name: string): string | null };

/** Same-origin JSON with a small body, like the other owner-session write routes. */
export function checkRunRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_RUN_BODY_BYTES)) return { status: 413, error: "body too large" };
  return null;
}

/** The body is an empty JSON object: there is nothing to choose yet (one task, the Kindle harvest). */
export function parseRunBody(text: string): { ok: true } | { ok: false; error: string } {
  if (text.length > MAX_RUN_BODY_BYTES) return { ok: false, error: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    return { ok: false, error: "body must be JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  if (Object.keys(body).length > 0) return { ok: false, error: "unknown field" };
  return { ok: true };
}

export function isRunId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

/**
 * Whether a new press should reuse the newest request instead of writing another row: one the PC
 * has not answered yet (under 2 min old), or a run it started that has not finished (under 25 min).
 */
export function shouldReuse(row: RunRequest | null, now: number): boolean {
  if (!row) return false;
  const age = now - ms(row.requested_at);
  if (!Number.isFinite(age)) return false;
  if (!row.picked_up_at) return age < REUSE_UNANSWERED_MS;
  if (row.outcome === "failed" || row.finished_at) return false;
  return age < REUSE_RUNNING_MS;
}

export type RunPhase = "waiting" | "no_answer" | "running" | "done" | "failed";
export type RunView = { phase: RunPhase; text: string; tone: "neutral" | "ok" | "warn" | "error"; final: boolean };

const EXIT_TEXT: Record<number, string> = {
  1: "The harvest finished with an error. The card shows what it reported.",
  2: "Amazon signed the harvester out. On the PC run: node harvest.mjs --login (in tools\\kindle_harvest).",
  3: "The PC has no Onyx token (~/.onyx_ci_token), so nothing was sent.",
};

const DETAIL_TEXT: Record<string, string> = {
  task_missing: "The \"Onyx Kindle Harvest\" task is missing on the PC. Run tools\\kindle_harvest\\register-task.ps1.",
  did_not_start: "The PC answered but Windows did not start the harvest task.",
  timeout: "The harvest was still running after 25 minutes; Windows stops it at 20, so check the card.",
  task_query_failed: "The PC answered but could not read the harvest task's state.",
};

/**
 * What the button says about a request. `elapsed` = milliseconds since this screen sent the press
 * (the screen's own clock, so a skewed PC or server clock cannot make it look late).
 */
export function runView(row: RunRequest | null, elapsed: number): RunView {
  if (!row || !row.picked_up_at) {
    if (elapsed >= GIVE_UP_UNANSWERED_MS)
      return { phase: "failed", tone: "error", final: true, text: "Your PC didn't answer. It is probably asleep or off, or the run listener is not running on it." };
    if (elapsed >= NO_ANSWER_MS)
      return { phase: "no_answer", tone: "warn", final: false, text: "Waiting for your PC. No answer yet: it may be asleep or off." };
    return { phase: "waiting", tone: "neutral", final: false, text: "Asking your PC…" };
  }
  if (row.outcome === "failed") {
    const known = row.detail ? DETAIL_TEXT[row.detail] : undefined;
    return { phase: "failed", tone: "error", final: true, text: known ?? `The PC could not start the harvest (${row.detail ?? "no detail"}).` };
  }
  if (!row.finished_at) {
    if (elapsed >= GIVE_UP_RUNNING_MS)
      return { phase: "failed", tone: "warn", final: true, text: "Stopped waiting for the harvest. The card updates when it reports." };
    return {
      phase: "running",
      tone: "neutral",
      final: false,
      text: row.outcome === "already_running" ? "A scheduled harvest was already running. Waiting for it to finish…" : "Harvesting on your PC…",
    };
  }
  if (row.detail && DETAIL_TEXT[row.detail]) return { phase: "failed", tone: "error", final: true, text: DETAIL_TEXT[row.detail] };
  if (row.exit_code === 0) return { phase: "done", tone: "ok", final: true, text: "Done. Highlights and reading position are up to date." };
  const exitText = row.exit_code != null ? EXIT_TEXT[row.exit_code] : undefined;
  return {
    phase: "failed",
    tone: "error",
    final: true,
    text: exitText ?? `The harvest ended with code ${row.exit_code ?? row.detail ?? "unknown"}. The card shows what it reported.`,
  };
}
