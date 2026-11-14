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

/** "Mon, Dec 7" for a YYYY-MM-DD day, without going through a time zone. */
export function dayLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
