/**
 * N-of-1 experiment framework (docs/experiment-framework.md): what the Today card may know.
 *
 * Pure: no I/O. The only thing the app ever learns about a trial is the answer of
 * pds.experiment_today(): today's arm, never a later one. parseExperimentToday() is the single
 * gate between that answer and the browser; it copies the fields it knows and nothing else, and
 * rejects anything it does not recognise instead of passing it through.
 */

export type ExperimentArm = "A" | "B";

export type ExperimentToday =
  // No trial is registered (the usual case), or the last one has ended.
  | { status: "none" }
  // sql/experiment_framework_schema.sql has not been applied to this database.
  | { status: "not_connected" }
  | { status: "upcoming"; experimentId: string; title: string; startDate: string; nDays: number }
  | { status: "paused"; experimentId: string; title: string }
  | {
      status: "active";
      experimentId: string;
      title: string;
      behavioralDate: string;
      dayNumber: number;
      nDays: number;
      plannedEnd: string;
      arm: ExperimentArm;
      instruction: string;
    };

const ID = /^EXP-\d{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid experiment text");
  return value.trim();
}
function day(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)) throw new Error("invalid experiment date");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5000) throw new Error("invalid experiment count");
  return value;
}

/** Validate the database answer. Throws on anything unexpected (the route then answers 500). */
export function parseExperimentToday(raw: unknown): ExperimentToday {
  if (!raw || typeof raw !== "object") throw new Error("invalid experiment answer");
  const r = raw as Record<string, unknown>;
  if (r.status === "none" || r.status === "ended") return { status: "none" };
  if (r.status !== "upcoming" && r.status !== "paused" && r.status !== "active") throw new Error("invalid experiment status");
  if (typeof r.experiment_id !== "string" || !ID.test(r.experiment_id)) throw new Error("invalid experiment id");
  const experimentId = r.experiment_id;
  const title = text(r.title, 200);
  if (r.status === "upcoming") return { status: "upcoming", experimentId, title, startDate: day(r.start_date), nDays: count(r.n_days) };
  if (r.status === "paused") return { status: "paused", experimentId, title };
  if (r.arm !== "A" && r.arm !== "B") throw new Error("invalid experiment arm");
  const nDays = count(r.n_days);
  const dayNumber = count(r.day_number);
  if (dayNumber > nDays) throw new Error("invalid experiment day");
  return {
    status: "active",
    experimentId,
    title,
    behavioralDate: day(r.behavioral_date),
    dayNumber,
    nDays,
    plannedEnd: day(r.planned_end),
    arm: r.arm,
    instruction: text(r.instruction, 600),
  };
}

/** The client-side check of the route's JSON (same shape the parser produced on the server). */
export function isExperimentToday(value: unknown): value is ExperimentToday {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.status === "none" || v.status === "not_connected") return true;
  if (typeof v.experimentId !== "string" || typeof v.title !== "string") return false;
  if (v.status === "paused") return true;
  if (v.status === "upcoming") return typeof v.startDate === "string" && typeof v.nDays === "number";
  return v.status === "active" && (v.arm === "A" || v.arm === "B") && typeof v.instruction === "string"
    && typeof v.dayNumber === "number" && typeof v.nDays === "number";
}

// --- The check-in question "Followed today's arm?" (docs/experiment-framework.md 4.5) -------------
// The database answers through pds.experiment_adherence_day() / pds.experiment_record_adherence()
// (sql/experiment_adherence_reports_schema.sql). Both work on the behavioral today or the day before,
// only for a running trial and only for a day whose arm Today has already shown, so the question can
// never reveal an arm early. parseAdherenceDay() is the gate between that answer and the browser.

export const ADHERENCE_ANSWERS = ["yes", "partly", "no"] as const;
export type AdherenceAnswer = (typeof ADHERENCE_ANSWERS)[number];
export const ADHERENCE_NOTE_MAX = 500;

