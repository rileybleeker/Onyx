import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  parseAdherenceDay,
  parseExperimentToday,
  type AdherenceDay,
  type AdherenceRequest,
  type ExperimentToday,
} from "@/lib/experiments";

/**
 * Server-side access to the N-of-1 experiment framework. SERVICE ROLE ONLY: the experiment tables
 * (sql/experiment_framework_schema.sql) have RLS on, no policies and no grants to
 * anon / authenticated, so the browser can never query them, and this module must never be
 * imported from a client component ("server-only" enforces that at build time).
 *
 * It calls database FUNCTIONS only and never selects from a table, so no code path in the app can
 * read a future arm:
 *   pds.experiment_today()              today's arm for the Today card. It stamps the first time a
 *                                       day's arm was shown (the allocation audit trail).
 *   pds.experiment_adherence_day()      the check-in question "Followed today's arm?" for today or
 *                                       yesterday; only for a day whose arm was already shown, and
 *                                       it stamps nothing.
 *   pds.experiment_record_adherence()   saves Riley's answer to that question (the per-day table).
 *
 * Nothing here logs an answer: a failure logs an error code only.
 */
function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false },
  });
}

// PGRST202: the function is not in the schema cache, i.e. its SQL file was never applied.
const NOT_APPLIED = "PGRST202";

export async function loadExperimentToday(): Promise<ExperimentToday> {
  const { data, error } = await serviceClient().rpc("experiment_today");
  if (error) {
    if (error.code === NOT_APPLIED) return { status: "not_connected" };
    throw new Error(`experiment_today failed (${error.code ?? "no code"})`);
  }
  return parseExperimentToday(data);
}

/** The check-in question for a behavioral day (null = today). Reads only; reveals nothing new. */
export async function loadAdherenceDay(date: string | null): Promise<AdherenceDay> {
  const { data, error } = await serviceClient().rpc("experiment_adherence_day", { p_date: date });
  if (error) {
    if (error.code === NOT_APPLIED) return { status: "not_connected" };
    throw new Error(`experiment_adherence_day failed (${error.code ?? "no code"})`);
  }
  return parseAdherenceDay(data);
}

/**
 * Save the answer. The database decides whether the day is open (running trial, today or yesterday,
 * arm already shown); when it is not, nothing is written and its state comes back instead.
 */
export async function recordAdherence({ date, answer, note }: AdherenceRequest): Promise<AdherenceDay> {
  const { data, error } = await serviceClient().rpc("experiment_record_adherence", {
    p_date: date,
    p_answer: answer,
    p_note: note,
  });
  if (error) {
    if (error.code === NOT_APPLIED) return { status: "not_connected" };
    throw new Error(`experiment_record_adherence failed (${error.code ?? "no code"})`);
  }
  return parseAdherenceDay(data);
}
