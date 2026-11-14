import "server-only";
import { createClient } from "@supabase/supabase-js";
import { parseExperimentToday, type ExperimentToday } from "@/lib/experiments";

/**
 * Server-side read of today's experiment arm. SERVICE ROLE ONLY: the experiment tables
 * (sql/experiment_framework_schema.sql) have RLS on, no policies and no grants to
 * anon / authenticated, so the browser can never query them, and this module must never be
 * imported from a client component ("server-only" enforces that at build time).
 *
 * It calls ONE database function, pds.experiment_today(), which returns the arm of the current
 * behavioral day and nothing later. This module never selects from the schedule table, so no
 * code path in the app can read a future arm. The function stamps the first time a day's arm was
 * shown (the allocation audit trail); it records nothing about what Riley did.
 *
 * Nothing here logs the answer: a failure logs an error code only.
 */
export async function loadExperimentToday(): Promise<ExperimentToday> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false },
  });
  const { data, error } = await client.rpc("experiment_today");
  if (error) {
    // PGRST202: the function is not in the schema cache, i.e. the SQL file was never applied.
    if (error.code === "PGRST202") return { status: "not_connected" };
    throw new Error(`experiment_today failed (${error.code ?? "no code"})`);
  }
  return parseExperimentToday(data);
}