export type AdherenceDay =
  // No running trial on that day (the usual case), or the day is neither today nor yesterday.
  | { status: "none" }
  // sql/experiment_adherence_reports_schema.sql has not been applied to this database.
  | { status: "not_connected" }
  // A trial day whose arm Today has not shown yet: open Today first.
  | { status: "not_revealed"; experimentId: string; title: string; behavioralDate: string }
  | {
      status: "open";
      experimentId: string;
      title: string;
      behavioralDate: string;
      dayNumber: number;
      nDays: number;
      arm: ExperimentArm;
      instruction: string;
      answer: AdherenceAnswer | null;
      note: string | null;
    };

export function isAdherenceAnswer(value: unknown): value is AdherenceAnswer {
  return typeof value === "string" && (ADHERENCE_ANSWERS as readonly string[]).includes(value);
}

/** Validate the database answer. Throws on anything unexpected (the route then answers 500). */
export function parseAdherenceDay(raw: unknown): AdherenceDay {
  if (!raw || typeof raw !== "object") throw new Error("invalid experiment answer");
  const r = raw as Record<string, unknown>;
  if (r.status === "none") return { status: "none" };
  if (r.status !== "not_revealed" && r.status !== "open") throw new Error("invalid experiment status");
  if (typeof r.experiment_id !== "string" || !ID.test(r.experiment_id)) throw new Error("invalid experiment id");
  const experimentId = r.experiment_id;
  const title = text(r.title, 200);
  const behavioralDate = day(r.behavioral_date);
  if (r.status === "not_revealed") return { status: "not_revealed", experimentId, title, behavioralDate };
  if (r.arm !== "A" && r.arm !== "B") throw new Error("invalid experiment arm");
  const nDays = count(r.n_days);
  const dayNumber = count(r.day_number);
  if (dayNumber > nDays) throw new Error("invalid experiment day");
  if (r.self_report != null && !isAdherenceAnswer(r.self_report)) throw new Error("invalid experiment answer");
  if (r.self_report_note != null && (typeof r.self_report_note !== "string" || r.self_report_note.length > ADHERENCE_NOTE_MAX)) {
    throw new Error("invalid experiment note");
  }
  return {
    status: "open",
    experimentId,
    title,
    behavioralDate,
    dayNumber,
    nDays,
    arm: r.arm,
    instruction: text(r.instruction, 600),
    answer: (r.self_report as AdherenceAnswer | null | undefined) ?? null,
    note: (r.self_report_note as string | null | undefined) ?? null,
  };
}

/** The client-side check of the route's JSON (same shape the parser produced on the server). */
export function isAdherenceDay(value: unknown): value is AdherenceDay {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.status === "none" || v.status === "not_connected") return true;
  if (typeof v.experimentId !== "string" || typeof v.title !== "string" || typeof v.behavioralDate !== "string") return false;
  if (v.status === "not_revealed") return true;
  return v.status === "open" && (v.arm === "A" || v.arm === "B") && typeof v.instruction === "string"
    && typeof v.dayNumber === "number" && typeof v.nDays === "number"
    && (v.answer === null || isAdherenceAnswer(v.answer)) && (v.note === null || typeof v.note === "string");
}

export type AdherenceRequest = { date: string | null; answer: AdherenceAnswer; note: string | null };

/** Validate a POST /api/experiments/adherence body: { date?: "YYYY-MM-DD", answer, note? }. */
export function parseAdherenceRequest(body: unknown): { ok: true; value: AdherenceRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  if (b.date != null && (typeof b.date !== "string" || !DAY.test(b.date))) return { ok: false, error: "date must be YYYY-MM-DD." };
  if (!isAdherenceAnswer(b.answer)) return { ok: false, error: "answer must be yes, partly or no." };
  if (b.note != null && typeof b.note !== "string") return { ok: false, error: "note must be text." };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > ADHERENCE_NOTE_MAX) return { ok: false, error: `note is longer than ${ADHERENCE_NOTE_MAX} characters.` };
  return { ok: true, value: { date: (b.date as string | null | undefined) ?? null, answer: b.answer, note: note || null } };
}

/** "Mon, Dec 7" for a YYYY-MM-DD day, without going through a time zone. */
export function dayLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
